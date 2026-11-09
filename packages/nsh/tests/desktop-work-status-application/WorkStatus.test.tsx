import { expect, open, test } from 'nsh/test';
import { createWorkStatusHost, navigationRecord, draftKey, draftRecord } from './Host.js';
import { navigationIdentity as identity } from '../desktop-application/NavigationHost.js';

async function launch(platform, width = 1440, params = {}) {
  const fixture = createWorkStatusHost(), gates = [];
  fixture.handlers['work.status.application.gate'] = value => { gates.push(value); };
  const app = await open('./Root.tsx', { platform, clock: {}, width, height: 1100,
    storage: { 'desktop.navigation.v1': navigationRecord, [draftKey]: draftRecord('Keep actual WorkStatus draft') }, host: { params, handlers: fixture.handlers } });
  await app.waitFor('id:composer'); return { app, fixture, gates };
}
for (const platform of ['macos', 'windows'] as const) {
  test(platform + ' actual open child groups follow exact scoped root events without another child GET or parent history read', async () => {
    const { app, fixture } = await launch(platform);
    await app.waitUntil(() => fixture.childReads.length === 1);
    await app.waitFor('id:desktop-work-status-subagents');
    await app.press('id:desktop-work-status-subagents'); await app.waitFor('id:desktop-work-status-agents-unknown');
    const parentReads = fixture.parentReads.length;
    const send = (type, sessionID = 'ses_work_status_child', expectedHost = { hostID: identity.hostID, lease: identity.lease }, directory = identity.directory) => app.host.send('runtime.event', {
      key: 'global', ...(expectedHost === null ? {} : { expectedHost }), data: JSON.stringify({ type, data: { sessionID }, location: { directory } }),
    });
    await send('session.execution.started'); await app.waitFor('id:desktop-work-status-agents-working');
    await send('session.idle', 'ses_work_status_child', { hostID: identity.hostID, lease: 'retired-lease' });
    await send('session.idle', 'ses_work_status_child', { hostID: identity.hostID, lease: identity.lease }, '/fixture/wrong-directory');
    expect(app.shows('id:desktop-work-status-agents-working')).toBe(true);
    await send('session.idle'); await app.waitFor('id:desktop-work-status-agents-done');
    for (let index = 0; index < 50; index++) { await send('session.execution.started', 'unrelated-child'); await send('session.text.delta'); }
    expect(app.shows('id:desktop-work-status-agents-done')).toBe(true);
    expect(fixture.childReads).toHaveLength(1); expect(fixture.parentReads).toHaveLength(parentReads);
    await send('session.execution.started', 'ses_work_status_child', null); await app.waitFor('id:desktop-work-status-agents-unknown');
    await app.press('id:desktop-chat-header-work-status'); await app.waitFor('id:desktop-work-status-inline', { state: 'gone' });
    await send('session.idle'); expect(fixture.childReads).toHaveLength(1);
    await app.press('id:desktop-chat-header-work-status'); await app.waitFor('id:desktop-work-status-agents-done');
    expect(fixture.childReads).toHaveLength(2); expect(fixture.parentReads).toHaveLength(parentReads);
    expect(app.value('id:composer')).toBe('Keep actual WorkStatus draft'); expect(fixture.rejected).toEqual([]); expect(fixture.mutations).toEqual([]);
  });
  test(platform + ' actual WorkStatus rejects a held child result after modal retirement and resumes on its original Chat', async () => {
    const { app, fixture, gates } = await launch(platform, 1440, { holdWorkStatusChildren: true });
    await app.waitUntil(() => gates.length === 1); expect(fixture.childReads).toHaveLength(1);
    await app.press('id:desktop-settings'); await app.waitFor('id:desktop-settings-window');
    await app.host.send('work.status.application.control', { action: 'release-children' });
    fixture.childTitle('Fresh verified child title');
    expect(fixture.childReads).toHaveLength(1); expect(app.enabled('id:desktop-work-status-subagents')).toBe(false);
    await app.press('id:desktop-settings-close'); await app.waitFor('id:desktop-settings-window', { state: 'gone' });
    await app.waitUntil(() => fixture.childReads.length === 2);
    await app.press('id:desktop-work-status-subagents'); await app.waitFor('text:Fresh verified child title');
    expect(app.texts()).not.toContain('Actual child title'); expect(app.count('id:composer')).toBe(1);
    expect(app.value('id:composer')).toBe('Keep actual WorkStatus draft'); expect(fixture.rejected).toEqual([]); expect(fixture.mutations).toEqual([]);
  });
  test(platform + ' actual WorkStatus retains expansion and child prior through inline-overlay resize and failed refresh', async () => {
    const { app, fixture } = await launch(platform);
    await app.waitUntil(() => fixture.childReads.length === 1);
    await app.press('id:desktop-work-status-subagents'); await app.waitFor('text:Actual child title');
    await app.press('id:desktop-work-status-todos');
    await app.setViewport(1200, 1100); await app.waitFor('id:desktop-work-status-inline', { state: 'gone' });
    expect(app.shows('id:desktop-work-status-overlay')).toBe(false); expect(fixture.childReads).toHaveLength(1);
    fixture.failChildren(true);
    await app.press('id:desktop-chat-header-work-status'); await app.waitFor('id:desktop-work-status-overlay');
    await app.waitUntil(() => fixture.childReads.length === 2);
    expect(app.texts()).toContain('Actual child title'); expect(app.shows('id:desktop-work-status-todo-list')).toBe(false);
    fixture.failChildren(false);
    await app.setViewport(1440, 1100); await app.waitFor('id:desktop-work-status-inline');
    expect(app.shows('id:desktop-work-status-overlay')).toBe(false); expect(app.texts()).toContain('Actual child title');
    expect(app.shows('id:desktop-work-status-todo-list')).toBe(false); expect(fixture.childReads).toHaveLength(2);
    expect(app.count('id:composer')).toBe(1); expect(app.count('id:transcript')).toBe(1);
    expect(app.value('id:composer')).toBe('Keep actual WorkStatus draft'); expect(fixture.rejected).toEqual([]); expect(fixture.mutations).toEqual([]);
  });
  test(platform + ' actual Chat WorkStatus uses original tasks and exact child read without replacing its composer or transcript', async () => {
    const { app, fixture } = await launch(platform);
    await app.waitFor('id:desktop-work-status-inline'); await app.waitFor('id:desktop-work-status-todo-list');
    expect(app.texts()).toContain('Keep completed desktop task'); expect(app.texts()).toContain('Keep cancelled desktop task'); expect(app.texts()).toContain('Keep pending desktop task');
    expect(app.texts()).toContain('actual-main'); expect(app.shows('id:desktop-work-status-changes')).toBe(true);
    expect(app.count('id:composer')).toBe(1); expect(app.count('id:transcript')).toBe(1);
    await app.waitUntil(() => fixture.childReads.length === 1);
    await app.press('id:desktop-work-status-subagents'); await app.waitFor('id:desktop-work-status-agent-ses_work_status_child');
    expect(app.texts()).toContain('Actual child title'); expect(app.texts()).not.toContain('1 working');
    const reads = fixture.childReads.length;
    for (let index = 0; index < 50; index++) { await app.clear('id:composer'); await app.paste('id:composer', { text: `Actual WorkStatus edit ${index}` }); }
    expect(fixture.childReads).toHaveLength(reads); expect(app.count('id:composer')).toBe(1); expect(app.value('id:composer')).toBe('Actual WorkStatus edit 49');
    await app.press('id:desktop-work-status-todos'); expect(app.shows('id:desktop-work-status-todo-list')).toBe(false);
    await app.press('id:desktop-settings'); await app.waitFor('id:desktop-settings-window');
    expect(app.enabled('id:desktop-work-status-todos')).toBe(false);
    await app.press('id:desktop-settings-close'); await app.waitFor('id:desktop-settings-window', { state: 'gone' });
    expect(app.shows('id:desktop-work-status-todo-list')).toBe(false); expect(app.shows('id:desktop-work-status-agent-ses_work_status_child')).toBe(true);
    expect(app.value('id:composer')).toBe('Actual WorkStatus edit 49'); expect(fixture.rejected).toEqual([]); expect(fixture.mutations).toEqual([]);
  });
  test(platform + ' actual narrow WorkStatus overlay shares the header toggle and opens only the existing readonly child workbench', async () => {
    const { app, fixture } = await launch(platform, 1200);
    expect(app.shows('id:desktop-work-status-inline')).toBe(false); expect(fixture.childReads).toEqual([]);
    await app.press('id:desktop-chat-header-work-status'); await app.waitFor('id:desktop-work-status-overlay');
    await app.waitFor('id:desktop-work-status-subagents'); await app.press('id:desktop-work-status-subagents');
    await app.waitFor('id:desktop-work-status-agent-ses_work_status_child');
    await app.keyboard.press('escape'); await app.waitFor('id:desktop-work-status-overlay', { state: 'gone' });
    const reads = fixture.childReads.length;
    for (let index = 0; index < 50; index++) { await app.clear('id:composer'); await app.paste('id:composer', { text: `Closed WorkStatus edit ${index}` }); }
    expect(fixture.childReads).toHaveLength(reads);
    await app.press('id:desktop-chat-header-work-status'); await app.waitFor('id:desktop-work-status-overlay');
    expect(app.shows('id:desktop-work-status-agent-ses_work_status_child')).toBe(true);
    await app.press('id:desktop-work-status-agent-ses_work_status_child'); await app.waitFor('text:Verified independent child transcript');
    expect(fixture.childTranscriptReads.length).toBeGreaterThan(0);
    expect(app.shows('id:desktop-context-panel')).toBe(true); expect(app.shows('id:composer')).toBe(false);
    await app.press('id:desktop-panel-close-panel'); await app.waitFor('id:composer');
    expect(app.value('id:composer')).toBe('Closed WorkStatus edit 49');
    expect(app.texts()).toContain('Actual retained parent transcript');
    expect(app.count('id:composer')).toBe(1); expect(app.count('id:desktop-work-status-toggle')).toBe(0);
    expect(fixture.rejected).toEqual([]); expect(fixture.mutations).toEqual([]);
  });
}
