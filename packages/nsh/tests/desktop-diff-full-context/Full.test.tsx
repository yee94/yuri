import { expect, open, test } from 'nsh/test';

const prefix = 'PREFIX\n'.repeat(99), tail = 'FULL_ONLY_CONTEXT\n'.repeat(9000) + 'FULL_END';
const before = prefix + 'SAME\nBEFORE_WORKSPACE\nTAIL\n' + tail, after = prefix + 'SAME\nAFTER_WORKSPACE\nTAIL\n' + tail;
const patch = '@@ -100,3 +100,3 @@\n SAME\n-BEFORE_WORKSPACE\n+AFTER_WORKSPACE\n TAIL\n';

async function launch(platform, staged = false) {
  const reads = [], rejected = [], audit = [];
  let failure = false, held = false, release, index = staged ? 'M' : ' ', working = 'M';
  const directory = platform === 'windows' ? 'C:\\repo' : '/repo';
  const app = await open('./App.tsx', { platform, width: 1400, height: 900, host: { params: { mode: 'workspace-full', windowsRoot: platform === 'windows', staged }, handlers: {
    'desktop.diff.audit': value => { audit.push(value); },
    'runtime.request': async value => {
      reads.push(value); const url = new URL(value.path, 'https://synthetic.example');
      if (value.method !== 'GET' || value.body !== undefined || value.expectedHost?.hostID !== 'synthetic-A' || value.expectedHost?.lease !== 'lease-A' || url.searchParams.get('directory') !== directory || !['/api/git/diff', '/api/git/status', '/api/git/file-diff'].includes(url.pathname)) { rejected.push(value); throw new Error('Unapproved source/Host/write'); }
      if (url.pathname === '/api/git/status') return { status: 200, body: { isClean: false, files: [{ path: 'source.ts', index, working_dir: working }] } };
      if (url.searchParams.get('path') !== 'source.ts') { rejected.push(value); throw new Error('Wrong selected file'); }
      if (url.pathname === '/api/git/diff') return { status: 200, body: { diff: patch } };
      if (url.searchParams.get('staged') !== (staged ? 'true' : null)) { rejected.push(value); throw new Error('Wrong formal full-context staged contract'); }
      if (held) await new Promise(done => { release = done; });
      if (failure) throw new Error('synthetic unknown GET response');
      return { status: 200, body: { path: 'source.ts', original: before, modified: after, isBinary: false } };
    },
  } } });
  await app.waitFor('text:AFTER_WORKSPACE');
  const control = (action, value) => app.host.send('desktop.diff.control', { action, value });
  const count = path => reads.filter(value => value.path.startsWith(path + '?')).length;
  return { app, reads, rejected, audit, control, count, fail: value => { failure = value; }, hold: value => { held = value; }, release: () => release?.(), status: (a, b) => { index = a; working = b; } };
}

for (const platform of ['macos', 'windows']) {
  test(platform + ' explicit formal GET upgrades the same document, preserves source-line selection and hunk anchor, copy contains all context', async () => {
    const f = await launch(platform); expect(f.count('/api/git/file-diff')).toBe(0); expect(f.count('/api/git/status')).toBe(0);
    await f.app.waitUntil(() => f.audit.some(value => value.kind === 'focus' && value.value.selection?.start === 1));
    await f.app.press('id:desktop-diff-list-full-context');
    await f.app.waitFor('text:FULL_ONLY_CONTEXT'); await f.app.waitFor('text:AFTER_WORKSPACE');
    await f.app.waitUntil(() => f.audit.some(value => value.kind === 'focus' && value.value.selection?.start === 100));
    expect(f.count('/api/git/file-diff')).toBe(1); expect(f.count('/api/git/status')).toBe(2);
    await f.app.press('id:desktop-diff-copy'); await f.app.waitUntil(() => f.app.clipboard()?.includes('FULL_END'));
    expect(f.app.clipboard()).toBe(before + '\n\n' + after);
    const count = f.reads.length; for (let i = 0; i < 50; i++) await f.app.type('id:diff-fixture-composer', 'x'); expect(f.reads.length).toBe(count);
    await f.control('scale', 150); await f.app.waitUntil(() => f.app.spanStyle('id:desktop-native-diff >> text:AFTER_WORKSPACE').fontSize === 18).catch(error => { throw new Error('font adoption: ' + error); }); expect(f.reads.length).toBe(count);
    await f.app.press('id:desktop-diff-list-full-context'); await f.app.waitFor('text:FULL_ONLY_CONTEXT', { state: 'gone' });
    await f.app.waitUntil(() => f.audit.filter(value => value.kind === 'focus').pop().value.selection?.start === 1).catch(error => { throw new Error('patch selection restore: ' + JSON.stringify(f.audit.filter(value => value.kind === 'focus').slice(-3)) + ' ' + error); });
    expect(f.reads.length).toBe(count); await f.app.press('id:desktop-diff-copy'); await f.app.waitUntil(() => f.app.clipboard() === patch);
    await f.app.press('id:desktop-diff-list-full-context'); await f.app.waitFor('text:FULL_ONLY_CONTEXT'); expect(f.reads.length).toBe(count); expect(f.rejected).toEqual([]);
  });
  test(platform + ' failure/unknown GET keeps original patch; explicit Retry alone rereads full context with captured scope', async () => {
    const f = await launch(platform); f.fail(true); await f.app.press('id:desktop-diff-list-full-context'); await f.app.waitFor('id:desktop-diff-full-context-error');
    expect(f.app.shows('text:AFTER_WORKSPACE')).toBe(true); expect(f.app.shows('text:FULL_ONLY_CONTEXT')).toBe(false);
    const count = f.reads.length; await f.app.wait(100); expect(f.reads.length).toBe(count);
    await f.app.press('id:desktop-diff-copy'); await f.app.waitUntil(() => f.app.clipboard() === patch);
    f.fail(false); await f.app.press('id:desktop-diff-full-context-retry'); await f.app.waitFor('text:FULL_ONLY_CONTEXT'); await f.app.waitFor('id:desktop-diff-full-context-error', { state: 'gone' });
    expect(f.count('/api/git/file-diff')).toBe(2); expect(f.rejected).toEqual([]);
  });
  test(platform + ' staged is HEAD->index; mixed working index changes are explicitly blocked, never silently HEAD->filesystem', async () => {
    const staged = await launch(platform, true); await staged.app.press('id:desktop-diff-list-full-context'); await staged.app.waitFor('text:FULL_ONLY_CONTEXT'); expect(staged.rejected).toEqual([]);
    const mixed = await launch(platform); mixed.status('M', 'M'); await mixed.app.press('id:desktop-diff-list-full-context'); await mixed.app.waitFor('id:desktop-diff-full-context-error');
    expect(mixed.count('/api/git/file-diff')).toBe(0); expect(mixed.app.shows('text:AFTER_WORKSPACE')).toBe(true); expect(mixed.rejected).toEqual([]);
  });
  test(platform + ' background and current retirement cancel the exact full operation, accept no late body and make no automatic full retry', async () => {
    for (const kind of ['background', 'retire', 'unload']) {
      const f = await launch(platform); f.hold(true); const loading = f.app.press('id:desktop-diff-list-full-context'); await f.app.waitUntil(() => f.count('/api/git/file-diff') === 1);
      if (kind === 'background') await f.app.setLifecycle('background'); else if (kind === 'retire') await f.control('retire'); else await f.app.press('id:desktop-diff-list-full-context');
      expect(f.app.enabled('id:desktop-diff-list-full-context')).toBe(kind === 'unload'); f.release(); await loading;
      expect(f.count('/api/git/status')).toBe(1); expect(f.app.shows('text:FULL_ONLY_CONTEXT')).toBe(false); expect(f.app.shows('text:AFTER_WORKSPACE')).toBe(true);
      if (kind === 'background') { await f.app.setLifecycle('active'); await f.app.waitFor('text:AFTER_WORKSPACE'); expect(f.count('/api/git/file-diff')).toBe(1); }
      expect(f.rejected).toEqual([]);
    }
  });
}

test('actual iOS-model mobile consumers keep their patch-only contract after confirmed connection admission', async () => {
  const reads = [], rejected = [];
  const app = await open('./Mobile.tsx', { platform: 'ios', host: { handlers: {
    'connection.list': () => ({ selected: 'synthetic-mobile', connections: [{ id: 'synthetic-mobile', url: 'https://synthetic.example', authorizationID: 'synthetic-auth' }], runtimeScope: { hostID: 'synthetic-mobile', lease: 'mobile-lease' } }),
    'runtime.request': value => {
      reads.push(value);
      if (value.method !== 'GET' || value.body !== undefined || value.expectedHost?.hostID !== 'synthetic-mobile' || value.expectedHost?.lease !== 'mobile-lease' || value.path.includes('file-diff') || value.path.includes('mode=light')) { rejected.push(value); throw new Error('Mobile default full-context regression'); }
      if (value.path === '/api/git/status?directory=%2Frepo') return { status: 200, body: { isClean: false, files: [{ path: 'source.ts', index: ' ', working_dir: 'M' }], diffStats: { 'source.ts': { insertions: 1, deletions: 1 } } } };
      if (value.path === '/api/git/diff?directory=%2Frepo&path=source.ts&staged=false') return { status: 200, body: { diff: '@@ -1 +1 @@\n-MOBILE_BEFORE\n+MOBILE_AFTER\n' } };
      rejected.push(value); throw new Error('Unexpected mobile request');
    },
  } } });
  await app.waitFor('text:mobile-diff-admitted'); await app.waitFor('text:1 file'); const count = reads.length;
  for (let i = 0; i < 50; i++) await app.type('id:mobile-diff-draft', 'x'); expect(reads.length).toBe(count);
  await app.press('id:composer-changes'); await app.waitFor('id:composer-change-source.ts'); await app.press('id:composer-change-source.ts'); await app.waitFor('text:MOBILE_AFTER');
  await app.press('id:changes-diff-refresh'); await app.waitFor('text:MOBILE_AFTER');
  expect(reads.some(value => value.path.includes('file-diff') || value.path.includes('mode=light'))).toBe(false);
  expect(app.value('id:mobile-diff-draft')).toBe('x'.repeat(50)); expect(rejected).toEqual([]);
});
