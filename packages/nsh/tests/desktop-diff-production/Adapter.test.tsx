import { expect, open, test } from 'nsh/test';

const key = (scope, path) => JSON.stringify([scope, path]);
const entry = (scope, path) => 'id:desktop-diff-entry-' + key(scope, path);
const control = (app, action) => app.host.send('diff.adapter.control', { action });
async function launch(platform, mode = 'panel', params = {}) {
  const reads = [], rejected = [];
  let version = '', failStatus = false, failPatch = false, held = false, finish;
  const app = await open('./App.tsx', { platform, ...(params.long ? { clock: {} } : {}), width: 1400, height: 1000, host: { params: { mode, ...params }, handlers: {
    'runtime.request': async value => {
      reads.push(value); const url = new URL(value.path, 'https://synthetic.invalid');
      if (value.method !== 'GET' || value.body !== undefined || value.expectedHost?.hostID !== 'adapter' || value.expectedHost?.lease !== 'adapter-lease' || url.searchParams.get('directory') !== '/workspace' || !['/api/git/status', '/api/git/diff'].includes(url.pathname)) { rejected.push(value); throw new Error('unapproved adapter request'); }
      if (url.pathname === '/api/git/status') {
        if (failStatus) return { status: 503, body: { error: 'CATALOG_OFFLINE' } };
        return { status: 200, body: { isClean: false, files: [{ path: 'z.ts', index: 'M', working_dir: 'M' }, { path: 'a.ts', index: ' ', working_dir: 'M' }, { path: 'last.ts', index: 'M', working_dir: ' ' }] } };
      }
      const waiting = held; if (waiting) await new Promise(done => { finish = done; });
      if (failPatch) return { status: 503, body: { error: 'PATCH_OFFLINE' } };
      const path = url.searchParams.get('path'), staged = url.searchParams.get('staged') === 'true';
      if (params.long && path === 'z.ts') return { status: 200, body: { diff: '@@ -1,12002 +1,12002 @@\n-ROOT_TOP_OLD\n' + '-ROOT_BODY_OLD\n'.repeat(12000) + '-ROOT_END_OLD\n+ROOT_TOP_NEW\n' + '+ROOT_BODY_NEW\n'.repeat(12000) + '+ROOT_END_NEW' + version + '\n' } };
      return { status: 200, body: { diff: '@@ -1,3 +1,3 @@\n SAME\n-OLD_' + path + '\n+' + (waiting ? 'LATE_FORBIDDEN' : (staged ? 'STAGED_' : 'WORKING_') + path + version) + '\n TAIL\n' } };
    },
  } } });
  await app.waitFor('text:adapter-ready');
  const count = pathname => reads.filter(value => new URL(value.path, 'https://synthetic.invalid').pathname === pathname).length;
  const patchCount = (path, staged) => reads.filter(value => { const url = new URL(value.path, 'https://synthetic.invalid'); return url.pathname === '/api/git/diff' && url.searchParams.get('path') === path && url.searchParams.get('staged') === String(staged); }).length;
  return { app, reads, rejected, count, patchCount, version: value => { version = value; }, failStatus: value => { failStatus = value; }, failPatch: value => { failPatch = value; }, hold: value => { held = value; }, waiting: () => !!finish, finish: () => finish?.() };
}
async function choose(app, label) { await app.press('role:combobox[Select change mode]'); await app.press('text:' + label); }
for (const platform of ['macos', 'windows']) {
  test(platform + ' actual panel uses the sole outer List for a natural 12000-line document, keeps visible demand and never passively navigates after refresh', async () => {
    const f = await launch(platform, 'panel', { long: true }); await f.app.waitFor('text:ROOT_TOP_NEW');
    expect(f.app.shows('text:ROOT_END_NEW')).toBe(false);
    await f.app.scroll('id:desktop-diff-stack', 2400); await f.app.waitFor('text:ROOT_BODY_NEW');
    expect(f.app.shows('text:ROOT_TOP_NEW')).toBe(false);
    const count = f.patchCount('z.ts', false); f.version('_REFRESH');
    await f.app.press('id:desktop-diff-refresh'); await f.app.waitFor('text:ROOT_BODY_NEW');
    expect(f.patchCount('z.ts', false)).toBe(count + 1); expect(f.app.shows('text:ROOT_TOP_NEW')).toBe(false);
    const before = f.reads.length;
    for (let i = 0; i < 50; i++) await f.app.type('id:diff-adapter-composer', 'x');
    await f.app.setViewport(1350, 950); await f.app.waitFor('text:ROOT_BODY_NEW');
    expect(f.reads.length).toBe(before); expect(f.rejected).toEqual([]);
  });
  test(platform + ' actual panel source.path discovers full catalog, preserves source order, owner per-file projections and 50 edits/resize zero GET', async () => {
    const f = await launch(platform); await f.app.waitFor('text:WORKING_z.ts'); await f.app.waitFor('text:WORKING_a.ts');
    expect(f.app.shows('id:native-desktop-panel')).toBe(true); expect(f.app.shows('id:native-desktop-diff-list')).toBe(true);
    expect(f.app.shows('id:desktop-diff-list-files')).toBe(false);
    expect(f.app.texts().filter(text => text === 'z.ts' || text === 'a.ts')).toEqual(['z.ts', 'z.ts', 'a.ts']);
    expect(f.app.count(entry('working', 'z.ts') + ' >> text:SAME')).toBe(2);
    expect(f.app.count(entry('working', 'a.ts') + ' >> text:SAME')).toBe(1);
    expect(f.count('/api/git/status')).toBe(1); expect(f.patchCount('z.ts', false)).toBe(1); expect(f.patchCount('a.ts', false)).toBe(1);
    const before = f.reads.length;
    for (let i = 0; i < 50; i++) await f.app.type('id:diff-adapter-composer', 'x');
    expect(f.app.value('id:diff-adapter-composer')).toBe('x'.repeat(50));
    await f.app.setViewport(1099, 1000); await f.app.setViewport(1100, 1000); expect(f.reads.length).toBe(before); expect(f.rejected).toEqual([]);
  });
  test(platform + ' controlled Working/Staged shares source, inventory and cached bodies; hidden-scope invalidation waits for demand; missing Turn disabled', async () => {
    const f = await launch(platform); await f.app.waitFor('text:WORKING_a.ts');
    await f.app.press('role:combobox[Select change mode]'); expect(f.app.enabled('text:Last turn: 0')).toBe(false); await f.app.press('text:Staged: 2');
    await f.app.waitFor('text:STAGED_z.ts'); await f.app.waitFor('text:STAGED_last.ts');
    expect(f.count('/api/git/status')).toBe(1);
    const before = f.reads.length; await choose(f.app, 'Changed: 2'); await f.app.waitFor('text:WORKING_z.ts'); expect(f.reads.length).toBe(before);
    await choose(f.app, 'Staged: 2'); await f.app.waitFor('text:STAGED_z.ts'); expect(f.reads.length).toBe(before);
    const working = f.patchCount('z.ts', false); f.version('_REFRESHED'); await f.app.press('id:desktop-diff-refresh'); await f.app.waitFor('text:STAGED_z.ts_REFRESHED');
    expect(f.patchCount('z.ts', false)).toBe(working); expect(f.count('/api/git/status')).toBe(2);
    await choose(f.app, 'Changed: 2'); await f.app.waitFor('text:WORKING_z.ts_REFRESHED'); expect(f.patchCount('z.ts', false)).toBe(working + 1); expect(f.rejected).toEqual([]);
  });
  test(platform + ' same M/M refresh updates visible body; inventory failure and patch failure keep prior; explicit single-row retry only GET', async () => {
    const f = await launch(platform); await f.app.waitFor('text:WORKING_a.ts');
    f.version('_NEW'); await f.app.press('id:desktop-diff-refresh'); await f.app.waitFor('text:WORKING_z.ts_NEW'); await f.app.waitFor('text:WORKING_a.ts_NEW');
    const before = f.reads.length; f.failStatus(true); await f.app.press('id:desktop-diff-refresh'); await f.app.waitFor('text:HTTP 503: CATALOG_OFFLINE');
    expect(f.app.shows('text:WORKING_z.ts_NEW')).toBe(true); expect(f.app.shows('text:WORKING_a.ts_NEW')).toBe(true); expect(f.app.count('id:desktop-native-diff')).toBe(2); expect(f.reads.length).toBe(before + 1);
    f.failStatus(false); f.failPatch(true); await f.app.press('id:desktop-diff-refresh'); await f.app.waitFor('id:desktop-diff-retry-' + key('working', 'z.ts'));
    expect(f.app.shows('text:WORKING_z.ts_NEW')).toBe(true); const failed = f.reads.length;
    for (let i = 0; i < 50; i++) await f.app.type('id:diff-adapter-composer', 'x'); expect(f.reads.length).toBe(failed);
    f.failPatch(false); f.version('_RETRY'); await f.app.press('id:desktop-diff-retry-' + key('working', 'z.ts')); await f.app.waitFor('text:WORKING_z.ts_RETRY');
    expect(f.reads.length).toBe(failed + 1); expect(f.app.shows('text:WORKING_a.ts_NEW')).toBe(true); expect(f.rejected).toEqual([]);
  });
  test(platform + ' authoritative props.files overrides inventory and explicit same-catalog invalidation refreshes bodies without status GET', async () => {
    const f = await launch(platform, 'catalog'); await f.app.waitFor('text:WORKING_a.ts'); expect(f.count('/api/git/status')).toBe(0);
    f.version('_EVENT'); await control(f.app, 'invalidate'); await f.app.waitFor('text:WORKING_z.ts_EVENT'); expect(f.count('/api/git/status')).toBe(0);
    expect(f.patchCount('z.ts', false)).toBe(2); expect(f.patchCount('a.ts', false)).toBe(2); expect(f.rejected).toEqual([]);
  });
  test(platform + ' inventory-only ordinary panel uses the same owner for runtime invalidation, failed catalog keeps prior, hidden event/poll demand is zero', async () => {
    const f = await launch(platform, 'panel', { noPath: true }); await f.app.waitFor('text:WORKING_a.ts');
    const event = () => f.app.host.send('runtime.event', { key: 'global', data: JSON.stringify({ directory: '/workspace', payload: { type: 'yuri:git-changed' } }) });
    f.version('_EVENT'); f.failStatus(true); await event(); await f.app.waitFor('text:WORKING_z.ts_EVENT');
    expect(f.count('/api/git/status')).toBe(2); expect(f.app.shows('text:HTTP 503: CATALOG_OFFLINE')).toBe(true);
    f.failStatus(false); await f.app.press('id:desktop-changes-refresh'); await f.app.waitFor('text:HTTP 503: CATALOG_OFFLINE', { state: 'gone' }); await f.app.waitFor('text:WORKING_a.ts_EVENT');
    await control(f.app, 'modal'); const before = f.reads.length; await event(); await f.app.wait(10_050); expect(f.reads.length).toBe(before); expect(f.rejected).toEqual([]);
  });
  test(platform + ' delayed body cannot land after modal/background/authority/source retirement; hidden panel has zero event/poll demand', async () => {
    for (const kind of ['modal', 'background', 'authority', 'source']) {
      const f = await launch(platform); await f.app.waitFor('text:WORKING_a.ts'); f.hold(true);
      const refreshing = f.app.press('id:desktop-diff-refresh'); await f.app.waitUntil(f.waiting);
      if (kind === 'background') await f.app.setLifecycle('background'); else await control(f.app, kind);
      const before = f.reads.length; f.hold(false); f.finish(); await refreshing; await f.app.wait(50);
      expect(f.app.texts().some(text => text.includes('LATE_FORBIDDEN'))).toBe(false); expect(f.reads.length).toBe(before);
      if (kind !== 'source') expect(f.app.shows('text:WORKING_z.ts')).toBe(true);
      expect(f.rejected).toEqual([]);
    }
  });
  test(platform + ' actual file-diff keeps single renderer and hidden global toolbar; thin exact turn never current Git', async () => {
    const f = await launch(platform, 'single'); await f.app.waitFor('text:HISTORY_AFTER');
    expect(f.app.shows('id:native-desktop-diff-list')).toBe(false); expect(f.app.shows('id:desktop-diff-scope')).toBe(false); expect(f.app.shows('id:desktop-diff-layout')).toBe(false); expect(f.app.shows('id:desktop-diff-list-wrap')).toBe(false);
    expect(f.app.count('id:desktop-native-diff')).toBe(1); expect(f.app.shows('text:A_HISTORY')).toBe(false); expect(f.reads).toEqual([]);
    await f.app.press('id:desktop-diff-copy'); await f.app.waitUntil(() => f.app.clipboard()?.includes('HISTORY_AFTER')); expect(f.app.clipboard()).toContain('HISTORY_BEFORE');
    const thin = await launch(platform, 'thin'); await thin.app.waitFor('id:desktop-diff-retry-' + key('turn', 'thin.ts')); expect(thin.reads).toEqual([]);
    await thin.app.press('id:desktop-diff-retry-' + key('turn', 'thin.ts')); expect(thin.reads).toEqual([]); expect(thin.app.shows('text:exact resolver unavailable')).toBe(true);
    expect(f.rejected).toEqual([]); expect(thin.rejected).toEqual([]);
  });
}
