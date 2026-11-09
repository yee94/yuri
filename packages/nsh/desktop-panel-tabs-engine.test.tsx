import { test, open, expect } from 'nsh/test';
const ids = ['a.ts', 'b.ts', 'c.ts', 'd.ts'].map(path => JSON.stringify(['file', '/workspace/' + path]));
const tab = (id: string) => 'id:desktop-panel-tab-' + id;
const state = (app: Awaited<ReturnType<typeof open>>) => JSON.parse(app.texts().find(text => text.startsWith('tabs-state:'))!.slice(11));

test('strip native pan reorders measured rows; close preserves selected background and exact file editor owner', async () => {
  const app = await open('./desktop-panel-tabs-fixture.tsx', { platform: 'macos', width: 1000, height: 700 });
  await app.waitFor('text:tabs-ready:true');
  // Native measured rows include the restored file icon and the close button.
  await app.drag(tab(ids[0]), { x: 168, y: 0 });
  await app.waitUntil(() => state(app).ids[2] === ids[0]);
  expect(state(app).ids).toEqual([ids[1], ids[2], ids[0], ids[3]]);
  await app.press('id:desktop-panel-close-' + ids[2]);
  await app.waitUntil(() => state(app).ids.length === 3); expect(state(app).selected).toBe(ids[3]);
});

test('right-click close all sequentially uses actual dirty guard: Cancel B, discard C, preserve B and completed closes', async () => {
  const app = await open('./desktop-panel-tabs-fixture.tsx', { platform: 'macos', width: 1000, height: 700 });
  await app.waitFor('text:tabs-ready:true'); await app.press('id:tabs-fixture-dirty-b'); await app.press('id:tabs-fixture-dirty-c');
  await app.press('id:tabs-fixture-menu');
  expect(state(app).dirtyB).toBe(true); expect(state(app).dirtyC).toBe(true);
  let dialogs = 0; app.onDialog(() => ++dialogs === 1 ? 'Cancel' : 'Discard');
  await app.rightClick(tab(ids[0])); await app.press('role:menuitem[Close All]');
  await app.waitUntil(() => state(app).ids.length === 1);
  expect(state(app).ids).toEqual([ids[1]]); expect(state(app).dirtyB).toBe(true); expect(state(app).dirtyC).toBe(false); expect(dialogs).toBe(2);
});

test('right/others follow exact current order without closing the context anchor', async () => {
  const app = await open('./desktop-panel-tabs-fixture.tsx', { platform: 'macos', width: 1000, height: 700 });
  await app.waitFor('text:tabs-ready:true'); await app.press('id:tabs-fixture-menu'); await app.rightClick(tab(ids[1])); await app.press('role:menuitem[Close Right]');
  await app.waitUntil(() => state(app).ids.length === 2); expect(state(app).ids).toEqual(ids.slice(0, 2));
  await app.rightClick(tab(ids[1])); await app.press('role:menuitem[Close Others]');
  await app.waitUntil(() => state(app).ids.length === 1); expect(state(app).ids).toEqual([ids[1]]);
});

test('hide/expand, stable auth/session/directory isolation, same-identity lease renew preserves dirty file', async () => {
  const app = await open('./desktop-panel-tabs-fixture.tsx', { platform: 'macos', width: 1000, height: 700 });
  await app.waitFor('text:tabs-ready:true'); await app.press('id:tabs-fixture-dirty-b');
  await app.press('id:desktop-panel-toggle-expanded'); expect(state(app).expanded).toBe(true);
  await app.press('id:desktop-panel-close-panel'); expect(app.shows('id:desktop-panel-tabs')).toBe(false); expect(state(app).ids).toEqual(ids);
  await app.press('id:tabs-fixture-show'); await app.waitFor(tab(ids[0]));
  await app.press('id:tabs-fixture-renew'); expect(state(app).ids).toEqual(ids); expect(state(app).dirtyB).toBe(true);
  for (const dimension of ['host', 'auth', 'session', 'directory']) {
    await app.press('id:tabs-fixture-' + dimension); expect(state(app).ids).toEqual([]);
    await app.press('id:tabs-fixture-' + dimension); expect(state(app).ids).toEqual(ids); expect(state(app).dirtyB).toBe(true);
  }
});

test('public Storage persists order and selection, restart restores metadata only', async () => {
  const app = await open('./desktop-panel-tabs-fixture.tsx', { platform: 'macos', width: 1000, height: 700 });
  await app.waitFor('text:tabs-ready:true'); await app.press(tab(ids[1]));
  await app.waitUntil(() => !JSON.parse(app.texts().find(text => text.startsWith('tabs-metadata:'))!.slice(14)).pending);
  const next = await open('./desktop-panel-tabs-fixture.tsx', { platform: 'macos', width: 1000, height: 700, storage: app.storage() });
  await next.waitFor('text:tabs-ready:true'); expect(state(next).ids).toEqual(ids); expect(state(next).selected).toBe(ids[1]); expect(state(next).dirtyB).toBe(false);
});

test('focused strip keyboard navigates/reorders/reveals narrow tabs; inactive strip releases bindings', async () => {
  const app = await open('./desktop-panel-tabs-fixture.tsx', { platform: 'macos', width: 1000, height: 700 });
  await app.waitFor('text:tabs-ready:true'); await app.press(tab(ids[0]));
  await app.keyboard.press('right'); expect(state(app).selected).toBe(ids[1]);
  await app.keyboard.press('end'); expect(state(app).selected).toBe(ids[3]);
  await app.keyboard.press('alt+shift+left'); expect(state(app).ids[2]).toBe(ids[3]);
  await app.press('id:tabs-fixture-narrow');
  await app.press('id:tabs-fixture-active');
  const selected = state(app).selected; await app.keyboard.press('home'); expect(state(app).selected).toBe(selected);
  await app.press('id:tabs-fixture-active'); await app.press('id:tabs-fixture-wide'); await app.press(tab(ids[0])); await app.keyboard.press('mod+w');
  await app.waitUntil(() => state(app).ids.length === 3);
});

test('412-point panel keeps the 48-point single-row header with a scrolling 24-point tablist', async () => {
  const app = await open('./desktop-panel-tabs-fixture.tsx', { platform: 'macos', width: 1068, height: 832 });
  await app.waitFor('text:tabs-ready:true'); await app.press('id:tabs-fixture-panel-width');
  await app.waitUntil(() => JSON.parse(app.texts().find(text => text.startsWith('tabs-layout:'))!.slice(12)).width === 412);
  expect(JSON.parse(app.texts().find(text => text.startsWith('tabs-layout:'))!.slice(12)).height).toBe(48);
  await app.press(tab(ids[0])); await app.keyboard.press('end'); expect(state(app).selected).toBe(ids[3]);
  await app.press('id:desktop-panel-close-' + ids[3]); await app.waitUntil(() => state(app).ids.length === 3);
  expect(state(app).ids).toEqual(ids.slice(0, 3));
  await app.scroll('id:desktop-panel-tabs', -200); await app.press(tab(ids[0])); expect(state(app).selected).toBe(ids[0]);
});

test('production reactive metadata binding preserves prior Storage on failure, retains live selected tab and explicit retry saves it', async () => {
  const app = await open('./desktop-panel-tabs-fixture.tsx', { platform: 'macos', width: 1000, height: 700 });
  await app.waitFor('text:tabs-ready:true');
  await app.waitUntil(() => app.storage()['desktop.panel-tabs.v1'] !== undefined);
  const prior = app.storage()['desktop.panel-tabs.v1'];
  await app.press('id:tabs-fixture-fail-write'); await app.press(tab(ids[1]));
  await app.waitFor('id:desktop-panel-tabs-metadata-error');
  expect(app.storage()['desktop.panel-tabs.v1']).toBe(prior); expect(state(app).selected).toBe(ids[1]);
  await app.press('id:tabs-fixture-active'); expect(app.enabled('id:desktop-panel-tabs-metadata-retry')).toBe(false);
  await app.press('id:tabs-fixture-active'); await app.press('id:desktop-panel-tabs-metadata-retry');
  await app.waitUntil(() => !app.shows('id:desktop-panel-tabs-metadata-error'));
  expect(JSON.parse(app.storage()['desktop.panel-tabs.v1']).scopes[0].selectedID).toBe(ids[1]);
});

test('corrupt metadata is not adopted as empty success or overwritten by later seed actions; explicit read retry merges current live state', async () => {
  const app = await open('./desktop-panel-tabs-fixture.tsx', { platform: 'macos', width: 1000, height: 700, storage: { 'desktop.panel-tabs.v1': '{synthetic-corrupt' } });
  await app.waitFor('text:tabs-ready:true'); await app.waitFor('id:desktop-panel-tabs-metadata-error');
  expect(app.storage()['desktop.panel-tabs.v1']).toBe('{synthetic-corrupt'); expect(state(app).ids).toEqual(ids);
  await app.press(tab(ids[1])); await app.press('id:tabs-fixture-repair-metadata'); await app.press('id:desktop-panel-tabs-metadata-retry');
  await app.waitUntil(() => !app.shows('id:desktop-panel-tabs-metadata-error'));
  expect(state(app).selected).toBe(ids[1]); expect(state(app).ids).toEqual(ids);
  expect(JSON.parse(app.storage()['desktop.panel-tabs.v1']).scopes[0].selectedID).toBe(ids[1]);
});

test('background while a native gesture is held cancels it without changing order or losing dirty state', async () => {
  const app = await open('./desktop-panel-tabs-fixture.tsx', { platform: 'macos', width: 1000, height: 700 });
  await app.waitFor('text:tabs-ready:true'); await app.press('id:tabs-fixture-dirty-b');
  await app.dragAndHold(tab(ids[0]), { x: 168, y: 0 }); await app.setLifecycle('background'); await app.drop(); await app.setLifecycle('active');
  expect(state(app).ids).toEqual(ids); expect(state(app).dirtyB).toBe(true);
});

test('parity default has no close menu; explicit labels enable it and removing them keeps tab focus and native pan usable', async () => {
  const app = await open('./desktop-panel-tabs-fixture.tsx', { platform: 'macos', width: 1000, height: 700 });
  await app.waitFor('text:tabs-ready:true'); await app.rightClick(tab(ids[0]));
  expect(app.shows('role:menuitem[Close All]')).toBe(false); expect(state(app).modal).toBe(false);
  await app.press('id:tabs-fixture-menu'); await app.rightClick(tab(ids[0]));
  expect(app.shows('role:menuitem[Close All]')).toBe(true); expect(state(app).modal).toBe(true);
  await app.keyboard.press('escape'); await app.press('id:tabs-fixture-menu');
  await app.rightClick(tab(ids[0])); expect(app.shows('role:menuitem[Close All]')).toBe(false); expect(state(app).modal).toBe(false);
  expect(app.count(tab(ids[0]))).toBe(1);
  await app.press(tab(ids[0])); await app.keyboard.press('right'); expect(state(app).selected).toBe(ids[1]);
  await app.drag(tab(ids[0]), { x: 168, y: 0 });
  await app.waitUntil(() => state(app).ids[2] === ids[0]);
});

for (const platform of ['macos', 'windows'] as const) test(platform + ' root closes through the same real dirty guard; macOS focused strip excludes owned strokes', async () => {
  const app = await open('./desktop-panel-tabs-fixture.tsx', { platform, width: 1000, height: 700 });
  await app.waitFor('text:tabs-ready:true');
  if (platform === 'macos') {
    await app.press(tab(ids[1])); await app.keyboard.press('home'); expect(state(app).selected).toBe(ids[0]);
  }
  await app.press('id:tabs-fixture-dirty-b'); await app.press('id:tabs-fixture-menu-owned');
  await app.press(tab(ids[1]));
  await app.keyboard.press(platform === 'macos' ? 'cmd+w' : 'ctrl+w');
  await app.keyboard.press('right'); await app.keyboard.press('alt+shift+left');
  expect(state(app).ids).toEqual(ids); expect(state(app).selected).toBe(ids[1]); expect(app.dialogs()).toHaveLength(0);
  if (platform === 'macos') { await app.keyboard.press('home'); expect(state(app).selected).toBe(ids[0]); }
  await app.press(tab(ids[1]));
  let dialogs = 0; app.onDialog(() => ++dialogs === 1 ? 'Cancel' : 'Discard');
  await app.press('id:tabs-fixture-root-close'); expect(state(app).ids).toEqual(ids); expect(state(app).dirtyB).toBe(true);
  await app.press('id:tabs-fixture-root-close'); await app.waitUntil(() => state(app).ids.length === 3);
  expect(state(app).ids).toEqual([ids[0], ids[2], ids[3]]); expect(dialogs).toBe(2);
  if (platform === 'macos') {
    await app.press('id:tabs-fixture-menu-owned'); await app.press(tab(ids[0])); await app.keyboard.press('mod+w');
    await app.waitUntil(() => state(app).ids.length === 2);
  }
});

test('stable dirty testID exposes the existing unsaved AX label and staged source keeps its localized hint', async () => {
  const app = await open('./desktop-panel-tabs-fixture.tsx', { platform: 'macos', width: 1000, height: 700 });
  await app.waitFor('text:tabs-ready:true'); await app.press('id:tabs-fixture-dirty-b');
  expect(app.count('id:desktop-tab-dirty-' + ids[1])).toBe(1);
  expect(app.shows('id:desktop-panel-tabs >> label:Unsaved changes')).toBe(true);
  expect(app.shows('id:desktop-tab-dirty-' + ids[0])).toBe(false);
  await app.press('id:tabs-fixture-presentations'); expect(app.shows('id:desktop-panel-tabs >> text:Staged')).toBe(true);
  expect(state(app).ids).toHaveLength(8);
});

test('synthetic native receipt passes production event admission then the actual editor dirty guard; not a physical middle-click test', async () => {
  const app = await open('./desktop-panel-tabs-fixture.tsx', { platform: 'macos', width: 1000, height: 700 });
  await app.waitFor('text:tabs-ready:true'); await app.press('id:tabs-fixture-dirty-b');
  const event = { owner: 'synthetic-delivery', generation: 1, revision: 1, expectedHost: { hostID: 'synthetic', lease: 'lease-a' }, sequence: 1 };
  let dialogs = 0; app.onDialog(() => ++dialogs === 1 ? 'Cancel' : 'Discard');
  await app.host.send('synthetic.tab.middleClose', event);
  expect(state(app).dirtyB).toBe(true); expect(state(app).ids).toEqual(ids); expect(dialogs).toBe(1);
  await app.host.send('synthetic.tab.middleClose', event); expect(dialogs).toBe(1);
  await app.host.send('synthetic.tab.middleClose', { ...event, sequence: 2 });
  await app.waitUntil(() => state(app).ids.length === 3);
  expect(state(app).ids).toEqual([ids[0], ids[2], ids[3]]); expect(dialogs).toBe(2); expect(state(app).dirtyB).toBe(false);
});

test('readOnly chat strip uses the explicit target title and navigation updates do not produce a second tab', async () => {
  const app = await open('./desktop-panel-tabs-fixture.tsx', { platform: 'macos', width: 1000, height: 700 });
  await app.waitFor('text:tabs-ready:true'); await app.press('id:tabs-fixture-chat');
  const selected = state(app).selected;
  expect(app.shows('id:desktop-panel-tabs >> text:Synthetic session')).toBe(true); expect(state(app).ids).toHaveLength(5);
  await app.press('id:tabs-fixture-chat-refresh');
  expect(app.shows('id:desktop-panel-tabs >> text:Updated session')).toBe(true); expect(state(app).ids).toHaveLength(5); expect(state(app).selected).toBe(selected);
});
