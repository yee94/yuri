import { expect, open, test, type App } from 'nsh/test';

async function audit(app: App): Promise<Array<{ path: string; method: string }>> {
  const previous = app.texts().find(value => value.startsWith('audit:'));
  await app.press('id:fixture-schedules-audit');
  await app.waitUntil(() => app.texts().some(value => value.startsWith('audit:[') && value !== previous));
  return JSON.parse(app.texts().find(value => value.startsWith('audit:['))!.slice(6));
}
for (const platform of ['macos', 'windows'] as const) {
  test(`${platform} headless: desktop filters/search and existing editor slot, no mobile detail navigation`, async () => {
    const app = await open('./desktop-schedules-fixture.tsx', { platform, width: 1068, height: 832 });
    await app.waitFor('id:desktop-scheduled-task-project-daily');
    expect(app.shows('id:scheduled-create')).toBe(false);
    const before = await audit(app);
    await app.type('id:desktop-scheduled-search', 'no-match');
    await app.waitFor('id:desktop-scheduled-empty');
    expect(app.shows('id:desktop-scheduled-task-project-daily')).toBe(false);
    await app.clear('id:desktop-scheduled-search');
    await app.press('id:desktop-scheduled-filter-paused');
    expect(app.shows('id:desktop-scheduled-task-project-paused')).toBe(true);
    expect(app.shows('id:desktop-scheduled-task-project-daily')).toBe(false);
    await app.press('id:desktop-scheduled-filter-all');
    expect((await audit(app)).filter(row => row.path.startsWith('/api/')).length).toBe(before.filter(row => row.path.startsWith('/api/')).length);
    await app.press('id:desktop-scheduled-task-project-daily');
    await app.waitFor('id:desktop-scheduled-editor'); await app.waitFor('text:Editor:daily');
    expect(app.shows('text:unexpected-mobile-detail')).toBe(false);
    await app.setViewport(800, 480);
    expect(app.shows('id:desktop-scheduled-editor')).toBe(true);
    expect(app.shows('text:editor-owners:1:0')).toBe(true);
  });
  test(`${platform} headless: modal and dirty guard retain the same editor/search with bounded reads`, async () => {
    const app = await open('./desktop-schedules-fixture.tsx', { platform, width: 1068, height: 832 });
    await app.waitFor('id:desktop-scheduled-task-project-daily');
    await app.press('id:desktop-scheduled-task-project-daily');
    await app.clear('id:fixture-schedule-draft');
    const before = await audit(app);
    await app.type('id:fixture-schedule-draft', 'x'.repeat(50));
    const draft = app.value('id:fixture-schedule-draft');
    for (let i = 0; i < 20; i++) {
      await app.press('id:fixture-schedules-modal');
      expect(app.value('id:fixture-schedule-draft')).toBe(draft);
      expect(app.shows('text:editor-owners:1:0')).toBe(true);
      expect(app.shows('id:desktop-scheduled-task-project-daily')).toBe(true);
    }
    expect((await audit(app)).filter(row => row.path.startsWith('/api/')).length).toBe(before.filter(row => row.path.startsWith('/api/')).length);
    await app.press('id:fixture-schedules-veto');
    await app.press('id:desktop-scheduled-history-tab'); await app.waitFor('text:dirty-veto');
    expect(app.shows('id:desktop-scheduled-editor')).toBe(true);
    expect(app.value('id:fixture-schedule-draft')).toBe(draft);
    await app.press('id:fixture-schedules-modal');
    expect(app.enabled('id:desktop-scheduled-create')).toBe(false);
    await app.rightClick('id:desktop-scheduled-task-project-daily'); expect(app.shows('role:menuitem[Run now]')).toBe(false);
    await app.press('id:fixture-schedules-modal');
    await app.type('id:fixture-schedule-draft', ' restored');
    expect(app.value('id:fixture-schedule-draft')).toBe(draft + ' restored');
    expect((await audit(app)).some(row => row.method === 'PATCH' || row.method === 'POST' || row.method === 'DELETE')).toBe(false);
  });
  test(`${platform} headless: native task menus preserve run-in-place, pause/resume and confirmed delete`, async () => {
    const app = await open('./desktop-schedules-fixture.tsx', { platform, width: 1068, height: 832 });
    await app.waitFor('id:desktop-scheduled-task-project-daily');
    await app.rightClick('id:desktop-scheduled-task-project-daily'); await app.press('role:menuitem[Run now]');
    await app.waitFor('text:Schedule started');
    expect(app.texts().some(text => text.startsWith('session:'))).toBe(false);
    await app.rightClick('id:desktop-scheduled-task-project-daily'); await app.press('role:menuitem[Pause]');
    await app.waitFor('text:Schedule saved');
    await app.press('id:desktop-scheduled-menu-project-daily'); await app.press('role:menuitem[Resume]');
    app.onDialog(() => 'Cancel');
    await app.rightClick('id:desktop-scheduled-task-project-daily'); await app.press('role:menuitem[Delete]');
    expect((await audit(app)).some(row => row.method === 'DELETE')).toBe(false);
    app.onDialog(() => 'Delete');
    await app.rightClick('id:desktop-scheduled-task-project-daily'); await app.press('role:menuitem[Delete]');
    await app.waitUntil(() => !app.shows('id:desktop-scheduled-task-project-daily'));
    expect((await audit(app)).filter(row => row.method === 'DELETE').length).toBe(1);
    await app.press('id:desktop-scheduled-create'); await app.waitFor('text:Editor:new');
  });
  // NSH 0.4 dispatches headless view Tab traversal only on macOS/Web.
  (platform === 'macos' ? test : test.skip)(`${platform} headless: semantic workspace tabs use native roving keyboard focus`, async () => {
    const app = await open('./desktop-schedules-fixture.tsx', { platform, width: 1068, height: 832 });
    await app.waitFor('id:desktop-scheduled-task-project-daily');
    await app.keyboard.press('tab');
    await app.keyboard.press('right');
    await app.waitFor('id:desktop-scheduled-run-run-0');
    await app.keyboard.press('left');
    await app.waitFor('id:desktop-scheduled-task-project-daily');
    expect((await audit(app)).some(row => row.method === 'POST' || row.method === 'PATCH' || row.method === 'DELETE')).toBe(false);
  });
  test(`${platform} headless: catalog failure/partial results never masquerade as authoritative empty`, async () => {
    const app = await open('./desktop-schedules-fixture.tsx', { platform, width: 1068, height: 832 });
    await app.waitFor('id:desktop-scheduled-task-project-daily');
    await app.press('id:fixture-schedules-fail'); await app.waitFor('text:HTTP 503: synthetic_schedule_read_failed');
    expect(app.shows('id:desktop-scheduled-task-project-daily')).toBe(true);
    expect(app.shows('id:desktop-scheduled-empty')).toBe(false);
    await app.press('id:desktop-schedules-retry'); await app.waitUntil(() => !app.shows('text:HTTP 503: synthetic_schedule_read_failed'));
    await app.press('id:fixture-schedules-partial'); await app.wait(200);
    expect(app.shows('id:desktop-scheduled-task-project-daily')).toBe(true);
    expect(app.shows('id:desktop-scheduled-empty')).toBe(false);
    await app.press('id:fixture-schedules-empty'); await app.waitFor('id:desktop-scheduled-empty');
  });
  test(`${platform} headless: history uses opaque paging, explicit failed-page retry and recorded directory`, async () => {
    const app = await open('./desktop-schedules-fixture.tsx', { platform, width: 1068, height: 832 });
    await app.waitFor('id:desktop-scheduled-task-project-daily');
    await app.press('id:desktop-scheduled-history-project-daily');
    await app.waitFor('id:desktop-scheduled-run-run-0');
    expect(app.shows('id:desktop-scheduled-history-clear')).toBe(true);
    const beforeModal = await audit(app);
    for (let index = 0; index < 20; index++) await app.press('id:fixture-schedules-modal');
    const afterModal = await audit(app);
    expect(afterModal.filter(row => row.path.startsWith('/api/')).length).toBe(beforeModal.filter(row => row.path.startsWith('/api/')).length);
    expect(app.shows('id:desktop-scheduled-run-run-0')).toBe(true);
    await app.scroll('id:desktop-scheduled-history', 3000);
    await app.waitFor('text:HTTP 503: synthetic_history_more_failed');
    const failed = await audit(app);
    await app.wait(200);
    expect((await audit(app)).filter(row => row.path.includes('before=')).length).toBe(failed.filter(row => row.path.includes('before=')).length);
    await app.press('id:desktop-scheduled-history-retry');
    await app.waitUntil(() => !app.shows('text:HTTP 503: synthetic_history_more_failed'));
    await app.scroll('id:desktop-scheduled-history', 3000);
    await app.waitFor('id:desktop-scheduled-run-run-20');
    await app.press('id:desktop-scheduled-run-run-20');
    await app.waitFor('text:session:session-20:/workspace/recorded-worktree');
    const requests = await audit(app);
    expect(requests.filter(row => row.path.includes('before=opaque%2B%2F%3D')).length).toBe(2);
    expect(requests.filter(row => row.path.startsWith('/api/yuri/scheduled-task-runs?')).every(row => row.path.includes('taskId=daily'))).toBe(true);
    await app.press('id:desktop-scheduled-history-clear');
    await app.waitFor('id:desktop-scheduled-run-run-0');
    const global = await audit(app);
    expect(global.filter(row => row.path.startsWith('/api/yuri/scheduled-task-runs?')).at(-1)?.path.includes('taskId=')).toBe(false);
  });
}
