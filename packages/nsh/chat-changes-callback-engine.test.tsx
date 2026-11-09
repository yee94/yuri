import { expect, open, test } from 'nsh/test';
import { createHost } from './chat-changes-callback-fixture-host.js';

test('mock Changes callbacks preserve unknown through GET, dismissal and remount', async () => {
  const mock = createHost();
  // Headless cannot deliver the Swift pageSheet registration/completion events.
  // The real native component uses its non-iOS Sheet here; UIKit owns a separate acceptance lane.
  const app = await open('./chat-changes-callback-fixture.tsx', {
    platform: 'macos', width: 390, height: 844, network: {}, storage: {},
    host: { handlers: { 'runtime.request': (input: unknown) => mock.call('runtime.request', input) } },
  });
  // Keep the same startup GC window as the former stdin-generated steps, not a longer wait timeout.
  await app.wait(1200);
  const marker = 'changes-write-v1:["changes-callback-fixture","/fixture"]';
  const message = 'fix: fixture subject\n\nFixture highlight one\nFixture highlight two';
  async function phase(name: string, work: () => Promise<void>) {
    console.log('changes-callback-phase:start:' + name);
    try { await work(); }
    catch (cause) { throw new Error(`Changes callback phase ${name}: ${String(cause)}`); }
    console.log('changes-callback-phase:passed:' + name);
  }
  function locked() {
    expect(app.shows('id:changes-write-unknown')).toBe(true);
    expect(app.enabled('id:changes-commit')).toBe(false);
    expect(app.enabled('id:changes-commit-sync')).toBe(false);
    expect(app.enabled('id:changes-stage-src/deep/b.ts')).toBe(false);
    expect(app.enabled('id:changes-generate')).toBe(false);
    expect(app.storage()[marker]).toBe('pending');
    expect(mock.audit().commits).toBe(1);
    expect(mock.audit().posts).toEqual(['/api/small-model/generate', '/api/git/commit']);
  }
  async function refreshWithoutReplay() {
    const before = mock.audit().statusReads;
    expect(app.enabled('id:changes-refresh')).toBe(true);
    await app.press('id:changes-refresh');
    await app.waitUntil(() => mock.audit().statusReads > before && app.enabled('id:changes-refresh'));
    locked();
  }
  try {
    await phase('01-directory-generation-highlights', async () => {
      await app.waitFor('id:changes-staged-src/a.ts');
      await app.press('id:changes-collapse-directories-false');
      expect(app.shows('id:changes-working-src/deep/b.ts')).toBe(false);
      expect(app.shows('id:changes-staged-src/a.ts')).toBe(true);
      await app.press('id:changes-collapse-directories-false');
      await app.waitFor('id:changes-working-src/deep/b.ts');
      await app.press('id:changes-generate');
      await app.waitFor('text:Fixture highlight one');
      expect(app.value('id:changes-commit-message')).toBe('fix: fixture subject');
      await app.press('id:changes-insert-highlights');
      expect(app.value('id:changes-commit-message')).toBe(message);
      expect(app.shows('id:changes-highlights')).toBe(false);
    });
    await phase('02-unknown-marker-and-write-lock', async () => {
      await app.press('id:changes-commit');
      await app.waitFor('id:changes-write-unknown');
      await app.waitUntil(() => app.enabled('id:changes-refresh'));
      expect(app.value('id:changes-commit-message')).toBe(message);
      locked();
    });
    await phase('03-successful-get-keeps-unknown', refreshWithoutReplay);
    await phase('04-sheet-dismiss-completion', async () => {
      await app.press('id:changes-close');
      await app.waitUntil(() => !app.shows('id:native-changes-sheet'));
      expect(app.storage()[marker]).toBe('pending');
    });
    await phase('05-remount-and-get-keep-unknown', async () => {
      await app.press('id:changes-fixture-reopen');
      await app.waitFor('id:changes-write-unknown');
      await app.type('id:changes-commit-message', 'Nonempty draft after remount');
      locked();
      await refreshWithoutReplay();
    });
  } finally { app.dispose(); }
});
