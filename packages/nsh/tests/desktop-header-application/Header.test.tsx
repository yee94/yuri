import { expect, open, test } from 'nsh/test';
import { createHeaderHost, navigationRecord, draftKey, draftRecord } from './Host.js';
import { navigationIdentity as identity } from '../desktop-application/NavigationHost.js';

async function launch(platform, params = {}, options = {}) {
  const fixture = createHeaderHost(options), gates = [];
  const storage = { 'desktop.navigation.v1': navigationRecord, [draftKey]: draftRecord('Keep header draft') };
  if (options.dirtyFile) {
    const scope = { host: { hostID: identity.hostID }, authorityKey: JSON.stringify([identity.hostID, identity.origin, identity.authorizationID]), sessionID: identity.sessionID, directory: identity.directory };
    const path = identity.directory + '/readme.md', id = JSON.stringify(['file', path]);
    const key = 'desktop-file-journal-v1:' + JSON.stringify([JSON.stringify([identity.hostID, scope.authorityKey, identity.sessionID, identity.directory]), path]);
    fixture.handlers['desktop.files.journal.commit']({ expectedVersion: 0, requestID: 'seed-header-dirty', records: { [key]: JSON.stringify({ version: 1, scope, path, text: 'Keep Header protected file', base: 'Prior Host file', wire: 'Prior Host file', eol: '\n', bom: false, pending: null, conflict: false }) } });
    storage['desktop.panel-tabs.v1'] = JSON.stringify({ version: 1, scopes: [{ scope, tabs: [{ kind: 'file', path, id }], selectedID: id, rail: null, activeView: 'preview' }] });
    storage['desktop.layout.v1'] = JSON.stringify({ panelOpen: true });
  }
  fixture.handlers['header.application.gate'] = value => { gates.push(value); };
  const app = await open('./Root.tsx', { platform, clock: {}, width: 1440, height: 900,
    storage, host: { params, handlers: fixture.handlers } });
  await app.waitFor('id:composer'); await app.waitFor('id:desktop-chat-header-context-ring');
  return { app, fixture, gates };
}
async function instances(app) {
  await app.press('id:desktop-chat-header-menu'); await app.press('id:desktop-chat-header-menu-instance');
  await app.waitFor('id:desktop-header-services-instance-row-connection:navigation-root');
  await app.waitUntil(() => app.enabled('id:desktop-header-services-instance-switch-connection:navigation-other'));
}
async function usage(app) {
  await app.press('id:desktop-chat-header-menu'); await app.press('id:desktop-chat-header-menu-usage');
  await app.waitFor('id:desktop-chat-header-quota-provider-magpie:header:cursor');
}
async function mcp(app) {
  await app.press('id:desktop-chat-header-menu'); await app.press('id:desktop-chat-header-menu-instance');
  await app.press('id:desktop-chat-header-tab-mcp'); await app.waitFor('id:desktop-header-services-mcp-toggle-Alpha');
  await app.waitUntil(() => app.enabled('id:desktop-header-services-mcp-refresh'));
}
for (const platform of ['macos', 'windows'] as const) {
  test(platform + ' actual native close prepares the original Chat without release and a rejected decision restores its editable draft', async () => {
    const { app, fixture } = await launch(platform, {}, { rejectFirstClose: true });
    await app.type('id:composer', ' before close');
    const held = fixture.writer.held(); expect(held).toHaveLength(1);
    await app.host.send('desktop.window.closeRequested', { ticket: 'writer-close-rejected', windowID: 'synthetic-writer-window', generation: 1, reason: 'close' });
    await app.waitUntil(() => fixture.decisions.length === 1);
    expect(fixture.decisions[0]).toEqual({ ticket: 'writer-close-rejected', approved: true });
    await app.type('id:composer', ' after cancellation');
    expect(app.value('id:composer')).toBe('Keep header draft before close after cancellation');
    expect(fixture.writer.held()).toEqual(held); expect(fixture.writer.calls.filter(call => call.name === 'release')).toEqual([]);
    await app.host.send('desktop.window.closeRequested', { ticket: 'writer-close-accepted', windowID: 'synthetic-writer-window', generation: 2, reason: 'close' });
    await app.waitUntil(() => fixture.decisions.length === 2);
    expect(fixture.decisions[1]).toEqual({ ticket: 'writer-close-accepted', approved: true });
    expect(fixture.writer.held()).toEqual(held); expect(fixture.writer.calls.filter(call => call.name === 'release')).toEqual([]);
    expect(JSON.parse(app.storage()[draftKey]).draft).toBe('Keep header draft before close after cancellation');
    expect(fixture.writer.calls.filter(call => call.name === 'acquire')).toHaveLength(1);
    expect(fixture.rejected).toEqual([]); expect(fixture.mutations).toEqual([]);
  });
  test(platform + ' actual Chat waits for verified writer ACK before constructing or restoring its durable draft', async () => {
    const fixture = createHeaderHost(), gates = [];
    const app = await open('./Root.tsx', { platform, width: 1440, height: 900,
      storage: { 'desktop.navigation.v1': navigationRecord, [draftKey]: draftRecord('Keep verified writer draft') },
      host: { params: { holdChatWriter: true }, handlers: { ...fixture.handlers, 'header.application.gate': event => gates.push(event) } } });
    await app.waitFor('id:desktop-chat-writer-waiting'); await app.waitUntil(() => gates.some(event => event.phase === 'writer-held'));
    expect(app.shows('id:composer')).toBe(false); expect(gates.filter(event => event.phase === 'draft-read')).toEqual([]);
    const claims = () => fixture.writer.calls.filter(call => call.name === 'acquire');
    expect(claims()).toHaveLength(1); expect(claims()[0].value.target).toEqual({ kind: 'session', id: identity.sessionID });
    await app.host.send('header.application.control', { action: 'release-writer' });
    await app.waitFor('id:composer'); await app.waitUntil(() => app.value('id:composer') === 'Keep verified writer draft');
    expect(gates.filter(event => event.phase === 'draft-read' && event.key === draftKey)).toHaveLength(1);
    await app.press('id:desktop-settings'); await app.waitFor('id:desktop-settings-window');
    await app.press('id:desktop-settings-close'); await app.waitFor('id:desktop-settings-window', { state: 'gone' });
    for (let index = 0; index < 50; index++) await app.type('id:composer', 'x');
    expect(claims()).toHaveLength(1); expect(fixture.writer.calls.filter(call => call.name === 'renew' || call.name === 'release')).toEqual([]);
    expect(fixture.rejected).toEqual([]); expect(fixture.mutations).toEqual([]);
  });
  test(platform + ' actual About and Header share the confirmed version source and do not admit update writes', async () => {
    const { app, fixture } = await launch(platform);
    expect(fixture.aboutReads).toEqual([]);
    await instances(app); await app.waitUntil(() => app.texts().includes('2.3.0') && app.enabled('id:desktop-header-services-instance-refresh'));
    expect(app.shows('id:desktop-header-services-update')).toBe(false);
    const statuses = () => fixture.aboutReads.filter(read => read.path === '/api/system/update').length;
    expect(statuses()).toBe(1);
    await app.keyboard.press('escape'); await app.press('id:desktop-settings'); await app.waitFor('id:desktop-settings-window');
    await app.press('id:desktop-settings-page:about'); await app.waitFor('id:about-host-version');
    await app.waitUntil(() => app.texts().includes('2.3.0'));
    expect(statuses()).toBe(1); expect(app.shows('id:about-host-update-unavailable')).toBe(true);
    fixture.aboutFailure(true); await app.press('id:about-refresh');
    await app.waitUntil(() => statuses() === 2 && app.enabled('id:about-refresh'));
    expect(app.texts()).toContain('2.3.0');
    await app.press('id:desktop-settings-close'); await app.waitFor('id:desktop-settings-window', { state: 'gone' });
    const reads = fixture.aboutReads.length;
    for (let index = 0; index < 50; index++) { await app.clear('id:composer'); await app.paste('id:composer', { text: `Shared About draft ${index}` }); }
    expect(fixture.aboutReads).toHaveLength(reads); expect(fixture.mutations).toEqual([]); expect(fixture.rejected).toEqual([]);
  });
  test(platform + ' actual GitHub Settings first failed status read retains the Header-confirmed account and stale state', async () => {
    const { app, fixture } = await launch(platform, {}, { github: true });
    await app.waitFor('id:desktop-header-github-menu');
    await app.press('id:desktop-header-github-menu'); await app.press('id:desktop-header-github-account-oauth-b');
    await app.waitUntil(() => fixture.githubWrites.length === 1 && app.enabled('id:desktop-header-github-menu'));
    fixture.githubFailure(true);
    await app.press('id:desktop-settings'); await app.waitFor('id:desktop-settings-window'); await app.press('id:desktop-settings-page:git');
    await app.waitFor('id:github-current'); await app.waitUntil(() => fixture.githubReads.length === 2 && app.enabled('id:github-refresh'));
    expect(app.texts()).toContain('b'); expect(app.shows('id:github-stale')).toBe(true); expect(fixture.githubWrites).toHaveLength(1);
    expect(fixture.rejected).toEqual([]); expect(fixture.mutations).toEqual([]);
  });
  test(platform + ' actual Header and original Git Settings select through one GitHub source without reading on composer edits', async () => {
    const { app, fixture } = await launch(platform, {}, { github: true });
    await app.waitFor('id:desktop-header-github-menu'); expect(fixture.githubReads).toHaveLength(1);
    for (let index = 0; index < 50; index++) { await app.clear('id:composer'); await app.paste('id:composer', { text: `Shared GitHub draft ${index}` }); }
    expect(fixture.githubReads).toHaveLength(1); expect(fixture.githubWrites).toEqual([]);
    await app.press('id:desktop-header-github-menu'); await app.press('id:desktop-header-github-account-oauth-a');
    expect(fixture.githubWrites).toEqual([]);
    await app.press('id:desktop-header-github-menu'); await app.press('id:desktop-header-github-account-oauth-b');
    await app.waitUntil(() => fixture.githubWrites.length === 1 && app.enabled('id:desktop-header-github-menu'));
    expect(fixture.githubWrites[0].body).toEqual({ accountId: 'b' });
    await app.press('id:desktop-settings'); await app.waitFor('id:desktop-settings-window');
    await app.press('id:desktop-settings-page:git'); await app.waitFor('id:github-current');
    expect(app.texts()).toContain('b'); expect(app.enabled('id:desktop-header-github-menu')).toBe(false);
    await app.press('id:github-activate-oauth-a'); await app.waitFor('id:github-activate-oauth-b');
    expect(fixture.githubWrites).toHaveLength(2);
    await app.press('id:desktop-settings-close'); await app.waitFor('id:desktop-settings-window', { state: 'gone' });
    await app.press('id:desktop-header-github-menu'); expect(app.texts()).toContain('Synthetic a');
    expect(app.value('id:composer')).toBe('Shared GitHub draft 49'); expect(fixture.rejected).toEqual([]); expect(fixture.mutations).toEqual([]);
  });
  test(platform + ' actual unknown GitHub activation vetoes Host switch, route departure and final native close without replay', async () => {
    const { app, fixture } = await launch(platform, {}, { github: true });
    await app.waitFor('id:desktop-header-github-menu'); fixture.githubUnknown(true);
    await app.press('id:desktop-header-github-menu'); await app.press('id:desktop-header-github-account-oauth-b');
    await app.waitUntil(() => fixture.githubWrites.length === 1 && !app.enabled('id:desktop-header-github-menu'));
    await app.press('id:desktop-chat-header-menu'); await app.press('id:desktop-chat-header-menu-instance');
    await app.waitFor('id:desktop-header-services-instance-row-connection:navigation-other');
    expect(app.enabled('id:desktop-header-services-instance-switch-connection:navigation-other')).toBe(false);
    await app.keyboard.press('escape'); await app.press('id:desktop-schedules');
    expect(app.shows('id:desktop-schedules-workspace')).toBe(false); expect(app.value('id:composer')).toBe('Keep header draft');
    await app.host.send('desktop.window.closeRequested', { ticket: 'github:unknown', windowID: 'window', generation: 1, reason: 'close' });
    await app.waitUntil(() => fixture.decisions.length === 1);
    expect(fixture.decisions[0]).toEqual({ ticket: 'github:unknown', approved: false });
    expect(fixture.githubWrites).toHaveLength(1); expect(app.host.calls().filter(call => call.name === 'connection.select')).toEqual([]);
    expect(fixture.rejected).toEqual([]); expect(fixture.mutations).toEqual([]);
  });
  for (const retire of ['settings', 'route'] as const) {
    test(platform + ' actual Header held file approval cannot revive after external ' + retire + ' retirement', async () => {
      const { app, fixture, gates } = await launch(platform, { holdHeaderConfirmation: true }, { dirtyFile: true });
      await app.waitFor('id:desktop-file-editor'); app.onDialog(() => 'Discard'); await instances(app);
      await app.press('id:desktop-header-services-instance-switch-connection:navigation-other');
      await app.waitUntil(() => gates.some(value => value.phase === 'confirmation-held'));
      expect(app.host.calls().filter(call => call.name === 'connection.select')).toEqual([]);
      if (retire === 'settings') {
        await app.press('id:desktop-settings'); await app.waitFor('id:desktop-settings-window');
        await app.press('id:desktop-settings-close'); await app.waitFor('id:desktop-settings-window', { state: 'gone' });
      } else {
        await app.press('id:desktop-schedules'); await app.waitFor('id:desktop-schedules-workspace');
      }
      await app.host.send('header.application.control', { action: 'release-confirmation' });
      expect(app.host.calls().filter(call => call.name === 'connection.select')).toEqual([]);
      if (retire === 'settings') expect(app.value('id:composer')).toBe('Keep header draft');
      else expect(app.shows('id:desktop-schedules-workspace')).toBe(true);
      expect(fixture.rejected).toEqual([]); expect(fixture.mutations).toEqual([]);
    });
  }
  test(platform + ' actual Header same-target switch is a zero-select no-op and Add opens original instance Settings', async () => {
    const { app, fixture } = await launch(platform); await instances(app);
    await app.press('id:desktop-header-services-instance-switch-connection:navigation-root');
    expect(app.host.calls().filter(call => call.name === 'connection.select')).toEqual([]);
    expect(app.value('id:composer')).toBe('Keep header draft');
    await app.press('id:desktop-header-services-instance-add'); await app.waitFor('id:desktop-settings-window');
    expect(app.texts()).toContain('Saved connections'); expect(app.texts()).toContain('Other navigation Host');
    await app.press('id:desktop-settings-close'); await app.waitFor('id:desktop-settings-window', { state: 'gone' });
    expect(app.value('id:composer')).toBe('Keep header draft'); expect(fixture.rejected).toEqual([]); expect(fixture.mutations).toEqual([]);
  });
  test(platform + ' actual Header clean switch uses exactly the selected native connection without a second source', async () => {
    const { app, fixture } = await launch(platform); await instances(app);
    await app.press('id:desktop-header-services-instance-switch-connection:navigation-other');
    await app.waitUntil(() => app.host.calls().filter(call => call.name === 'connection.select').length === 1);
    await app.waitFor('id:new-session-composer');
    expect(app.host.calls().filter(call => call.name === 'connection.select')[0].data).toEqual({ id: 'navigation-other' });
    expect(app.shows('id:desktop-chat-header-services')).toBe(false);
    expect(fixture.rejected).toEqual([]); expect(fixture.mutations).toEqual([]);
  });
  test(platform + ' actual Header dirty file Cancel retains its editor and Discard transfers the admitted action after its own popup closes', async () => {
    const { app, fixture } = await launch(platform, {}, { dirtyFile: true });
    await app.waitFor('id:desktop-file-editor'); let confirmations = 0;
    app.onDialog(() => { confirmations++; return 'Cancel'; }); await instances(app);
    await app.press('id:desktop-header-services-instance-switch-connection:navigation-other');
    await app.waitUntil(() => confirmations === 1);
    expect(app.host.calls().filter(call => call.name === 'connection.select')).toEqual([]);
    expect(app.texts()).toContain('Keep Header protected file'); expect(app.value('id:composer')).toBe('Keep header draft');
    expect(app.shows('id:desktop-chat-header-services')).toBe(false);
    app.onDialog(() => { confirmations++; return 'Discard'; }); await instances(app);
    await app.press('id:desktop-header-services-instance-switch-connection:navigation-other');
    await app.waitUntil(() => app.host.calls().filter(call => call.name === 'connection.select').length === 1);
    expect(confirmations).toBe(2); await app.waitFor('id:new-session-composer');
    expect(fixture.rejected).toEqual([]); expect(fixture.mutations).toEqual([]);
  });
  test(platform + ' actual Instance tab projects only the committed root connection and refreshes without another Host read', async () => {
    const { app, fixture } = await launch(platform);
    const reads = fixture.reads.length;
    await app.press('id:desktop-chat-header-menu'); await app.press('id:desktop-chat-header-menu-instance');
    await app.waitFor('id:desktop-header-services-instance-row-connection:navigation-root');
    expect(app.texts()).toContain('Navigation test Host');
    expect(app.enabled('id:desktop-header-services-instance-default-connection:navigation-root')).toBe(false);
    expect(app.enabled('id:desktop-header-services-instance-new-window-connection:navigation-root')).toBe(false);
    await app.waitUntil(() => app.enabled('id:desktop-header-services-instance-refresh'));
    expect(app.count('id:desktop-header-services-update')).toBe(0); expect(app.texts()).toContain('2.3.0');
    await app.press('id:desktop-header-services-instance-refresh');
    expect(fixture.reads.filter(read => !['/api/system/info', '/api/system/update', '/api/opencode/upgrade-status'].includes(read.path))).toHaveLength(reads);
    expect(fixture.quotas).toEqual([]); expect(fixture.servicesReads).toEqual([]);
    await app.keyboard.press('escape'); await app.waitFor('id:desktop-chat-header-services', { state: 'gone' });
    expect(app.value('id:composer')).toBe('Keep header draft'); expect(fixture.rejected).toEqual([]); expect(fixture.mutations).toEqual([]);
  });
  test(platform + ' actual quota family expansion survives Usage popup remount and Settings without reading during input', async () => {
    const { app, fixture } = await launch(platform, {}, { families: true });
    await usage(app); await app.waitFor('id:desktop-chat-header-quota-family-google-gemini-auth');
    expect(app.shows('id:desktop-chat-header-quota-fill-model:gemini/root-family:weekly')).toBe(false);
    await app.press('id:desktop-chat-header-quota-family-google-gemini-auth');
    expect(app.shows('id:desktop-chat-header-quota-fill-model:gemini/root-family:weekly')).toBe(true);
    expect(app.shows('id:desktop-chat-header-quota-fill-model:antigravity/root-family:weekly')).toBe(false);
    expect(app.shows('id:desktop-chat-header-quota-marker-model:gemini/root-family:weekly')).toBe(true);
    expect(app.shows('id:desktop-chat-header-quota-pace-model:gemini/root-family:weekly')).toBe(true);
    expect(app.shows('id:desktop-chat-header-quota-updated')).toBe(true);
    const quotaReads = fixture.quotas.length, reads = fixture.reads.length;
    await app.keyboard.press('escape'); await app.waitFor('id:desktop-chat-header-services', { state: 'gone' });
    for (let index = 0; index < 50; index++) { await app.clear('id:composer'); await app.paste('id:composer', { text: `Quota family root draft ${index}` }); }
    expect(fixture.quotas).toHaveLength(quotaReads); expect(fixture.reads).toHaveLength(reads);
    await usage(app); expect(app.shows('id:desktop-chat-header-quota-fill-model:gemini/root-family:weekly')).toBe(true);
    await app.press('id:desktop-settings'); await app.waitFor('id:desktop-settings-window');
    expect(app.shows('id:desktop-chat-header-services')).toBe(false);
    await app.press('id:desktop-settings-close'); await app.waitFor('id:desktop-settings-window', { state: 'gone' });
    await usage(app); expect(app.shows('id:desktop-chat-header-quota-fill-model:gemini/root-family:weekly')).toBe(true);
    expect(app.shows('id:desktop-chat-header-quota-fill-model:antigravity/root-family:weekly')).toBe(false);
    expect(fixture.quotas).toHaveLength(quotaReads); expect(app.value('id:composer')).toBe('Quota family root draft 49');
    expect(fixture.rejected).toEqual([]); expect(fixture.mutations).toEqual([]);
  });
  test(platform + ' actual services modal revokes a held MCP response without a remount, follow-up read or lost draft', async () => {
    const { app, fixture, gates } = await launch(platform, { holdMcpStatus: true });
    await app.press('id:desktop-chat-header-menu'); await app.press('id:desktop-chat-header-menu-instance');
    await app.press('id:desktop-chat-header-tab-mcp'); await app.waitUntil(() => gates.filter(value => value.phase === 'held').length === 1);
    expect(fixture.servicesReads).toHaveLength(2);
    await app.press('id:desktop-settings'); await app.waitFor('id:desktop-settings-window');
    await app.host.send('header.application.control', { action: 'release-mcp' });
    expect(fixture.servicesReads).toHaveLength(2); expect(fixture.servicesWrites).toEqual([]);
    expect(app.count('id:composer')).toBe(1); expect(app.value('id:composer')).toBe('Keep header draft');
    await app.press('id:desktop-settings-close'); await app.waitFor('id:desktop-settings-window', { state: 'gone' });
    expect(app.shows('id:desktop-chat-header-services')).toBe(false); expect(fixture.servicesReads).toHaveLength(2);
    await mcp(app); expect(fixture.servicesReads).toHaveLength(4); expect(app.enabled('id:desktop-header-services-mcp-toggle-Alpha')).toBe(true);
    expect(fixture.rejected).toEqual([]); expect(fixture.mutations).toEqual([]);
  });
  test(platform + ' actual header services read only the visible MCP tab, preserve failed prior and do no work for fifty edits after close', async () => {
    const { app, fixture } = await launch(platform); expect(fixture.servicesReads).toEqual([]);
    await mcp(app); expect(fixture.servicesReads).toHaveLength(2); expect(fixture.quotas).toEqual([]);
    expect(app.shows('id:desktop-header-services-mcp-row-Beta')).toBe(true);
    fixture.mcpFailure(true); await app.press('id:desktop-header-services-mcp-refresh'); await app.waitFor('id:desktop-header-services-error');
    expect(app.shows('id:desktop-header-services-mcp-row-Alpha')).toBe(true); expect(app.shows('id:desktop-header-services-mcp-row-Beta')).toBe(true);
    expect(app.enabled('id:desktop-header-services-mcp-toggle-Alpha')).toBe(false);
    fixture.mcpFailure(false); await app.press('id:desktop-header-services-mcp-refresh');
    await app.waitUntil(() => app.enabled('id:desktop-header-services-mcp-toggle-Alpha'));
    await app.press('id:desktop-chat-header-tab-instance'); const reads = fixture.servicesReads.length;
    await app.press('id:desktop-settings'); await app.waitFor('id:desktop-settings-window');
    await app.press('id:desktop-settings-close'); await app.waitFor('id:desktop-settings-window', { state: 'gone' });
    expect(app.shows('id:desktop-chat-header-services')).toBe(false); expect(fixture.servicesReads).toHaveLength(reads);
    for (let index = 0; index < 50; index++) { await app.clear('id:composer'); await app.paste('id:composer', { text: `Retained services draft ${index}` }); }
    expect(fixture.servicesReads).toHaveLength(reads); expect(fixture.servicesWrites).toEqual([]);
    expect(app.value('id:composer')).toBe('Retained services draft 49'); expect(app.count('id:composer')).toBe(1);
    await mcp(app); expect(fixture.servicesReads).toHaveLength(reads + 2); expect(app.shows('id:desktop-header-services-mcp-row-Beta')).toBe(true);
    expect(fixture.rejected).toEqual([]); expect(fixture.mutations).toEqual([]);
  });
  test(platform + ' actual MCP unknown write is retained across popup dismissal and explicitly reconciled without replay', async () => {
    const { app, fixture } = await launch(platform); await mcp(app); fixture.mcpUnknown(true);
    await app.press('id:desktop-header-services-mcp-toggle-Alpha'); await app.waitFor('id:desktop-header-services-mcp-retry-Alpha');
    expect(fixture.servicesWrites).toHaveLength(1); expect(app.enabled('id:desktop-header-services-mcp-toggle-Alpha')).toBe(false);
    expect(app.enabled('id:desktop-header-services-mcp-toggle-Beta')).toBe(true);
    await app.keyboard.press('escape'); await app.waitFor('id:desktop-chat-header-services', { state: 'gone' });
    await mcp(app); expect(fixture.servicesWrites).toHaveLength(1);
    expect(app.enabled('id:desktop-header-services-mcp-toggle-Alpha')).toBe(false);
    fixture.mcpUnknown(false); await app.press('id:desktop-header-services-mcp-retry-Alpha');
    await app.waitUntil(() => app.enabled('id:desktop-header-services-mcp-toggle-Alpha'));
    expect(fixture.servicesWrites).toHaveLength(1);
    await app.press('id:desktop-header-services-mcp-toggle-Alpha');
    await app.waitUntil(() => fixture.servicesWrites.length === 2 && app.enabled('id:desktop-header-services-mcp-toggle-Alpha'));
    expect(fixture.servicesWrites[0].path).toContain('/connect?'); expect(fixture.servicesWrites[1].path).toContain('/disconnect?');
    expect(app.value('id:composer')).toBe('Keep header draft'); expect(fixture.rejected).toEqual([]); expect(fixture.mutations).toEqual([]);
  });
  test(platform + ' header opens the actual empty browser without a guessed URL, native viewport or system fallback', async () => {
    const { app, fixture } = await launch(platform);
    await app.press('id:desktop-chat-header-menu'); await app.press('id:desktop-chat-header-menu-browser');
    await app.waitFor('id:native-desktop-browser-pane');
    expect(app.value('id:desktop-browser-address')).toBe(''); expect(app.count('id:desktop-browser-viewport')).toBe(0);
    expect(app.enabled('id:desktop-browser-reload')).toBe(false); expect(app.enabled('id:desktop-browser-external')).toBe(false);
    await app.paste('id:desktop-browser-address', { text: 'http://localhost:3000/retained' });
    await app.press('id:desktop-settings'); await app.waitFor('id:desktop-settings-window');
    expect(app.enabled('id:desktop-browser-go')).toBe(false);
    await app.press('id:desktop-settings-close'); await app.waitFor('id:desktop-settings-window', { state: 'gone' });
    expect(app.value('id:desktop-browser-address')).toBe('http://localhost:3000/retained');
    await app.press('id:desktop-chat-header-menu'); await app.press('id:desktop-chat-header-menu-browser');
    await app.waitFor('id:native-desktop-browser-pane', { state: 'gone' });
    await app.press('id:desktop-chat-header-menu'); await app.press('id:desktop-chat-header-menu-browser');
    await app.waitFor('id:native-desktop-browser-pane');
    expect(app.value('id:desktop-browser-address')).toBe('http://localhost:3000/retained'); expect(app.count('id:desktop-browser-viewport')).toBe(0);
    const rows = JSON.parse(app.storage()['desktop.panel-tabs.v1']).scopes.flatMap(row => row.tabs).filter(tab => tab.kind === 'browser');
    expect(rows).toHaveLength(1); expect(rows[0].url).toBe('');
    expect(app.value('id:composer')).toBe('Keep header draft'); expect(fixture.quotas).toEqual([]);
    expect(fixture.rejected).toEqual([]); expect(fixture.mutations).toEqual([]); expect(app.requests()).toEqual([]);
  });
  test(platform + ' actual Chat publishes one bounded metadata owner, no hidden mobile header and zero reads for fifty edits', async () => {
    const { app, fixture } = await launch(platform);
    // Main history and the one bounded header source each have an authoritative read.
    expect(fixture.metadata).toHaveLength(2); expect(fixture.lightStatus).toHaveLength(1); expect(fixture.quotas).toEqual([]);
    expect(app.count('id:chat-header-options')).toBe(0); expect(app.count('id:chat-header-metadata')).toBe(0);
    expect(app.count('id:desktop-terminal-toggle')).toBe(0); expect(app.count('id:desktop-context-toggle')).toBe(0);
    await app.hover('id:desktop-chat-header-context'); await app.waitFor('id:desktop-chat-header-context-detail');
    expect(app.texts()).toContain('15.0%  150/1.0K');
    const reads = fixture.reads.length;
    for (let index = 0; index < 50; index++) { await app.clear('id:composer'); await app.paste('id:composer', { text: 'Keep header draft' + 'x'.repeat(index + 1) }); }
    expect(fixture.reads).toHaveLength(reads); expect(fixture.metadata).toHaveLength(2); expect(fixture.lightStatus).toHaveLength(1); expect(fixture.quotas).toEqual([]);
    expect(app.value('id:composer')).toBe('Keep header draft' + 'x'.repeat(50));
    await app.press('id:desktop-chat-header-context'); await app.waitFor('id:desktop-context-summary');
    expect(app.count('id:composer')).toBe(1); expect(app.value('id:composer')).toBe('Keep header draft' + 'x'.repeat(50));
    expect(fixture.rejected).toEqual([]); expect(fixture.mutations).toEqual([]);
  });

  test(platform + ' actual usage is explicit, modal retains context and quota prior, failures stay visible and mode is not optimistic', async () => {
    const { app, fixture } = await launch(platform);
    await usage(app); expect(app.texts()).toContain('25%'); expect(fixture.quotas).toHaveLength(2);
    expect(app.enabled('id:desktop-chat-header-quota-remaining')).toBe(false);
    await app.keyboard.press('escape'); await app.waitFor('id:desktop-chat-header-services', { state: 'gone' });
    await app.press('id:desktop-settings'); await app.waitFor('id:desktop-settings-window');
    expect(app.shows('id:desktop-chat-header-context-ring')).toBe(true); expect(app.enabled('id:desktop-chat-header-context')).toBe(false);
    expect(fixture.metadata).toHaveLength(2); expect(fixture.lightStatus).toHaveLength(1); expect(fixture.quotas).toHaveLength(2);
    await app.press('id:desktop-settings-close'); await app.waitFor('id:desktop-settings-window', { state: 'gone' });
    expect(fixture.metadata).toHaveLength(2); expect(fixture.lightStatus).toHaveLength(1); expect(app.value('id:composer')).toBe('Keep header draft');
    fixture.offline(true); await usage(app); await app.press('id:desktop-chat-header-quota-refresh');
    await app.waitUntil(() => app.enabled('id:desktop-chat-header-quota-refresh'));
    expect(app.texts()).toContain('25%'); expect(app.texts()).toContain('Showing the last known status. Latest status is still updating.');
    expect(app.texts()).not.toContain('No rate limits reported.'); expect(fixture.quotas).toHaveLength(4);
    fixture.offline(false); await app.press('id:desktop-chat-header-quota-refresh');
    await app.waitUntil(() => app.enabled('id:desktop-chat-header-quota-refresh'));
    expect(fixture.quotas).toHaveLength(6); expect(app.texts()).toContain('25%');
    expect(app.texts()).not.toContain('Showing the last known status. Latest status is still updating.');
    expect(fixture.metadata).toHaveLength(2); expect(fixture.lightStatus).toHaveLength(1); expect(fixture.rejected).toEqual([]); expect(fixture.mutations).toEqual([]);
  });
}
