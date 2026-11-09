import { expect, open, test, type App } from 'nsh/test';

async function audit(app: App): Promise<Array<{ path: string; method: string }>> {
  const previous = app.texts().find(text => text.startsWith('audit:'));
  await app.press('id:fixture-sidebar-audit');
  await app.waitUntil(() => app.texts().some(text => text.startsWith('audit:[') && text !== previous));
  return JSON.parse(app.texts().find(text => text.startsWith('audit:['))!.slice(6));
}

async function source(app: App) {
  await app.press('id:fixture-sidebar-source');
  return app.texts().find(text => text.startsWith('source:'));
}

for (const platform of ['macos', 'windows'] as const) {
  test(`${platform} headless: Web action order, titlebar ownership and compact semantic footer`, async () => {
    const app = await open('./desktop-sidebar-chrome-fixture.tsx', { platform, width: 1068, height: 832 });
    await app.waitFor('id:desktop-session-/workspace-head');
    expect(app.shows('id:desktop-search')).toBe(false);
    expect(app.count('text:Yuri')).toBe(1);
    const texts = app.texts();
    expect(texts.indexOf('New chat') < texts.indexOf('Schedule')).toBe(true);
    expect(texts.indexOf('Schedule') < texts.indexOf('Bots')).toBe(true);
    expect(app.count('id:desktop-sidebar-footer >> role:button')).toBe(3);
    expect(app.count('id:desktop-sidebar-footer >> text:Settings')).toBe(0);
    await app.press('id:fixture-titlebar-search'); await app.waitFor('text:search');
    await app.press('id:fixture-titlebar-switcher'); await app.waitFor('text:switcher');
    await app.press('id:desktop-new-session'); await app.waitFor('text:draft');
    await app.press('id:desktop-schedules'); await app.waitFor('text:schedules');
    await app.press('id:desktop-assistants'); await app.waitFor('text:assistants');
    expect(app.shows('id:projects-indicator-head-idle')).toBe(false);
    expect(app.shows('id:projects-indicator-running-running')).toBe(true);
    await app.press('id:desktop-sidebar-top-section');
    expect(app.shows('id:desktop-session-pinned-pin')).toBe(false);
    expect(app.shows('id:desktop-session-running-running')).toBe(false);
    expect(app.shows('id:desktop-session-/workspace-head')).toBe(true);
    await app.press('id:desktop-sidebar-top-section');
    expect(app.shows('id:desktop-session-pinned-pin')).toBe(true);
    expect(app.shows('id:desktop-session-running-running')).toBe(true);
    await app.press('id:desktop-settings'); await app.waitFor('text:settings');
    await app.press('id:desktop-connections'); await app.waitFor('text:connections');
    expect(app.enabled('id:desktop-shortcuts')).toBe(false);
    await app.press('id:fixture-help-owner');
    expect(app.enabled('id:desktop-shortcuts')).toBe(true);
    await app.press('id:desktop-shortcuts'); await app.waitFor('text:help-dialog');
    await app.press('id:desktop-sidebar-projects-menu');
    await app.press('role:menuitem[Collapse all]'); expect(app.shows('id:desktop-session-/workspace-head')).toBe(false);
    await app.press('id:desktop-sidebar-projects-menu'); await app.press('role:menuitem[Expand all]'); await app.waitFor('id:desktop-session-/workspace-head');
  });

  test(`${platform} headless: short viewport preserves footer; hidden/inactive sidebars expose no actions`, async () => {
    const app = await open('./desktop-sidebar-chrome-fixture.tsx', { platform, width: 800, height: 480 });
    await app.waitFor('id:desktop-session-/workspace-head');
    await app.press('id:desktop-settings'); await app.waitFor('text:settings');
    await app.scroll('id:desktop-sidebar-scroll', 500);
    await app.press('id:desktop-connections'); await app.waitFor('text:connections');
    await app.press('id:fixture-sidebar-visible');
    expect(app.shows('id:desktop-new-session')).toBe(false);
    expect(app.shows('id:desktop-sidebar-footer')).toBe(false);
    await app.press('id:fixture-sidebar-visible');
    await app.press('id:fixture-sidebar-active');
    expect(app.shows('id:desktop-new-session')).toBe(false);
    expect(app.shows('id:desktop-sidebar-footer')).toBe(false);
  });

  test(`${platform} headless: modal admission preserves rename/folds/source without catalog fanout`, async () => {
    const app = await open('./desktop-sidebar-chrome-fixture.tsx', { platform, width: 1068, height: 1000 });
    await app.waitFor('id:desktop-session-/workspace-head');
    await app.waitFor('text:owner:true:1');
    await app.press('id:desktop-sidebar-top-section');
    await app.press('label:Expand feature/desktop');
    await app.waitFor('id:desktop-session-/tree-tree');
    await app.rightClick('id:desktop-session-/workspace-head');
    await app.press('role:menuitem[Rename]');
    await app.clear('id:desktop-session-rename');
    const before = await audit(app);
    await app.type('id:desktop-session-rename', 'x'.repeat(50));
    const draft = app.value('id:desktop-session-rename');
    const retained = await source(app);
    expect(retained?.includes('"ready":true')).toBe(true);
    for (let i = 0; i < 20; i++) {
      await app.press('id:fixture-sidebar-interactive');
      expect(app.shows('text:owner:true:1')).toBe(true);
      expect(app.count('id:desktop-session-rename')).toBe(1);
      expect(app.shows('id:desktop-session-/workspace-head')).toBe(false);
      expect(app.shows('id:desktop-session-/tree-tree')).toBe(true);
      expect(app.shows('id:desktop-session-pinned-pin')).toBe(false);
      expect(app.value('id:desktop-session-rename')).toBe(draft);
      expect(await source(app)).toBe(retained);
    }
    const after = await audit(app);
    expect(after.filter(row => row.path.startsWith('/api/')).length).toBe(before.filter(row => row.path.startsWith('/api/')).length);
    expect(after.some(row => row.method === 'POST' || row.method === 'PUT' || row.method === 'DELETE')).toBe(false);
    await app.type('id:desktop-session-rename', ' restored');
    expect(app.value('id:desktop-session-rename')).toBe(draft + ' restored');
    await app.press('id:fixture-sidebar-active');
    expect(app.shows('id:desktop-session-rename')).toBe(false);
    expect(app.shows('text:owner:false:2')).toBe(true);
    await app.press('id:fixture-sidebar-active');
    await app.waitFor('text:owner:true:3');
    expect(app.shows('id:desktop-session-rename')).toBe(false);
  });

  test(`${platform} headless: blocked controls/menu/drag/navigation cannot mutate; source stays readable`, async () => {
    const app = await open('./desktop-sidebar-chrome-fixture.tsx', { platform, width: 1068, height: 1000 });
    await app.waitFor('id:desktop-session-/workspace-head');
    const retained = await source(app);
    await app.rightClick('id:desktop-session-/workspace-head');
    await app.waitFor('role:menuitem[Pin]');
    await app.hover('id:desktop-session-/workspace-head');
    await app.press('id:fixture-sidebar-interactive');
    expect(app.shows('role:menuitem[Pin]')).toBe(false);
    expect(await source(app)).toBe(retained);
    for (const id of ['desktop-new-session', 'desktop-schedules', 'desktop-assistants', 'desktop-settings', 'desktop-connections', 'desktop-sidebar-projects-menu', 'desktop-children-head']) {
      expect(app.enabled(`id:${id}`)).toBe(false);
      // The headless driver can resolve a press disabled by an ancestor;
      // admission must still reject it at the actual handler boundary.
      await app.press(`id:${id}`).catch(error => expect(error).toMatchObject({ code: 'ERR_NSH_TEST_DISABLED' }));
    }
    expect(app.shows('text:draft')).toBe(false);
    expect(app.shows('text:schedules')).toBe(false);
    expect(app.shows('text:assistants')).toBe(false);
    expect(app.shows('text:settings')).toBe(false);
    expect(app.shows('text:connections')).toBe(false);
    await app.rightClick('id:desktop-session-/workspace-head');
    expect(app.shows('role:menuitem[Pin]')).toBe(false);
    await app.drag('id:desktop-drag-session-z', { x: 0, y: 30 });
    await app.press('id:fixture-sidebar-numbered'); await app.waitFor('text:numbered:false');
    const requests = await audit(app);
    expect(requests.some(row => row.method === 'POST' || row.method === 'PUT' || row.method === 'DELETE')).toBe(false);
    expect(app.shows('text:owner:true:1')).toBe(true);
    await app.press('id:fixture-sidebar-interactive');
    await app.press('id:desktop-schedules'); await app.waitFor('text:schedules');
    await app.dragAndHold('id:desktop-drag-session-z', { x: 0, y: 30 });
    await app.press('id:fixture-sidebar-interactive'); await app.drop();
    expect((await audit(app)).some(row => row.method === 'POST' || row.method === 'PUT' || row.method === 'DELETE')).toBe(false);
    await app.press('id:fixture-sidebar-interactive');
    await app.rightClick('id:desktop-session-/workspace-head'); await app.waitFor('role:menuitem[Pin]');
  });
}
