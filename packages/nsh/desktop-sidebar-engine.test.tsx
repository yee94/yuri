import { expect, open, test } from 'nsh/test';
import type { App } from 'nsh/test';

async function audit(app: App): Promise<Array<{ path: string; method: string; body?: { scopeKey?: string; order?: string[]; orderedPaths?: string[]; expectedRevision?: number; foldersMap?: Record<string, Array<{ id: string; name: string; parentId?: string | null }>> } }>> {
  const previous = app.texts().find(text => text.includes('"/fixture/audit"'));
  await app.press('id:desktop-fixture-audit');
  await app.waitUntil(() => app.texts().some(text => text.includes('"/fixture/audit"') && text !== previous));
  return JSON.parse(app.texts().find(text => text.includes('"/fixture/audit"'))!);
}

test('desktop: persistent navigation, compact directory/worktree fold and explicit paging', async () => {
  const app = await open('./desktop-sidebar-fixture.tsx', { platform: 'macos', width: 900, height: 900 });
  await app.waitFor('text:Desktop session');
  expect(app.count('role:tab')).toBe(0);
  expect(app.shows('id:desktop-session-/workspace-old')).toBe(false);
  expect(app.shows('id:desktop-session-/workspace-running')).toBe(true);
  await app.press('id:desktop-session-/workspace-head');
  await app.waitFor('text:chat:head');
  expect(app.shows('id:desktop-search')).toBe(false);
  await app.press('id:desktop-fixture-search');
  await app.waitFor('text:search');
  expect(app.shows('id:desktop-session-/workspace-head')).toBe(true);
  await app.press('id:desktop-new-session');
  await app.waitFor('text:draft:global');
  await app.press('id:desktop-more-/workspace');
  await app.waitFor('id:desktop-session-/workspace-older');
  await app.press('label:Expand feature/desktop');
  await app.waitFor('id:desktop-session-/tree-tree');
  await app.press('id:desktop-settings');
  await app.waitFor('text:settings');
  await app.press('id:desktop-connections');
  await app.waitFor('text:connections');
  await app.press('id:desktop-fixture-audit');
  await app.waitUntil(() => app.texts().some(text => text.includes('"/fixture/audit"')));
  const audit = app.texts().find(text => text.includes('"/fixture/audit"')) ?? '';
  expect(audit).not.toBe('');
  expect(audit).not.toContain('"method":"POST"');
});

test('desktop: right-click and hover pin use native controls; failures preserve row and rename draft', async () => {
  const app = await open('./desktop-sidebar-fixture.tsx', { platform: 'macos', width: 900, height: 900 });
  await app.waitFor('id:desktop-session-/workspace-head');
  await app.rightClick('id:desktop-session-/workspace-head');
  await app.waitFor('role:menuitem[Pin]');
  await app.press('role:menuitem[Pin]');
  await app.waitFor('text:HTTP 503: Synthetic pin retry');
  expect(app.shows('id:desktop-session-/workspace-head')).toBe(true);
  await app.hover('id:desktop-session-/workspace-head');
  await app.press('id:desktop-session-pin-/workspace-head');
  await app.waitFor('id:desktop-session-pinned-head');
  expect(app.shows('id:desktop-session-/workspace-head')).toBe(true);
  await app.rightClick('id:desktop-session-pinned-head');
  await app.press('role:menuitem[Rename]');
  await app.waitFor('id:desktop-session-rename');
  await app.type('id:desktop-session-rename', 'Retained desktop name');
  const draft = app.value('id:desktop-session-rename');
  await app.press('label:Save session name');
  await app.waitFor('text:HTTP 503: Synthetic rename retry');
  expect(app.value('id:desktop-session-rename')).toBe(draft);
  await app.press('label:Save session name');
  await app.waitUntil(() => !app.shows('id:desktop-session-rename'));
  await app.waitFor('text:' + draft);
});

test('desktop: deactivation disposes menus/requests and Host changes fence old native actions', async () => {
  const app = await open('./desktop-sidebar-fixture.tsx', { platform: 'macos', width: 900, height: 900 });
  await app.waitFor('id:desktop-session-/workspace-head');
  await app.press('label:Collapse Desktop workspace');
  expect(app.shows('id:desktop-session-/workspace-head')).toBe(false);
  await app.press('id:desktop-fixture-active');
  expect(app.shows('id:desktop-new-session')).toBe(false);
  await app.press('id:desktop-fixture-active');
  await app.waitFor('label:Expand Desktop workspace');
  expect(app.shows('id:desktop-session-/workspace-head')).toBe(false);
  await app.press('label:Expand Desktop workspace');
  await app.waitFor('id:desktop-session-/workspace-head');
  await app.rightClick('id:desktop-session-/workspace-head');
  await app.waitFor('role:menuitem[Pin]');
  await app.press('id:desktop-fixture-host');
  await app.waitFor('text:Other Host');
  expect(app.shows('role:menuitem[Pin]')).toBe(false);
});

test('desktop: archive and undo delegate the controller subtree protocol', async () => {
  const app = await open('./desktop-sidebar-fixture.tsx', { platform: 'macos', width: 900, height: 900 });
  await app.waitFor('id:desktop-session-/workspace-head');
  app.onDialog(dialog => dialog.buttons.includes('Archive') ? 'Archive' : null);
  await app.rightClick('id:desktop-session-/workspace-head');
  await app.press('role:menuitem[Archive]');
  await app.waitFor('text:Undo');
  expect(app.shows('id:desktop-session-/workspace-head')).toBe(false);
  await app.press('text:Undo');
  await app.waitFor('id:desktop-session-/workspace-head');
});

test('desktop: failed authority retains rows until an explicit read retry', async () => {
  const app = await open('./desktop-sidebar-fixture.tsx', { platform: 'macos', width: 900, height: 900 });
  await app.waitFor('id:desktop-session-/workspace-head');
  await app.press('id:desktop-fixture-read-failure');
  await app.waitFor('text:read-failure-armed');
  await app.waitFor('text:HTTP 503: Synthetic catalog retry');
  expect(app.shows('id:desktop-session-/workspace-head')).toBe(true);
  await app.wait(300);
  expect(app.shows('text:HTTP 503: Synthetic catalog retry')).toBe(true);
  await app.press('id:desktop-sidebar-retry');
  await app.waitUntil(() => !app.shows('text:HTTP 503: Synthetic catalog retry'));
  expect(app.shows('id:desktop-session-/workspace-head')).toBe(true);
});

test('desktop: token traffic and disabled/background lifetime do not read catalogs', async () => {
  const app = await open('./desktop-sidebar-fixture.tsx', { platform: 'macos', width: 900, height: 900 });
  await app.waitFor('id:desktop-session-/workspace-head');
  const catalogs = (rows: Array<{ path: string }>) => rows.filter(row => row.path.startsWith('/api/')).length;
  const initial = catalogs(await audit(app));
  await app.press('id:desktop-fixture-burst');
  await app.waitFor('text:burst-delivered');
  expect(catalogs(await audit(app))).toBe(initial);
  await app.press('id:desktop-fixture-active');
  await app.press('id:desktop-fixture-burst');
  await app.wait(200);
  expect(catalogs(await audit(app))).toBe(initial);
  await app.press('id:desktop-fixture-active');
  await app.waitFor('id:desktop-session-/workspace-head');
  const resumed = catalogs(await audit(app));
  await app.rightClick('id:desktop-session-/workspace-head');
  await app.waitFor('role:menuitem[Pin]');
  await app.setLifecycle('background');
  expect(app.shows('role:menuitem[Pin]')).toBe(false);
  await app.press('id:desktop-fixture-burst');
  await app.wait(200);
  expect(catalogs(await audit(app))).toBe(resumed);
  await app.setLifecycle('active');
  await app.waitFor('id:desktop-session-/workspace-head');
});

test('desktop: shell actions consume logical rank/folds, cycle and release on background/unmount', async () => {
  const app = await open('./desktop-sidebar-fixture.tsx', { platform: 'macos', width: 900, height: 1100 });
  await app.waitFor('id:desktop-session-/workspace-head');
  await app.press('id:desktop-fixture-number-one'); await app.waitFor('text:chat:pin');
  await app.press('id:desktop-fixture-next'); await app.waitFor('text:chat:pin-two');
  await app.press('id:desktop-fixture-next'); await app.waitFor('text:chat:running');
  await app.press('id:desktop-fixture-next'); await app.waitFor('text:chat:head');
  await app.press('label:Collapse Desktop workspace');
  await app.press('id:desktop-fixture-targets');
  await app.waitFor('text:targets:[["pinned","pin"],["pinned","pin-two"],["running","running"]]');
  await app.press('id:desktop-fixture-previous'); await app.waitFor('text:chat:running');
  await app.setLifecycle('background');
  await app.press('id:desktop-fixture-targets'); await app.waitFor('text:targets:[]');
  await app.setLifecycle('active'); await app.press('id:desktop-fixture-active');
  await app.press('id:desktop-fixture-targets'); await app.waitFor('text:targets:[]');
});

test('desktop: native-pan session drag persists directory rank, preserves hidden IDs and survives remount', async () => {
  const app = await open('./desktop-sidebar-fixture.tsx', { platform: 'macos', width: 900, height: 1100 });
  await app.waitFor('id:desktop-drag-session-z');
  await app.drag('id:desktop-drag-session-z', { x: 0, y: 30 });
  let writes = (await audit(app)).filter(row => row.path === '/api/session-folders/order' && row.method === 'POST');
  expect(writes.length).toBe(1);
  expect(writes[0]?.body?.order?.slice(0, 3)).toEqual(['head', 'a', 'z']);
  expect(writes[0]?.body?.order).toContain('hidden-rank');
  await app.press('id:desktop-fixture-active'); await app.press('id:desktop-fixture-active');
  await app.waitFor('id:desktop-session-/workspace-z');
  const texts = app.texts(); expect(texts.indexOf('a') < texts.indexOf('z')).toBe(true);
  await app.drag('id:desktop-drag-session-pinned-pin', { x: 0, y: 30 });
  writes = (await audit(app)).filter(row => row.path === '/api/session-folders/order' && row.method === 'POST');
  expect(writes.length).toBe(2); expect(writes[1]?.body?.scopeKey).toBe('__pinned__');
  expect(writes[1]?.body?.order).toEqual(['pin-two', 'pin']);
});

test('desktop: failed drag keeps prior; lost ACK retry reads authority without a second move', async () => {
  const app = await open('./desktop-sidebar-fixture.tsx', { platform: 'macos', width: 900, height: 1100 });
  await app.waitFor('id:desktop-drag-session-z');
  await app.press('id:desktop-fixture-order-fail'); await app.waitFor('text:order-fail');
  await app.drag('id:desktop-drag-session-z', { x: 0, y: 30 }); await app.waitFor('id:desktop-order-retry');
  expect(app.texts().indexOf('z') < app.texts().indexOf('a')).toBe(true);
  await app.press('id:desktop-order-retry'); await app.waitUntil(() => !app.shows('id:desktop-order-retry'));
  await app.press('id:desktop-fixture-order-lost-ack'); await app.waitFor('text:order-lost-ack');
  await app.drag('id:desktop-drag-session-a', { x: 0, y: 30 }); await app.waitFor('id:desktop-order-retry');
  const count = (rows: Awaited<ReturnType<typeof audit>>) => rows.filter(row => row.path === '/api/session-folders/order' && row.method === 'POST').length;
  const before = count(await audit(app));
  await app.press('id:desktop-order-retry'); await app.waitUntil(() => !app.shows('id:desktop-order-retry'));
  expect(count(await audit(app))).toBe(before);
});

test('desktop: worktree drag uses Host revision PUT/readback and unknown ACK reconciliation', async () => {
  const app = await open('./desktop-sidebar-fixture.tsx', { platform: 'macos', width: 900, height: 1100 });
  await app.waitFor('id:desktop-drag-worktree-/tree');
  await app.press('id:desktop-fixture-tree-lost-ack'); await app.waitFor('text:tree-lost-ack');
  await app.drag('id:desktop-drag-worktree-/tree', { x: 0, y: 30 }); await app.waitFor('id:desktop-order-retry');
  const writes = (await audit(app)).filter(row => row.path === '/api/yuri/message-queue/worktrees/order' && row.method === 'PUT');
  expect(writes.length).toBe(1); expect(writes[0]?.body?.expectedRevision).toBe(1);
  expect(writes[0]?.body?.orderedPaths).toEqual(['/tree-two', '/tree', '/hidden-tree']);
  await app.press('id:desktop-order-retry'); await app.waitUntil(() => !app.shows('id:desktop-order-retry'));
  expect((await audit(app)).filter(row => row.method === 'PUT').length).toBe(1);
});

test('desktop: background and changed geometry retire a held drag without writing', async () => {
  const app = await open('./desktop-sidebar-fixture.tsx', { platform: 'macos', width: 900, height: 1100 });
  await app.waitFor('id:desktop-drag-session-z');
  await app.dragAndHold('id:desktop-drag-session-z', { x: 0, y: 30 });
  await app.setLifecycle('background'); await app.drop(); await app.setLifecycle('active');
  await app.waitFor('id:desktop-drag-session-z');
  expect((await audit(app)).some(row => row.method === 'POST')).toBe(false);
  await app.dragAndHold('id:desktop-drag-session-z', { x: 0, y: 30 });
  await app.setViewport(900, 1000); await app.drop();
  expect((await audit(app)).some(row => row.method === 'POST')).toBe(false);
});

test('desktop: delete needs confirmation, supports lossless Undo and retains failed commit for explicit retry', async () => {
  const app = await open('./desktop-sidebar-fixture.tsx', { platform: 'macos', width: 900, height: 1100, clock: {} });
  await app.waitFor('id:desktop-session-/workspace-head');
  async function quickDelete() {
    await app.hover('id:desktop-session-/workspace-head');
    await app.keyboard.down('shift'); await app.press('id:desktop-session-archive-/workspace-head'); await app.keyboard.up('shift');
  }
  await quickDelete();
  expect(app.shows('id:desktop-session-/workspace-head')).toBe(true);
  app.onDialog(dialog => dialog.buttons.includes('Delete session') ? 'Delete session' : null);
  await quickDelete();
  await app.waitFor('text:Undo');
  expect((await audit(app)).some(row => row.method === 'DELETE')).toBe(false);
  await app.press('text:Undo'); await app.waitFor('id:desktop-session-/workspace-head');
  await app.press('id:desktop-fixture-delete-fail'); await app.waitFor('text:delete-fail');
  await quickDelete();
  await app.wait(10001); await app.waitFor('text:HTTP 503: Synthetic delete retry');
  await app.press('text:Try again');
  await app.waitUntil(() => !app.shows('text:HTTP 503: Synthetic delete retry'));
  expect((await audit(app)).filter(row => row.method === 'DELETE').length).toBe(2);
});

test('desktop: hidden rows retain the same reactive actions owner without new catalog fanout', async () => {
  const app = await open('./desktop-sidebar-fixture.tsx', { platform: 'macos', width: 900, height: 1100 });
  await app.waitFor('id:desktop-session-/workspace-head'); await app.waitFor('text:owner:true:1');
  const initial = (await audit(app)).filter(row => row.path.startsWith('/api/')).length;
  await app.press('id:desktop-fixture-visible');
  expect(app.shows('id:desktop-session-/workspace-head')).toBe(false);
  expect(app.shows('text:owner:true:1')).toBe(true);
  await app.press('id:desktop-fixture-number-one'); await app.waitFor('text:chat:pin');
  await app.press('id:desktop-fixture-next'); await app.waitFor('text:chat:pin-two');
  await app.wait(200); expect((await audit(app)).filter(row => row.path.startsWith('/api/')).length).toBe(initial);
  await app.press('id:desktop-fixture-visible'); await app.waitFor('id:desktop-session-/workspace-head');
  expect(app.shows('text:owner:true:1')).toBe(true);
  await app.press('id:desktop-fixture-active'); await app.waitFor('text:owner:false:2');
});

test('desktop: switcher source exposes retained children, metadata and live status independently of hidden/collapsed rows', async () => {
  const app = await open('./desktop-sidebar-fixture.tsx', { platform: 'macos', width: 900, height: 1300 });
  await app.waitFor('id:desktop-session-/workspace-head');
  await app.press('id:desktop-fixture-tree-data'); await app.waitFor('text:tree-data-ready');
  await app.hover('id:desktop-session-/workspace-head'); await app.press('id:desktop-children-head'); await app.waitFor('id:desktop-session-/workspace-child-a');
  await app.press('id:desktop-children-head');
  await app.press('label:Collapse Desktop workspace'); await app.press('id:desktop-fixture-visible');
  const before = (await audit(app)).filter(row => row.path.startsWith('/api/')).length;
  await app.press('id:desktop-fixture-source');
  const raw = app.texts().find(text => text.startsWith('source:'))!;
  const source = JSON.parse(raw.slice('source:'.length));
  expect(source.ready).toBe(true); expect(source.loading).toBe(false); expect(source.error).toBe('');
  expect(source.sessions.some((row: { id: string }) => row.id === 'child-a')).toBe(true);
  expect(source.sessions.some((row: { id: string }) => row.id === 'old')).toBe(true);
  expect(source.sessions.find((row: { id: string }) => row.id === 'head').created).toBe(10);
  expect(source.pinnedSessionIDs).toEqual(['pin', 'pin-two']);
  expect(source.branches.some(([path, branch]: string[]) => path === '/tree' && branch === 'feature/desktop')).toBe(true);
  expect(source.statuses.some(([id, status]: string[]) => id === 'running' && status === 'running')).toBe(true);
  for (let i = 0; i < 5; i++) await app.press('id:desktop-fixture-source');
  expect((await audit(app)).filter(row => row.path.startsWith('/api/')).length).toBe(before);
  await app.press('id:desktop-fixture-source-retry'); await app.waitFor('text:source-retried');
  await app.press('id:desktop-fixture-active'); await app.waitFor('text:owner:false:2');
  await app.press('id:desktop-fixture-source');
  const retired = JSON.parse(app.texts().find(text => text.startsWith('source:'))!.slice('source:'.length));
  expect(retired.ready).toBe(false); expect(retired.sessions).toEqual([]);
});

test('desktop: children load only on explicit expansion, refresh on re-expansion and enter logical navigation', async () => {
  const app = await open('./desktop-sidebar-fixture.tsx', { platform: 'macos', width: 900, height: 1300 });
  await app.waitFor('id:desktop-session-/workspace-head');
  await app.press('id:desktop-fixture-tree-data'); await app.waitFor('text:tree-data-ready');
  expect((await audit(app)).some(row => row.path.includes('parentID=head'))).toBe(false);
  await app.press('id:desktop-session-/workspace-head');
  expect((await audit(app)).some(row => row.path.includes('parentID=head'))).toBe(false);
  await app.hover('id:desktop-session-/workspace-head'); await app.press('id:desktop-children-head'); await app.waitFor('id:desktop-session-/workspace-child-z');
  await app.waitFor('id:desktop-session-/workspace-child-a');
  await app.hover('id:desktop-session-/workspace-child-z'); await app.press('id:desktop-children-child-z'); await app.waitFor('id:desktop-session-/workspace-grandchild');
  await app.press('id:desktop-session-/workspace-child-z'); await app.press('id:desktop-fixture-next'); await app.waitFor('text:chat:grandchild');
  await app.hover('id:desktop-session-/workspace-head'); await app.press('id:desktop-children-head'); expect(app.shows('id:desktop-session-/workspace-child-z')).toBe(false);
  await app.hover('id:desktop-session-/workspace-head'); await app.press('id:desktop-children-head'); await app.waitFor('id:desktop-session-/workspace-child-z');
  expect((await audit(app)).filter(row => row.path.includes('parentID=head')).length).toBe(2);
  expect((await audit(app)).filter(row => row.path.includes('cursor=child-page')).length).toBe(2);
});

async function createFolder(app: App, name: string) {
  await app.rightClick('id:desktop-session-/workspace-head');
  await app.press('role:menuitem[Move to folder]');
  await app.press('role:menuitem[New folder...]');
  await app.waitFor('id:desktop-folder-name'); await app.clear('id:desktop-folder-name'); await app.type('id:desktop-folder-name', name);
  await app.press('id:desktop-folder-save'); await app.waitUntil(() => !app.shows('id:desktop-folder-name'));
  await app.waitFor(`label:Collapse folder ${name}`);
}

test('desktop: folder CRUD, nested visual collapse and membership drop persist to the real snapshot route', async () => {
  const app = await open('./desktop-sidebar-fixture.tsx', { platform: 'macos', width: 900, height: 1300 });
  await app.waitFor('id:desktop-session-/workspace-head');
  await createFolder(app, 'First');
  await app.drag('id:desktop-drag-session-z', { x: 0, y: -60 });
  const posts = (await audit(app)).filter(row => row.path === '/api/session-folders' && row.method === 'POST');
  expect(posts.length).toBe(3);
  await app.press('label:Collapse folder First');
  await app.waitUntil(() => !app.shows('id:desktop-session-/workspace-z'));
  await app.press('label:Expand folder First'); await app.waitFor('id:desktop-session-/workspace-z');
  await createFolder(app, 'Second');
  await app.press('label:Collapse folder First');
  await app.drag('label:Expand folder First', { x: 0, y: 35 });
  await app.press('id:desktop-fixture-active'); await app.press('id:desktop-fixture-active');
  await app.waitFor('label:Collapse folder Second');
  expect(app.texts().indexOf('Second') < app.texts().indexOf('First')).toBe(true);
});

test('desktop: archived group reads directory-owned pages and restore removes the archived row', async () => {
  const app = await open('./desktop-sidebar-fixture.tsx', { platform: 'macos', width: 900, height: 1300 });
  await app.waitFor('id:desktop-session-/workspace-head');
  await app.press('id:desktop-fixture-tree-data'); await app.waitFor('text:tree-data-ready');
  await app.press('id:desktop-archived-project'); await app.waitFor('id:desktop-session-__archived__:/workspace-archived-z');
  await app.rightClick('id:desktop-session-__archived__:/workspace-archived-z'); await app.press('role:menuitem[Restore]');
  await app.waitUntil(() => !app.shows('id:desktop-session-__archived__:/workspace-archived-z'));
  expect((await audit(app)).filter(row => row.path === '/api/yuri/sessions/archived-z/archive' && row.method === 'PUT').length).toBe(1);
});

test('desktop: worktree session folder submenu creates in that exact directory', async () => {
  const app = await open('./desktop-sidebar-fixture.tsx', { platform: 'macos', width: 900, height: 1300 });
  await app.waitFor('label:Expand feature/desktop');
  await app.press('label:Expand feature/desktop'); await app.waitFor('id:desktop-session-/tree-tree');
  await app.rightClick('id:desktop-session-/tree-tree'); await app.press('role:menuitem[Move to folder]'); await app.press('role:menuitem[New folder...]');
  await app.waitFor('id:desktop-folder-name'); await app.clear('id:desktop-folder-name'); await app.type('id:desktop-folder-name', 'Tree folder');
  await app.press('id:desktop-folder-save'); await app.waitUntil(() => !app.shows('id:desktop-folder-name'));
  await app.waitFor('label:Collapse folder Tree folder');
  const posts = (await audit(app)).filter(row => row.path === '/api/session-folders' && row.method === 'POST');
  expect(posts.length).toBe(2);
});

test('desktop: folder direct actions preserve exact draft membership, inline rename and one-level subfolders', async () => {
  const app = await open('./desktop-sidebar-fixture.tsx', { platform: 'macos', width: 1000, height: 1600 });
  await app.waitFor('id:desktop-session-/workspace-head'); await createFolder(app, 'Parent');
  await app.hover('label:Collapse folder Parent');
  expect(app.shows('label:Session menu')).toBe(false);
  await app.press('label:New session in Parent');
  await app.waitUntil(() => app.texts().some(value => value.startsWith('folder-draft:')));
  const draft = JSON.parse(app.texts().find(value => value.startsWith('folder-draft:'))!.slice(13));
  expect(draft[0]).toBe('/workspace'); expect(draft[1]).toBe('/workspace');
  await app.hover('label:Collapse folder Parent'); await app.press('label:Rename folder Parent');
  expect(app.shows('label:Collapse folder Parent')).toBe(false);
  await app.clear('id:desktop-folder-name'); await app.type('id:desktop-folder-name', 'Renamed'); await app.submit('id:desktop-folder-name');
  await app.waitFor('label:Collapse folder Renamed'); await app.hover('label:Collapse folder Renamed');
  await app.press('label:New sub-folder in Renamed');
  await app.clear('id:desktop-folder-name'); await app.type('id:desktop-folder-name', 'Nested'); await app.press('id:desktop-folder-save');
  await app.waitFor('label:Collapse folder Nested'); await app.hover('label:Collapse folder Nested');
  expect(app.shows('label:New sub-folder in Nested')).toBe(false);
  const posts = (await audit(app)).filter(value => value.path === '/api/session-folders' && value.method === 'POST');
  const folders = posts.at(-1)?.body?.foldersMap?.['/workspace'];
  expect(folders?.find(value => value.name === 'Nested')?.parentId).toBe(draft[2]);
});

test('desktop: archived group delete drains opaque pages before confirmation and delegates every retained root to lossless Undo', async () => {
  const app = await open('./desktop-sidebar-fixture.tsx', { platform: 'macos', width: 1000, height: 1600, clock: {} });
  let accept = false;
  app.onDialog(dialog => accept && dialog.buttons.includes('Delete session') ? 'Delete session' : 'Cancel');
  await app.waitFor('id:desktop-session-/workspace-head'); await app.press('id:desktop-fixture-archived-pages'); await app.waitFor('text:archived-pages');
  await app.press('id:desktop-archived-project'); await app.waitFor('id:desktop-session-__archived__:/workspace-archived-z');
  await app.hover('id:desktop-archived-project');
  await app.press('id:desktop-archived-delete-project');
  await app.waitUntil(() => app.dialogs().length === 1);
  await app.wait(0);
  expect(app.dialogs().at(-1)?.message).toBe('2 sessions will be permanently deleted.');
  expect((await audit(app)).some(value => value.method === 'DELETE')).toBe(false);
  expect(app.enabled('id:desktop-archived-delete-project')).toBe(true);
  accept = true;
  await app.hover('id:desktop-archived-project'); await app.waitUntil(() => app.enabled('id:desktop-archived-delete-project'));
  await app.press('id:desktop-archived-delete-project'); await app.waitUntil(() => app.dialogs().length === 2);
  // NSH waitUntil only observes; a step answers an alert opened by the async page drain.
  await app.wait(0);
  await app.waitUntil(() => !app.shows('id:desktop-session-__archived__:/workspace-archived-z'));
  await app.waitUntil(() => app.count('text:Undo') === 2);
  expect(app.shows('id:desktop-session-__archived__:/workspace-archived-folded')).toBe(false);
  expect(app.count('text:Undo')).toBe(2);
  const calls = await audit(app);
  expect(calls.some(value => value.path.includes('cursor=archive-next'))).toBe(true);
  expect(calls.some(value => value.method === 'DELETE')).toBe(false);
});

test('desktop: failed archived tail preserves prior rows and cannot confirm or schedule a partial group delete', async () => {
  const app = await open('./desktop-sidebar-fixture.tsx', { platform: 'macos', width: 1000, height: 1600 });
  await app.waitFor('id:desktop-session-/workspace-head'); await app.press('id:desktop-fixture-archived-pages');
  await app.press('id:desktop-archived-project'); await app.waitFor('id:desktop-session-__archived__:/workspace-archived-z');
  await app.press('id:desktop-fixture-archived-page-fail'); await app.hover('id:desktop-archived-project');
  await app.press('id:desktop-archived-delete-project');
  await app.waitFor('text:HTTP 503: Synthetic archived page retry');
  expect(app.shows('id:desktop-session-__archived__:/workspace-archived-z')).toBe(true);
  expect(app.dialogs().length).toBe(0); expect(app.count('text:Undo')).toBe(0);
  expect((await audit(app)).some(value => value.method === 'DELETE')).toBe(false);
});

test('desktop: project drag writes settings, export produces all Markdown pages, unsupported share is absent like Web', async () => {
  const app = await open('./desktop-sidebar-fixture.tsx', { platform: 'macos', width: 900, height: 1500 });
  await app.waitFor('id:desktop-session-/workspace-head');
  await app.press('id:desktop-fixture-add-project'); await app.waitFor('text:project-added');
  await app.press('label:Collapse Desktop workspace');
  await app.drag('id:desktop-drag-project-project', { x: 0, y: 30 });
  expect((await audit(app)).filter(row => row.path === '/api/config/settings' && row.method === 'PUT').length).toBe(1);
  await app.press('label:Expand Desktop workspace');
  await app.press('id:desktop-fixture-tree-data'); await app.waitFor('text:tree-data-ready');
  await app.rightClick('id:desktop-session-/workspace-head'); expect(app.shows('role:menuitem[Share]')).toBe(false); await app.keyboard.press('escape');
  app.onDialog(dialog => dialog.buttons.includes('Export') ? 'Export' : null);
  await app.rightClick('id:desktop-session-/workspace-head'); await app.press('role:menuitem[Export Markdown]');
  await app.waitFor('id:desktop-export-copy'); await app.press('id:desktop-export-copy');
  await app.waitUntil(() => (app.clipboard() ?? '').includes('Earlier exported text') && (app.clipboard() ?? '').includes('Later exported text'));
  const requests = await audit(app); expect(requests.some(row => row.path.includes('/share'))).toBe(false);
  expect(requests.filter(row => row.path.startsWith('/api/session/head/message?')).length).toBe(2);
});

test('desktop: verified Markdown retains preview/copy and only explicit Save invokes native local saving; unknown ACK only checks status', async () => {
  const app = await open('./desktop-sidebar-fixture.tsx', { platform: 'macos', width: 900, height: 1700 });
  await app.waitFor('id:desktop-session-/workspace-head');
  await app.press('id:desktop-fixture-tree-data'); await app.waitFor('text:tree-data-ready');
  await app.press('id:desktop-fixture-documents-lost-ack'); await app.waitFor('text:documents-lost-ack');
  app.onDialog(dialog => dialog.buttons.includes('Export') ? 'Export' : null);
  await app.rightClick('id:desktop-session-/workspace-head'); await app.press('role:menuitem[Export Markdown]');
  await app.waitFor('id:desktop-export-save');
  expect((await audit(app)).some(row => row.path === 'desktop.documents.save')).toBe(false);
  await app.press('id:desktop-export-save'); await app.waitFor('text:Unknown');
  await app.press('id:desktop-export-save'); await app.waitFor('text:Session exported');
  await app.press('id:desktop-export-copy'); await app.waitUntil(() => (app.clipboard() ?? '').includes('Earlier exported text'));
  const calls = await audit(app);
  expect(calls.filter(row => row.path === 'desktop.documents.save').length).toBe(1);
  expect(calls.filter(row => row.path === 'desktop.documents.status').length).toBe(1);
});

test('desktop: cancelling native Save retains the verified preview and never reports successful export', async () => {
  const app = await open('./desktop-sidebar-fixture.tsx', { platform: 'macos', width: 900, height: 1700 });
  await app.waitFor('id:desktop-session-/workspace-head');
  await app.press('id:desktop-fixture-tree-data'); await app.waitFor('text:tree-data-ready');
  await app.press('id:desktop-fixture-documents-cancelled'); await app.waitFor('text:documents-cancelled');
  app.onDialog(dialog => dialog.buttons.includes('Export') ? 'Export' : null);
  await app.rightClick('id:desktop-session-/workspace-head'); await app.press('role:menuitem[Export Markdown]');
  await app.waitFor('id:desktop-export-save'); await app.press('id:desktop-export-save'); await app.waitFor('text:Cancelled');
  expect(app.shows('text:Session exported')).toBe(false); expect(app.shows('id:desktop-export-copy')).toBe(true);
});
