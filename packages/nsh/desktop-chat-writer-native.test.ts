import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

test('real NSH mounted writer child waits for ACK and retains original durable across modal/background/renew on macOS and Windows', () => {
  const root = path.dirname(fileURLToPath(import.meta.url)), parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true }); const temporary = mkdtempSync(path.join(parent, 'desktop-chat-writer-'));
  try {
    writeFileSync(path.join(temporary, 'nsh.json'), JSON.stringify({ name: 'Chat writer fixture', id: 'example.yuri.chat-writer', version: '0.1.0', build: 1,
      theme: path.join(root, 'theme.json'), capabilities: { host: ['desktop.writer.capabilities', 'desktop.writer.acquire', 'desktop.writer.release', 'desktop.writer.renew'] } }));
    writeFileSync(path.join(temporary, 'App.tsx'), `import ${JSON.stringify(path.join(root, 'desktop-chat-writer-fixture.tsx'))};`);
    writeFileSync(path.join(temporary, 'Writer.test.tsx'), `
import { expect, open, test } from 'nsh/test';
import { StrictWriterHost } from ${JSON.stringify(path.join(root, 'desktop-writer-test-host.ts'))};
async function launch(platform, bad = false) {
 const native = new StrictWriterHost();
 if (bad) native.transform = (name, value) => name === 'desktop.writer.acquire' ? { ...value, extra: true } : value;
 const handlers = Object.fromEntries(['capabilities', 'acquire', 'release', 'renew'].map(name => ['desktop.writer.' + name, input => native.call('desktop.writer.' + name, input)]));
 const app = await open('./App.tsx', { platform, host: { handlers } });
 const control = (action, value?) => app.host.send('chat-writer.control', { action, value });
 async function audit() { await control('audit'); return JSON.parse(app.texts().find(text => text.startsWith('{"constructs"'))); }
 return { app, native, control, audit, activate: () => control('activate') };
}
for (const platform of ['macos', 'windows']) {
 test(platform + ' acquire-before-construct with actual openDraft, 50 input/modal zero calls, renewal preserves mounted child and old grant is unusable', async () => {
  const f = await launch(platform), app = f.app;
  const activation = f.activate();
  await app.waitFor('id:chat-writer-wait'); await app.waitUntil(() => f.native.calls.some(row => row.name === 'desktop.writer.acquire') || app.texts().includes('unknown'));
  expect(f.native.calls.map(row => row.name)).toEqual(['desktop.writer.capabilities', 'desktop.writer.acquire']);
  expect(await f.audit()).toMatchObject({ constructs: 0, reads: 0, writes: 0, writable: false });
  expect(app.shows('id:chat-writer-input')).toBe(false);
  await f.control('acquired'); await activation; await app.waitFor('id:chat-writer-input');
  await app.waitUntil(async () => (await f.audit()).reads === 1);
  const count = f.native.calls.length;
  for (let index = 0; index < 50; index++) { await app.type('id:chat-writer-input', 'x'); await f.control('modal', true); await f.control('modal', false); }
  const before = await f.audit(); expect(before.constructs).toBe(1); expect(before.draft.length).toBe(50); expect(before.reads).toBe(before.writes + 1); expect(f.native.calls.length).toBe(count);
  await app.setLifecycle('background'); expect((await f.audit()).draft).toBe(before.draft); await app.setLifecycle('active');
  expect((await f.audit()).draft).toBe(before.draft); expect(f.native.calls.length).toBe(count);
  f.native.scope = { hostID: 'host-a', lease: 'lease-two' }; const leaseChanging = f.control('lease');
  await app.waitUntil(() => f.native.calls.some(row => row.name === 'desktop.writer.renew'));
  expect(app.shows('id:chat-writer-input')).toBe(true);
  expect(await f.audit()).toMatchObject({ constructs: 1, unmounts: 0, writable: false, draft: before.draft });
  await f.control('stale'); expect((await f.audit()).staleRejected).toBe(2);
  await f.control('renewed'); await leaseChanging;
  expect(await f.audit()).toMatchObject({ constructs: 1, unmounts: 0, writable: true, laneBindings: 2, draft: before.draft });
  expect(f.native.calls.filter(row => row.name === 'desktop.writer.acquire').length).toBe(1);
  await f.control('prepare'); expect((await f.audit()).canClose).toBe(true); expect(f.native.calls.filter(row => row.name === 'desktop.writer.release').length).toBe(0);
  await f.control('cancel'); expect((await f.audit()).writable).toBe(true);
  await f.control('authority'); expect((await f.audit()).writable).toBe(false); expect(f.native.calls.filter(row => row.name === 'desktop.writer.renew').length).toBe(1);
 });
 test(platform + ' malformed native ACK stays waiting with zero construction/Storage and never retries', async () => {
  const f = await launch(platform, true), activation = f.activate(); await f.app.waitUntil(() => f.native.calls.some(row => row.name === 'desktop.writer.acquire') || f.app.texts().includes('unknown'));
  expect(f.native.calls.map(row => row.name)).toEqual(['desktop.writer.capabilities', 'desktop.writer.acquire']);
  await f.control('acquired'); await activation; await f.app.waitFor('text:unknown');
  for (let index = 0; index < 50; index++) { await f.control('modal', true); await f.control('modal', false); }
  expect(await f.audit()).toMatchObject({ constructs: 0, reads: 0, writes: 0, writable: false, phase: 'unknown' });
  expect(f.native.calls.length).toBe(2);
 });
}
`);
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'Writer.test.tsx'], { cwd: temporary, encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
    expect(result.error, result.stdout + result.stderr).toBeUndefined(); expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout + result.stderr).not.toContain('error unhandled rejection');
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}, 140_000);
