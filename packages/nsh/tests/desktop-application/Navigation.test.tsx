import { expect, open, test } from 'nsh/test';
import { createNavigationHost, isNavigationReadOnlyGoalRPC, navigationIdentity as identity, navigationOtherIdentity as otherIdentity } from './NavigationHost.js';
import { createScheduleHost } from './ScheduleHost.js';

const key = 'desktop.navigation.v1';
const partition = { connectionID: identity.hostID, origin: identity.origin, authorizationID: identity.authorizationID };
const session = { kind: 'session', sessionID: identity.sessionID, directory: identity.directory };
const envelope = target => JSON.stringify({ version: 1, entries: [{ partition, target }] });
const panelKey = 'desktop.panel-tabs.v1';
const panelEnvelope = () => JSON.stringify({ version: 1, scopes: [{
  scope: { host: { hostID: identity.hostID }, authorityKey: JSON.stringify([identity.hostID, identity.origin, identity.authorizationID]), sessionID: identity.sessionID, directory: identity.directory },
  tabs: [{ kind: 'context', id: 'context' }], selectedID: 'context', rail: null, activeView: 'preview',
}] });
const target = app => JSON.parse(app.storage()[key]).entries.find(entry => entry.partition.connectionID === identity.hostID)?.target;
const clean = fixture => {
  expect(fixture.rejected).toEqual([]); expect(fixture.mutations).toEqual([]);
  expect(fixture.readonlyRPCs.every(isNavigationReadOnlyGoalRPC)).toBe(true);
};
async function launch(platform, projection = session, params = {}) {
  const fixture = createNavigationHost();
  const app = await open('./NavigationRoot.tsx', { platform, width: 1440, height: 900,
    storage: { [key]: envelope(projection) }, host: { params, handlers: fixture.handlers } });
  await app.waitFor('id:desktop-workspace');
  return { app, fixture };
}
async function chooseDraftProject(app, projectID = identity.projectID) {
  await app.waitFor('id:new-session-project'); await app.press('id:new-session-project');
  await app.press('id:new-session-project-' + projectID);
  await app.waitFor('id:new-session-project-' + projectID, { state: 'gone' });
}
for (const platform of ['macos', 'windows'] as const) {
  for (const stage of ['resolve', 'writer'] as const) {
    test(platform + ' actual new-session pending ' + stage + ' vetoes navigation and native close before source guard takes custody', async () => {
      const fixture = createNavigationHost();
      const app = await open('./NavigationRoot.tsx', { platform, width: 1440, height: 900,
        host: { params: { trackDraftReads: true, holdNewSessionResolve: stage === 'resolve', holdNewSessionWriter: stage === 'writer' }, handlers: fixture.handlers } });
      await app.waitFor('id:new-session-project'); await app.press('id:new-session-project');
      await app.press('id:new-session-project-' + identity.projectID);
      await app.waitUntil(() => fixture.storage.some(event => event.phase === 'new-session-' + stage + '-held'));
      expect(app.shows('id:new-session-composer')).toBe(false);
      expect(fixture.storage.filter(event => event.phase === 'draft-read')).toEqual([]);
      const priorNavigation = app.storage()[key];
      await app.press('id:desktop-schedules');
      expect(app.shows('id:desktop-schedules-workspace')).toBe(false); expect(app.storage()[key]).toBe(priorNavigation);
      await app.host.send('desktop.window.closeRequested', { ticket: 'new-session-' + stage, windowID: 'synthetic-writer-window', generation: 1, reason: 'close' });
      await app.waitUntil(() => fixture.decisions.length === 1);
      expect(fixture.decisions[0]).toEqual({ ticket: 'new-session-' + stage, approved: false });
      expect(fixture.writer.calls.filter(call => call.name === 'release')).toEqual([]);
      await app.press('id:desktop-settings'); await app.waitFor('id:desktop-settings-window');
      await app.press('id:desktop-settings-close'); await app.waitFor('id:desktop-settings-window', { state: 'gone' });
      await app.host.send('navigation.test.storage.control', { action: 'release-new-session' });
      await app.waitFor('id:new-session-composer'); await app.type('id:new-session-composer', 'Admitted original source');
      expect(fixture.writer.calls.filter(call => call.name === 'acquire')).toHaveLength(1);
      await app.press('id:desktop-schedules'); await app.waitFor('id:desktop-schedules-workspace');
      const releases = fixture.writer.calls.filter(call => call.name === 'release');
      expect(releases).toHaveLength(1);
      await app.host.send('desktop.window.closeRequested', { ticket: 'new-session-source-ready', windowID: 'synthetic-writer-window', generation: 2, reason: 'close' });
      await app.waitUntil(() => fixture.decisions.length === 2);
      expect(fixture.decisions[1]).toEqual({ ticket: 'new-session-source-ready', approved: true });
      expect(fixture.writer.calls.filter(call => call.name === 'release')).toEqual(releases);
      clean(fixture);
    });
  }
  test(platform + ' actual writer lease ACK resumes the same Chat and draft without a second claim or durable restore', async () => {
    const { app, fixture } = await launch(platform, session, { trackDraftReads: true, holdWriterRenew: true });
    await app.waitFor('id:composer');
    expect(fixture.storage.filter(event => event.phase === 'draft-read')).toHaveLength(1);
    await app.type('id:composer', 'Retain this renewal draft');
    const draftKey = fixture.storage.find(event => event.phase === 'draft-read').key;
    await app.waitUntil(() => !!app.storage()[draftKey] && JSON.parse(app.storage()[draftKey]).draft === 'Retain this renewal draft');
    const readsBeforeRenew = fixture.storage.filter(event => event.phase === 'draft-read').length;
    await app.setLifecycle('background'); fixture.rotateLease(); await app.setLifecycle('active');
    await app.waitUntil(() => fixture.storage.some(event => event.phase === 'writer-renew-held'));
    expect(app.value('id:composer')).toBe('Retain this renewal draft'); expect(app.enabled('id:send')).toBe(false);
    expect(fixture.writer.calls.filter(call => call.name === 'acquire')).toHaveLength(1);
    expect(fixture.storage.filter(event => event.phase === 'draft-read')).toHaveLength(readsBeforeRenew);
    await app.host.send('navigation.test.storage.control', { action: 'release-writer-renew' });
    await app.waitUntil(() => app.enabled('id:send'));
    expect(fixture.storage.filter(event => event.phase === 'draft-read')).toHaveLength(readsBeforeRenew);
    await app.type('id:composer', ' resumed');
    expect(app.value('id:composer')).toBe('Retain this renewal draft resumed');
    expect(fixture.writer.calls.filter(call => call.name === 'renew')).toHaveLength(1);
    expect(fixture.writer.calls.filter(call => call.name === 'acquire')).toHaveLength(1);
    clean(fixture);
  });
  test(platform + ' native stable window descriptor partitions navigation, layout and tabs without adopting primary records', async () => {
    const fixture = createNavigationHost(), prefix = 'desktop.window.v1:second:';
    const primary = envelope(session), primaryLayout = JSON.stringify({ sidebarOpen: false, panelOpen: false }), primaryPanel = panelEnvelope();
    const secondaryTarget = { kind: 'new-session', projectID: identity.chosenID, directory: identity.chosen };
    const secondaryPanel = JSON.stringify({ version: 1, scopes: [{
      scope: { host: { hostID: identity.hostID }, authorityKey: JSON.stringify([identity.hostID, identity.origin, identity.authorizationID]), sessionID: null, directory: identity.chosen },
      tabs: [{ id: JSON.stringify(['browser', '']), kind: 'browser', url: '' }], selectedID: JSON.stringify(['browser', '']), rail: null, activeView: 'preview',
    }] });
    const app = await open('./NavigationRoot.tsx', { platform, clock: {}, width: 1440, height: 1000,
      storage: { [key]: primary, 'desktop.layout.v1': primaryLayout, [panelKey]: primaryPanel,
        [prefix + key]: envelope(secondaryTarget), [prefix + panelKey]: secondaryPanel },
      host: { params: { windowKey: 'second', windowKind: 'main' }, handlers: fixture.handlers } });
    await app.waitFor('id:new-session-composer'); await app.waitFor('text:What are we working on in Chosen project?');
    expect(app.shows('id:composer')).toBe(false);
    expect(app.shows('id:desktop-sidebar-panel')).toBe(true);
    await app.press('id:desktop-sidebar-toggle');
    await app.waitUntil(() => !!app.storage()[prefix + 'desktop.layout.v1']);
    expect(JSON.parse(app.storage()[prefix + 'desktop.layout.v1']).sidebarOpen).toBe(false);
    await app.waitUntil(() => app.enabled('id:desktop-chat-header-panel')); await app.press('id:desktop-chat-header-panel');
    await app.waitFor('id:native-desktop-browser-pane'); expect(app.value('id:desktop-browser-address')).toBe('');
    expect(app.storage()[key]).toBe(primary); expect(app.storage()['desktop.layout.v1']).toBe(primaryLayout); expect(app.storage()[panelKey]).toBe(primaryPanel);
    expect(JSON.parse(app.storage()[prefix + key]).entries[0].target).toEqual(secondaryTarget);
    expect(fixture.reads.filter(input => input.path.startsWith('/api/session/' + identity.sessionID + '?'))).toHaveLength(0);
    clean(fixture);
  });
  test(platform + ' malformed native window descriptor fails before any connection or runtime request', async () => {
    const fixture = createNavigationHost(), original = envelope(session);
    const app = await open('./NavigationRoot.tsx', { platform, clock: {}, width: 900, height: 600, storage: { [key]: original },
      host: { params: { windowKey: '../primary', windowKind: 'main' }, handlers: fixture.handlers } });
    await app.waitFor('id:desktop-window-descriptor-error');
    expect(app.shows('id:desktop-workspace')).toBe(false); expect(app.storage()[key]).toBe(original);
    expect(app.host.calls().filter(call => call.name === 'connection.list' || call.name === 'runtime.request')).toEqual([]);
    clean(fixture);
  });
  test(platform + ' actual schedule close grant is revalidated after delayed navigation durability and intervening edits', async () => {
    const fixture = createScheduleHost(), audit: string[] = [];
    const app = await open('./NavigationRoot.tsx', { platform, width: 1440, height: 900,
      host: { params: { holdNavigationWrite: true }, handlers: { ...fixture.handlers, 'navigation.test.storage': input => { audit.push(input.phase); } } } });
    await app.waitFor('id:new-session-composer'); await app.press('id:desktop-schedules');
    await app.waitUntil(() => audit.includes('write-held'));
    await app.waitFor('id:desktop-scheduled-task-desktop-project-alpha'); await app.press('id:desktop-scheduled-task-desktop-project-alpha');
    await app.waitFor('id:task-editor-desktop'); await app.type('id:features-task-name', ' before grant');
    let confirmations = 0;
    app.onDialog(() => { confirmations++; return 'Discard'; });
    await app.host.send('desktop.window.closeRequested', { ticket: 'schedule:late-flush', windowID: 'window', generation: 1, reason: 'close' });
    await app.waitUntil(() => confirmations === 1);
    expect(app.host.calls().filter(call => call.name === 'desktop.window.closeDecision')).toEqual([]);
    await app.type('id:features-task-name', ' after grant');
    await app.host.send('navigation.test.storage.control', { action: 'release-write' });
    await app.waitUntil(() => app.host.calls().some(call => call.name === 'desktop.window.closeDecision'));
    expect(app.host.calls().filter(call => call.name === 'desktop.window.closeDecision').at(-1).data).toEqual({ ticket: 'schedule:late-flush', approved: false });
    expect(app.value('id:features-task-name')).toBe('Schedule alpha before grant after grant');
    expect(fixture.writes).toEqual([]); expect(fixture.rejected).toEqual([]);
  });
  for (const pending of [false, true]) {
    test(platform + ' startup restores the retained file owner with ' + (pending ? 'an unknown write' : 'a dirty buffer') + ' without approving close or replaying a write', async () => {
      const fixture = createNavigationHost(), metadata = JSON.parse(panelEnvelope()), scope = metadata.scopes[0].scope;
      const path = identity.directory + '/readme.md', tabID = JSON.stringify(['file', path]);
      const scopeKey = JSON.stringify([identity.hostID, scope.authorityKey, identity.sessionID, identity.directory]);
      const recordKey = 'desktop-file-journal-v1:' + JSON.stringify([scopeKey, path]);
      const raw = JSON.stringify({ version: 1, scope, path, text: 'Recovered retained file draft', base: 'Prior Host file', wire: 'Prior Host file', eol: '\n', bom: false,
        pending: pending ? { text: 'Captured unknown write', wire: 'Captured unknown write' } : null, conflict: false });
      fixture.handlers['desktop.files.journal.commit']({ expectedVersion: 0, requestID: 'seed-retained-draft', records: { [recordKey]: raw } });
      metadata.scopes[0].tabs = [{ kind: 'file', path, id: tabID }]; metadata.scopes[0].selectedID = tabID;
      const app = await open('./NavigationRoot.tsx', { platform, width: 1440, height: 900,
        storage: { [key]: envelope(session), [panelKey]: JSON.stringify(metadata), 'desktop.layout.v1': JSON.stringify({ panelOpen: true }) },
        host: { handlers: fixture.handlers } });
      await app.waitFor('id:composer'); await app.waitFor('id:desktop-file-editor');
      expect(app.texts()).toContain('Recovered retained file draft');
      await app.press('id:desktop-editor-copy');
      await app.waitUntil(() => app.clipboard() === 'Recovered retained file draft');
      expect(app.shows('id:desktop-tab-dirty-' + tabID)).toBe(true);
      app.onDialog(() => 'Cancel');
      await app.host.send('desktop.window.closeRequested', { ticket: 'retained:file', windowID: 'window', generation: 1, reason: 'close' });
      expect(fixture.decisions.at(-1)).toEqual({ ticket: 'retained:file', approved: false });
      expect(app.texts()).toContain('Recovered retained file draft');
      expect(fixture.handlers['desktop.files.journal.snapshot']({}).records[recordKey]).toBe(raw);
      clean(fixture);
    });
  }
  test(platform + ' startup waits for the actual native journal before restoring a saved session', async () => {
    const fixture = createNavigationHost();
    const app = await open('./NavigationRoot.tsx', { platform, width: 1440, height: 900,
      storage: { [key]: envelope(session) }, host: { params: { holdJournalRead: true }, handlers: fixture.handlers } });
    await app.waitFor('id:new-session-composer');
    await app.waitUntil(() => fixture.reads.some(input => input.path === '/api/session/' + identity.sessionID + '?directory=' + encodeURIComponent(identity.directory)));
    expect(app.storage()[key]).toBe(envelope(session));
    await app.host.send('navigation.test.storage.control', { action: 'release-journal-read' });
    await app.waitFor('id:composer');
    expect(app.shows('id:new-session-composer')).toBe(false);
    expect(target(app)).toEqual(session); clean(fixture);
  });
  test(platform + ' user intent while native journal is delayed vetoes the old startup restore', async () => {
    const fixture = createNavigationHost();
    const app = await open('./NavigationRoot.tsx', { platform, width: 1440, height: 900,
      storage: { [key]: envelope(session) }, host: { params: { holdJournalRead: true }, handlers: fixture.handlers } });
    await app.waitFor('id:new-session-composer');
    await app.waitUntil(() => fixture.reads.some(input => input.path === '/api/session/' + identity.sessionID + '?directory=' + encodeURIComponent(identity.directory)));
    await app.press('id:desktop-schedules'); await app.waitFor('id:desktop-schedules-workspace');
    await app.host.send('navigation.test.storage.control', { action: 'release-journal-read' });
    await app.waitUntil(() => target(app)?.kind === 'home');
    expect(app.shows('id:composer')).toBe(false);
    expect(target(app)).toEqual({ kind: 'home', section: 'schedules' }); clean(fixture);
  });
  test(platform + ' late panel metadata restores the active session tabs before any empty panel snapshot can replace them', async () => {
    const fixture = createNavigationHost(), prior = panelEnvelope();
    const app = await open('./NavigationRoot.tsx', { platform, width: 1440, height: 900,
      storage: { [key]: envelope(session), [panelKey]: prior, 'desktop.layout.v1': JSON.stringify({ panelOpen: true }) },
      host: { params: { holdPanelMetadataRead: true }, handlers: fixture.handlers } });
    await app.waitFor('id:composer');
    expect(app.shows('id:native-desktop-panel')).toBe(false);
    expect(app.storage()[panelKey]).toBe(prior);
    await app.host.send('navigation.test.storage.control', { action: 'release-panel-read' });
    await app.waitFor('id:desktop-panel-tab-context');
    expect(app.shows('id:desktop-panel-context-content')).toBe(true);
    expect(app.storage()[panelKey]).toBe(prior);
    clean(fixture);
  });
  test(platform + ' failed panel metadata writes preserve prior and deny close until explicit retry saves the latest state', async () => {
    const fixture = createNavigationHost(), prior = panelEnvelope();
    const app = await open('./NavigationRoot.tsx', { platform, width: 1440, height: 900,
      storage: { [key]: envelope(session), [panelKey]: prior, 'desktop.layout.v1': JSON.stringify({ panelOpen: true }) },
      host: { params: { failPanelMetadataWrite: true }, handlers: fixture.handlers } });
    await app.waitFor('id:desktop-panel-tab-context');
    await app.press('id:desktop-panel-rail-files');
    await app.waitFor('id:desktop-panel-metadata-error');
    expect(app.storage()[panelKey]).toBe(prior);
    await app.host.send('desktop.window.closeRequested', { ticket: 'metadata:close:1', windowID: 'window', generation: 1, reason: 'close' });
    expect(fixture.decisions.at(-1)).toEqual({ ticket: 'metadata:close:1', approved: false });
    await app.host.send('navigation.test.storage.control', { action: 'recover-panel-write' });
    await app.press('id:desktop-panel-metadata-retry');
    await app.waitFor('id:desktop-panel-metadata-error', { state: 'gone' });
    expect(JSON.parse(app.storage()[panelKey]).scopes.find(row => row.scope.sessionID === identity.sessionID).rail).toBe('files');
    expect(app.storage()[panelKey]).not.toContain(identity.lease);
    clean(fixture);
  });
  for (const section of ['assistants', 'schedules'] as const) {
    const selector = section === 'assistants' ? 'id:desktop-assistants-workspace' : 'id:desktop-schedules-workspace';
    test(platform + ' production restores the complete ' + section + ' home without inventing a draft directory', async () => {
      const projection = { kind: 'home', section };
      const { app, fixture } = await launch(platform, projection);
      await app.waitFor(selector);
      expect(app.shows('id:new-session-composer')).toBe(false);
      expect(target(app)).toEqual(projection);
      expect(fixture.reads.filter(input => input.path.startsWith('/api/fs/list?'))).toHaveLength(0);
      clean(fixture);
    });
    test(platform + ' user selecting ' + section + ' wins a delayed restore and persists only the public section', async () => {
      const { app, fixture } = await launch(platform, session, { holdNavigationRead: true });
      await app.waitFor('id:new-session-composer');
      await app.press('id:desktop-' + section);
      await app.waitFor(selector);
      await app.host.send('navigation.test.storage.control', { action: 'release-read' });
      await app.waitUntil(() => target(app)?.kind === 'home');
      expect(target(app)).toEqual({ kind: 'home', section });
      expect(fixture.reads.filter(input => input.path.startsWith('/api/session/' + identity.sessionID + '?'))).toHaveLength(0);
      clean(fixture);
    });
  }
  test(platform + ' production root startup restores exact new-session directory without initial root publication erasing metadata', async () => {
    const projection = { kind: 'new-session', projectID: identity.projectID, directory: identity.directory };
    const { app, fixture } = await launch(platform, projection, { holdNavigationRead: true });
    await app.waitFor('id:new-session-composer');
    expect(app.storage()[key]).toBe(envelope(projection));
    expect(fixture.storage.some(event => event.phase === 'read-held')).toBe(true);
    await app.host.send('navigation.test.storage.control', { action: 'release-read' });
    await app.waitUntil(() => fixture.reads.some(input => input.path === '/api/fs/list?path=' + encodeURIComponent(identity.directory)));
    await app.waitFor('id:new-session-project');
    expect(app.texts()).toContain('Actual project');
    expect(target(app)).toEqual(projection); clean(fixture);
  });
  test(platform + ' production root restores real ProjectDetail with actual project authority', async () => {
    const projection = { kind: 'project', projectID: identity.projectID, directory: identity.directory };
    const { app, fixture } = await launch(platform, projection);
    await app.waitFor('text:Main workspace ✓');
    expect(app.texts()).toContain(identity.directory);
    expect(app.shows('id:new-session-composer')).toBe(false);
    expect(fixture.reads.some(input => input.path === '/api/fs/list?path=' + encodeURIComponent(identity.directory))).toBe(true);
    expect(target(app)).toEqual(projection); clean(fixture);
  });
  test(platform + ' production root restores session by exact metadata lookup and real Chat transcript', async () => {
    const { app, fixture } = await launch(platform);
    await app.waitFor('id:composer'); await app.waitFor('text:Verified saved session transcript');
    expect(app.shows('id:new-session-composer')).toBe(false);
    const reads = fixture.reads.filter(input => input.path === '/api/session/' + identity.sessionID + '?directory=' + encodeURIComponent(identity.directory));
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every(input => input.expectedHost?.hostID === identity.hostID && input.expectedHost?.lease === identity.lease)).toBe(true);
    expect(target(app)).toEqual(session); clean(fixture);
  });
  test(platform + ' production root 401 preserves prior and exact read retry restores Chat', async () => {
    const fixture = createNavigationHost(); fixture.failLookup(401);
    const app = await open('./NavigationRoot.tsx', { platform, width: 1440, height: 900, storage: { [key]: envelope(session) }, host: { handlers: fixture.handlers } });
    await app.waitFor('id:desktop-navigation-restore-retry');
    expect(app.storage()[key]).toBe(envelope(session)); expect(app.shows('id:new-session-composer')).toBe(true);
    expect(app.texts().join('\n')).not.toContain('/private/path');
    fixture.failLookup(200); await app.press('id:desktop-navigation-restore-retry');
    await app.waitFor('id:composer'); await app.waitFor('text:Verified saved session transcript');
    expect(target(app)).toEqual(session); clean(fixture);
  });
  test(platform + ' production explicit project selection and composer typing veto late startup restore without leaking draft/context into navigation', async () => {
    const { app, fixture } = await launch(platform, session, { holdNavigationRead: true });
    await app.waitFor('id:new-session-composer');
    expect(app.enabled('id:send')).toBe(false);
    await chooseDraftProject(app);
    await app.type('id:new-session-composer', 'Private draft must not enter navigation metadata');
    await app.host.send('navigation.test.storage.control', { action: 'release-read' });
    expect(app.value('id:new-session-composer')).toBe('Private draft must not enter navigation metadata');
    expect(app.shows('id:composer')).toBe(false);
    expect(fixture.reads.filter(input => input.path.startsWith('/api/session/' + identity.sessionID + '?'))).toHaveLength(0);
    expect(app.storage()[key]).not.toContain('Private draft');
    expect(app.storage()[key]).not.toContain('context'); clean(fixture);
  });
  test(platform + ' production edit after 401 permanently retires startup retry and preserves the editable page', async () => {
    const fixture = createNavigationHost(); fixture.failLookup(401);
    const app = await open('./NavigationRoot.tsx', { platform, width: 1440, height: 900, storage: { [key]: envelope(session) }, host: { handlers: fixture.handlers } });
    await app.waitFor('id:desktop-navigation-restore-retry');
    expect(app.storage()[key]).toBe(envelope(session));
    expect(app.enabled('id:send')).toBe(false);
    await chooseDraftProject(app);
    await app.type('id:new-session-composer', 'Keep the user editing here'); fixture.failLookup(200);
    expect(app.shows('id:desktop-navigation-restore-retry')).toBe(false);
    expect(app.shows('id:composer')).toBe(false); expect(app.value('id:new-session-composer')).toBe('Keep the user editing here');
    expect(fixture.reads.filter(input => input.path.startsWith('/api/session/' + identity.sessionID + '?'))).toHaveLength(1);
    clean(fixture);
  });
  test(platform + ' production project change signals intent before awaiting durable old-directory flush', async () => {
    const { app, fixture } = await launch(platform, session, { holdNavigationRead: true, holdDraftRead: true });
    await app.waitFor('id:new-session-composer');
    await chooseDraftProject(app);
    await app.waitUntil(() => fixture.storage.some(event => event.phase === 'draft-read-held'));
    await app.press('id:new-session-project'); await app.press('id:new-session-project-' + identity.chosenID);
    expect(app.texts()).not.toContain('What are we working on in Chosen project?');
    await app.host.send('navigation.test.storage.control', { action: 'release-read' });
    expect(app.shows('id:composer')).toBe(false);
    expect(fixture.reads.filter(input => input.path.startsWith('/api/session/' + identity.sessionID + '?'))).toHaveLength(0);
    await app.host.send('navigation.test.storage.control', { action: 'release-draft-read' });
    await app.waitFor('id:new-session-project-' + identity.chosenID, { state: 'gone' });
    await app.waitUntil(() => target(app)?.directory === identity.chosen);
    expect(target(app)).toEqual({ kind: 'new-session', directory: identity.chosen, projectID: identity.chosenID });
    clean(fixture);
  });
  test(platform + ' same connection ID and origin with changed authorization resets the old Chat, not just its request lease', async () => {
    const { app, fixture } = await launch(platform);
    await app.waitFor('text:Verified saved session transcript');
    const prior = app.storage()[key];
    await app.setLifecycle('background'); fixture.rotateAuthorization(); await app.setLifecycle('active');
    await app.waitFor('id:new-session-composer');
    expect(app.shows('id:composer')).toBe(false); expect(app.texts()).not.toContain('Verified saved session transcript');
    expect(app.value('id:new-session-composer')).toBe(''); expect(app.storage()[key]).toBe(prior);
    expect(app.enabled('id:send')).toBe(false);
    await chooseDraftProject(app);
    await app.type('id:new-session-composer', 'Only the new authorization draft');
    const entries = JSON.parse(app.storage()[key]).entries;
    expect(entries.find(entry => entry.partition.authorizationID === identity.authorizationID).target).toEqual(session);
    expect(entries.some(entry => entry.partition.authorizationID === 'navigation-rotated-auth' && entry.target.kind === 'new-session')).toBe(true);
    clean(fixture);
  });
  test(platform + ' superseded A then native switch B cannot publish B default over its saved metadata', async () => {
    const fixture = createNavigationHost();
    const otherPartition = { connectionID: otherIdentity.hostID, origin: otherIdentity.origin, authorizationID: otherIdentity.authorizationID };
    const otherEntry = { partition: otherPartition, target: session };
    const seed = JSON.stringify({ version: 1, entries: [{ partition, target: { kind: 'new-session', projectID: identity.projectID, directory: identity.directory } }, otherEntry] });
    const app = await open('./NavigationRoot.tsx', { platform, width: 1440, height: 900, storage: { [key]: seed }, host: { handlers: fixture.handlers } });
    await app.waitFor('id:new-session-composer'); await app.waitFor('text:What are we working on in Actual project?');
    await app.type('id:new-session-composer', 'Only A has user intent');
    await app.press('id:desktop-connections'); await app.press('text:Other navigation Host');
    await app.waitFor('id:new-session-composer');
    await app.waitUntil(() => fixture.reads.some(input => input.expectedHost?.hostID === otherIdentity.hostID && input.path === '/api/config/settings'));
    expect(app.value('id:new-session-composer')).toBe('');
    expect(JSON.parse(app.storage()[key]).entries.find(entry => entry.partition.connectionID === otherIdentity.hostID)).toEqual(otherEntry);
    expect(fixture.reads.filter(input => input.expectedHost?.hostID === otherIdentity.hostID && input.path.startsWith('/api/session/' + identity.sessionID + '?'))).toHaveLength(0);
    clean(fixture);
  });
  test(platform + ' a restored actual-project route persists the chosen owner project ID together with its directory', async () => {
    const { app, fixture } = await launch(platform, { kind: 'new-session', projectID: identity.projectID, directory: identity.directory });
    await app.waitFor('text:What are we working on in Actual project?');
    await app.waitUntil(() => app.enabled('id:new-session-project'));
    await app.press('id:new-session-project'); await app.press('id:new-session-project-' + identity.chosenID);
    await app.waitUntil(() => target(app)?.directory === identity.chosen);
    expect(target(app)).toEqual({ kind: 'new-session', projectID: identity.chosenID, directory: identity.chosen });
    clean(fixture);
  });
  test(platform + ' direct connect completion cannot overwrite the newly adopted Host navigation record', async () => {
    const fixture = createNavigationHost(), connects = [];
    const otherEntry = { partition: { connectionID: otherIdentity.hostID, origin: otherIdentity.origin, authorizationID: otherIdentity.authorizationID }, target: session };
    const seed = JSON.stringify({ version: 1, entries: [{ partition, target: { kind: 'new-session', projectID: identity.projectID, directory: identity.directory } }, otherEntry] });
    fixture.handlers['connection.connect'] = input => {
      expect(input).toEqual({ pairingLink: '', url: otherIdentity.origin, password: '', token: '', label: '' });
      connects.push(input);
      return { ...fixture.handlers['connection.select']({ id: otherIdentity.hostID }), runtimeInvalidated: true };
    };
    const app = await open('./NavigationRoot.tsx', { platform, width: 1440, height: 900, storage: { [key]: seed }, host: { handlers: fixture.handlers } });
    await app.waitFor('id:new-session-composer'); await app.waitFor('text:What are we working on in Actual project?');
    await app.press('id:desktop-connections'); await app.press('id:connection-manual');
    await app.type('id:server-url', otherIdentity.origin); await app.press('id:connection-submit');
    await app.waitFor('id:new-session-composer'); await app.waitUntil(() => app.enabled('id:new-session-project'));
    expect(connects).toHaveLength(1);
    expect(JSON.parse(app.storage()[key]).entries.find(entry => entry.partition.connectionID === otherIdentity.hostID)).toEqual(otherEntry);
    expect(fixture.reads.filter(input => input.expectedHost?.hostID === otherIdentity.hostID && input.path.startsWith('/api/session/' + identity.sessionID + '?'))).toHaveLength(0);
    clean(fixture);
  });
  test(platform + ' production successful navigation saves only public projection and native close flush failure denies without disposal', async () => {
    const projection = { kind: 'new-session', directory: identity.directory };
    const { app, fixture } = await launch(platform, projection);
    await app.waitFor('id:new-session-composer');
    await app.type('id:new-session-composer', 'Retained across denied native close');
    await app.host.send('navigation.test.storage.control', { action: 'fail-write' });
    await app.press('id:new-session-project'); await app.press('id:new-session-project-' + identity.chosenID);
    await app.waitFor('id:new-session-project-' + identity.chosenID, { state: 'gone' });
    await app.waitUntil(() => fixture.storage.some(event => event.phase === 'write-rejected'));
    expect(app.storage()[key]).toBe(envelope(projection));
    await app.type('id:new-session-composer', 'Chosen owner survives close rejection');
    await app.host.send('desktop.window.closeRequested', { ticket: 'navigation:close:1', windowID: 'navigation-window', generation: 1, reason: 'close' });
    expect(fixture.decisions).toEqual([{ ticket: 'navigation:close:1', approved: false }]);
    expect(app.shows('id:new-session-composer')).toBe(true);
    expect(app.value('id:new-session-composer')).toBe('Chosen owner survives close rejection');
    await app.type('id:new-session-composer', ' · still writable after denied close');
    expect(app.value('id:new-session-composer')).toBe('Chosen owner survives close rejection · still writable after denied close');
    await app.host.send('navigation.test.storage.control', { action: 'recover-write' });
    const readsBeforeRetry = fixture.reads.length;
    await app.press('id:desktop-navigation-write-retry');
    await app.waitFor('id:desktop-navigation-write-retry', { state: 'gone' });
    expect(fixture.reads.length).toBe(readsBeforeRetry);
    expect(app.value('id:new-session-composer')).toBe('Chosen owner survives close rejection · still writable after denied close');
    await app.host.send('desktop.window.closeRequested', { ticket: 'navigation:close:2', windowID: 'navigation-window', generation: 2, reason: 'close' });
    expect(fixture.decisions[1]).toEqual({ ticket: 'navigation:close:2', approved: true });
    expect(target(app)).toEqual({ kind: 'new-session', directory: identity.chosen, projectID: identity.chosenID });
    const entry = JSON.parse(app.storage()[key]).entries[0];
    expect(Object.keys(entry).sort()).toEqual(['partition', 'target']);
    expect(Object.keys(entry.target).sort()).toEqual(['directory', 'kind', 'projectID']);
    expect(app.storage()[key]).not.toContain('Chosen owner survives'); expect(app.storage()[key]).not.toContain('context'); clean(fixture);
  });
}
