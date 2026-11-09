import { expect, open, test, type App } from 'nsh/test';

async function audit(app: App): Promise<Array<{ path: string; method: string; body?: { task?: Record<string, unknown> } }>> {
  const previous = app.texts().find(value => value.startsWith('audit:'));
  await app.press('id:fixture-task-audit');
  await app.waitUntil(() => app.texts().some(value => value.startsWith('audit:[') && value !== previous));
  return JSON.parse(app.texts().find(value => value.startsWith('audit:['))!.slice(6));
}
const writes = (rows: Awaited<ReturnType<typeof audit>>) => rows.filter(row => row.method !== 'GET');
for (const platform of ['macos', 'windows'] as const) {
  test(`${platform}: desktop TaskEditor is a full retained panel with native selectors and independent scroll`, async () => {
    const app = await open('./task-editor-desktop-fixture.tsx', { platform, width: 1068, height: 900 });
    await app.waitFor('id:task-editor-desktop'); await app.waitFor('text:Model · high');
    expect(app.shows('text:owners:1:0;done:0;close:0;leave:0;history:0')).toBe(true);
    expect(app.value('id:features-task-name')).toBe('Task a'); expect(app.value('id:features-task-prompt')).toBe('Existing full prompt');
    await app.press('id:task-editor-model'); await app.press('text:Other model');
    await app.press('id:task-editor-agent'); await app.press('text:plan');
    await app.press('id:features-goal');
    await app.scroll('id:task-editor-scroll', 600);
    await app.press('id:task-editor-kind'); await app.press('text:Weekly');
    await app.press('id:task-editor-weekday-2'); await app.press('id:task-editor-add-time');
    await app.press('id:features-task-save'); await app.waitFor('text:owners:1:0;done:1;close:0;leave:0;history:0');
    const request = writes(await audit(app)).at(-1)!;
    expect(request.method).toBe('PATCH');
    expect(request.body?.task).toMatchObject({ id: 'a', name: 'Task a', schedule: { kind: 'weekly', weekdays: [1, 2], times: ['09:00', '18:30'], timezone: 'UTC' }, execution: { providerID: 'provider', modelID: 'other', agent: 'plan', variant: '', goalEnabled: false, prompt: 'Existing full prompt' } });
  });
  test(`${platform}: 50 input updates/20 modal toggles/resize retain one complete dirty draft and zero catalog reads`, async () => {
    const app = await open('./task-editor-desktop-fixture.tsx', { platform, width: 1068, height: 900 });
    await app.waitFor('text:Model · high'); const before = await audit(app);
    await app.type('id:features-task-prompt', 'x'.repeat(50)); const draft = app.value('id:features-task-prompt');
    for (let i = 0; i < 20; i++) { await app.press('id:fixture-task-modal'); expect(app.value('id:features-task-prompt')).toBe(draft); }
    await app.setViewport(800, 480); await app.setViewport(1068, 900);
    expect(app.shows('text:owners:1:0;done:0;close:0;leave:0;history:0')).toBe(true);
    const after = await audit(app); expect(after.filter(row => row.path.startsWith('/api/')).length).toBe(before.filter(row => row.path.startsWith('/api/')).length);
    app.onDialog(() => 'Cancel'); await app.press('id:fixture-task-switch');
    expect(app.value('id:features-task-prompt')).toBe(draft); expect(app.value('id:features-task-name')).toBe('Task a');
    await app.press('id:fixture-task-modal'); expect(app.enabled('id:features-task-save')).toBe(false); await app.press('id:fixture-task-leave');
    await app.press('id:fixture-task-modal'); app.onDialog(() => 'Discard'); await app.press('id:fixture-task-switch');
    await app.waitFor('text:owners:2:1;done:0;close:0;leave:0;history:0'); expect(app.value('id:features-task-name')).toBe('Task b');
    expect(writes(await audit(app)).length).toBe(0);
  });
  test(`${platform}: refusal retains draft and permits retry; unsynced confirmed write never replays`, async () => {
    const app = await open('./task-editor-desktop-fixture.tsx', { platform, width: 1068, height: 900 });
    await app.waitFor('text:Model · high'); await app.type('id:features-task-name', ' revised');
    await app.press('id:fixture-task-refuse'); await app.press('id:features-task-save'); await app.waitFor('text:HTTP 409: synthetic_task_refused');
    expect(app.value('id:features-task-name')).toBe('Task a revised'); expect(app.enabled('id:features-task-save')).toBe(true);
    await app.press('id:fixture-task-unsynced'); await app.press('id:features-task-save'); await app.waitFor('id:task-editor-done');
    expect(app.shows('text:owners:1:0;done:0;close:0;leave:0;history:0')).toBe(true);
    const before = writes(await audit(app)).length;
    await app.press('id:task-editor-done'); await app.waitFor('text:owners:1:0;done:1;close:0;leave:0;history:0');
    expect(writes(await audit(app)).length).toBe(before);
  });
  test(`${platform}: native window grant retains owner under modal; cancellation and post-grant editing veto close`, async () => {
    const app = await open('./task-editor-desktop-fixture.tsx', { platform, width: 1068, height: 900 });
    await app.waitFor('text:Model · high'); await app.type('id:features-task-name', ' dirty'); const draft = app.value('id:features-task-name');
    app.onDialog(() => 'Cancel'); await app.press('id:fixture-task-window-request'); await app.waitFor('text:requested:false');
    await app.press('id:fixture-task-modal'); app.onDialog(() => 'Discard'); await app.press('id:fixture-task-window-request'); await app.waitFor('text:requested:true');
    await app.press('id:fixture-task-window-check'); await app.waitFor('text:canClose:true');
    expect(app.value('id:features-task-name')).toBe(draft); expect(app.shows('text:owners:1:0;done:0;close:0;leave:0;history:0')).toBe(true);
    // Simulate an expired/rejected native ticket by doing no destructive action.
    await app.press('id:fixture-task-modal'); await app.type('id:features-task-name', ' later edit');
    await app.press('id:fixture-task-window-check'); await app.waitFor('text:canClose:false');
    expect(app.shows('text:owners:1:0;done:0;close:0;leave:0;history:0')).toBe(true); expect(writes(await audit(app)).length).toBe(0);
  });
  test(`${platform}: unknown save locks write/departure, complete readback verifies without a second mutation`, async () => {
    const app = await open('./task-editor-desktop-fixture.tsx', { platform, width: 1068, height: 900 });
    await app.waitFor('text:Model · high'); await app.press('id:features-goal'); await app.press('id:task-editor-model'); await app.press('text:Other model'); await app.press('id:fixture-task-unknown'); await app.press('id:features-task-save'); await app.waitFor('id:task-editor-unknown');
    expect(app.enabled('id:features-task-save')).toBe(false); expect(app.enabled('id:features-task-cancel')).toBe(false);
    await app.press('id:fixture-task-leave'); expect(app.shows('text:owners:1:0;done:0;close:0;leave:0;history:0')).toBe(true);
    await app.press('id:task-editor-recover'); await app.waitFor('id:task-editor-done'); expect(app.shows('id:task-editor-unknown')).toBe(false);
    await app.press('id:task-editor-done'); await app.waitFor('text:owners:1:0;done:1;close:0;leave:0;history:0');
    expect(writes(await audit(app)).length).toBe(1);
  });
  test(`${platform}: unmatched verification remains unknown; it never offers duplicate save or false onDone`, async () => {
    const app = await open('./task-editor-desktop-fixture.tsx', { platform, width: 1068, height: 900 });
    await app.waitFor('text:Model · high'); await app.type('id:features-task-name', ' not saved'); await app.press('id:fixture-task-missing');
    await app.press('id:features-task-save'); await app.waitFor('id:task-editor-unknown'); await app.press('id:task-editor-recover');
    expect(app.shows('id:task-editor-unknown')).toBe(true); expect(app.enabled('id:features-task-save')).toBe(false);
    expect(app.shows('text:owners:1:0;done:0;close:0;leave:0;history:0')).toBe(true); expect(writes(await audit(app)).length).toBe(1);
  });
  test(`${platform}: run/toggle/history/delete use real captured actions and shared leave confirmation`, async () => {
    const app = await open('./task-editor-desktop-fixture.tsx', { platform, width: 1068, height: 900 });
    await app.waitFor('text:Model · high'); await app.press('id:task-editor-more'); await app.press('role:menuitem[Run now]'); await app.waitFor('text:Schedule started');
    await app.press('id:task-editor-toggle'); await app.waitFor('text:Paused');
    await app.press('id:task-editor-toggle'); await app.waitFor('text:Enabled');
    await app.type('id:features-task-prompt', ' dirty'); app.onDialog(() => 'Cancel');
    await app.press('id:task-editor-more'); await app.press('role:menuitem[History]'); expect(app.shows('text:owners:1:0;done:0;close:0;leave:0;history:0')).toBe(true);
    app.onDialog(() => 'Discard'); await app.press('id:task-editor-more'); await app.press('role:menuitem[History]'); await app.waitFor('text:owners:1:0;done:0;close:0;leave:0;history:1');
    app.onDialog(() => 'Cancel'); await app.press('id:task-editor-more'); await app.press('role:menuitem[Delete]'); expect(writes(await audit(app)).filter(row => row.method === 'DELETE').length).toBe(0);
    app.onDialog(() => 'Delete'); await app.press('id:task-editor-more'); await app.press('role:menuitem[Delete]'); await app.waitFor('text:owners:1:0;done:1;close:0;leave:0;history:1');
    expect(writes(await audit(app)).filter(row => row.method === 'DELETE').length).toBe(1);
  });
  test(`${platform}: create retains all fields, directory-scoped choices, full long prompt, Cron validation/preview and one-time schedule`, async () => {
    const app = await open('./task-editor-desktop-fixture.tsx', { platform, width: 1068, height: 900 });
    await app.waitFor('text:Model · high'); await app.press('id:fixture-task-new'); await app.waitFor('text:New schedule');
    await app.press('id:features-task-save'); expect(writes(await audit(app)).length).toBe(0);
    expect(app.enabled('id:task-editor-project')).toBe(true);
    await app.press('id:task-editor-project'); await app.press('text:Other project'); await app.press('id:task-editor-project'); await app.press('text:Project');
    const catalog = await audit(app); expect(catalog.some(row => row.path === '/api/config/catalog/providers?directory=%2Fworkspace%2Fother')).toBe(true);
    await app.type('id:features-task-name', 'New scheduled task'); const prompt = 'Full prompt content. '.repeat(300); await app.type('id:features-task-prompt', prompt);
    await app.scroll('id:task-editor-scroll', 1500); await app.clear('id:task-editor-timezone'); await app.type('id:task-editor-timezone', 'UTC'); await app.press('id:task-editor-kind'); await app.press('text:Cron');
    await app.clear('id:features-cron'); await app.type('id:features-cron', 'invalid cron'); await app.press('id:features-task-save');
    expect(writes(await audit(app)).length).toBe(0);
    await app.clear('id:features-cron'); await app.type('id:features-cron', '0 * * * *'); await app.waitUntil(() => app.count('id:features-cron-next-run') === 4);
    await app.press('id:task-editor-kind'); await app.press('text:One-time'); await app.waitFor('id:features-date');
    await app.press('id:features-task-save'); await app.waitFor('text:owners:2:1;done:1;close:0;leave:0;history:0');
    const call = writes(await audit(app)).at(-1)!; expect(call.method).toBe('PUT');
    expect(call.body?.task).toMatchObject({ name: 'New scheduled task', schedule: { kind: 'once', timezone: 'UTC', time: '09:00' }, execution: { prompt, providerID: 'provider', modelID: 'model', agent: 'build', variant: 'high' } });
    expect(String(call.body?.task?.id).startsWith('task_')).toBe(true);
  });
  test(`${platform}: unknown run cannot be inferred from history or replayed and never authorizes native close`, async () => {
    const app = await open('./task-editor-desktop-fixture.tsx', { platform, width: 1068, height: 900 });
    await app.waitFor('text:Model · high'); await app.press('id:fixture-task-unknown'); await app.press('id:task-editor-more'); await app.press('role:menuitem[Run now]'); await app.waitFor('id:task-editor-unknown');
    await app.press('id:task-editor-recover'); expect(app.shows('id:task-editor-unknown')).toBe(true);
    await app.press('id:fixture-task-window-request'); await app.waitFor('text:requested:false');
    const requests = await audit(app); expect(writes(requests).length).toBe(1); expect(writes(requests)[0].path.endsWith('/run')).toBe(true);
    expect(requests.some(row => row.path.includes('scheduled-task-runs'))).toBe(false);
  });
  (platform === 'macos' ? test : test.skip)(`${platform}: native Tab activation uses semantic controls; no production key shim`, async () => {
    const app = await open('./task-editor-desktop-fixture.tsx', { platform, width: 1068, height: 900 });
    await app.waitFor('text:Model · high'); await app.keyboard.press('tab'); await app.keyboard.press('enter');
    await app.waitFor('role:menuitem[Run now]'); await app.keyboard.press('escape');
    expect(writes(await audit(app)).length).toBe(0);
  });
}
