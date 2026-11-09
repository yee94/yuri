import { expect, open, test } from 'nsh/test';
import { attachment, createFolderHost, draftRecord, folder, identity, navigationRecord, newDraftKey, newDraftNavigation, secondFolder } from './Host.js';

const receiptKey = 'nsh:new-session:v1:' + encodeURIComponent(JSON.stringify([identity.hostID, identity.directory, JSON.stringify([identity.hostID, identity.origin, identity.authorizationID])]));
const receipt = app => app.storage()[receiptKey] ? JSON.parse(app.storage()[receiptKey]) : null;
const folderButton = 'label:New session in Root folder';
const secondButton = 'label:New session in Second folder';
async function chooseFolder(app, second = false) {
  await app.hover('id:desktop-folder-' + (second ? secondFolder.id : folder.id));
  await app.press(second ? secondButton : folderButton);
}
async function launch(platform, draft = null) {
  const fixture = createFolderHost();
  const app = await open('./Root.tsx', { platform, width: 1440, height: 1000,
    storage: { 'desktop.navigation.v1': draft === null ? navigationRecord : newDraftNavigation,
      ...(draft === null ? {} : { [newDraftKey]: draftRecord(draft, [attachment]) }) }, host: { handlers: fixture.handlers } });
  await app.waitFor('id:desktop-folder-' + folder.id);
  await app.waitFor(draft === null ? 'id:composer' : 'id:new-session-composer');
  if (draft !== null) await app.waitUntil(() => app.value('id:new-session-composer') === draft && app.enabled('id:send'));
  return { app, fixture };
}
function clean(fixture) { expect(fixture.rejected).toEqual([]); expect(fixture.mutations).toEqual([]); }
for (const platform of ['macos', 'windows'] as const) {
  test(platform + ' actual sidebar first folder draft creates nothing until send, then durable ACK precedes selection and actual Chat admission', async () => {
    const { app, fixture } = await launch(platform);
    await chooseFolder(app); await app.waitFor('id:new-session-composer');
    await app.waitUntil(() => receipt(app)?.folder?.id === folder.id);
    expect(receipt(app).folder).toEqual(folder); expect(fixture.writes).toEqual([]);
    await app.type('id:new-session-composer', 'First folder input');
    await app.press('id:new-session-agent'); await app.waitFor('id:new-session-agent-build');
    await app.waitUntil(() => app.enabled('id:new-session-agent-build')); await app.press('id:new-session-agent-build');
    await app.waitFor('id:new-session-selection-search', { state: 'gone' });
    await app.waitUntil(() => receipt(app)?.selection?.model?.id === 'model');
    expect(fixture.writes).toEqual([]);
    await app.waitUntil(() => app.enabled('id:send')); await app.press('id:send');
    await app.waitUntil(() => fixture.prompts.length === 1); await app.waitFor('id:composer');
    await app.waitUntil(() => JSON.parse(app.storage()[newDraftKey]).pendingSend === null);
    expect(fixture.creates.length).toBe(1); expect(fixture.memberships.length).toBe(1);
    expect(fixture.memberships[0].body.foldersMap[identity.directory][0].sessionIds).toEqual([fixture.createdID]);
    expect(fixture.prompts[0].body.text).toBe('First folder input');
    expect(fixture.configurations.map(row => row.body)).toEqual([{ model: { providerID: 'fixture', id: 'model' } }, { agent: 'build' }]);
    const create = fixture.events.findIndex(row => row.kind === 'write' && row.path === '/api/session');
    const unknown = fixture.events.findIndex(row => row.kind === 'persisted' && row.folder?.status === 'unknown');
    const membership = fixture.events.findIndex(row => row.kind === 'write' && row.path === '/api/session-folders');
    const ack = fixture.events.findIndex(row => row.kind === 'persisted' && row.folder?.status === 'acknowledged');
    const prompt = fixture.events.findIndex(row => row.kind === 'write' && row.path.includes('/prompt?'));
    expect(create >= 0 && create < unknown && unknown < membership && membership < ack && ack < prompt).toBe(true);
    for (const selection of fixture.configurations) expect(fixture.events.findIndex(row => row.kind === 'write' && row.path === selection.path) > ack).toBe(true);
    expect(app.count('id:composer')).toBe(1); clean(fixture);
  });
  test(platform + ' actual same-directory folder retarget preserves existing text and attachment without remounting a second composer', async () => {
    const { app, fixture } = await launch(platform, 'Existing retained draft');
    await chooseFolder(app); await app.waitUntil(() => receipt(app)?.folder?.id === folder.id);
    await chooseFolder(app, true); await app.waitUntil(() => receipt(app)?.folder?.id === secondFolder.id);
    expect(app.value('id:new-session-composer')).toBe('Existing retained draft'); expect(app.count('id:new-session-composer')).toBe(1);
    expect(JSON.parse(app.storage()[newDraftKey]).attachments).toEqual([attachment]);
    expect(app.shows('id:new-session-remove-attachment-retained.txt')).toBe(true); expect(fixture.writes).toEqual([]); clean(fixture);
  });
  test(platform + ' actual retained background draft is activated before folder retarget and keeps its body and attachment', async () => {
    const { app, fixture } = await launch(platform, 'Retained below actual Chat');
    await app.press('id:desktop-session-' + identity.directory + '-' + identity.sessionID); await app.waitFor('id:composer');
    await chooseFolder(app); await app.waitUntil(() => receipt(app)?.folder?.id === folder.id);
    await app.waitUntil(() => app.value('id:new-session-composer') === 'Retained below actual Chat');
    expect(app.count('id:new-session-composer')).toBe(1); expect(JSON.parse(app.storage()[newDraftKey]).attachments).toEqual([attachment]);
    expect(fixture.writes).toEqual([]); clean(fixture);
  });
  test(platform + ' actual dirty TaskEditor Cancel cannot commit a folder intent or touch the retained draft', async () => {
    const { app, fixture } = await launch(platform, 'Draft protected by page departure');
    await chooseFolder(app); await app.waitUntil(() => receipt(app)?.folder?.id === folder.id);
    const before = app.storage()[receiptKey];
    await app.press('id:desktop-schedules'); await app.waitFor('id:desktop-scheduled-task-' + identity.projectID + '-folder-task');
    await app.press('id:desktop-scheduled-task-' + identity.projectID + '-folder-task'); await app.waitFor('id:task-editor-desktop');
    await app.type('id:features-task-name', ' dirty');
    let confirmations = 0; app.onDialog(() => { confirmations++; return 'Cancel'; });
    await chooseFolder(app, true); await app.waitUntil(() => confirmations === 1);
    expect(app.value('id:features-task-name')).toBe('Folder task dirty'); expect(app.shows('id:task-editor-desktop')).toBe(true);
    expect(app.storage()[receiptKey]).toBe(before); expect(JSON.parse(app.storage()[newDraftKey]).attachments).toEqual([attachment]);
    expect(fixture.writes).toEqual([]); clean(fixture);
  });
  test(platform + ' actual unknown membership stays on new-page across retries and modals with zero create or membership replay', async () => {
    const { app, fixture } = await launch(platform, 'Unknown folder input'); fixture.loseMembership();
    await chooseFolder(app); await app.waitUntil(() => receipt(app)?.folder?.id === folder.id);
    await app.press('id:send'); await app.waitUntil(() => receipt(app)?.folder?.status === 'unknown');
    await app.waitFor('id:new-session-error');
    for (let i = 0; i < 2; i++) {
      const reads = fixture.folderReads.length;
      await app.press('id:new-session-storage-retry'); await app.waitUntil(() => app.enabled('id:send')); await app.press('id:send');
      await app.waitUntil(() => fixture.folderReads.length > reads); await app.waitFor('id:new-session-error');
    }
    await app.press('id:desktop-shortcuts'); await app.waitFor('id:desktop-help-dialog'); await app.keyboard.press('escape'); await app.waitFor('id:desktop-help-dialog', { state: 'gone' });
    expect(receipt(app).folder.status).toBe('unknown'); expect(receipt(app).phase).toBe('created');
    expect(fixture.creates.length).toBe(1); expect(fixture.memberships.length).toBe(1); expect(fixture.prompts).toEqual([]); expect(fixture.configurations).toEqual([]);
    expect(app.shows('id:new-session-composer')).toBe(true); expect(JSON.parse(app.storage()[newDraftKey]).attachments).toEqual([attachment]);
    const inputID = receipt(app).inputID;
    const restored = await open('./Root.tsx', { platform, width: 1440, height: 1000, storage: app.storage(), host: { handlers: fixture.handlers } });
    await restored.waitFor('id:new-session-composer'); await restored.waitUntil(() => restored.enabled('id:send'));
    const reads = fixture.folderReads.length; await restored.press('id:send'); await restored.waitUntil(() => fixture.folderReads.length > reads);
    await restored.waitFor('id:new-session-error'); expect(receipt(restored).inputID).toBe(inputID); expect(receipt(restored).folder.status).toBe('unknown');
    expect(fixture.creates.length).toBe(1); expect(fixture.memberships.length).toBe(1); expect(fixture.prompts).toEqual([]); clean(fixture);
  });
}
