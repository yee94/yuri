import { expect, open, test } from 'nsh/test';
import { createHost } from './host.js';
import { desktopJournalMethods } from '../desktop-journal-host.js';
import { createScheduleHost } from './ScheduleHost.js';

function hostHandlers(fixture: ReturnType<typeof createHost>) {
  const names = [...desktopJournalMethods, ...Object.keys(fixture.writer.handlers), 'appearance.reset', 'appearance.apply', 'native.diagnostics.status', 'notification.status', 'notification.launch.peek', 'connection.list', 'connection.select', 'runtime.stream', 'runtime.stop', 'runtime.request', 'desktop.window.closeDecision'];
  return Object.fromEntries(names.map(name => [name, input => fixture.call(name, input)]));
}

function contactReadReply(fixture: ReturnType<typeof createHost>, input) {
  const match = /^\/api\/yuri\/assistants\/(alpha|beta)\/contact\/read$/.exec(input.path);
  if (!match || input.method !== 'POST') return null;
  fixture.writer.assertWrite(input, { kind: 'assistant', id: match[1] });
  expect(Object.keys(input.body).sort()).toEqual(['generation', 'messageID', 'ordinal']);
  expect(Number.isSafeInteger(input.body.generation)).toBe(true); expect(Number.isSafeInteger(input.body.ordinal)).toBe(true);
  return { status: 200, body: { assistantID: match[1], changed: true, unreadCount: 0, readWatermark: input.body, readTip: input.body, revision: 2 } };
}

async function chooseProject(app: Awaited<ReturnType<typeof open>>, projectID = 'desktop-project') {
  await app.waitFor('id:new-session-project');
  await app.waitUntil(() => app.enabled('id:new-session-project'));
  await app.press('id:new-session-project');
  await app.press('id:new-session-project-' + projectID);
  await app.waitFor('id:new-session-project-' + projectID, { state: 'gone' });
  await app.waitFor('id:new-session-composer');
  await app.waitUntil(() => app.enabled('id:new-session-composer'));
}

for (const platform of ['macos', 'windows'] as const) {
  test(`${platform} actual contact messages and attachment-only send use dedicated native presentation and the original writer`, async () => {
    const fixture = createHost(), posts: unknown[] = [], picks: unknown[] = [];
    const bot = { id: 'alpha', name: 'Contact alpha', revision: 1, enabled: true, pinnedAt: null, unreadCount: 0,
      effectiveWorkspacePath: '/fixture/project', providerID: 'fixture', modelID: 'model', agent: 'build' };
    const message = (messageID, role, ordinal, turnID, text, extra = {}) => ({ messageID, role, ordinal, turnID, text, assistantID: 'alpha', createdAt: 1000 + ordinal, bubbleIndex: 0, status: 'complete', parts: [{ type: 'text', text }], ...extra });
    const messages = [message('answer-one', 'assistant', 1, 'first-turn', 'First original bubble'), message('answer-two', 'assistant', 2, 'first-turn', 'Second original bubble'),
      message('peer-message', 'peer', 3, 'peer-turn', 'A real peer message', { fromAssistantID: 'beta', fromAssistantName: 'Contact beta' })];
    const contact = { type: 'file', assistantID: 'alpha', attachmentID: 'uploaded', sha256: 'a'.repeat(64), size: 17, mime: 'text/plain', filename: 'note.txt' };
    const file = { uri: '/api/yuri/assistants/alpha/contact/attachments/uploaded', name: 'note.txt', mime: contact.mime, contact };
    const handlers = Object.fromEntries(Object.entries(hostHandlers(fixture)).map(([name, call]) => [name, async input => {
      if (name === 'runtime.request') {
        const read = contactReadReply(fixture, input); if (read) return read;
        if (input.path === '/api/yuri/assistants/capability') return { status: 200, body: { enabled: true, supported: true } };
        if (input.path === '/api/yuri/assistants/snapshot') return { status: 200, body: { enabled: true, revision: 1, assistants: [bot] } };
        if (input.path === '/api/yuri/assistants/alpha/contact/messages?limit=30') return { status: 200, body: { generation: 1, revision: 1, complete: true, messages } };
        if (input.path === '/api/yuri/assistants/alpha/messages' && input.method === 'POST') {
          fixture.writer.assertWrite(input, { kind: 'assistant', id: 'alpha' }); posts.push(input);
          const { assistantID: _owner, ...part } = contact;
          expect(input.body.parts).toEqual([part]); expect(input.body.language).toBe('en-US');
          return { status: 200, body: { admitted: true, messageID: input.body.messageID } };
        }
        if (input.method !== 'GET') throw new Error('Unexpected contact mutation');
      }
      return call(input);
    }]));
    handlers['desktop.attachments.pick'] = input => {
      expect(input.target).toEqual({ kind: 'assistant', assistantID: 'alpha' });
      expect(input.expectedHost).toEqual({ hostID: 'desktop-fixture', lease: 'desktop-fixture-lease-0' }); picks.push(input);
      return { requestID: input.requestID, target: input.target, state: 'ready', attachments: [file], orphaned: 0 };
    };
    const app = await open('../../App.tsx', { platform, width: 1440, height: 1000, clock: {}, host: { handlers } });
    await app.waitFor('id:new-session-composer'); await app.press('id:desktop-assistants'); await app.waitFor('text:A real peer message');
    await app.waitUntil(() => app.enabled('id:composer'));
    expect(app.count('id:transcript')).toBe(1); expect(app.count('id:composer')).toBe(1);
    expect(app.shows('id:desktop-assistant-avatar-answer-one')).toBe(true); expect(app.shows('id:desktop-assistant-avatar-answer-two')).toBe(false);
    expect(app.shows('id:desktop-assistant-avatar-peer-message')).toBe(true); expect(app.texts().some(value => value.includes('Contact beta'))).toBe(true);
    expect(app.shows('id:composer-dictate')).toBe(false); expect(app.shows('id:stop')).toBe(false);
    const before = app.host.calls().filter(call => call.name === 'runtime.request').length;
    for (let count = 0; count < 50; count++) await app.type('id:composer', ' ');
    expect(app.host.calls().filter(call => call.name === 'runtime.request')).toHaveLength(before);
    expect(fixture.writer.calls.filter(call => call.name === 'acquire')).toHaveLength(1);
    await app.press('id:composer-attach'); await app.waitFor('id:composer-remove-attachment-note.txt');
    expect(picks).toHaveLength(1); expect(app.enabled('id:send')).toBe(true);
    await app.press('id:desktop-settings'); await app.waitFor('id:desktop-settings-window'); expect(app.shows('id:composer-remove-attachment-note.txt')).toBe(true);
    await app.press('id:desktop-settings-close'); await app.waitUntil(() => app.enabled('id:send'));
    await app.press('id:send'); await app.waitUntil(() => posts.length === 1); await app.waitFor('id:composer-remove-attachment-note.txt', { state: 'gone' });
    expect(fixture.writer.calls.filter(call => call.name === 'acquire')).toHaveLength(1);
    const saved = Object.entries(app.storage()).filter(([key]) => key.startsWith('nsh:chat-draft:v1:')).map(([, value]) => JSON.parse(value));
    expect(saved.some(value => value.attachments.length === 0 && value.pendingSend === null)).toBe(true);
  });
  for (const kind of ['session', 'assistant', 'schedule'] as const) for (const catalogMiss of kind === 'session' ? [false] : [false, true]) test(`${platform} actual contact ${kind} receipt uses original sources and guarded resource navigation${catalogMiss ? ' after a fresh exact lookup' : ''}`, async () => {
    const fixture = createHost();
    let exposeTarget = !catalogMiss;
    const bots = ['alpha', 'beta'].map(id => ({ id, name: 'Card contact ' + id, revision: 1, enabled: true, working: false, pinnedAt: null, unreadCount: 0,
      effectiveWorkspacePath: '/fixture/project', providerID: 'fixture', modelID: 'model', agent: 'build', avatarSeed: id }));
    const session = { id: 'card-session', title: 'Current session title', directory: '/actual/project', time: { created: 1, updated: 10 },
      model: { providerID: 'fixture', id: 'model' }, summary: { additions: 8, deletions: 3, files: 2 } };
    const task = { id: 'card-task', name: 'Actual scheduled task', enabled: true, schedule: { kind: 'daily', times: ['07:15'], timezone: 'UTC' },
      execution: { prompt: 'Actual task prompt', providerID: 'fixture', modelID: 'model', agent: 'build', variant: '', goalEnabled: false }, state: { lastStatus: 'success' } };
    const cards = {
      session: { type: 'card', cardType: 'session', sessionID: session.id, directory: '/obsolete/project', title: 'Old receipt title', status: 'complete', branch: 'historical-branch-must-not-appear' },
      assistant: { type: 'card', cardType: 'assistant', assistantID: 'beta', name: 'Receipt assistant beta', providerID: 'fixture', modelID: 'model' },
      schedule: { type: 'card', cardType: 'schedule', projectID: 'desktop-project', taskID: task.id, name: 'Receipt schedule', kind: 'daily', time: '08:00', prompt: 'Receipt prompt' },
    };
    const handlers = Object.fromEntries(Object.entries(hostHandlers(fixture)).map(([name, call]) => [name, async input => {
      if (name === 'runtime.request') {
        const read = contactReadReply(fixture, input); if (read) return read;
        const path = input.path.split('?')[0];
        if (path === '/api/yuri/assistants/capability') return { status: 200, body: { enabled: true, supported: true } };
        if (path === '/api/yuri/assistants/snapshot') return { status: 200, body: { enabled: true, revision: exposeTarget ? 2 : 1, assistants: exposeTarget ? bots : bots.slice(0, 1) } };
        if (path === '/api/yuri/session-index') return { status: 200, body: { available: true, pinnedSessionIds: [], directories: [{ directory: session.directory, sessions: [session], hasMore: false }] } };
        if (path === '/api/session') return { status: 200, body: { data: [session], cursor: {} } };
        if (path === '/api/yuri/scheduled-tasks') return { status: 200, body: { tasks: exposeTarget ? [{ projectId: 'desktop-project', task }] : [], failedProjectIds: [] } };
        if (path === '/api/projects/desktop-project/scheduled-tasks') return { status: 200, body: { tasks: [task] } };
        if (path === '/api/yuri/scheduled-task-runs') return { status: 200, body: { runs: [], complete: true, nextCursor: null } };
        if (path === '/api/yuri/assistants/alpha/contact/messages') return { status: 200, body: { generation: 1, revision: 1, complete: true, messages: [{
          messageID: 'receipt-message', assistantID: 'alpha', role: 'assistant', ordinal: 1, turnID: 'receipt-turn', bubbleIndex: 0, status: 'complete', createdAt: 1, parts: [cards[kind]],
        }] } };
        if (path === '/api/yuri/assistants/beta/contact/messages') return { status: 200, body: { generation: 1, revision: 1, complete: true, messages: [{
          messageID: 'opened-beta', assistantID: 'beta', role: 'assistant', ordinal: 1, turnID: 'beta-turn', bubbleIndex: 0, status: 'complete', createdAt: 1, parts: [{ type: 'text', text: 'Opened exact assistant card target' }],
        }] } };
        if (path === '/api/session/card-session') { expect(input.path).toContain('directory=%2Factual%2Fproject'); return { status: 200, body: session }; }
        if (path === '/api/session/card-session/message') { expect(input.path).toContain('directory=%2Factual%2Fproject'); return { status: 200, body: { data: [{ id: 'opened-session', type: 'assistant', parts: [{ type: 'text', text: 'Opened actual session card target' }] }], cursor: {} } }; }
        if (path === '/api/session/card-session/inbox') return { status: 200, body: { data: [] } };
        if (path === '/api/rpc/opencode.goal/get') return { status: 200, body: { output: null } };
        if (path === '/api/git/worktrees') return { status: 200, body: [{ path: session.directory, name: 'Actual project', branch: 'feature/card-current' }] };
        if (path === '/api/fs/list' && input.path.includes('%2Factual%2Fproject')) return { status: 200, body: { path: session.directory, entries: [] } };
        if (input.method !== 'GET' && path !== '/api/config/commands/metadata') throw new Error('Unexpected receipt mutation');
      }
      return call(input);
    }]));
    const app = await open('../../App.tsx', { platform, width: 1440, height: 1000, clock: {}, host: { handlers } });
    await app.waitFor('id:new-session-composer'); await app.press('id:desktop-assistants'); await app.waitFor('id:desktop-assistant-receipt-' + kind);
    await app.waitUntil(() => app.enabled('id:composer'));
    expect(app.shows('id:resource-card-' + kind + '-' + (kind === 'session' ? session.id : kind === 'assistant' ? 'beta' : task.id))).toBe(false);
    if (kind === 'session') {
      expect(app.texts()).toContain('Current session title'); expect(app.texts()).toContain('fixture/model'); expect(app.texts()).toContain('+8');
      expect(app.texts()).not.toContain('Old receipt title'); expect(app.texts()).not.toContain('historical-branch-must-not-appear');
      await app.host.send('runtime.event', { key: 'global', expectedHost: { hostID: 'desktop-fixture', lease: 'desktop-fixture-lease-0' },
        data: JSON.stringify({ type: 'session.status', directory: session.directory, data: { sessionID: session.id, status: { type: 'retry' } } }) });
      await app.waitFor('id:desktop-assistant-card-changes', { state: 'gone' });
    } else if (kind === 'schedule') expect(app.texts()).toContain(catalogMiss ? '08:00' : '07:15');
    const before = app.host.calls().filter(call => call.name === 'runtime.request').length;
    for (let index = 0; index < 50; index++) await app.type('id:composer', ' ');
    expect(app.host.calls().filter(call => call.name === 'runtime.request')).toHaveLength(before);
    const owner = fixture.writer.held();
    await app.press('id:desktop-settings'); await app.waitFor('id:desktop-settings-window');
    expect(app.enabled('id:desktop-assistant-receipt-' + kind)).toBe(false); expect(fixture.writer.held()).toEqual(owner);
    await app.press('id:desktop-settings-close'); await app.waitUntil(() => app.enabled('id:desktop-assistant-receipt-' + kind));
    exposeTarget = true;
    await app.press('id:desktop-assistant-receipt-' + kind);
    if (kind !== 'session') await app.waitUntil(() => fixture.writer.calls.some(call => call.name === 'release'));
    if (kind === 'session') await app.waitFor('text:Opened actual session card target');
    else if (kind === 'assistant') {
      await app.waitFor('text:Opened exact assistant card target'); await app.waitFor('id:desktop-assistant-chat');
      expect(app.shows('id:desktop-assistant-receipt-assistant')).toBe(false);
    }
    else {
      await app.waitFor('id:desktop-schedules-workspace'); await app.waitFor('id:task-editor-desktop');
      expect(app.value('id:features-task-name')).toBe(task.name);
    }
    expect(fixture.writer.calls.filter(call => call.name === 'release')).toHaveLength(kind === 'session' ? 0 : 1);
    if (kind === 'session') expect(fixture.writer.held().filter(value => owner.some(prior => prior.grantID === value.grantID))).toEqual(owner);
    expect(app.requests()).toEqual([]);
  });
  for (const failure of ['unknown', 'not-dispatched'] as const) test(`${platform} actual contact ${failure} send has one message error owner and exact retry`, async () => {
    const fixture = createHost(), writes: unknown[] = [], proofs: unknown[] = [];
    const bot = { id: 'alpha', name: 'Contact alpha', revision: 1, enabled: true, pinnedAt: null, unreadCount: 0,
      effectiveWorkspacePath: '/fixture/project', providerID: 'fixture', modelID: 'model', agent: 'build' };
    let inputID = '', retry = false;
    const row = { messageID: 'original', assistantID: 'alpha', role: 'assistant', ordinal: 1, turnID: 'original-turn', bubbleIndex: 0, status: 'complete', createdAt: 1,
      parts: [{ type: 'text', text: 'Original before sending' }] };
    const handlers = Object.fromEntries(Object.entries(hostHandlers(fixture)).map(([name, call]) => [name, async input => {
      if (name === 'runtime.request') {
        const read = contactReadReply(fixture, input); if (read) return read;
        if (input.path === '/api/yuri/assistants/capability') return { status: 200, body: { enabled: true, supported: true } };
        if (input.path === '/api/yuri/assistants/snapshot') return { status: 200, body: { enabled: true, revision: 1, assistants: [bot] } };
        if (input.path === '/api/yuri/assistants/alpha/contact/messages?limit=30') return { status: 200, body: { generation: 1, revision: 1, complete: true, messages: [row] } };
        if (input.path === '/api/yuri/assistants/alpha/messages' && input.method === 'POST') {
          fixture.writer.assertWrite(input, { kind: 'assistant', id: 'alpha' }); writes.push(input);
          inputID = input.body.messageID; expect(input.body.parts).toEqual([{ type: 'text', text: 'Captured original user intent' }]);
          if (retry) return { status: 200, body: { admitted: true, messageID: inputID } };
          throw new Error(failure === 'not-dispatched' ? 'native_host_busy' : 'Synthetic lost ACK details must stay out of global error');
        }
        if (input.path === '/api/yuri/assistants/alpha/contact/messages?messageID=' + encodeURIComponent(inputID) + '&limit=1' && input.method === 'GET') {
          proofs.push(input);
          return { status: 200, body: { generation: 1, revision: 2, complete: true, messages: [{ ...row, messageID: inputID, role: 'user', ordinal: 2, turnID: inputID, parts: [{ type: 'text', text: 'Captured original user intent' }] }] } };
        }
        if (input.method !== 'GET') throw new Error('Unexpected contact error mutation');
      }
      return call(input);
    }]));
    handlers['desktop.attachments.pick'] = () => { throw new Error('Synthetic independent upload error'); };
    const app = await open('../../App.tsx', { platform, width: 1440, height: 1000, clock: {}, host: { handlers } });
    await app.waitFor('id:new-session-composer'); await app.press('id:desktop-assistants'); await app.waitFor('text:Original before sending');
    await app.waitUntil(() => app.enabled('id:composer')); await app.type('id:composer', 'Captured original user intent'); await app.press('id:send');
    await app.waitUntil(() => writes.length === 1); await app.waitFor('id:desktop-assistant-send-error-' + inputID);
    expect(app.count('id:desktop-assistant-message-' + inputID)).toBe(1);
    expect(app.shows('id:chat-send-retry')).toBe(false); expect(app.shows('id:chat-global-error')).toBe(false);
    expect(app.texts().some(value => value.includes('Synthetic lost ACK details'))).toBe(false);
    const held = fixture.writer.held();
    await app.press('id:desktop-assistant-send-error-' + inputID); await app.waitFor('id:desktop-assistant-send-error-popup');
    await app.press('id:desktop-settings'); await app.waitFor('id:desktop-settings-window');
    await app.waitFor('id:desktop-assistant-send-error-popup', { state: 'gone' }); expect(app.enabled('id:desktop-assistant-send-error-' + inputID)).toBe(false);
    await app.press('id:desktop-settings-close'); await app.waitFor('id:desktop-settings-window', { state: 'gone' });
    if (failure === 'not-dispatched') {
      await app.waitUntil(() => app.enabled('id:composer')); await app.type('id:composer', ' later draft');
      await app.press('id:composer-attach'); await app.waitFor('id:chat-global-error');
      expect(app.shows('id:desktop-assistant-send-error-' + inputID)).toBe(true);
    } else expect(app.enabled('id:composer')).toBe(false);
    retry = true; await app.press('id:desktop-assistant-send-error-' + inputID); await app.waitFor('id:desktop-assistant-message-retry');
    await app.press('id:desktop-assistant-message-retry'); await app.waitFor('id:desktop-assistant-send-error-' + inputID, { state: 'gone' });
    expect(writes).toHaveLength(failure === 'unknown' ? 1 : 2); expect(proofs).toHaveLength(failure === 'unknown' ? 1 : 0);
    expect(app.count('id:desktop-assistant-message-' + inputID)).toBe(1); expect(fixture.writer.held()).toEqual(held);
    expect(fixture.writer.calls.filter(call => call.name === 'acquire')).toHaveLength(1);
    if (failure === 'unknown') expect(app.enabled('id:composer')).toBe(false);
    else expect(app.value('id:composer')).toBe('Captured original user intent later draft');
  });
  for (const change of ['removal', 'disable', 'directory'] as const) for (const mode of ['clean', 'release-held', 'pending', 'unknown'] as const) {
    test(`${platform} actual assistant ${change} retirement ${mode} retains the original writer until safe release ACK`, async () => {
      const fixture = createHost(), rejected: string[] = [], writes: unknown[] = [];
      const originalBots = ['alpha', 'beta'].map(id => ({ id, name: 'Contact ' + id, revision: 1, enabled: true, pinnedAt: null,
        effectiveWorkspacePath: '/fixture/project', providerID: 'fixture', modelID: 'model', agent: 'build', unreadCount: 0 }));
      let bots = originalBots, revision = 1, enabled = true, releaseRequested = false, snapshots = 0;
      const handlers = Object.fromEntries(Object.entries(hostHandlers(fixture)).map(([name, call]) => [name, async input => {
        if (name === 'runtime.request') {
          const read = contactReadReply(fixture, input); if (read) return read;
          if (input.path === '/api/yuri/assistants/alpha/messages' && input.method === 'POST') {
            fixture.writer.assertWrite(input, { kind: 'assistant', id: 'alpha' });
            expect(Object.keys(input.body).sort()).toEqual(['language', 'messageID', 'parts']);
            writes.push(input);
            if (mode === 'pending') return await new Promise(() => {});
            if (mode === 'unknown') throw new Error('Synthetic lost contact admission ACK');
            throw new Error('Unexpected contact send in clean retirement');
          }
          if (input.path === '/api/yuri/assistants/capability' && input.method === 'GET') return { status: 200, body: { enabled: true, supported: true } };
          if (input.path === '/api/yuri/assistants/snapshot' && input.method === 'GET') { snapshots++; return { status: 200, body: { enabled, revision, assistants: bots } }; }
          for (const bot of originalBots) if (input.path === '/api/yuri/assistants/' + bot.id + '/contact/messages?limit=30' && input.method === 'GET') {
            return { status: 200, body: { generation: 1, revision: 1, complete: true, messages: [{ messageID: bot.id + '-message', assistantID: bot.id, role: 'assistant', ordinal: 1, turnID: bot.id + '-turn', bubbleIndex: 0, status: 'complete',
              text: 'Original contact history ' + bot.id, parts: [{ type: 'text', text: 'Original contact history ' + bot.id }], createdAt: 1 }] } };
          }
          if (input.method !== 'GET') { rejected.push(input.path); throw new Error('Unexpected assistant retirement mutation'); }
        }
        return call(input);
      }]));
      handlers['assistant.test.release'] = () => { releaseRequested = true; };
      const app = await open('../../AssistantRoot.tsx', { platform, width: 1440, height: 900,
        host: { params: { holdAssistantRelease: mode === 'release-held' }, handlers } });
      await app.waitFor('id:new-session-composer'); await app.press('id:desktop-assistants');
      await app.waitFor('text:Original contact history alpha'); await app.waitUntil(() => app.enabled('id:composer'));
      await app.type('id:composer', 'Retain terminal alpha draft');
      const initialGrant = fixture.writer.held(); expect(initialGrant.map(grant => grant.target)).toEqual([{ kind: 'assistant', id: 'alpha' }]);
      if (mode === 'pending' || mode === 'unknown') {
        await app.press('id:send'); await app.waitUntil(() => writes.length === 1);
        if (mode === 'unknown') await app.waitUntil(() => !app.enabled('id:send'));
      }
      bots = change === 'removal' ? originalBots.slice(1) : change === 'directory' ? originalBots.map(bot => bot.id === 'alpha' ? { ...bot, effectiveWorkspacePath: '/fixture/replaced' } : bot) : originalBots;
      enabled = change !== 'disable'; revision++;
      const notify = () => app.host.send('runtime.event', { key: 'global', data: JSON.stringify({ type: 'yuri:assistants-changed', data: {} }) });
      const beforeSnapshot = snapshots; await notify(); await app.waitUntil(() => snapshots > beforeSnapshot);
      if (mode === 'clean') {
        await app.waitFor('id:desktop-assistant-chat', { state: 'gone' });
        expect(fixture.writer.held()).toEqual([]);
        expect(fixture.writer.calls.filter(call => call.name === 'release')).toHaveLength(1);
      } else {
        if (mode === 'release-held') await app.waitUntil(() => releaseRequested);
        else await app.waitUntil(() => !app.enabled('id:composer'));
        expect(app.shows('id:desktop-assistant-chat')).toBe(true);
        expect(app.value('id:composer')).toBe('Retain terminal alpha draft');
        expect(fixture.writer.held()).toEqual(initialGrant);
        expect(fixture.writer.calls.filter(call => call.name === 'release')).toEqual([]);
        await app.host.send('desktop.window.closeRequested', { ticket: 'retired:' + change + ':' + mode, windowID: 'synthetic-writer-window', generation: 1, reason: 'close' });
        await app.waitUntil(() => app.host.calls().some(call => call.name === 'desktop.window.closeDecision'));
        expect(app.host.calls().filter(call => call.name === 'desktop.window.closeDecision').at(-1).data.approved).toBe(false);
        await app.press('id:desktop-schedules'); expect(app.shows('id:desktop-schedules-workspace')).toBe(false);
        await app.press('id:desktop-settings'); await app.waitFor('id:desktop-settings-window');
        expect(app.value('id:composer')).toBe('Retain terminal alpha draft');
        await app.press('id:desktop-settings-close'); await app.waitFor('id:desktop-settings-window', { state: 'gone' });
        expect(fixture.writer.held()).toEqual(initialGrant);
        if (mode === 'release-held') {
          await app.host.send('assistant.test.release.control', {}); await app.waitFor('id:desktop-assistant-chat', { state: 'gone' });
          expect(fixture.writer.held()).toEqual([]);
          expect(fixture.writer.calls.filter(call => call.name === 'release')).toHaveLength(1);
        }
      }
      bots = originalBots; enabled = true; revision++; await notify();
      await app.wait(180);
      expect(app.shows('id:desktop-assistant-conversation-beta')).toBe(false);
      expect(fixture.writer.calls.filter(call => call.name === 'acquire')).toHaveLength(1);
      expect(writes).toHaveLength(mode === 'pending' || mode === 'unknown' ? 1 : 0);
      expect(rejected).toEqual([]);
      const stored = Object.entries(app.storage()).filter(([key]) => key.startsWith('nsh:chat-draft:v1:')).map(([, value]) => JSON.parse(value));
      expect(stored.some(record => record.draft === 'Retain terminal alpha draft')).toBe(true);
    });
  }
  test(`${platform} actual schedule inline editor retains draft under modals, same-task selection and cancelled departures`, async () => {
    const fixture = createScheduleHost();
    const app = await open('../../App.tsx', { platform, width: 1440, height: 900, host: { handlers: fixture.handlers } });
    await app.waitFor('id:new-session-composer'); await app.press('id:desktop-schedules');
    await app.waitFor('id:desktop-scheduled-task-desktop-project-alpha');
    await app.press('id:desktop-scheduled-task-desktop-project-alpha'); await app.waitFor('id:task-editor-desktop');
    await app.waitUntil(() => app.enabled('id:features-task-name'));
    await app.type('id:features-task-name', ' dirty');
    const draft = app.value('id:features-task-name');
    await app.press('id:desktop-scheduled-task-desktop-project-alpha');
    expect(app.value('id:features-task-name')).toBe(draft);
    for (const dialog of ['help', 'search', 'settings'] as const) {
      const openID = dialog === 'help' ? 'desktop-shortcuts' : dialog === 'search' ? 'desktop-global-search' : 'desktop-settings';
      const surface = dialog === 'help' ? 'desktop-help-dialog' : dialog === 'search' ? 'desktop-command-palette' : 'desktop-settings-window';
      await app.press('id:' + openID); await app.waitFor('id:' + surface);
      expect(app.shows('id:task-editor-desktop')).toBe(true); expect(app.value('id:features-task-name')).toBe(draft);
      expect(app.enabled('id:features-task-save')).toBe(false);
      if (dialog === 'settings') await app.press('id:desktop-settings-close'); else await app.keyboard.press('escape');
      await app.waitFor('id:' + surface, { state: 'gone' });
    }
    let confirmations = 0;
    app.onDialog(() => { confirmations++; return 'Cancel'; });
    for (const id of ['desktop-scheduled-task-desktop-project-beta', 'desktop-scheduled-history-tab', 'desktop-assistants', 'desktop-new-session']) {
      await app.press('id:' + id);
      expect(app.shows('id:task-editor-desktop')).toBe(true); expect(app.value('id:features-task-name')).toBe(draft);
    }
    expect(confirmations).toBe(4);
    app.onDialog(() => { confirmations++; return 'Discard'; });
    await app.press('id:desktop-scheduled-task-desktop-project-beta');
    await app.waitUntil(() => app.value('id:features-task-name') === 'Schedule beta');
    expect(confirmations).toBe(5); expect(app.count('id:task-editor-desktop')).toBe(1);
    await app.type('id:features-task-prompt', ' dirty');
    await app.press('id:task-editor-more'); await app.press('role:menuitem[History]');
    await app.waitFor('id:task-editor-desktop', { state: 'gone' });
    expect(confirmations).toBe(6); expect(app.shows('id:desktop-scheduled-history-clear')).toBe(true);
    expect(fixture.writes).toEqual([]); expect(fixture.rejected).toEqual([]);
  });

  test(`${platform} actual schedule native close Cancel and expired approval never destroy the retained editor`, async () => {
    const fixture = createScheduleHost();
    const app = await open('../../App.tsx', { platform, width: 1440, height: 900, host: { handlers: fixture.handlers } });
    await app.waitFor('id:new-session-composer'); await app.press('id:desktop-schedules');
    await app.waitFor('id:desktop-scheduled-task-desktop-project-alpha'); await app.press('id:desktop-scheduled-task-desktop-project-alpha');
    await app.waitFor('id:task-editor-desktop'); await app.type('id:features-task-name', ' dirty');
    app.onDialog(() => 'Cancel');
    await app.host.send('desktop.window.closeRequested', { ticket: 'schedule:cancel', windowID: 'window', generation: 1, reason: 'close' });
    expect(app.host.calls().filter(call => call.name === 'desktop.window.closeDecision').at(-1).data).toEqual({ ticket: 'schedule:cancel', approved: false });
    app.onDialog(() => 'Discard');
    await app.host.send('desktop.window.closeRequested', { ticket: 'schedule:expired', windowID: 'window', generation: 2, reason: 'close' });
    expect(app.host.calls().filter(call => call.name === 'desktop.window.closeDecision').at(-1).data).toEqual({ ticket: 'schedule:expired', approved: true });
    expect(app.value('id:features-task-name')).toBe('Schedule alpha dirty');
    await app.type('id:features-task-name', ' after rejected ticket');
    app.onDialog(() => 'Cancel');
    await app.host.send('desktop.window.closeRequested', { ticket: 'schedule:edited', windowID: 'window', generation: 3, reason: 'quit' });
    expect(app.host.calls().filter(call => call.name === 'desktop.window.closeDecision').at(-1).data).toEqual({ ticket: 'schedule:edited', approved: false });
    expect(app.value('id:features-task-name')).toBe('Schedule alpha dirty after rejected ticket');
    expect(fixture.writes).toEqual([]);
  });

  for (const mode of ['pending', 'unknown'] as const) test(`${platform} actual schedule ${mode} save vetoes navigation and native close without replay`, async () => {
    const fixture = createScheduleHost(); fixture.mode(mode);
    const app = await open('../../App.tsx', { platform, width: 1440, height: 900, host: { handlers: fixture.handlers } });
    await app.waitFor('id:new-session-composer'); await app.press('id:desktop-schedules');
    await app.waitFor('id:desktop-scheduled-task-desktop-project-alpha'); await app.press('id:desktop-scheduled-task-desktop-project-alpha');
    await app.waitFor('text:Fixture model'); await app.type('id:features-task-name', ' saved once'); await app.press('id:features-task-save');
    await app.waitUntil(() => fixture.writes.length === 1);
    if (mode === 'unknown') await app.waitFor('id:task-editor-unknown');
    await app.press('id:desktop-assistants'); expect(app.shows('id:task-editor-desktop')).toBe(true);
    await app.host.send('desktop.window.closeRequested', { ticket: 'schedule:' + mode, windowID: 'window', generation: 1, reason: 'close' });
    expect(app.host.calls().filter(call => call.name === 'desktop.window.closeDecision').at(-1).data).toEqual({ ticket: 'schedule:' + mode, approved: false });
    expect(fixture.writes.length).toBe(1); expect(app.value('id:features-task-name')).toBe('Schedule alpha saved once');
  });

  test(`${platform} confirmed unsynced schedule save leaves a completion action, never repeats the write`, async () => {
    const fixture = createScheduleHost(); fixture.mode('unsynced');
    const app = await open('../../App.tsx', { platform, width: 1440, height: 900, host: { handlers: fixture.handlers } });
    await app.waitFor('id:new-session-composer'); await app.press('id:desktop-schedules');
    await app.waitFor('id:desktop-scheduled-task-desktop-project-alpha'); await app.press('id:desktop-scheduled-task-desktop-project-alpha');
    await app.waitFor('text:Fixture model'); await app.type('id:features-task-name', ' committed'); await app.press('id:features-task-save');
    await app.waitFor('id:task-editor-done'); expect(fixture.writes.length).toBe(1);
    await app.press('id:task-editor-done'); await app.waitFor('id:task-editor-desktop', { state: 'gone' });
    expect(fixture.writes.length).toBe(1);
  });
  test(`${platform} actual desktop assistant Chat retains one contact writer across modal windows and restores each contact draft`, async () => {
    const fixture = createHost(), rejected: string[] = [];
    const bots = ['alpha', 'beta'].map((id, index) => ({ id, name: 'Contact ' + id, revision: 1, enabled: true, pinnedAt: null, unreadCount: 0,
      effectiveWorkspacePath: '/fixture/project', providerID: 'fixture', modelID: 'model', agent: 'build', latestMessagePreview: { text: 'Preview ' + id, createdAt: index + 1 } }));
    const names = [...desktopJournalMethods, ...Object.keys(fixture.writer.handlers), 'appearance.reset', 'appearance.apply', 'native.diagnostics.status', 'notification.status', 'notification.launch.peek', 'connection.list', 'runtime.stream', 'runtime.stop', 'runtime.request'];
    const handlers = Object.fromEntries(names.map(name => [name, async input => {
      if (name === 'runtime.request') {
        const read = contactReadReply(fixture, input); if (read) return read;
        if (input.method !== 'GET') { rejected.push(input.path); throw new Error('Contact navigation must not send or mutate'); }
        if (input.path === '/api/yuri/assistants/capability') return { status: 200, body: { enabled: true, supported: true } };
        if (input.path === '/api/yuri/assistants/snapshot') return { status: 200, body: { enabled: true, revision: 1, assistants: bots } };
        for (const bot of bots) if (input.path === '/api/yuri/assistants/' + bot.id + '/contact/messages?limit=30') {
          expect(input.expectedHost).toEqual({ hostID: 'desktop-fixture', lease: 'desktop-fixture-lease-0' });
          return { status: 200, body: { generation: 1, revision: 1, complete: true, messages: [{ messageID: bot.id + '-message', assistantID: bot.id, role: 'assistant', ordinal: 1, turnID: bot.id + '-turn', bubbleIndex: 0, status: 'complete',
            text: 'Verified contact history ' + bot.id, parts: [{ type: 'text', text: 'Verified contact history ' + bot.id }], createdAt: 1 }] } };
        }
      }
      return fixture.call(name, input);
    }]));
    const app = await open('../../App.tsx', { platform, width: 1440, height: 900, host: { handlers } });
    await app.waitFor('id:new-session-composer'); await app.press('id:desktop-assistants');
    await app.waitFor('id:desktop-assistant-conversation-alpha'); await app.waitFor('id:composer');
    await app.waitFor('text:Verified contact history alpha').catch(error => { throw new Error('Initial alpha contact: ' + error.message); });
    await app.waitUntil(() => app.enabled('id:composer'));
    expect(app.count('id:composer')).toBe(1); expect(app.count('id:transcript')).toBe(1);
    expect(app.shows('id:desktop-assistant-composer')).toBe(true);
    expect(app.shows('id:desktop-assistant-message-alpha-message')).toBe(true);
    expect(app.shows('id:desktop-assistant-avatar-alpha-message')).toBe(true);
    expect(app.shows('id:composer-dictate')).toBe(false);
    expect(app.shows('id:stop')).toBe(false);
    await app.type('id:composer', 'Retained alpha draft');
    const historyReads = () => app.host.calls().filter(call => call.name === 'runtime.request' && call.data.path.includes('/contact/messages'));
    const before = historyReads().length;
    const writerCallsBeforeModals = fixture.writer.calls.length;
    for (const dialog of ['help', 'search', 'settings'] as const) {
      const openID = dialog === 'help' ? 'desktop-shortcuts' : dialog === 'search' ? 'desktop-global-search' : 'desktop-settings';
      const surface = dialog === 'help' ? 'desktop-help-dialog' : dialog === 'search' ? 'desktop-command-palette' : 'desktop-settings-window';
      await app.press('id:' + openID); await app.waitFor('id:' + surface);
      expect(app.shows('id:desktop-assistant-chat')).toBe(true);
      expect(app.value('id:composer')).toBe('Retained alpha draft');
      expect(app.enabled('id:desktop-assistant-beta')).toBe(false);
      if (dialog === 'settings') await app.press('id:desktop-settings-close'); else await app.keyboard.press('escape');
      await app.waitFor('id:' + surface, { state: 'gone' });
      await app.waitUntil(() => app.enabled('id:composer'));
      expect(app.value('id:composer')).toBe('Retained alpha draft');
    }
    expect(historyReads().length).toBe(before);
    expect(fixture.writer.calls.length).toBe(writerCallsBeforeModals);
    await app.press('id:desktop-assistant-beta'); await app.waitFor('text:Verified contact history beta');
    expect(fixture.writer.held().map(grant => grant.target)).toEqual([{ kind: 'assistant', id: 'beta' }]);
    expect(app.value('id:composer')).toBe('');
    await app.type('id:composer', 'Retained beta draft');
    await app.press('id:desktop-assistant-alpha');
    await app.waitFor('text:Verified contact history alpha').catch(error => { throw new Error('Returning to alpha contact: ' + error.message + '; writer calls: ' + JSON.stringify(fixture.writer.calls)); });
    expect(fixture.writer.held().map(grant => grant.target)).toEqual([{ kind: 'assistant', id: 'alpha' }]);
    expect(app.value('id:composer')).toBe('Retained alpha draft');
    await app.type('id:composer', ' still writable');
    expect(app.value('id:composer')).toBe('Retained alpha draft still writable');
    expect(app.host.calls().filter(call => call.name === 'runtime.stream' && call.data.key === 'chat')).toEqual([]);
    expect(rejected).toEqual([]);
  });
  test(`${platform} production root mounts the desktop workspace instead of mobile tabs`, async () => {
    const fixture = createHost();
    const app = await open('../../App.tsx', { platform, width: 1440, height: 900, host: { handlers: hostHandlers(fixture) } });
    await app.waitFor('id:desktop-workspace');
    await app.waitFor('id:desktop-sidebar');
    expect(app.shows('id:main-tabs')).toBe(false);
    await app.waitFor('id:new-session-page');
    await app.waitFor('id:new-session-composer');
    expect(app.enabled('id:new-session-composer')).toBe(false);
    expect(app.texts()).toContain('Choose a project first');
    expect(app.host.calls().filter(call => call.name === 'desktop.writer.acquire')).toEqual([]);
    const texts = app.texts(), feedback = texts.findIndex(value => value.includes('Could not read notification settings'));
    expect(feedback).toBeGreaterThan(texts.indexOf('Yuri'));
    await app.press('id:desktop-sidebar-toggle');
    await app.press('id:desktop-sidebar-toggle');
    expect(app.shows('id:new-session-page')).toBe(true);
  });

  test(`${platform} repeated new-session actions retain the same writable draft`, async () => {
    const fixture = createHost();
    const app = await open('../../App.tsx', { platform, width: 1440, height: 900, host: { handlers: hostHandlers(fixture) } });
    await chooseProject(app);
    await app.waitUntil(() => app.enabled('id:desktop-chat-header-panel'));
    const acquires = () => app.host.calls().filter(call => call.name === 'desktop.writer.acquire');
    expect(acquires()).toHaveLength(1);
    expect(acquires()[0].data.target).toEqual({ kind: 'new-session', id: '/fixture/project' });
    expect(acquires()[0].data.expectedHost).toEqual({ hostID: 'desktop-fixture', lease: 'desktop-fixture-lease-0' });
    expect(app.host.calls().filter(call => call.name === 'runtime.request' && call.data.path === '/api/fs/list?path=%2Ffixture%2Fproject').length).toBeGreaterThan(0);
    await app.type('id:new-session-composer', 'Same owner');
    await app.press('id:desktop-new-session');
    await app.press('id:desktop-new-session');
    expect(app.value('id:new-session-composer')).toBe('Same owner');
    await app.type('id:new-session-composer', ' still writable');
    expect(app.value('id:new-session-composer')).toBe('Same owner still writable');
    expect(app.shows('id:new-session-error')).toBe(false);
    expect(acquires()).toHaveLength(1);
    expect(app.host.calls().filter(call => call.name === 'desktop.writer.release' || call.name === 'desktop.writer.renew')).toEqual([]);
    expect(app.host.calls().filter(call => call.name === 'runtime.request' && call.data.method !== 'GET')).toEqual([]);
    expect(JSON.stringify(app.storage()).includes('synthetic-writer-')).toBe(false);
  });

  test(`${platform} unavailable native file journal never falls back to NSH Storage and only explicit retry unblocks close`, async () => {
    const fixture = createHost(); let available = false;
    const handlers = Object.fromEntries([...desktopJournalMethods, ...Object.keys(fixture.writer.handlers), 'appearance.reset', 'appearance.apply', 'native.diagnostics.status', 'notification.status', 'notification.launch.peek', 'connection.list', 'runtime.stream', 'runtime.stop', 'runtime.request', 'desktop.window.closeDecision'].map(name => [name, input => {
      if (desktopJournalMethods.includes(name) && !available) throw new Error('Synthetic native journal unavailable');
      return fixture.call(name, input);
    }]));
    const app = await open('../../App.tsx', { platform, width: 1440, height: 900, host: { handlers } });
    await app.waitFor('id:desktop-file-journal-error');
    await app.host.send('desktop.window.closeRequested', { ticket: 'journal:1', windowID: 'window', generation: 1, reason: 'close' });
    expect(app.host.calls().filter(call => call.name === 'desktop.window.closeDecision').at(-1).data).toEqual({ ticket: 'journal:1', approved: false });
    available = true;
    await app.press('id:desktop-file-journal-retry');
    await app.waitFor('id:desktop-file-journal-error', { state: 'gone' });
    await app.host.send('desktop.window.closeRequested', { ticket: 'journal:2', windowID: 'window', generation: 2, reason: 'close' });
    expect(app.host.calls().filter(call => call.name === 'desktop.window.closeDecision').at(-1).data).toEqual({ ticket: 'journal:2', approved: true });
    expect(Object.keys(app.storage()).some(key => key.startsWith('desktop-file-journal-v1:') || key.startsWith('desktop-file-operation-v1:'))).toBe(false);
    expect(app.host.calls().filter(call => call.name === 'desktop.files.journal.snapshot').length).toBeGreaterThan(0);
  });

  for (const decision of ['Save changes', 'Discard'] as const) {
    for (const failBarrier of [false, true]) {
    test(`${platform} actual file ${decision} ${failBarrier ? 'retains draft and refuses close until the failed native barrier is explicitly recovered' : 'checkpoints the native journal before allowing window close'}`, async () => {
      const fixture = createHost();
      let content = 'Synthetic file base', writes = 0, barrierUnavailable = failBarrier;
      const barriers: Array<{ version: number; requestID: string | null }> = [];
       const names = [...desktopJournalMethods, ...Object.keys(fixture.writer.handlers), 'appearance.reset', 'appearance.apply', 'native.diagnostics.status', 'notification.status', 'notification.launch.peek', 'connection.list', 'runtime.stream', 'runtime.stop', 'runtime.request', 'desktop.window.closeDecision'];
      const handlers = Object.fromEntries(names.map(name => [name, async input => {
        if (name === 'desktop.files.journal.sync' && barrierUnavailable) throw new Error('Synthetic native durability barrier failure');
        if (name === 'runtime.request') {
          const file = '/fixture/project/readme.md', query = '?directory=%2Ffixture%2Fproject&path=%2Ffixture%2Fproject%2Freadme.md';
          if (input.path === '/api/fs/stat' + query && input.method === 'GET') return { status: 200, body: { path: file, size: content.length, mtimeMs: writes + 1, isDirectory: false, isFile: true, isBinary: false, mimeType: 'text/plain' } };
          if (input.path === '/api/fs/read' + query && input.method === 'GET') return { status: 200, body: content };
          if (input.path === '/api/fs/write?directory=%2Ffixture%2Fproject' && input.method === 'POST') {
            expect(input.expectedHost).toEqual({ hostID: 'desktop-fixture', lease: 'desktop-fixture-lease-0' });
            expect(Object.keys(input.body).sort()).toEqual(['content', 'path']);
            expect(input.body.path).toBe(file);
            expect(barriers.length).toBeGreaterThan(0);
            content = input.body.content; writes++;
            return { status: 200, body: { success: true, path: file } };
          }
        }
        const result = await fixture.call(name, input);
        if (name === 'desktop.files.journal.sync') barriers.push(input);
        if (name === 'desktop.window.closeDecision' && input.approved) expect(barriers.length).toBeGreaterThan(0);
        return result;
      }]));
      const app = await open('../../App.tsx', { platform, width: 1440, height: 900, host: { handlers } });
      await chooseProject(app);
      await app.waitUntil(() => app.enabled('id:desktop-chat-header-panel'));
      await app.press('id:desktop-chat-header-panel');
      await app.waitFor('id:desktop-panel-rail-files'); await app.press('id:desktop-panel-rail-files');
      await app.waitFor('id:desktop-file-/fixture/project/readme.md'); await app.press('id:desktop-file-/fixture/project/readme.md');
      await app.waitFor('id:desktop-file-editor');
      await app.type('id:desktop-file-editor', '_checkpoint_edit');
      app.onDialog(() => decision);
      if (failBarrier) {
        await app.host.send('desktop.window.closeRequested', { ticket: 'file:failed-barrier', windowID: 'window', generation: 1, reason: 'close' });
        expect(app.host.calls().filter(call => call.name === 'desktop.window.closeDecision').at(-1).data).toEqual({ ticket: 'file:failed-barrier', approved: false });
        expect(writes).toBe(0);
        expect(app.value('id:desktop-file-editor')).toContain('_checkpoint_edit');
        barrierUnavailable = false;
        await app.waitFor('id:desktop-panel-journal-retry'); await app.press('id:desktop-panel-journal-retry');
        await app.waitFor('id:desktop-panel-journal-retry', { state: 'gone' });
      }
      await app.host.send('desktop.window.closeRequested', { ticket: 'file:checkpoint', windowID: 'window', generation: 2, reason: 'close' });
      expect(app.host.calls().filter(call => call.name === 'desktop.window.closeDecision').at(-1).data).toEqual({ ticket: 'file:checkpoint', approved: true });
      expect(barriers.length).toBeGreaterThan(decision === 'Save changes' ? 1 : 0);
      expect(writes).toBe(decision === 'Save changes' ? 1 : 0);
      expect(content.includes('_checkpoint_edit')).toBe(decision === 'Save changes');
      expect(Object.keys(app.storage()).some(key => key.startsWith('desktop-file-journal-v1:') || key.startsWith('desktop-file-operation-v1:'))).toBe(false);
    });
    }
  }

  test(`${platform} shortcut help is a separate guarded dialog over the same writable draft and sidebar`, async () => {
    const app = await open('../../App.tsx', { platform, width: 1440, height: 900 });
    await chooseProject(app);
    await app.type('id:new-session-composer', 'Help retains the original draft');
    await app.press('id:desktop-shortcuts');
    await app.waitFor('id:desktop-help-dialog');
    expect(app.shows('id:desktop-settings-window')).toBe(false);
    expect(app.shows('id:desktop-new-session')).toBe(true);
    expect(app.enabled('id:desktop-new-session')).toBe(false);
    expect(app.shows('id:desktop-help-row-open_command_palette')).toBe(true);
    await app.keyboard.press('escape');
    await app.waitFor('id:desktop-help-dialog', { state: 'gone' });
    await app.type('id:new-session-composer', ' still writable');
    expect(app.value('id:new-session-composer')).toBe('Help retains the original draft still writable');
    await app.press('id:desktop-shortcuts');
    await app.waitFor('id:desktop-help-dialog');
    await app.setLifecycle('background');
    await app.waitFor('id:desktop-help-dialog', { state: 'gone' });
    await app.setLifecycle('active');
    await app.waitUntil(() => app.enabled('id:new-session-composer'));
    expect(app.value('id:new-session-composer')).toBe('Help retains the original draft still writable');
  });

  test(`${platform} the title menu is anchored over the same draft and never mounts the mobile catalog`, async () => {
    const app = await open('../../App.tsx', { platform, width: 1440, height: 900 });
    await chooseProject(app);
    await app.type('id:new-session-composer', 'Keep the title menu draft');
    await app.press('id:desktop-session-title');
    await app.waitFor('id:desktop-session-switcher');
    expect(app.shows('id:new-session-page')).toBe(true);
    expect(app.shows('id:desktop-switcher-search')).toBe(false);
    await app.keyboard.press('escape');
    await app.waitFor('id:desktop-session-switcher', { state: 'gone' });
    expect(app.value('id:new-session-composer')).toBe('Keep the title menu draft');
    await app.press('id:desktop-session-title');
    await app.waitFor('id:desktop-switcher-new');
    await app.press('id:desktop-switcher-new');
    await app.waitFor('id:desktop-session-switcher', { state: 'gone' });
    await app.type('id:new-session-composer', ' still writable');
    expect(app.value('id:new-session-composer')).toBe('Keep the title menu draft still writable');
  });

  test(`${platform} the composer leader opens the actual Agent picker without creating or sending`, async () => {
    const app = await open('../../App.tsx', { platform, width: 1440, height: 900 });
    await chooseProject(app);
    await app.type('id:new-session-composer', 'Keep this captured draft');
    await app.keyboard.press('ctrl+x');
    await app.keyboard.press('a');
    await app.waitFor('id:new-session-agent-build');
    await app.keyboard.press('escape');
    await app.waitFor('id:new-session-selection-search', { state: 'gone' });
    expect(app.value('id:new-session-composer')).toBe('Keep this captured draft');
  });

  test(`${platform} selecting a retained title-menu session navigates after the popup closes`, async () => {
    const fixture = createHost();
    const session = { id: 'title-menu-session', title: 'Retained title-menu target', directory: '/fixture/project', time: { created: 1, updated: 2 } };
    const names = [...desktopJournalMethods, ...Object.keys(fixture.writer.handlers), 'appearance.reset', 'appearance.apply', 'native.diagnostics.status', 'notification.status', 'notification.launch.peek', 'connection.list', 'runtime.stream', 'runtime.stop', 'runtime.request'];
    const handlers = Object.fromEntries(names.map(name => [name, input => {
      if (name === 'runtime.request') {
        const path = input.path.split('?')[0];
        if (path === '/api/rpc/opencode.goal/get' && input.method === 'POST') {
          expect(input.path).toBe('/api/rpc/opencode.goal/get?location%5Bdirectory%5D=%2Ffixture%2Fproject');
          expect(input.expectedHost).toEqual({ hostID: 'desktop-fixture', lease: 'desktop-fixture-lease-0' });
          expect(input.body).toEqual({ input: { sessionID: session.id } });
          return { status: 200, body: { output: null } };
        }
        if (input.method !== 'GET') throw new Error('Title-menu selection must never send or create');
        if (path === '/api/yuri/session-index') return { status: 200, body: { available: true, pinnedSessionIds: [], directories: [{ directory: session.directory, sessions: [session], hasMore: false }] } };
        if (path === '/api/session/title-menu-session') return { status: 200, body: session };
        if (path === '/api/session/title-menu-session/message') return { status: 200, body: { data: [], cursor: { next: null } } };
        if (path === '/api/session/title-menu-session/inbox' || path === '/api/session/title-menu-session/form' || path === '/api/permission/request') return { status: 200, body: { data: [] } };
      }
      return fixture.call(name, input);
    }]));
    const app = await open('../../App.tsx', { platform, width: 1440, height: 900, host: { handlers } });
    await chooseProject(app);
    await app.type('id:new-session-composer', 'Retain the previous local draft');
    await app.press('id:desktop-session-title');
    await app.waitFor('id:desktop-switcher-session-title-menu-session');
    await app.press('id:desktop-switcher-session-title-menu-session');
    await app.waitFor('id:desktop-session-switcher', { state: 'gone' });
    await app.waitFor('id:composer');
    expect(app.texts()).toContain('Retained title-menu target');
    expect(app.shows('id:new-session-composer')).toBe(false);
    expect(app.host.calls().filter(call => call.name === 'runtime.request' && call.data.method !== 'GET' && !call.data.path.startsWith('/api/rpc/opencode.goal/get?'))).toEqual([]);
  });

  test(`${platform} a narrow open panel never hides the connection form`, async () => {
    const app = await open('../../App.tsx', { platform, width: 1000, height: 700 });
    await chooseProject(app);
    await app.waitUntil(() => app.enabled('id:desktop-chat-header-panel'));
    await app.press('id:desktop-chat-header-panel');
    await app.waitFor('id:native-desktop-panel');
    await app.press('id:desktop-connections');
    await app.waitFor('id:pairing-link');
    await app.press('text:Manual connection');
    await app.waitFor('id:server-url');
    expect(app.shows('id:server-url')).toBe(true);
  });

  test(`${platform} desktop search uses the homepage's selected directory`, async () => {
    const app = await open('../../App.tsx', { platform, width: 1440, height: 900 });
    await chooseProject(app);
    await app.waitUntil(() => app.enabled('id:desktop-chat-header-panel'));
    await app.press('id:desktop-global-search');
    await app.waitFor('id:projects-global-search');
    await app.type('id:projects-global-search', 'desktop-search-proof');
    await app.waitFor('text:desktop-search-proof.txt');
    expect(app.texts()).toContain('desktop-search-proof.txt');
  });

  test(`${platform} desktop palette dismissal and settings commands retain the product navigation owner`, async () => {
    const app = await open('../../App.tsx', { platform, width: 1440, height: 900 });
    await chooseProject(app);
    await app.type('id:new-session-composer', 'Palette keeps this draft');
    await app.press('id:desktop-global-search');
    await app.waitFor('id:desktop-command-palette');
    await app.keyboard.press('escape');
    await app.waitFor('id:desktop-command-palette', { state: 'gone' });
    expect(app.value('id:new-session-composer')).toBe('Palette keeps this draft');
    await app.press('id:desktop-global-search');
    await app.type('id:projects-global-search', 'Chat');
    await app.press('id:projects-search-command:settings:chat');
    await app.waitFor('id:desktop-command-palette', { state: 'gone' });
    await app.waitFor('id:settings-preference-sessionGoalEnabled');
    await app.press('id:desktop-settings-close');
    await app.waitFor('id:desktop-settings-window', { state: 'gone' });
    expect(app.value('id:new-session-composer')).toBe('Palette keeps this draft');
    await app.type('id:new-session-composer', ' still writable');
    expect(app.value('id:new-session-composer')).toBe('Palette keeps this draft still writable');
  });

  test(`${platform} switching Host retires the homepage draft and its directory projection`, async () => {
    const app = await open('../../App.tsx', { platform, width: 1440, height: 900 });
    await chooseProject(app);
    await app.waitUntil(() => app.enabled('id:desktop-chat-header-panel'));
    await app.type('id:new-session-composer', 'Only Host A');
    await app.press('id:desktop-connections');
    await app.press('text:Other synthetic Host');
    await app.waitFor('id:new-session-composer');
    expect(app.value('id:new-session-composer')).toBe('');
    expect(app.enabled('id:new-session-composer')).toBe(false);
    expect(app.texts()).toContain('Choose a project first');
    expect(app.enabled('id:desktop-chat-header-panel')).toBe(false);
    await chooseProject(app, 'other-project');
    await app.waitUntil(() => app.enabled('id:desktop-chat-header-panel'));
    await app.type('id:new-session-composer', 'Host B is writable');
    expect(app.value('id:new-session-composer')).toBe('Host B is writable');
    expect(app.shows('id:new-session-error')).toBe(false);
  });

  test(`${platform} settings is a guarded window over the same product draft`, async () => {
    const app = await open('../../App.tsx', { platform, width: 1440, height: 900 });
    await chooseProject(app);
    await app.type('id:new-session-composer', 'Keep product draft');
    await app.press('id:desktop-settings');
    await app.waitFor('id:desktop-settings-window');
    await app.waitFor('id:settings-basics-fontSize');
    await app.waitUntil(() => app.enabled('id:desktop-settings-close'));
    await app.clear('id:settings-basics-fontSize');
    await app.type('id:settings-basics-fontSize', '125');
    app.onDialog(() => 'Cancel');
    await app.press('id:desktop-settings-close');
    expect(app.shows('id:desktop-settings-window')).toBe(true);
    expect(app.value('id:settings-basics-fontSize')).toBe('125');
    app.onDialog(() => 'Discard');
    await app.press('id:desktop-settings-page:chat');
    await app.waitFor('id:settings-preference-sessionGoalEnabled');
    await app.press('id:desktop-settings-close');
    await app.waitFor('id:desktop-settings-window', { state: 'gone' });
    expect(app.value('id:new-session-composer')).toBe('Keep product draft');
    await app.type('id:new-session-composer', ' still writable');
    expect(app.value('id:new-session-composer')).toBe('Keep product draft still writable');
  });

  test(`${platform} archive preview uses its explicit directory outside the settings entry workspace`, async () => {
    const app = await open('../../App.tsx', { platform, width: 1440, height: 900 });
    await chooseProject(app);
    await app.waitUntil(() => app.enabled('id:desktop-chat-header-panel'));
    await app.press('id:desktop-settings');
    await app.waitFor('id:settings-basics-fontSize');
    await app.type('id:desktop-settings-search', 'Archived sessions');
    await app.press('id:desktop-settings-page:archived-sessions');
    await app.waitFor('text:/workspace-b');
    await app.press('text:Preview');
    await app.waitFor('text:Archived workspace B');
    await app.press('text:Preview');
    await app.waitFor('text:Archive B directory verified');
    expect(app.texts()).toContain('Archive B directory verified');
  });

  test(`${platform} native close tickets honor Settings denial without destroying window owners`, async () => {
    const fixture = createHost();
    const handlers = Object.fromEntries([...desktopJournalMethods, ...Object.keys(fixture.writer.handlers), 'appearance.reset', 'appearance.apply', 'native.diagnostics.status', 'notification.status', 'notification.launch.peek', 'connection.list', 'connection.select', 'runtime.stream', 'runtime.stop', 'runtime.request', 'desktop.window.closeDecision'].map(name => [name, input => {
      if (name === 'desktop.window.closeDecision' && input.approved === true) throw new Error('Synthetic native ticket expired');
      return fixture.call(name, input);
    }]));
    const app = await open('../../App.tsx', { platform, width: 1440, height: 900, host: { handlers } });
    await chooseProject(app);
    await app.type('id:new-session-composer', 'Retained product draft');
    await app.press('id:desktop-settings');
    await app.waitFor('id:settings-basics-fontSize');
    await app.waitUntil(() => app.enabled('id:desktop-settings-close'));
    await app.clear('id:settings-basics-fontSize');
    await app.type('id:settings-basics-fontSize', '125');
    app.onDialog(() => 'Cancel');
    await app.host.send('desktop.window.closeRequested', { ticket: 'window:1:nonce', windowID: 'window', generation: 1, reason: 'close' });
    expect(app.shows('id:desktop-settings-window')).toBe(true);
    expect(app.value('id:settings-basics-fontSize')).toBe('125');
    expect(app.host.calls().filter(call => call.name === 'desktop.window.closeDecision')).toEqual([{ name: 'desktop.window.closeDecision', data: { ticket: 'window:1:nonce', approved: false } }]);
    app.onDialog(() => 'Discard');
    await app.host.send('desktop.window.closeRequested', { ticket: 'window:2:nonce', windowID: 'window', generation: 2, reason: 'quit' });
    expect(app.host.calls().filter(call => call.name === 'desktop.window.closeDecision')).toHaveLength(2);
    expect(app.host.calls().filter(call => call.name === 'desktop.window.closeDecision')[1].data).toEqual({ ticket: 'window:2:nonce', approved: true });
    await app.press('id:desktop-settings-close');
    await app.waitFor('id:desktop-settings-window', { state: 'gone' });
    expect(app.value('id:new-session-composer')).toBe('Retained product draft');
    await app.type('id:new-session-composer', ' still editable');
    expect(app.value('id:new-session-composer')).toBe('Retained product draft still editable');
  });

}
