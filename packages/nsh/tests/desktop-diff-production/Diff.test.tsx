import { expect, open, test } from 'nsh/test';

async function launch(platform, mode = 'history') {
  const audit = [], reads = [], rejected = [];
  let fail = false, delayed = false, resolve;
  const handlers = {
    'desktop.diff.audit': value => { audit.push(value); },
    'runtime.request': async value => {
      reads.push(value);
      if (value.method !== 'GET' || value.body !== undefined || value.expectedHost?.hostID !== 'synthetic-A' || value.expectedHost?.lease !== 'lease-A' || !value.path.startsWith('/api/git/diff?')) { rejected.push(value); throw new Error('Unexpected wire'); }
      const waiting = delayed;
      if (waiting) await new Promise(done => { resolve = done; });
      if (fail) return { status: 503, body: { error: 'synthetic failure' } };
      return { status: 200, body: { diff: '@@ -1,3 +1,3 @@\n SAME\n-BEFORE_WORKSPACE\n+' + (waiting ? 'LATE_RETIRED_HOST_BODY' : 'AFTER_WORKSPACE') + '\n TAIL\n' } };
    },
  };
  const app = await open('./App.tsx', { platform, width: 1400, height: 900, host: { params: { mode, windowsRoot: platform === 'windows' }, handlers } });
  await app.waitFor('text:diff-fixture-ready');
  const control = (action, value) => app.host.send('desktop.diff.control', { action, value });
  return { app, audit, reads, rejected, control, fail: value => { fail = value; }, delay: value => { delayed = value; }, resolve: () => resolve?.() };
}

for (const platform of ['macos', 'windows']) {
  test(platform + ' historical exact before-after copy, real native focus and 50 input edits without any requests', async () => {
    const f = await launch(platform); await f.app.waitFor('text:AFTER_EXACT');
    expect(f.app.texts().filter(value => value === 'SAME').length).toBe(2);
    await f.app.waitUntil(() => f.audit.some(value => value.kind === 'focus'));
    const focus = f.audit.find(value => value.kind === 'focus').value;
    expect(focus.viewport).toBe('hunk-only'); expect(focus.selection).toEqual({ side: 'new', start: 1, end: 1 });
    await f.app.press('id:desktop-diff-copy'); await f.app.waitUntil(() => f.app.clipboard() !== null);
    expect(f.app.clipboard()).toContain('BEFORE_EXACT'); expect(f.app.clipboard()).toContain('AFTER_EXACT'); expect(f.app.clipboard()).toContain('NEW_TAIL');
    expect(f.app.shows('id:desktop-diff-open-editor')).toBe(false);
    for (let i = 0; i < 50; i++) await f.app.type('id:diff-fixture-composer', 'x');
    expect(f.reads).toEqual([]); expect(f.rejected).toEqual([]);
    const focusCount = f.audit.filter(value => value.kind === 'focus').length;
    await f.app.setViewport(1099, 900); expect(f.app.texts().filter(value => value === 'SAME').length).toBe(1);
    await f.app.setViewport(1100, 900); expect(f.app.texts().filter(value => value === 'SAME').length).toBe(2);
    await f.app.setViewport(1099, 900); await f.app.press('id:desktop-diff-list-layout');
    expect(f.app.texts().filter(value => value === 'SAME').length).toBe(2);
    expect(f.audit.filter(value => value.kind === 'layout').pop().layout).toBe('side-by-side');
    await f.app.press('id:desktop-diff-list-wrap'); expect(f.audit.some(value => value.kind === 'wrap' && value.wrapLines)).toBe(true);
    await f.control('scale', 150); expect(f.app.spanStyle('id:desktop-native-diff >> text:AFTER_EXACT').fontSize).toBe(18);
    const lightColor = f.app.spanStyle('id:desktop-native-diff >> text:AFTER_EXACT').color;
    await f.app.setColorScheme('dark'); expect(f.app.spanStyle('id:desktop-native-diff >> text:AFTER_EXACT').color).not.toEqual(lightColor);
    expect(f.audit.filter(value => value.kind === 'focus').length).toBe(focusCount); expect(f.reads).toEqual([]);
    await f.app.setViewport(1400, 900); await f.app.press('id:desktop-diff-list-file-second.ts');
    await f.app.waitFor('text:SECOND_NEW');
    await f.app.press('id:desktop-diff-entry-' + JSON.stringify(['turn', 'second.ts']) + ' >> id:desktop-diff-open-file');
    expect(f.audit.filter(value => value.kind === 'preview').pop().path).toBe('second.ts');
    expect(f.audit.filter(value => value.kind === 'file')).toEqual([]);
    expect(f.reads).toEqual([]);
  });
  test(platform + ' background/hidden/retired Host deny every action, retained view is not recreated for a draft', async () => {
    const f = await launch(platform); await f.app.waitFor('text:AFTER_EXACT');
    await f.control('active', false); const count = f.audit.length;
    expect(f.app.enabled('id:desktop-diff-copy')).toBe(false); expect(f.app.enabled('id:desktop-diff-open-file')).toBe(false); expect(f.app.enabled('id:desktop-diff-refresh')).toBe(false);
    for (const id of ['desktop-diff-copy', 'desktop-diff-open-file']) { let blocked = false; try { await f.app.press('id:' + id); } catch (cause) { blocked = String(cause).includes('disabled'); } expect(blocked).toBe(true); }
    expect(f.audit.length).toBe(count); expect(f.app.clipboard()).toBe(null);
    await f.control('active', true); await f.app.setLifecycle('background'); expect(f.app.enabled('id:desktop-diff-list-wrap')).toBe(false);
    await f.app.setLifecycle('active'); await f.control('retire'); expect(f.app.enabled('id:desktop-diff-list-layout')).toBe(false);
    expect(f.app.enabled('id:desktop-diff-refresh')).toBe(false); expect(f.reads).toEqual([]); expect(f.rejected).toEqual([]);
  });
  test(platform + ' unique current Git reader retains successful snapshot on failure, retry only GET; retirement rejects delayed result', async () => {
    const f = await launch(platform, 'workspace'); await f.app.waitFor('text:AFTER_WORKSPACE'); expect(f.reads.length).toBe(1);
    expect(f.app.enabled('id:desktop-diff-list-full-context')).toBe(true);
    await f.app.press('id:desktop-diff-open-editor'); expect(f.audit.find(value => value.kind === 'editor').line).toBe(2);
    for (let i = 0; i < 50; i++) await f.app.type('id:diff-fixture-composer', 'x'); expect(f.reads.length).toBe(1);
    f.fail(true); await f.app.press('id:desktop-diff-refresh'); await f.app.waitFor('text:HTTP 503: synthetic failure'); expect(f.app.shows('text:AFTER_WORKSPACE')).toBe(true);
    f.fail(false); await f.app.press('id:desktop-diff-refresh'); await f.app.waitFor('text:HTTP 503: synthetic failure', { state: 'gone' });
    expect(f.reads.length).toBe(3); expect(f.rejected).toEqual([]);
    f.delay(true); const refreshing = f.app.press('id:desktop-diff-refresh'); await f.app.waitUntil(() => f.reads.length === 4);
    await f.control('retire'); const count = f.audit.length; f.resolve(); await refreshing; await f.app.wait(50);
    expect(f.audit.length).toBe(count); expect(f.app.enabled('id:desktop-diff-open-editor')).toBe(false); expect(f.app.shows('text:LATE_RETIRED_HOST_BODY')).toBe(false); expect(f.app.shows('text:AFTER_WORKSPACE')).toBe(true);
  });
  test(platform + ' complete document expands retained context without a new request; emptiness and binary remain distinct', async () => {
    const f = await launch(platform, 'full-document'); await f.app.waitFor('text:AFTER_EXACT');
    expect(f.app.enabled('id:desktop-diff-full-context')).toBe(true); await f.app.press('id:desktop-diff-full-context');
    await f.app.waitFor('text:NEW_TAIL'); expect(f.app.texts().filter(value => value === 'retained context').length).toBe(60); expect(f.reads).toEqual([]);
    await f.app.press('id:desktop-diff-copy'); await f.app.waitUntil(() => f.app.clipboard()?.includes('NEW_TAIL'));
    const empty = await launch(platform, 'empty'); await empty.app.waitFor('text:No last turn changes to display'); expect(empty.reads).toEqual([]);
    const binary = await launch(platform, 'binary'); await binary.app.waitFor('text:Content of this file cannot be viewed.'); expect(binary.app.shows('id:desktop-native-diff')).toBe(false); expect(binary.reads).toEqual([]);
    expect(binary.app.enabled('id:desktop-diff-copy')).toBe(false); await binary.app.press('id:desktop-diff-open-file'); expect(binary.audit.some(value => value.kind === 'preview')).toBe(true);
    const single = await launch(platform, 'single-file'); await single.app.waitFor('text:AFTER_EXACT');
    expect(single.app.shows('id:desktop-diff-files')).toBe(false); expect(single.app.shows('id:desktop-diff-layout')).toBe(false); expect(single.app.shows('id:desktop-diff-wrap')).toBe(false);
    await single.control('preferences', { layoutPreference: 'inline', wrapLines: true }); expect(single.app.texts().filter(value => value === 'SAME').length).toBe(1); expect(single.reads).toEqual([]);
  });
}

for (const platform of ['macos', 'windows']) test(platform + ' large retained history is never cut; 50 input edits request nothing and long hunk reports only hunk positioning', async () => {
  const f = await launch(platform, 'large'); await f.app.waitFor('id:desktop-native-diff');
  await f.app.waitUntil(() => f.audit.some(value => value.kind === 'focus'));
  expect(f.audit.find(value => value.kind === 'focus').value.viewport).toBe('hunk-only');
  await f.app.press('id:desktop-diff-copy'); await f.app.waitUntil(() => !!f.app.clipboard());
  expect(f.app.clipboard()).toContain('OLD_END'); expect(f.app.clipboard()).toContain('NEW_END'); expect(f.app.clipboard().length > 150000).toBe(true); expect(f.reads).toEqual([]);
  for (let i = 0; i < 50; i++) await f.app.type('id:diff-fixture-composer', 'x');
  expect(f.reads).toEqual([]); expect(f.rejected).toEqual([]);
});
