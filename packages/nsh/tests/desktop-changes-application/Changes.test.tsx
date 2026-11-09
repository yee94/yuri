import { expect, open, test } from 'nsh/test';
import { createChangesApplicationHost, draftKey, draftRecord, historyToolID, identity, navigationRecord } from './Host.js';

async function launch(platform, options = {}) {
  const fixture = createChangesApplicationHost(options), gates = [];
  const app = await open('./Root.tsx', { platform, clock: {}, width: 1440, height: 1100,
    storage: { 'desktop.navigation.v1': navigationRecord, [draftKey]: draftRecord('Keep real Chat draft') },
    host: { params: { holdChangesCommit: options.pending === true }, handlers: { ...fixture.handlers, 'changes.application.gate': event => gates.push(event) } } });
  await app.waitFor('id:composer');
  await app.waitFor('id:composer-changes');
  return { app, fixture, gates };
}
function clean(fixture) {
  expect(fixture.rejected).toEqual([]);
  expect(fixture.mutations).toEqual([]);
}
async function composerSheet(app) {
  await app.press('id:composer-changes');
  await app.waitFor('id:composer-change-readme.md');
  await app.press('id:composer-change-readme.md');
  await app.waitFor('id:native-changes-sheet');
  await app.press('id:changes-back');
  await app.waitUntil(() => app.enabled('id:changes-commit-message'));
}
async function projectPage(app) {
  await app.hover('id:desktop-project-' + identity.projectID);
  await app.press('label:New worktree');
  await app.press('text:Cancel');
  await app.waitFor('id:project-worktree-' + identity.chosen);
}
async function projectSheet(app) {
  await app.press('text:Changes');
  await app.waitFor('id:native-changes-sheet');
  await app.waitUntil(() => app.enabled('id:changes-commit-message'));
}
async function protectedProject(platform, mode) {
  const result = await launch(platform, { [mode]: true });
  const { app, fixture, gates } = result;
  await projectPage(app);
  await app.press('id:project-worktree-' + identity.chosen);
  await projectSheet(app);
  await app.type('id:changes-commit-message', 'Protected Changes draft');
  await app.waitUntil(() => app.enabled('id:changes-commit'));
  await app.press('id:changes-commit');
  if (mode === 'pending') await app.waitUntil(() => gates.some(event => event.phase === 'commit-held'));
  else await app.waitFor('id:changes-write-unknown');
  expect(fixture.posts).toHaveLength(1);
  expect(fixture.posts[0].path).toBe('/api/git/commit?directory=' + encodeURIComponent(identity.chosen));
  expect(fixture.posts[0].writerGrant).toBeUndefined();
  const releases = fixture.writer.calls.filter(call => call.name === 'release').length;
  const held = fixture.writer.held();
  await app.host.send('desktop.window.closeRequested', { ticket: 'changes:live-' + mode, windowID: 'changes-window', generation: 1, reason: 'close' });
  await app.waitUntil(() => fixture.decisions.length === 1);
  expect(fixture.decisions[0]).toEqual({ ticket: 'changes:live-' + mode, approved: false });
  expect(app.shows('id:native-changes-sheet')).toBe(true);
  expect(app.value('id:changes-commit-message')).toBe('Protected Changes draft');
  expect(fixture.writer.calls.filter(call => call.name === 'release')).toHaveLength(releases);
  expect(fixture.writer.held()).toEqual(held);
  await app.press('id:changes-close'); await app.waitFor('id:native-changes-sheet', { state: 'gone' });
  return result;
}
for (const platform of ['macos', 'windows'] as const) {
  test(platform + ' actual project action uses the production Changes panel rather than an invented Sheet entry', async () => {
    const { app, fixture } = await launch(platform);
    await projectPage(app);
    await app.waitFor('text:Changes');
    await app.press('text:Changes');
    await app.waitFor('id:desktop-changes-refresh');
    expect(app.shows('id:native-changes-sheet')).toBe(false);
    expect(fixture.posts).toEqual([]); clean(fixture);
  });
  test(platform + ' actual historical edit button uses the captured message payload in the production panel', async () => {
    const { app, fixture } = await launch(platform);
    await app.press('text:Used');
    await app.waitFor('id:tool-expand-' + historyToolID);
    await app.press('id:tool-expand-' + historyToolID);
    await app.waitFor('id:desktop-native-diff');
    expect(app.texts()).toContain('AFTER_CAPTURED_SOURCE');
    expect(app.shows('id:native-changes-sheet')).toBe(false);
    expect(fixture.requests.filter(input => input.path.startsWith('/api/git/diff?'))).toEqual([]);
    expect(fixture.posts).toEqual([]); clean(fixture);
  });
  test(platform + ' actual composer Changes Sheet keeps its commit draft across dismissal with fifty input edits and zero GETs', async () => {
    const { app, fixture } = await launch(platform);
    await composerSheet(app);
    await app.type('id:changes-commit-message', 'Protected Changes draft');
    const reads = fixture.requests.filter(input => input.method === 'GET').length;
    for (let index = 0; index < 50; index++) await app.type('id:changes-commit-message', 'x');
    expect(fixture.requests.filter(input => input.method === 'GET')).toHaveLength(reads);
    await app.press('id:changes-close'); await app.waitFor('id:native-changes-sheet', { state: 'gone' });
    const closedReads = fixture.requests.filter(input => input.method === 'GET').length;
    for (let index = 0; index < 50; index++) await app.type('id:composer', 'x');
    expect(fixture.requests.filter(input => input.method === 'GET')).toHaveLength(closedReads);
    await composerSheet(app);
    expect(app.value('id:changes-commit-message')).toBe('Protected Changes draft' + 'x'.repeat(50));
    expect(app.value('id:composer')).toBe('Keep real Chat draft' + 'x'.repeat(50));
    expect(fixture.posts).toEqual([]); clean(fixture);
  });
  test(platform + ' actual project dirty draft vetoes native close and route; clearing the same draft restores normal navigation', async () => {
    const { app, fixture } = await launch(platform);
    await projectPage(app); await app.press('id:project-worktree-' + identity.chosen); await projectSheet(app);
    await app.type('id:changes-commit-message', 'Protected Changes draft');
    await app.press('id:changes-close'); await app.waitFor('id:native-changes-sheet', { state: 'gone' });
    const releases = fixture.writer.calls.filter(call => call.name === 'release').length;
    await app.press('id:desktop-schedules');
    expect(app.shows('id:desktop-schedules-workspace')).toBe(false);
    await app.host.send('desktop.window.closeRequested', { ticket: 'changes:dirty', windowID: 'changes-window', generation: 1, reason: 'close' });
    await app.waitUntil(() => fixture.decisions.length === 1);
    expect(fixture.decisions[0]).toEqual({ ticket: 'changes:dirty', approved: false });
    expect(fixture.writer.calls.filter(call => call.name === 'release')).toHaveLength(releases);
    await projectSheet(app);
    expect(app.value('id:changes-commit-message')).toBe('Protected Changes draft');
    await app.clear('id:changes-commit-message');
    await app.press('id:changes-close'); await app.waitFor('id:native-changes-sheet', { state: 'gone' });
    await app.press('id:desktop-schedules'); await app.waitFor('id:desktop-schedules-workspace');
    expect(fixture.posts).toEqual([]); clean(fixture);
  });
  test(platform + ' actual selected-worktree project Changes Sheet retains its draft and reads nothing for fifty edits', async () => {
    const { app, fixture } = await launch(platform);
    await projectPage(app); await app.press('id:project-worktree-' + identity.chosen); await projectSheet(app);
    await app.type('id:changes-commit-message', 'Protected Changes draft');
    const reads = fixture.requests.filter(input => input.method === 'GET').length;
    for (let index = 0; index < 50; index++) await app.type('id:changes-commit-message', 'x');
    expect(fixture.requests.filter(input => input.method === 'GET')).toHaveLength(reads);
    await app.press('id:changes-close'); await app.waitFor('id:native-changes-sheet', { state: 'gone' });
    await projectSheet(app);
    expect(app.value('id:changes-commit-message')).toBe('Protected Changes draft' + 'x'.repeat(50));
    expect(fixture.posts).toEqual([]); clean(fixture);
  });
  for (const mode of ['pending', 'unknown'] as const) {
    test(platform + ' actual project ' + mode + ' commit survives close/reopen without replay and vetoes native close without release', async () => {
      const { app, fixture } = await protectedProject(platform, mode);
      const releases = fixture.writer.calls.filter(call => call.name === 'release').length;
      const held = fixture.writer.held();
      await projectSheet(app); await app.waitFor('id:changes-write-unknown');
      expect(app.value('id:changes-commit-message')).toBe('Protected Changes draft');
      expect(app.enabled('id:changes-commit')).toBe(false);
      await app.press('id:changes-close'); await app.waitFor('id:native-changes-sheet', { state: 'gone' });
      await app.host.send('desktop.window.closeRequested', { ticket: 'changes:' + mode, windowID: 'changes-window', generation: 2, reason: 'close' });
      await app.waitUntil(() => fixture.decisions.length === 2);
      expect(fixture.decisions[1]).toEqual({ ticket: 'changes:' + mode, approved: false });
      expect(fixture.writer.held()).toEqual(held);
      expect(fixture.writer.calls.filter(call => call.name === 'release')).toHaveLength(releases);
      if (mode === 'pending') await app.host.send('changes.application.control', { action: 'release-commit' });
      await projectSheet(app); await app.waitFor('id:changes-write-unknown');
      expect(app.value('id:changes-commit-message')).toBe('Protected Changes draft');
      expect(fixture.posts).toHaveLength(1); clean(fixture);
    });
    test(platform + ' actual project ' + mode + ' commit vetoes root navigation, route and Host switch before writer release', async () => {
      const { app, fixture } = await protectedProject(platform, mode);
      const releases = fixture.writer.calls.filter(call => call.name === 'release').length;
      const navigation = app.storage()['desktop.navigation.v1'];
      await app.press('id:desktop-schedules');
      expect(app.shows('id:desktop-schedules-workspace')).toBe(false);
      await app.press('id:desktop-new-session');
      expect(app.storage()['desktop.navigation.v1']).toBe(navigation);
      expect(app.shows('id:project-worktree-' + identity.chosen)).toBe(true);
      await app.press('id:desktop-connections');
      expect(app.shows('id:connection-submit')).toBe(false);
      await app.press('id:desktop-chat-header-menu'); await app.press('id:desktop-chat-header-menu-instance');
      await app.waitFor('id:desktop-header-services-instance-row-connection:navigation-other');
      await app.press('id:desktop-header-services-instance-switch-connection:navigation-other');
      expect(app.host.calls().filter(call => call.name === 'connection.select')).toEqual([]);
      expect(fixture.writer.calls.filter(call => call.name === 'release')).toHaveLength(releases);
      await app.keyboard.press('escape');
      await projectSheet(app);
      expect(app.value('id:changes-commit-message')).toBe('Protected Changes draft');
      expect(fixture.posts).toHaveLength(1); clean(fixture);
    });
  }
  test(platform + ' actual project Changes preview uses captured worktree directory, not the page project directory', async () => {
    const { app, fixture } = await launch(platform);
    await projectPage(app); await app.press('id:project-worktree-' + identity.chosen); await projectSheet(app);
    await app.press('id:changes-staged-readme.md'); await app.waitFor('id:changes-native-diff');
    await app.press('id:changes-open-preview'); await app.waitFor('id:native-changes-sheet', { state: 'gone' });
    await app.waitUntil(() => fixture.previews.length === 1);
    expect(fixture.previews[0].path).toBe(identity.chosen + '/readme.md');
    expect(fixture.previews[0].path).not.toBe(identity.directory + '/readme.md');
    await app.waitFor('text:AFTER_CAPTURED_SOURCE');
    expect(fixture.posts).toEqual([]); clean(fixture);
  });
}
