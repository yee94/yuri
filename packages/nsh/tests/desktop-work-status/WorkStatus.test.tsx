import { expect, open, test } from 'nsh/test';

async function launch(platform, width = 1440) {
  const events: Array<{ event: string; value?: any }> = [];
  const app = await open('./App.tsx', { platform, width, height: 1000, clock: {}, host: { handlers: { 'work.status.audit': value => { events.push(value); } } } });
  const control = (action, value?) => app.host.send('work.status.control', { action, value });
  const snapshot = async () => { const count = events.filter(event => event.event === 'snapshot').length; await control('snapshot'); await app.waitUntil(() => events.filter(event => event.event === 'snapshot').length > count); return events.filter(event => event.event === 'snapshot').at(-1).value; };
  const count = event => events.filter(value => value.event === event).length;
  return { app, control, snapshot, events, count };
}
for (const platform of ['macos', 'windows'] as const) {
  test(platform + ' complete Web blocks, original actions, cancelled todos and live-only subagent authority', async () => {
    const f = await launch(platform), app = f.app;
    await app.waitFor('id:desktop-work-status-inline');
    expect(app.texts()).toContain('Exact Project'); expect(app.texts()).toContain('feature/real'); expect(app.texts()).toContain('Secondary worktree');
    expect(app.texts()).toContain('+7'); expect(app.texts()).toContain('−3'); expect(app.texts().join('')).toContain('1/4');
    expect(app.texts()).toContain('Cancelled todo'); expect(f.count('read')).toBe(0);
    await app.hover('id:desktop-work-status-branch'); await app.press('id:desktop-work-status-copy-branch');
    await app.waitUntil(() => f.count('copy') === 1); expect(f.events.find(event => event.event === 'copy').value).toBe('feature/real');
    await app.hover('id:desktop-work-status-worktree'); await app.press('id:desktop-work-status-copy-worktree');
    await app.waitUntil(() => f.count('copy') === 2); expect(f.events.filter(event => event.event === 'copy')[1].value).toBe('/fixture/tree');
    await f.control('copy-fail', true); await app.hover('id:desktop-work-status-branch'); await app.press('id:desktop-work-status-copy-branch');
    await app.waitUntil(() => f.count('error') === 1); expect(f.events.find(event => event.event === 'error').value).toBe('gitView.toast.copyFailed');
    await app.press('id:desktop-work-status-changes'); await app.waitUntil(() => f.count('open-git') === 1);
    await app.press('id:desktop-work-status-subagents');
    await app.waitFor('id:desktop-work-status-agents-unknown');
    expect(app.enabled('id:desktop-work-status-agent-unresolved')).toBe(false);
    await f.control('read'); await app.waitFor('text:Authoritative child title');
    await app.press('id:desktop-work-status-agent-child');
    await app.waitUntil(() => f.count('open-child') === 1);
    const target = f.events.find(event => event.event === 'open-child').value;
    expect(target.sessionID).toBe('child'); expect(target.readOnly).toBe(true); expect(target.scope.directory).toBe('/fixture/project');
    await f.control('working'); await app.waitFor('id:desktop-work-status-agents-working');
    expect(app.count('id:desktop-work-status-face-child')).toBe(1); expect(app.shows('id:desktop-work-status-face-unresolved')).toBe(false);
    await f.control('finished'); expect(app.texts().join('')).toContain('1/2'); expect(app.texts()).toContain('Cancelled todo'); expect(app.shows('id:desktop-work-status-todos-complete')).toBe(true);
    expect((await f.snapshot()).backgroundShell).toEqual({ phase: 'unavailable' }); expect(app.requests()).toEqual([]);
  });
  test(platform + ' exact window geometry/toggle, preview popup Escape, modal keeps one snapshot and expansion', async () => {
    const f = await launch(platform), app = f.app;
    expect(f.events.filter(event => event.event === 'layout').at(-1).value.reserve).toBe(210);
    await app.press('id:desktop-work-status-todos'); await app.press('id:desktop-work-status-subagents');
    await f.control('modal', true); expect(app.enabled('id:desktop-work-status-toggle')).toBe(false);
    expect(app.count('id:desktop-work-status-compact')).toBe(1); expect((await f.snapshot()).expanded).toEqual([false, true]);
    await f.control('read'); expect(f.count('read')).toBe(0); await f.control('modal', false);
    await app.setViewport(1439, 1000); expect(app.shows('id:desktop-work-status-inline')).toBe(false);
    await app.press('id:desktop-work-status-toggle'); await app.waitFor('id:desktop-work-status-overlay');
    expect((await f.snapshot()).expanded).toEqual([false, true]);
    await app.keyboard.press('escape'); await app.waitFor('id:desktop-work-status-overlay', { state: 'gone' });
    await app.setViewport(1440, 1000); await app.waitFor('id:desktop-work-status-inline');
    await f.control('preview', true); expect(app.shows('id:desktop-work-status-inline')).toBe(false);
    await app.press('id:desktop-work-status-toggle'); await app.waitFor('id:desktop-work-status-overlay');
    await f.control('expanded', true); await app.waitFor('id:desktop-work-status-compact', { state: 'gone' });
    expect(f.count('read')).toBe(0); expect(app.requests()).toEqual([]);
  });
  test(platform + ' explicit reads preserve prior on failure, empty is authoritative, retired lanes reject late completion', async () => {
    const f = await launch(platform);
    expect((await f.snapshot()).children).toEqual({ phase: 'unknown' });
    await f.control('read'); expect((await f.snapshot()).children.phase).toBe('ready');
    await f.control('fail', true); await f.control('read');
    const failed = (await f.snapshot()).children; expect(failed.phase).toBe('failed'); expect(failed.value[0].id).toBe('child');
    await f.control('fail', false); await f.control('empty', true); await f.control('read');
    expect((await f.snapshot()).children).toEqual({ phase: 'ready', value: [] });
    await f.control('empty', false); await f.control('hold'); await f.control('read'); expect((await f.snapshot()).reading).toBe(true);
    await f.control('lane'); await f.control('empty', true); await f.control('read');
    await f.control('release'); expect((await f.snapshot()).children).toEqual({ phase: 'ready', value: [] });
    await f.control('git-fail'); expect((await f.snapshot()).git.phase).toBe('failed'); expect(f.app.texts()).toContain('feature/real');
    await f.control('git-unknown'); expect((await f.snapshot()).git).toEqual({ phase: 'unknown' });
    await f.control('git-empty'); expect((await f.snapshot()).git.value.changedFiles).toBe(0); expect(f.app.shows('id:desktop-work-status-changes')).toBe(false);
    await f.control('retire'); expect(f.app.shows('id:desktop-work-status-compact')).toBe(false); expect(f.app.requests()).toEqual([]);
  });
  test(platform + ' 50 native input events cause zero reads/projection access and thousands of todos stay virtualized', async () => {
    const f = await launch(platform), app = f.app;
    const reads = f.count('read'), projections = f.count('projection-read');
    for (let index = 0; index < 50; index++) { await app.clear('id:fixture-composer'); await app.paste('id:fixture-composer', { text: `input ${index}` }); }
    expect(f.count('read')).toBe(reads); expect(f.count('projection-read')).toBe(projections);
    await f.control('many', 2000); expect(app.texts().join('')).toContain('0/2000');
    expect(app.texts().filter(text => /^Todo \d+$/.test(text)).length).toBeLessThan(30);
    await app.scroll('id:desktop-work-status-todo-list', 2000); expect(app.requests()).toEqual([]);
    await f.control('many-children', 2000); await app.press('id:desktop-work-status-subagents');
    expect(app.texts().filter(text => /^Large Child \d+$/.test(text)).length).toBeLessThan(50);
    expect(f.count('read')).toBe(reads);
  });
}
