import { expect, open, test, type App } from 'nsh/test';

async function audit(app: App) {
  const before = app.texts().find(value => value.startsWith('audit:'));
  await app.press('id:parity-audit');
  await app.waitUntil(() => app.texts().some(value => value.startsWith('audit:[') && value !== before));
  return JSON.parse(app.texts().find(value => value.startsWith('audit:['))!.slice(6)) as Array<{ path: string; method: string }>;
}
for (const platform of ['macos', 'windows'] as const) {
  test(`${platform}: actual navigation consumes only exact known authority, with saved avatar and independent activity/unread`, async () => {
    const app = await open('./desktop-sidebar-parity-fixture.tsx', { platform, width: 1068, height: 1000 });
    await app.waitFor('id:desktop-session-/workspace-head');
    expect(app.shows('id:desktop-assistant-avatar')).toBe(false);
    expect(app.shows('id:desktop-assistant-unread')).toBe(false);
    const before = await audit(app);
    await app.press('id:parity-known');
    await app.waitFor('id:desktop-assistant-avatar');
    expect(app.shows('text:99+')).toBe(true);
    expect(app.shows('id:projects-indicator-sidebar-assistants-running')).toBe(true);
    expect(app.shows('id:projects-indicator-sidebar-schedules-running')).toBe(true);
    await app.rightClick('id:desktop-session-/workspace-head'); await app.waitFor('role:menuitem[Sync messages]');
    expect(app.shows('role:menuitem[Stop Desktop session]')).toBe(false);
    await app.keyboard.press('escape');
    await app.press('id:parity-idle');
    expect(app.shows('id:desktop-assistant-avatar')).toBe(true);
    expect(app.shows('id:desktop-assistant-unread')).toBe(true);
    expect(app.shows('id:projects-indicator-sidebar-assistants-running')).toBe(false);
    expect(app.shows('id:projects-indicator-sidebar-schedules-running')).toBe(false);
    await app.press('id:parity-disabled'); expect(app.shows('id:desktop-assistant-avatar')).toBe(false); expect(app.shows('id:desktop-assistant-unread')).toBe(false);
    await app.press('id:parity-stale'); expect(app.shows('id:desktop-assistant-avatar')).toBe(false); expect(app.shows('id:projects-indicator-sidebar-schedules-running')).toBe(false);
    const after = await audit(app); expect(after.filter(row => row.path.startsWith('/api/')).length).toBe(before.filter(row => row.path.startsWith('/api/')).length);
  });
  test(`${platform}: question/permission/aggregate activity/unread stay independent; hover actions do not clear unread or navigate`, async () => {
    const app = await open('./desktop-sidebar-parity-fixture.tsx', { platform, width: 1068, height: 1000 });
    await app.waitFor('id:desktop-session-/workspace-head'); await app.press('id:parity-known');
    await app.press('id:parity-question'); await app.waitFor('id:projects-indicator-head-question');
    expect(app.shows('id:desktop-permission-head')).toBe(true);
    await app.press('id:parity-permission'); await app.waitFor('id:projects-indicator-head-running');
    expect(app.shows('id:desktop-permission-head')).toBe(true);
    await app.press('id:parity-clear'); await app.press('id:parity-idle');
    const unread = 'id:desktop-session-/workspace-head >> id:projects-indicator-head-completed-unread';
    await app.waitFor(unread);
    await app.press('id:desktop-session-/workspace-head');
    await app.hover('id:desktop-session-/workspace-head');
    expect(app.shows(unread)).toBe(false);
    expect(app.shows('id:desktop-session-pin-/workspace-head')).toBe(true);
    expect(app.shows('id:desktop-session-archive-/workspace-head')).toBe(true);
    expect(app.shows('id:desktop-session-menu-/workspace-head')).toBe(false);
    const calls = await audit(app); await app.hover('id:parity-audit'); await app.waitFor(unread);
    expect(calls.some(row => row.method !== 'GET')).toBe(false);
  });
  test(`${platform}: only authoritative child hints reveal a chevron; modal/resize retain native rows and block actions`, async () => {
    const app = await open('./desktop-sidebar-parity-fixture.tsx', { platform, width: 1068, height: 1000 });
    await app.waitFor('id:desktop-session-/workspace-head'); await app.hover('id:desktop-session-/workspace-head');
    expect(app.shows('id:desktop-children-head')).toBe(false);
    await app.press('id:parity-known'); await app.hover('id:desktop-session-/workspace-head');
    expect(app.shows('id:desktop-children-head')).toBe(true);
    expect(app.shows('id:desktop-children-z')).toBe(false);
    const before = await audit(app);
    for (let index = 0; index < 50; index++) await app.press('id:parity-modal');
    await app.setViewport(800, 480); await app.setViewport(1068, 1000);
    const after = await audit(app); expect(after.filter(row => row.path.startsWith('/api/')).length).toBe(before.filter(row => row.path.startsWith('/api/')).length);
    await app.press('id:parity-modal'); expect(app.enabled('id:desktop-session-/workspace-head')).toBe(false);
    expect(app.shows('id:desktop-assistant-avatar')).toBe(true);
  });
}
