import { expect, open, test } from 'nsh/test';
import { attachment, createGitHost, draftKey, draftRecord, identity, instructions, visible } from './host.js';

const saved = (app, sessionID?) => app.storage()[draftKey(sessionID)] ? JSON.parse(app.storage()[draftKey(sessionID)]) : undefined;
const clean = fixture => { expect(fixture.rejected).toEqual([]); expect(fixture.mutations).toEqual([]); };
async function launch(platform, storage = {}, currentChat = false) {
  const fixture = createGitHost();
  const navigation = currentChat ? { 'desktop.navigation.v1': JSON.stringify({ version: 1, entries: [{ partition: { connectionID: identity.hostID, origin: identity.origin, authorizationID: identity.authorizationID }, target: { kind: 'session', sessionID: identity.sessionID, directory: identity.directory } }] }) } : {};
  const app = await open('./App.tsx', { platform, width: 1440, height: 900, storage: { language: 'en', ...navigation, ...storage }, host: { handlers: fixture.handlers } });
  await app.waitFor('id:desktop-workspace');
  if (currentChat) await app.waitFor('id:composer');
  else {
    await app.waitFor('id:new-session-project');
    await app.press('id:new-session-project'); await app.press('id:new-session-project-' + identity.projectID);
    await app.waitFor('id:new-session-project-' + identity.projectID, { state: 'gone' });
  }
  await app.waitUntil(() => app.enabled('id:desktop-chat-header-panel'));
  await app.press('id:desktop-chat-header-panel'); await app.waitFor('id:native-desktop-panel');
  if (!app.shows('id:desktop-git-resolve-new')) await app.press('id:desktop-panel-rail-git');
  await app.waitFor('id:desktop-git-resolve-new');
  return { app, fixture };
}
for (const platform of ['macos', 'windows'] as const) {
  test(platform + ' production root stages resolve-new into the selected directory without create or send', async () => {
    const { app, fixture } = await launch(platform);
    expect(app.enabled('id:desktop-git-resolve-current')).toBe(false);
    await app.press('id:desktop-git-resolve-new');
    await app.waitUntil(() => app.value('id:new-session-composer') === visible);
    await app.waitUntil(() => saved(app)?.context?.kind === 'conflict');
    expect(saved(app).context.instructionsText).toBe(instructions);
    expect(saved(app).context.payloadText).toContain('CAPTURED_CONFLICT_A_PRIVATE_DIFF');
    expect(app.texts().join('\n')).not.toContain(instructions);
    expect(app.texts().join('\n')).not.toContain('CAPTURED_CONFLICT_A_PRIVATE_DIFF');
    expect(app.value('id:new-session-composer')).not.toContain('PRIVATE_DIFF');
    expect(fixture.reads.filter(input => input.path.startsWith('/api/git/conflict-details?'))).toHaveLength(1);
    await app.press('id:desktop-new-session');
    await app.type('id:new-session-composer', ' editable');
    expect(app.value('id:new-session-composer')).toBe(visible + ' editable'); clean(fixture);
  });
  test(platform + ' production draft Cancel preserves prior; Replace keeps attachments and captured context only', async () => {
    const prior = draftRecord('Prior authored work', [attachment]);
    const { app, fixture } = await launch(platform, { [draftKey()]: prior });
    await app.waitFor('text:retained.txt');
    let dialogs = 0;
    app.onDialog(dialog => { dialogs++; expect(dialog.buttons).toContain('Cancel'); return 'Cancel'; });
    await app.press('id:desktop-git-resolve-new');
    await app.waitUntil(() => dialogs === 1);
    expect(app.value('id:new-session-composer')).toBe('Prior authored work');
    expect(app.storage()[draftKey()]).toBe(prior);
    expect(app.shows('id:new-session-remove-attachment-retained.txt')).toBe(true); clean(fixture);
    app.onDialog(() => { dialogs++; fixture.setConflict('LATER_CONFLICT_B'); return 'Replace draft'; });
    await app.press('id:desktop-git-resolve-new');
    await app.waitUntil(() => app.value('id:new-session-composer') === visible);
    expect(dialogs).toBe(2);
    expect(saved(app).context.payloadText).toContain('CAPTURED_CONFLICT_A_PRIVATE_DIFF');
    expect(saved(app).context.payloadText).not.toContain('LATER_CONFLICT_B');
    expect(saved(app).attachments).toEqual([attachment]);
    expect(app.shows('id:new-session-remove-attachment-retained.txt')).toBe(true);
    expect(app.texts().join('\n')).not.toContain(instructions); clean(fixture);
  });
  test(platform + ' production Replace CAS refuses a staged write overtaken by actual composer input', async () => {
    const { app, fixture } = await launch(platform, { [draftKey()]: draftRecord('Prior work', [attachment]) });
    await app.host.send('git.test.storage.control', { action: 'hold' });
    app.onDialog(() => 'Replace draft');
    await app.press('id:desktop-git-resolve-new');
    await app.waitUntil(() => fixture.storage.some(event => event.phase === 'context-write-held'));
    await app.type('id:new-session-composer', ' with newer user intent');
    await app.host.send('git.test.storage.control', { action: 'release' });
    await app.waitUntil(() => saved(app)?.draft === 'Prior work with newer user intent');
    expect(app.value('id:new-session-composer')).toBe('Prior work with newer user intent');
    expect(saved(app).context).toBeUndefined(); expect(saved(app).attachments).toEqual([attachment]); clean(fixture);
  });
  test(platform + ' production current Chat stages without sending and retains exact Chat owner', async () => {
    const { app, fixture } = await launch(platform, {}, true);
    await app.press('id:desktop-git-resolve-current');
    await app.waitUntil(() => app.value('id:composer') === visible);
    expect(saved(app, identity.sessionID).context.payloadText).toContain('CAPTURED_CONFLICT_A_PRIVATE_DIFF');
    expect(app.shows('id:new-session-composer')).toBe(false);
    expect(app.texts().join('\n')).not.toContain(instructions); clean(fixture);
  });
  test(platform + ' production resolve-new from Chat admits captured initialContext through the actual new-page owner', async () => {
    const { app, fixture } = await launch(platform, {}, true);
    await app.press('id:desktop-git-resolve-new');
    await app.waitFor('id:new-session-composer');
    await app.waitUntil(() => app.value('id:new-session-composer') === visible);
    expect(saved(app).context.instructionsText).toBe(instructions);
    expect(saved(app).context.payloadText).toContain('CAPTURED_CONFLICT_A_PRIVATE_DIFF');
    expect(saved(app, identity.sessionID)?.context).toBeUndefined();
    expect(app.texts().join('\n')).not.toContain(instructions);
    await app.type('id:new-session-composer', ' writable after admission');
    expect(app.value('id:new-session-composer')).toBe(visible + ' writable after admission'); clean(fixture);
  });
  test(platform + ' production PR explicit send preserves the ordinary Chat send parameter contract and clears admitted context', async () => {
    const { app, fixture } = await launch(platform, {}, true);
    await app.type('id:composer', 'Ordinary authored baseline');
    await app.press('id:send');
    await app.waitUntil(() => fixture.mutations.length === 1 && saved(app, identity.sessionID)?.pendingSend === null);
    await app.waitUntil(() => app.value('id:composer') === '');
    const baseline = fixture.mutations[0];
    await app.press('id:desktop-git-tab-pr'); await app.waitFor('text:#42 · Synthetic application PR');
    await app.press('text:Send to agent');
    await app.waitUntil(() => fixture.mutations.length === 2 && saved(app, identity.sessionID)?.pendingSend === null);
    const sent = fixture.mutations[1];
    expect(Object.keys(sent.body).sort()).toEqual(Object.keys(baseline.body).sort());
    expect(sent.body.delivery).toBe(baseline.body.delivery);
    expect(sent.body.text).toContain('Review captured PR 42\nPR_SYNTHETIC_INSTRUCTIONS_ONLY\nGitHub PR context (JSON)');
    expect(sent.body.text).toContain('CAPTURED_PR_COMMENT');
    expect(saved(app, identity.sessionID).context).toBeUndefined();
    expect(app.value('id:composer')).toBe(''); expect(fixture.rejected).toEqual([]);
  });
  test(platform + ' production PR explicit action uses existing send wire once and unknown outcome cannot restage or resend', async () => {
    const { app, fixture } = await launch(platform, {}, true);
    fixture.losePrompt();
    await app.press('id:desktop-git-tab-pr'); await app.waitFor('text:#42 · Synthetic application PR');
    expect(fixture.mutations).toEqual([]);
    await app.press('text:Send to agent');
    await app.waitUntil(() => fixture.mutations.length === 1);
    const sent = fixture.mutations[0];
    expect(sent.path).toBe('/api/session/' + identity.sessionID + '/prompt?directory=' + encodeURIComponent(identity.directory));
    expect(sent.body.text).toContain('Review captured PR 42\nPR_SYNTHETIC_INSTRUCTIONS_ONLY\nGitHub PR context (JSON)');
    expect(sent.body.text).toContain('CAPTURED_PR_PRIVATE_DIFF');
    await app.waitUntil(() => saved(app, identity.sessionID)?.pendingSend?.uncertain === true);
    const captured = saved(app, identity.sessionID).pendingSend;
    expect(captured.id).toBe(sent.body.id); expect(captured.compiled.text).toBe(sent.body.text);
    await app.press('text:Send to agent');
    await app.waitUntil(() => app.texts().some(text => text.includes('Could not prepare the Git context')));
    expect(fixture.mutations).toHaveLength(1);
    expect(saved(app, identity.sessionID).pendingSend).toEqual(captured);
    expect(fixture.rejected).toEqual([]);
  });
}
