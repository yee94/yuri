import { expect, open, test } from 'nsh/test';
import { attachment, createCommandsHost, createBtwHost, createContentLinksHost, createDraftCommandsHost, createEmbeddedHost, createEmbeddedToolsHost, createHistoryHost, createPanelStreamHost, draftKey, draftRecord, navigationRecord, panelRecord, contextRecord, embeddedToolsRecord, newDraftKey, newDraftNavigation, identity } from './Host.js';
import { createCompactHost } from '../local-compact-writer/host.js';

async function launch(platform, text, files = []) {
  const fixture = createCommandsHost();
  const app = await open('./Root.tsx', { platform, width: 1440, height: 900,
    storage: { 'desktop.navigation.v1': navigationRecord, [draftKey]: draftRecord(text, files) }, host: { handlers: fixture.handlers } });
  await app.waitFor('id:composer'); await app.waitUntil(() => app.enabled('id:chat-agent-selection') && app.enabled('id:send'));
  return { app, fixture };
}
for (const platform of ['macos', 'windows'] as const) {
  test(platform + ' actual main body opens exact file and Host loopback panel without system fallback or changing the writer', async () => {
    const fixture = createContentLinksHost();
    const app = await open('./Root.tsx', { platform, width: 1440, height: 900,
      storage: { 'desktop.navigation.v1': navigationRecord, [draftKey]: draftRecord('Keep linked draft', [attachment]) }, host: { handlers: fixture.handlers } });
    await app.waitFor('text:Main file'); await app.press('text:Unavailable anchor'); await app.waitFor('id:body-link-error-main-link');
    expect(fixture.fileReads).toEqual([]);
    await app.press('text:Main file'); await app.waitFor('id:desktop-file-editor');
    expect(app.shows('id:body-link-error-main-link')).toBe(false);
    await app.press('id:desktop-editor-copy'); await app.waitUntil(() => app.clipboard() === 'Exact linked file\nSecond line\nThird line');
    expect(fixture.fileReads.length).toBeGreaterThan(0); expect(app.value('id:composer')).toBe('Keep linked draft');
    await app.press('text:Host preview'); await app.waitFor('id:native-desktop-browser-pane');
    expect(app.shows('id:desktop-panel-tab-desktop-browser')).toBe(true);
    expect(app.value('id:desktop-browser-address')).toBe('http://localhost:3000/example');
    await app.press('text:Other Host preview');
    expect(app.count('id:desktop-panel-tab-desktop-browser')).toBe(1);
    expect(app.count('id:desktop-browser-viewport')).toBe(1);
    expect(app.value('id:desktop-browser-address')).toBe('http://localhost:3000/other');
    await app.clear('id:desktop-browser-address'); await app.paste('id:desktop-browser-address', { text: 'http://localhost:3000/unsubmitted' });
    await app.press('id:desktop-chat-header-menu'); await app.press('id:desktop-chat-header-menu-browser');
    await app.waitFor('id:native-desktop-browser-pane', { state: 'gone' });
    await app.press('id:desktop-chat-header-menu'); await app.press('id:desktop-chat-header-menu-browser');
    await app.waitFor('id:native-desktop-browser-pane');
    expect(app.value('id:desktop-browser-address')).toBe('http://localhost:3000/unsubmitted');
    expect(app.count('id:desktop-panel-tab-desktop-browser')).toBe(1);
    const browserTabs = JSON.parse(app.storage()['desktop.panel-tabs.v1']).scopes.flatMap(row => row.tabs).filter(tab => tab.kind === 'browser');
    expect(browserTabs).toHaveLength(1); expect(browserTabs[0].url).toBe('http://localhost:3000/other');
    expect(app.host.calls().filter(row => row.name === 'openUrl' || row.name === 'url.open')).toEqual([]);
    expect(fixture.prompts).toEqual([]); expect(fixture.mutations).toEqual([]); expect(fixture.rejected).toEqual([]);
  });
  test(platform + ' actual embedded body resolves relative files against its own cross-directory target, never the parent', async () => {
    const fixture = createContentLinksHost();
    const app = await open('./Root.tsx', { platform, width: 1440, height: 900,
      storage: { 'desktop.navigation.v1': navigationRecord, [draftKey]: draftRecord('Keep parent draft', [attachment]),
        'desktop.panel-tabs.v1': embeddedToolsRecord, 'desktop.layout.v1': JSON.stringify({ panelOpen: true }) }, host: { handlers: fixture.handlers } });
    await app.waitFor('text:Child file'); await app.press('text:Child file'); await app.waitFor('id:desktop-file-editor');
    await app.press('id:desktop-editor-copy'); await app.waitUntil(() => app.clipboard() === 'Exact linked file\nSecond line\nThird line');
    expect(fixture.resources).toEqual([]); expect(fixture.fileReads.length).toBeGreaterThan(0);
    expect(fixture.fileReads.every(row => row.path.includes('directory=' + encodeURIComponent('/fixture/child-worktree')) && row.path.includes('path=' + encodeURIComponent('/fixture/child-worktree/readme.md')))).toBe(true);
    expect(app.count('id:composer')).toBe(1); expect(app.value('id:composer')).toBe('Keep parent draft');
    expect(app.count('id:transcript')).toBe(1); expect(app.shows('text:Main file')).toBe(true);
    await app.waitUntil(() => { const saved = app.storage()['desktop.panel-tabs.v1']; return !!saved && JSON.parse(saved).scopes.some(row => row.rail === null && row.tabs.some(tab => tab.kind === 'file' && tab.source?.directory === '/fixture/child-worktree' && tab.source?.sessionID === 'child')); });
    expect(JSON.parse(app.storage()[draftKey]).draft).toBe('Keep parent draft');
    expect(JSON.parse(app.storage()[draftKey]).attachments).toEqual([attachment]);
    expect(fixture.prompts).toEqual([]); expect(fixture.mutations).toEqual([]); expect(fixture.rejected).toEqual([]);
  });
  test(platform + ' actual BTW body uses the same exact-file router and keeps the main writer', async () => {
    const fixture = createContentLinksHost({ btw: true });
    const app = await open('./Root.tsx', { platform, width: 1440, height: 900,
      storage: { 'desktop.navigation.v1': navigationRecord, [draftKey]: draftRecord('/btw Link question', [attachment]) }, host: { handlers: fixture.handlers } });
    await app.waitUntil(() => app.enabled('id:send')); await app.press('id:send'); await app.waitFor('text:Side file');
    await app.press('text:Side anchor'); await app.waitFor('id:btw-link-error-btw_1'); expect(fixture.fileReads).toEqual([]);
    await app.type('id:composer', 'Unchanged main'); await app.press('text:Side file'); await app.waitFor('id:desktop-file-editor');
    await app.press('id:desktop-editor-copy'); await app.waitUntil(() => app.clipboard() === 'Exact linked file\nSecond line\nThird line');
    expect(app.value('id:composer')).toBe('Unchanged main'); expect(fixture.requests).toHaveLength(3);
    expect(fixture.prompts).toEqual([]); expect(fixture.mutations).toEqual([]); expect(fixture.rejected).toEqual([]);
  });
  test(platform + ' actual BTW opens the mounted native panel, uses captured model-agent-generate and preserves the main writer and attachments', async () => {
    const fixture = createBtwHost();
    const app = await open('./Root.tsx', { platform, width: 1440, height: 900,
      storage: { 'desktop.navigation.v1': navigationRecord, [draftKey]: draftRecord('/btw Side question', [attachment]) }, host: { handlers: fixture.handlers } });
    await app.waitUntil(() => app.enabled('id:send')); await app.press('id:send');
    await app.waitFor('id:desktop-btw-panel'); await app.waitFor('text:Actual side answer, no main prompt');
    await app.waitFor('id:btw-model-control');
    expect(app.texts().filter(value => value === 'Fixture model').length).toBeGreaterThan(1);
    expect(app.count('id:composer')).toBe(1); expect(app.count('id:transcript')).toBe(1); expect(app.value('id:composer')).toBe('');
    expect(fixture.requests.map(row => row.path.split('/').at(-1))).toEqual(['model', 'agent', 'generate']);
    expect(fixture.requests[2].body.prompt).toContain('Side question'); expect(new Set(fixture.requests.map(row => row.ownerID)).size).toBe(1);
    expect(JSON.parse(app.storage()[draftKey]).attachments).toEqual([attachment]);
    const streams = app.host.calls().filter(call => call.name === 'runtime.stream' && call.data.key === 'chat').length;
    await app.type('id:composer', 'Main retained follow-up');
    await app.type('id:btw-editor', 'Side retained follow-up');
    const reads = app.host.calls().filter(call => call.name === 'runtime.request' && call.data.method === 'GET').length;
    await app.type('id:composer', 'x'.repeat(50)); await app.type('id:btw-editor', 'y'.repeat(50));
    expect(app.host.calls().filter(call => call.name === 'runtime.request' && call.data.method === 'GET').length).toBe(reads);
    expect(fixture.requests.length).toBe(3);
    await app.clear('id:composer'); await app.type('id:composer', 'Main retained follow-up');
    await app.clear('id:btw-editor'); await app.type('id:btw-editor', 'Side retained follow-up');
    for (const [openID, surface] of [['desktop-shortcuts', 'desktop-help-dialog'], ['desktop-global-search', 'desktop-command-palette'], ['desktop-settings', 'desktop-settings-window']]) {
      await app.press('id:' + openID); await app.waitFor('id:' + surface);
      expect(app.enabled('id:btw-send')).toBe(false); expect(app.value('id:btw-editor')).toBe('Side retained follow-up');
      if (surface === 'desktop-settings-window') await app.press('id:desktop-settings-close'); else await app.keyboard.press('escape');
      await app.waitFor('id:' + surface, { state: 'gone' }); await app.waitUntil(() => app.enabled('id:btw-send'));
      expect(app.value('id:composer')).toBe('Main retained follow-up');
    }
    await app.press('id:btw-send'); await app.waitUntil(() => fixture.requests.length === 6);
    expect(fixture.requests[5].body.prompt).toContain('Earlier in this side conversation:');
    expect(fixture.requests[5].body.prompt).toContain('Side retained follow-up');
    await app.clear('id:composer'); await app.type('id:composer', '/btw'); await app.press('id:send');
    expect(app.count('id:desktop-btw-panel')).toBe(1); expect(fixture.requests.length).toBe(6);
    expect(app.host.calls().filter(call => call.name === 'runtime.stream' && call.data.key === 'chat').length).toBe(streams);
    await app.type('id:composer', 'Main survives panel close');
    await app.press('id:desktop-panel-close-panel');
    await app.clear('id:composer'); await app.type('id:composer', '/btw'); await app.press('id:send');
    await app.waitFor('id:desktop-btw-panel');
    expect(app.texts()).not.toContain('Actual side answer, no main prompt');
    expect(app.value('id:btw-editor')).toBe(''); expect(fixture.requests.length).toBe(6);
    await app.type('id:btw-editor', 'Reopened side request'); await app.press('id:btw-send');
    await app.waitUntil(() => fixture.requests.length === 9);
    expect(fixture.requests[8].body.prompt).not.toContain('Earlier in this side conversation:');
    expect(fixture.prompts).toEqual([]); expect(fixture.mutations).toEqual([]); expect(fixture.rejected).toEqual([]);
  });
  test(platform + ' actual native stream grant enables the child reader, isolates live keys and stops only that child on close', async () => {
    const fixture = createPanelStreamHost();
    const app = await open('./Root.tsx', { platform, width: 1440, height: 900,
      storage: { 'desktop.navigation.v1': navigationRecord, [draftKey]: draftRecord('Main retained'),
        'desktop.panel-tabs.v1': panelRecord, 'desktop.layout.v1': JSON.stringify({ panelOpen: true }) }, host: { handlers: fixture.handlers } });
    await app.waitFor('id:panel-chat-transcript:child');
    await app.type('id:panel-chat-search', 'Retained child query');
    const mainStreams = () => app.host.calls().filter(call => call.name === 'runtime.stream' && call.data.key === 'chat').length;
    const before = mainStreams();
    await app.waitUntil(() => fixture.starts.length === 1); await app.waitFor('id:panel-chat-stream-unavailable', { state: 'gone' });
    expect(app.value('id:panel-chat-search')).toBe('Retained child query'); expect(mainStreams()).toBe(before);
    const key = fixture.starts[0].key;
    const delta = (streamKey, text, sessionID = 'child') => app.host.send('runtime.event', { key: streamKey, data: JSON.stringify({ type: 'session.text.delta', data: { sessionID, assistantMessageID: 'native-stream-live', directory: identity.directory, ordinal: 0, delta: text } }) });
    await delta('panel-chat:9007199254740991:1', 'Foreign key must not appear');
    expect(app.texts()).not.toContain('Foreign key must not appear');
    await delta(key, 'Exact live child body'); await app.waitFor('text:Exact live child body');
    expect(app.value('id:composer')).toBe('Main retained'); expect(app.count('id:composer')).toBe(1);
    await app.press('id:desktop-shortcuts'); await app.waitFor('id:desktop-help-dialog');
    expect(fixture.stops).toEqual([]); await app.keyboard.press('escape'); await app.waitFor('id:desktop-help-dialog', { state: 'gone' });
    const id = JSON.stringify(['chat', identity.directory, 'child']); await app.press('id:desktop-panel-close-' + id);
    await app.waitUntil(() => fixture.stops.some(row => row.key === key));
    expect(app.host.calls().filter(call => call.name === 'runtime.stop' && call.data.key === 'chat')).toEqual([]);
    expect(mainStreams()).toBe(before); expect(app.value('id:composer')).toBe('Main retained');
    expect(fixture.prompts).toEqual([]); expect(fixture.mutations).toEqual([]); expect(fixture.rejected).toEqual([]);
  });
  test(platform + ' actual native panel capacity refusal keeps read-only history and cannot replace the main chat stream', async () => {
    const fixture = createPanelStreamHost({ capacity: true });
    const app = await open('./Root.tsx', { platform, width: 1440, height: 900,
      storage: { 'desktop.navigation.v1': navigationRecord, [draftKey]: draftRecord('Capacity retained'),
        'desktop.panel-tabs.v1': panelRecord, 'desktop.layout.v1': JSON.stringify({ panelOpen: true }) }, host: { handlers: fixture.handlers } });
    await app.waitFor('id:panel-chat-stream-unavailable'); await app.waitFor('text:Read-only actual child');
    expect(fixture.starts.length).toBe(1); expect(app.count('id:composer')).toBe(1); expect(app.value('id:composer')).toBe('Capacity retained');
    expect(app.host.calls().filter(call => call.name === 'runtime.stream' && call.data.key === 'chat').length).toBe(1);
    expect(app.host.calls().filter(call => call.name === 'runtime.stop' && call.data.key === 'chat')).toEqual([]);
    expect(fixture.prompts).toEqual([]); expect(fixture.mutations).toEqual([]); expect(fixture.rejected).toEqual([]);
  });
  test(platform + ' actual cold Context reuses the original Chat, copies received JSON and performs no additional history/catalog reads during fifty input edits', async () => {
    const fixture = createHistoryHost();
    const app = await open('./Root.tsx', { platform, width: 1440, height: 1000,
      storage: { 'desktop.navigation.v1': navigationRecord, [draftKey]: draftRecord('Retained draft', [attachment]),
        'desktop.panel-tabs.v1': contextRecord, 'desktop.layout.v1': JSON.stringify({ panelOpen: true }) }, host: { handlers: fixture.handlers } });
    await app.waitFor('id:desktop-context-summary'); await app.waitUntil(() => app.enabled('id:send'));
    expect(app.texts()).toContain('Saved exact conversation'); expect(app.texts()).toContain('Raw Messages');
    expect(app.count('id:composer')).toBe(1); expect(app.count('id:transcript')).toBe(1);
    const counts = () => ({ pages: fixture.historyPages.length,
      catalogs: app.host.calls().filter(call => call.name === 'runtime.request' && call.data.path.startsWith('/api/config/catalog/providers')).length,
      streams: app.host.calls().filter(call => call.name === 'runtime.stream' && call.data.key === 'chat').length });
    const before = counts();
    await app.type('id:composer', 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWX');
    expect(app.value('id:composer')).toBe('Retained draftabcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWX'); expect(counts()).toEqual(before);
    for (let step = 0; step < 10 && !app.shows('id:desktop-context-expand-history-answer-3'); step++) await app.scroll('id:desktop-context-list', 160);
    await app.press('id:desktop-context-expand-history-answer-3'); await app.waitFor('id:desktop-context-json-history-answer-3');
    await app.press('id:desktop-context-copy-history-answer-3'); await app.waitUntil(() => !!app.clipboard());
    const copied = JSON.parse(app.clipboard()); expect(copied.id ?? copied.info?.id).toBe('history-answer-3');
    expect(app.clipboard()).toContain('History answer 3'); expect(counts()).toEqual(before);
    for (const [openID, surface] of [['desktop-shortcuts', 'desktop-help-dialog'], ['desktop-global-search', 'desktop-command-palette'], ['desktop-settings', 'desktop-settings-window']]) {
      await app.press('id:' + openID); await app.waitFor('id:' + surface);
      expect(app.shows('id:desktop-context-json-history-answer-3')).toBe(true); expect(app.enabled('id:desktop-context-copy-history-answer-3')).toBe(false);
      expect(app.enabled('id:composer-remove-attachment-retained.txt')).toBe(false); expect(app.enabled('id:chat-selection')).toBe(false);
      if (surface === 'desktop-settings-window') await app.press('id:desktop-settings-close'); else await app.keyboard.press('escape');
      await app.waitFor('id:' + surface, { state: 'gone' }); await app.waitUntil(() => app.enabled('id:desktop-context-copy-history-answer-3'));
      expect(app.shows('id:desktop-context-json-history-answer-3')).toBe(true); expect(counts().streams).toBe(before.streams);
    }
    await app.press('id:desktop-panel-close-panel'); expect(app.shows('id:desktop-context-summary')).toBe(false);
    await app.press('id:desktop-chat-header-panel'); await app.waitFor('id:desktop-context-summary');
    expect(counts().streams).toBe(before.streams); expect(app.shows('id:desktop-context-json-history-answer-3')).toBe(true);
    expect(JSON.parse(app.storage()[draftKey]).attachments).toEqual([attachment]); expect(fixture.writes).toEqual([]);
    expect(fixture.prompts).toEqual([]); expect(fixture.mutations).toEqual([]); expect(fixture.rejected).toEqual([]);
  });
  test(platform + ' actual App new-page magic transfers once into the real Chat writer, preserving the original draft and resources', async () => {
    const fixture = createDraftCommandsHost(), source = JSON.parse(draftRecord('/explore retained source', [attachment]));
    source.context = { kind: 'checks', instructionsText: 'Retained source context', payloadText: '{}' };
    const app = await open('./Root.tsx', { platform, width: 1440, height: 900,
      storage: { 'desktop.navigation.v1': newDraftNavigation, [newDraftKey]: JSON.stringify(source) }, host: { handlers: fixture.handlers } });
    await app.waitFor('id:new-session-composer'); await app.waitUntil(() => app.value('id:new-session-composer') === source.draft && app.enabled('id:send'));
    await app.press('id:send'); await app.waitFor('id:composer'); await app.waitFor('text:Local magic created session');
    await app.waitUntil(() => fixture.prompts.length === 1 && JSON.parse(app.storage()[newDraftKey]).pendingSend === null);
    expect(fixture.creates.length).toBe(1); expect(fixture.prompts[0].body.text).not.toBe(source.draft); expect(fixture.prompts[0].body.files).toBeUndefined();
    const saved = JSON.parse(app.storage()[newDraftKey]); expect(saved.draft).toBe(source.draft); expect(saved.attachments).toEqual([attachment]); expect(saved.context).toEqual(source.context);
    expect(app.count('id:composer')).toBe(1); expect(app.value('id:composer')).toBe('');
    expect(fixture.mutations).toEqual([]); expect(fixture.rejected).toEqual([]);
  });
  test(platform + ' actual App new-page unknown creation retains the same page and cannot dispatch a second create', async () => {
    const fixture = createDraftCommandsHost(); fixture.loseCreate();
    const app = await open('./Root.tsx', { platform, width: 1440, height: 900,
      storage: { 'desktop.navigation.v1': newDraftNavigation, [newDraftKey]: draftRecord('/explore', [attachment]) }, host: { handlers: fixture.handlers } });
    await app.waitUntil(() => app.value('id:new-session-composer') === '/explore' && app.enabled('id:send')); await app.press('id:send');
    await app.waitFor('id:new-session-create-unknown'); expect(fixture.creates.length).toBe(1); expect(fixture.prompts.length).toBe(0);
    expect(app.value('id:new-session-composer')).toBe('/explore'); expect(app.enabled('id:send')).toBe(false);
    await app.press('id:desktop-shortcuts'); await app.waitFor('id:desktop-help-dialog'); await app.keyboard.press('escape'); await app.waitFor('id:desktop-help-dialog', { state: 'gone' });
    expect(app.value('id:new-session-composer')).toBe('/explore'); expect(app.enabled('id:send')).toBe(false); expect(fixture.creates.length).toBe(1);
    expect(JSON.parse(app.storage()[newDraftKey]).attachments).toEqual([attachment]); expect(fixture.mutations).toEqual([]); expect(fixture.rejected).toEqual([]);
  });
  test(platform + ' actual Timeline retains the writer and stream, searches and jumps without consuming the command or attachment', async () => {
    const fixture = createHistoryHost();
    const app = await open('./Root.tsx', { platform, width: 1440, height: 900,
      storage: { 'desktop.navigation.v1': navigationRecord, [draftKey]: draftRecord('/timeline', [attachment]) }, host: { handlers: fixture.handlers } });
    await app.waitFor('id:composer'); await app.waitUntil(() => app.enabled('id:chat-agent-selection') && app.enabled('id:send'));
    const streams = app.host.calls().filter(call => call.name === 'runtime.stream' && call.data.key === 'chat').length;
    await app.press('id:send'); await app.waitFor('id:composer-timeline'); await app.waitFor('id:timeline-row-history-user-3');
    expect(app.value('id:composer')).toBe('/timeline'); expect(app.texts()).toContain('retained.txt');
    expect(app.count('id:composer')).toBe(1); expect(app.enabled('id:send')).toBe(false);
    await app.type('id:timeline-search', 'question 2'); await app.waitFor('id:timeline-row-history-user-2');
    expect(app.shows('id:timeline-row-history-user-3')).toBe(false);
    await app.press('id:timeline-jump-history-user-2'); await app.waitFor('id:composer-timeline', { state: 'gone' });
    await app.waitUntil(() => app.enabled('id:send'));
    expect(app.value('id:composer')).toBe('/timeline'); expect(JSON.parse(app.storage()[draftKey]).attachments).toEqual([attachment]);
    expect(app.host.calls().filter(call => call.name === 'runtime.stream' && call.data.key === 'chat').length).toBe(streams);
    expect(fixture.writes).toEqual([]); expect(fixture.prompts).toEqual([]); expect(fixture.mutations).toEqual([]); expect(fixture.rejected).toEqual([]);
  });
  test(platform + ' actual Timeline stages the selected user boundary while its own modal retains history authority', async () => {
    const fixture = createHistoryHost();
    const app = await open('./Root.tsx', { platform, width: 1440, height: 900,
      storage: { 'desktop.navigation.v1': navigationRecord, [draftKey]: draftRecord('/timeline', [attachment]) }, host: { handlers: fixture.handlers } });
    await app.waitUntil(() => app.enabled('id:chat-agent-selection') && app.enabled('id:send'));
    await app.press('id:send'); await app.waitFor('id:timeline-revert-history-user-3');
    await app.press('id:timeline-revert-history-user-3'); await app.waitFor('id:composer-timeline', { state: 'gone' });
    await app.waitFor('id:history-revert-indicator');
    expect(fixture.writes.map(row => row.body)).toEqual([{ messageID: 'history-user-3', files: true }]);
    expect(app.value('id:composer')).toBe('/timeline'); expect(app.texts()).toContain('retained.txt');
    expect(fixture.prompts).toEqual([]); expect(fixture.mutations).toEqual([]); expect(fixture.rejected).toEqual([]);
  });
  test(platform + ' actual slash undo and redo follow the shared user-boundary order, preserve attachments and never send Host commands', async () => {
    const fixture = createHistoryHost();
    const app = await open('./Root.tsx', { platform, width: 1440, height: 900,
      storage: { 'desktop.navigation.v1': navigationRecord, [draftKey]: draftRecord('/undo', [attachment]) }, host: { handlers: fixture.handlers } });
    await app.waitUntil(() => app.enabled('id:chat-agent-selection') && app.enabled('id:send'));
    await app.press('id:send'); await app.waitUntil(() => fixture.writes.length === 1 && app.enabled('id:history-redo'));
    expect(app.value('id:composer')).toBe('');
    for (const [command, count] of [['/undo', 2], ['/redo', 3], ['/redo', 4]] as const) {
      await app.type('id:composer', command); await app.waitUntil(() => app.enabled('id:send')); await app.press('id:send');
      await app.waitUntil(() => fixture.writes.length === count);
      if (count < 4) await app.waitUntil(() => app.enabled('id:history-redo'));
      else await app.waitFor('id:history-revert-indicator', { state: 'gone' });
      expect(app.value('id:composer')).toBe('');
    }
    expect(fixture.writes.map(row => [row.method, row.body?.messageID ?? null])).toEqual([
      ['POST', 'history-user-3'], ['POST', 'history-user-2'], ['POST', 'history-user-3'], ['DELETE', null],
    ]);
    expect(JSON.parse(app.storage()[draftKey]).attachments).toEqual([attachment]);
    expect(fixture.prompts).toEqual([]); expect(fixture.mutations).toEqual([]); expect(fixture.rejected).toEqual([]);
  });
  test(platform + ' actual unknown Timeline stage stays locked after Escape and read refresh without replay', async () => {
    const fixture = createHistoryHost(); fixture.loseHistoryAck();
    const app = await open('./Root.tsx', { platform, width: 1440, height: 900,
      storage: { 'desktop.navigation.v1': navigationRecord, [draftKey]: draftRecord('/timeline', [attachment]) }, host: { handlers: fixture.handlers } });
    await app.waitUntil(() => app.enabled('id:chat-agent-selection') && app.enabled('id:send'));
    await app.press('id:send'); await app.waitFor('id:timeline-revert-history-user-3'); await app.press('id:timeline-revert-history-user-3');
    await app.waitFor('id:timeline-error'); expect(fixture.writes.length).toBe(1);
    await app.keyboard.press('escape'); await app.waitFor('id:composer-timeline', { state: 'gone' });
    expect(app.enabled('id:send')).toBe(false); expect(app.enabled('id:history-redo')).toBe(false);
    await app.press('id:desktop-settings'); await app.waitFor('id:desktop-settings-window'); await app.press('id:desktop-settings-close');
    await app.waitFor('id:desktop-settings-window', { state: 'gone' });
    expect(app.enabled('id:send')).toBe(false); expect(fixture.writes.length).toBe(1);
    expect(app.value('id:composer')).toBe('/timeline'); expect(app.texts()).toContain('retained.txt');
    const receipts = Object.entries(app.storage()).filter(([key]) => key.startsWith('nsh:history-operation:v1:')).map(([, raw]) => JSON.parse(raw));
    expect(receipts.length).toBe(1); expect(receipts[0].write).toEqual({ kind: 'stage', messageID: 'history-user-3' });
    expect(fixture.prompts).toEqual([]); expect(fixture.mutations).toEqual([]); expect(fixture.rejected).toEqual([]);
  });
  test(platform + ' actual fork-current navigates only after the acknowledged target and leaves source resources intact', async () => {
    const fixture = createHistoryHost();
    const app = await open('./Root.tsx', { platform, width: 1440, height: 900,
      storage: { 'desktop.navigation.v1': navigationRecord, [draftKey]: draftRecord('/fork', [attachment]) }, host: { handlers: fixture.handlers } });
    await app.waitUntil(() => app.enabled('id:chat-agent-selection') && app.enabled('id:send')); await app.press('id:send');
    await app.waitFor('text:Acknowledged history fork');
    await app.waitUntil(() => JSON.parse(app.storage()['desktop.navigation.v1']).entries.some(entry => entry.target.sessionID === 'history-fork'));
    expect(fixture.writes.map(row => row.body)).toEqual([{}]);
    expect(JSON.parse(app.storage()[draftKey]).draft).toBe(''); expect(JSON.parse(app.storage()[draftKey]).attachments).toEqual([attachment]);
    expect(fixture.prompts).toEqual([]); expect(fixture.mutations).toEqual([]); expect(fixture.rejected).toEqual([]);
  });
  test(platform + ' actual Timeline pages through the existing Chat once and reveals the older user without reopening its stream', async () => {
    const fixture = createHistoryHost(); fixture.paginateHistory();
    const app = await open('./Root.tsx', { platform, width: 1440, height: 900,
      storage: { 'desktop.navigation.v1': navigationRecord, [draftKey]: draftRecord('/timeline') }, host: { handlers: fixture.handlers } });
    await app.waitUntil(() => app.enabled('id:chat-agent-selection') && app.enabled('id:send'));
    const streams = app.host.calls().filter(call => call.name === 'runtime.stream' && call.data.key === 'chat').length;
    await app.press('id:send'); await app.waitFor('id:timeline-load-earlier');
    expect(app.shows('id:timeline-row-history-user-1')).toBe(false);
    await app.press('id:timeline-load-earlier'); await app.waitFor('id:timeline-row-history-user-1');
    await app.waitFor('id:timeline-load-earlier', { state: 'gone' });
    await app.press('id:timeline-jump-history-user-1'); await app.waitFor('id:composer-timeline', { state: 'gone' });
    expect(fixture.historyPages.filter(row => row.path.includes('&cursor=history-older')).length).toBe(1);
    expect(app.host.calls().filter(call => call.name === 'runtime.stream' && call.data.key === 'chat').length).toBe(streams);
    expect(app.value('id:composer')).toBe('/timeline'); expect(fixture.writes).toEqual([]); expect(fixture.prompts).toEqual([]);
    expect(fixture.mutations).toEqual([]); expect(fixture.rejected).toEqual([]);
  });
  test(platform + ' actual Timeline previous-turn and latest actions return to the same retained writer without a mutation', async () => {
    const fixture = createHistoryHost();
    const app = await open('./Root.tsx', { platform, width: 1440, height: 900,
      storage: { 'desktop.navigation.v1': navigationRecord, [draftKey]: draftRecord('/timeline', [attachment]) }, host: { handlers: fixture.handlers } });
    await app.waitUntil(() => app.enabled('id:chat-agent-selection') && app.enabled('id:send'));
    for (const action of ['timeline-previous', 'timeline-latest']) {
      await app.press('id:send'); await app.waitFor('id:' + action); await app.press('id:' + action);
      await app.waitFor('id:composer-timeline', { state: 'gone' }); await app.waitUntil(() => app.enabled('id:send'));
      expect(app.value('id:composer')).toBe('/timeline'); expect(app.count('id:composer')).toBe(1);
    }
    expect(JSON.parse(app.storage()[draftKey]).attachments).toEqual([attachment]);
    expect(fixture.writes).toEqual([]); expect(fixture.prompts).toEqual([]); expect(fixture.mutations).toEqual([]); expect(fixture.rejected).toEqual([]);
  });
  test(platform + ' actual workbench restores a read-only child, copies its body and keeps nested card navigation off the main writer', async () => {
    const fixture = createEmbeddedHost();
    const app = await open('./Root.tsx', { platform, width: 1440, height: 900,
      storage: { 'desktop.navigation.v1': navigationRecord, [draftKey]: draftRecord('Retained main draft'),
        'desktop.panel-tabs.v1': panelRecord, 'desktop.layout.v1': JSON.stringify({ panelOpen: true }) }, host: { handlers: fixture.handlers } });
    await app.waitFor('id:composer'); await app.waitFor('id:panel-chat-transcript:child'); await app.waitFor('text:Read-only actual child');
    expect(app.count('id:composer')).toBe(1); expect(app.value('id:composer')).toBe('Retained main draft');
    await app.type('id:panel-chat-search', 'retained child query');
    const childReads = () => app.host.calls().filter(call => call.name === 'runtime.request' && call.data.path.startsWith('/api/session/child')).length;
    const beforeModal = childReads();
    for (const [openID, surface] of [['desktop-shortcuts', 'desktop-help-dialog'], ['desktop-global-search', 'desktop-command-palette'], ['desktop-settings', 'desktop-settings-window']]) {
      await app.press('id:' + openID); await app.waitFor('id:' + surface);
      expect(app.shows('id:panel-chat-transcript:child')).toBe(true); expect(app.enabled('id:panel-chat-search')).toBe(false);
      if (surface === 'desktop-settings-window') await app.press('id:desktop-settings-close'); else await app.keyboard.press('escape');
      await app.waitFor('id:' + surface, { state: 'gone' }); await app.waitUntil(() => app.enabled('id:panel-chat-search'));
      expect(app.value('id:panel-chat-search')).toBe('retained child query'); expect(childReads()).toBe(beforeModal);
    }
    await app.press('id:panel-chat-copy:child-reply'); await app.waitUntil(() => app.clipboard().includes('Read-only actual child'));
    await app.press('id:resource-card-session-grandchild'); await app.waitFor('id:panel-chat-transcript:grandchild');
    await app.waitFor('text:Read-only actual grandchild');
    expect(app.value('id:composer')).toBe('Retained main draft'); expect(app.count('id:composer')).toBe(1);
    await app.press('id:panel-chat-back'); await app.waitFor('id:panel-chat-transcript:child');
    expect(app.value('id:composer')).toBe('Retained main draft');
    expect(app.host.calls().filter(call => call.name === 'runtime.stream' && call.data.key.startsWith('panel-chat:'))).toEqual([]);
    expect(app.shows('id:panel-chat-stream-unavailable')).toBe(true);
    expect(Object.keys(app.storage()).filter(key => key.startsWith('nsh:chat-draft:v1:') && key !== draftKey)).toEqual([]);
    expect(fixture.prompts).toEqual([]); expect(fixture.mutations).toEqual([]); expect(fixture.rejected).toEqual([]);
  });
  test(platform + ' actual embedded tool opens its own cross-directory fixed historical diff, never parent Git or a writable Chat', async () => {
    const fixture = createEmbeddedToolsHost();
    const app = await open('./Root.tsx', { platform, width: 1440, height: 900,
      storage: { 'desktop.navigation.v1': navigationRecord, [draftKey]: draftRecord('Retained parent draft'),
        'desktop.panel-tabs.v1': embeddedToolsRecord, 'desktop.layout.v1': JSON.stringify({ panelOpen: true }) }, host: { handlers: fixture.handlers } });
    await app.waitFor('text:Read-only child tool snapshot');
    const gitReads = () => app.host.calls().filter(call => call.name === 'runtime.request' && call.data.path.startsWith('/api/git/')).length;
    const before = gitReads();
    if (!app.shows('id:body-process:child-tool-message:fixed-edit')) await app.press('id:body-activity-child-tool-message');
    await app.press('id:body-process:child-tool-message:fixed-edit'); await app.waitFor('id:tool-expand-fixed-edit'); await app.press('id:tool-expand-fixed-edit');
    await app.waitFor('id:desktop-native-diff'); await app.press('id:desktop-diff-copy');
    await app.waitUntil(() => app.clipboard().includes('EXACT HISTORICAL BEFORE') && app.clipboard().includes('EXACT HISTORICAL AFTER'));
    expect(gitReads()).toBe(before); expect(app.value('id:composer')).toBe('Retained parent draft'); expect(app.count('id:composer')).toBe(1);
    await app.waitUntil(() => !!app.storage()['desktop.panel-tabs.v1']);
    expect(app.storage()['desktop.panel-tabs.v1']).not.toContain('EXACT HISTORICAL');
    expect(fixture.prompts).toEqual([]); expect(fixture.mutations).toEqual([]); expect(fixture.rejected).toEqual([]);
  });
  test(platform + ' actual Chat magic dispatch preserves command document and attachment, sends compiled text without files', async () => {
    const { app, fixture } = await launch(platform, '/summary retained focus', [attachment]);
    await app.press('id:send'); await app.waitUntil(() => fixture.prompts.length === 1);
    await app.waitUntil(() => JSON.parse(app.storage()[draftKey]).pendingSend === null);
    expect(app.value('id:composer')).toBe('/summary retained focus'); expect(app.texts()).toContain('retained.txt');
    expect(fixture.prompts[0].body.text).toContain('retained focus'); expect(fixture.prompts[0].body.text).not.toBe('/summary retained focus');
    expect(fixture.prompts[0].body.files).toBeUndefined();
    expect(JSON.parse(app.storage()[draftKey]).attachments).toEqual([attachment]);
    expect(fixture.mutations).toEqual([]); expect(fixture.rejected).toEqual([]);
  });
  test(platform + ' unbound local command claims a colliding Host name instead of sending or consuming the draft', async () => {
    const { app, fixture } = await launch(platform, '/btw');
    await app.press('id:send'); expect(app.value('id:composer')).toBe('/btw');
    expect(fixture.prompts).toEqual([]); expect(fixture.mutations).toEqual([]); expect(fixture.rejected).toEqual([]);
  });
  test(platform + ' actual compact uses the original writer with an exact control ACK and preserves source attachments', async () => {
    const fixture = createCompactHost();
    const app = await open('./Root.tsx', { platform, width: 1440, height: 900,
      storage: { 'desktop.navigation.v1': navigationRecord, [draftKey]: draftRecord('/compact', [attachment]) }, host: { handlers: fixture.handlers } });
    await app.waitUntil(() => app.enabled('id:chat-agent-selection') && app.enabled('id:send')); await app.press('id:send');
    await app.waitUntil(() => fixture.compacts.length === 1 && JSON.parse(app.storage()[draftKey]).pendingSend === null);
    expect(Object.keys(fixture.compacts[0].body).sort()).toEqual(['delivery', 'id']); expect(fixture.compacts[0].body.delivery).toBe('steer');
    expect(app.value('id:composer')).toBe(''); expect(JSON.parse(app.storage()[draftKey]).attachments).toEqual([attachment]);
    expect(fixture.prompts).toEqual([]); expect(fixture.mutations).toEqual([]); expect(fixture.rejected).toEqual([]);
  });
  test(platform + ' actual compact unknown retries only the original checkpoint, never a compact or prompt POST', async () => {
    const fixture = createCompactHost(); fixture.loseAck();
    const app = await open('./Root.tsx', { platform, width: 1440, height: 900,
      storage: { 'desktop.navigation.v1': navigationRecord, [draftKey]: draftRecord('/compact', [attachment]) }, host: { handlers: fixture.handlers } });
    await app.waitUntil(() => app.enabled('id:chat-agent-selection') && app.enabled('id:send')); await app.press('id:send');
    await app.waitFor('id:chat-send-retry'); await app.press('id:chat-send-retry');
    expect(fixture.compacts.length).toBe(1); expect(JSON.parse(app.storage()[draftKey]).pendingSend.localCompact).toEqual({ version: 1, resourcePolicy: 'preserve' });
    fixture.verify(); await app.press('id:chat-send-retry'); await app.waitFor('id:chat-send-retry', { state: 'gone' });
    expect(fixture.compacts.length).toBe(1); expect(app.value('id:composer')).toBe(''); expect(JSON.parse(app.storage()[draftKey]).attachments).toEqual([attachment]);
    expect(fixture.prompts).toEqual([]); expect(fixture.mutations).toEqual([]); expect(fixture.rejected).toEqual([]);
  });
  test(platform + ' actual immediate-command tail confirmation cancels safely and only submits after exact explicit discard', async () => {
    const fixture = createCompactHost();
    const app = await open('./Root.tsx', { platform, width: 1440, height: 900,
      storage: { 'desktop.navigation.v1': navigationRecord, [draftKey]: draftRecord('/compact important tail', [attachment]) }, host: { handlers: fixture.handlers } });
    await app.waitUntil(() => app.enabled('id:chat-agent-selection') && app.enabled('id:send'));
    let dialogs = 0; app.onDialog(() => { dialogs++; return 'Cancel'; });
    await app.press('id:send'); expect(dialogs).toBe(1); expect(fixture.compacts.length).toBe(0); expect(app.value('id:composer')).toBe('/compact important tail');
    app.onDialog(() => { dialogs++; return 'Discard'; }); await app.press('id:send');
    await app.waitUntil(() => fixture.compacts.length === 1 && JSON.parse(app.storage()[draftKey]).pendingSend === null);
    expect(dialogs).toBe(2); expect(app.value('id:composer')).toBe(''); expect(JSON.parse(app.storage()[draftKey]).attachments).toEqual([attachment]);
    expect(fixture.prompts).toEqual([]); expect(fixture.mutations).toEqual([]); expect(fixture.rejected).toEqual([]);
  });
  test(platform + ' actual Chat model command opens the real selector without consuming desktop text', async () => {
    const { app, fixture } = await launch(platform, '/model retained text');
    await app.press('id:send'); await app.waitFor('id:model-search');
    expect(app.value('id:composer')).toBe('/model retained text'); expect(fixture.prompts).toEqual([]); expect(fixture.mutations).toEqual([]);
  });
  test(platform + ' actual Chat unknown magic only verifies its original receipt and never ordinary-replays', async () => {
    const { app, fixture } = await launch(platform, '/summary', [attachment]); fixture.loseAck();
    await app.press('id:send'); await app.waitFor('id:chat-send-retry');
    await app.press('id:chat-send-retry'); expect(fixture.prompts.length).toBe(1);
    expect(app.value('id:composer')).toBe('/summary');
    fixture.verify(); await app.press('id:chat-send-retry'); await app.waitFor('id:chat-send-retry', { state: 'gone' });
    expect(fixture.prompts.length).toBe(1); expect(app.value('id:composer')).toBe('/summary');
    expect(app.texts()).toContain('retained.txt'); expect(fixture.mutations).toEqual([]); expect(fixture.rejected).toEqual([]);
  });
}
