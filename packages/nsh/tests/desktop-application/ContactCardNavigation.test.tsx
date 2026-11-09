import { expect, open, test } from 'nsh/test';
import { createHost } from './host.js';
import { desktopJournalMethods } from '../desktop-journal-host.js';

type Kind = 'assistant' | 'schedule';
type Metric = { phase: string; key: string };
const originalScope = { hostID: 'desktop-fixture', lease: 'desktop-fixture-lease-0' };
const originalDraft = 'Original alpha draft must flush before native release';
const task = { id: 'card-task', name: 'Exact card task', enabled: true, schedule: { kind: 'daily', times: ['07:15'], timezone: 'UTC' },
  execution: { prompt: 'Exact task prompt', providerID: 'fixture', modelID: 'model', agent: 'build', variant: '', goalEnabled: false }, state: { lastStatus: 'success' } };
const session = { id: 'card-session', title: 'Retained card session', directory: '/fixture/project', time: { created: 1, updated: 10 } };

function fixtureFor(kind: Kind, options: { same?: boolean; lostSend?: boolean; omitBeta?: boolean; sessionPath?: boolean } = {}) {
  const original = createHost(), metrics: Metric[] = [], requests = [], sends = [], reads = [], rejected: string[] = [];
  const allBots = ['alpha', 'beta'].map(id => ({ id, name: 'Navigation contact ' + id, revision: 1, enabled: true, working: false, pinnedAt: null, unreadCount: 0,
    effectiveWorkspacePath: '/fixture/project', providerID: 'fixture', modelID: 'model', agent: 'build', avatarSeed: id }));
  let bots = options.omitBeta ? allBots.slice(0, 1) : allBots, revision = 1;
  const card = kind === 'assistant'
    ? { type: 'card', cardType: 'assistant', assistantID: options.same ? 'alpha' : 'beta', name: 'Exact assistant receipt' }
    : { type: 'card', cardType: 'schedule', projectID: 'desktop-project', taskID: task.id, name: 'Exact schedule receipt', kind: 'daily', time: '07:15', prompt: 'Original task receipt' };
  const row = (id: string, parts: unknown[]) => ({ messageID: id + '-original', assistantID: id, role: 'assistant', ordinal: 1, turnID: id + '-turn', bubbleIndex: 0, status: 'complete', createdAt: 1, parts });
  const names = [...desktopJournalMethods, ...Object.keys(original.writer.handlers), 'appearance.reset', 'appearance.apply', 'native.diagnostics.status',
    'notification.status', 'notification.launch.peek', 'connection.list', 'connection.select', 'runtime.stream', 'runtime.stop', 'runtime.request', 'desktop.window.closeDecision'];
  const handlers = Object.fromEntries(names.map(name => [name, async input => {
    if (name !== 'runtime.request') return original.call(name, input);
    requests.push(input);
    const actual = await original.call('connection.list');
    if (JSON.stringify(input.expectedHost) !== JSON.stringify(actual.runtimeScope)) { rejected.push(input.path); throw new Error('Wrong synthetic card authority'); }
    if (input.expectedHost.hostID !== originalScope.hostID) return original.call(name, input);
    const path = input.path.split('?')[0], ok = body => ({ status: 200, body });
    const read = /^\/api\/yuri\/assistants\/(alpha|beta)\/contact\/read$/.exec(path);
    if (read && input.method === 'POST') {
      original.writer.assertWrite(input, { kind: 'assistant', id: read[1] }); reads.push(input);
      expect(Object.keys(input.body).sort()).toEqual(['generation', 'messageID', 'ordinal']);
      return ok({ assistantID: read[1], changed: true, unreadCount: 0, readWatermark: input.body, readTip: input.body, revision: 2 });
    }
    if (path === '/api/yuri/assistants/alpha/messages' && input.method === 'POST') {
      original.writer.assertWrite(input, { kind: 'assistant', id: 'alpha' }); sends.push(input);
      expect(Object.keys(input.body).sort()).toEqual(['language', 'messageID', 'parts']);
      if (options.lostSend) throw new Error('Synthetic lost contact send ACK');
      return ok({ admitted: true, messageID: input.body.messageID });
    }
    if (options.sessionPath && path === '/api/rpc/opencode.goal/get' && input.method === 'POST') {
      expect(input.path).toBe('/api/rpc/opencode.goal/get?location%5Bdirectory%5D=' + encodeURIComponent(session.directory));
      expect(input.body).toEqual({ input: { sessionID: session.id } }); return ok({ output: null });
    }
    if (input.method !== 'GET' && !(path === '/api/config/commands/metadata' && input.method === 'POST')) {
      rejected.push(path); throw new Error('Unexpected synthetic card mutation');
    }
    if (path === '/api/yuri/assistants/capability') return ok({ enabled: true, supported: true });
    if (path === '/api/yuri/assistants/snapshot') return ok({ enabled: true, revision, assistants: bots });
    if (path === '/api/yuri/assistants/alpha/contact/messages' && input.path.endsWith('?limit=30')) return ok({ generation: 1, revision: 1, complete: true, messages: [row('alpha', [
      { type: 'text', text: 'Original alpha retained conversation' }, card,
      ...(options.sessionPath ? [{ type: 'card', cardType: 'session', sessionID: session.id, directory: session.directory, title: session.title }] : []),
    ])] });
    if (path === '/api/yuri/assistants/beta/contact/messages' && input.path.endsWith('?limit=30')) return ok({ generation: 1, revision: 1, complete: true,
      messages: [row('beta', [{ type: 'text', text: 'Exact beta destination conversation' }])] });
    if (path === '/api/yuri/scheduled-tasks') return ok({ tasks: [{ projectId: 'desktop-project', task }], failedProjectIds: [] });
    if (path === '/api/projects/desktop-project/scheduled-tasks') return ok({ tasks: [task] });
    if (path === '/api/yuri/scheduled-task-runs') return ok({ runs: [], complete: true, nextCursor: null });
    if (options.sessionPath) {
      if (path === '/api/yuri/session-index') return ok({ available: true, pinnedSessionIds: [], directories: [{ directory: session.directory, sessions: [session], hasMore: false }] });
      if (path === '/api/session') return ok({ data: [session], cursor: {} });
      if (path === '/api/session/card-session') return ok(session);
      if (path === '/api/session/card-session/message') return ok({ data: [{ id: 'session-assistant-card', type: 'assistant', parts: [
        { type: 'card', cardType: 'assistant', assistantID: 'alpha', name: 'Open retained alpha route' },
      ] }], cursor: {} });
      if (path === '/api/session/card-session/inbox') return ok({ data: [] });
    }
    return original.call(name, input);
  }]));
  handlers['contact-card-navigation.test.audit'] = (metric: Metric) => { metrics.push(metric); };
  return { ...original, handlers, requests, sends, reads, rejected, metrics,
    removeBeta() { bots = allBots.slice(0, 1); revision++; },
    restoreBeta() { bots = allBots; revision++; },
    setAlphaWorking(working: boolean) { bots = bots.map(bot => bot.id === 'alpha' ? { ...bot, working } : bot); revision++; },
  };
}
async function launch(platform: 'macos' | 'windows', kind: Kind, options: Parameters<typeof fixtureFor>[1] = {}, params = {}, instrument = true) {
  const fixture = fixtureFor(kind, options);
  const app = await open(instrument ? '../../ContactCardNavigationRoot.tsx' : '../../App.tsx', {
    platform, width: 1440, height: 1000, clock: {}, host: { params, handlers: fixture.handlers },
  });
  await app.waitFor('id:new-session-composer'); await app.press('id:desktop-assistants');
  await app.waitFor('id:desktop-assistant-receipt-' + kind); await app.waitUntil(() => app.enabled('id:composer'));
  return { app, fixture };
}
const calls = (fixture: ReturnType<typeof fixtureFor>, name: string) => fixture.writer.calls.filter(call => call.name === name);
const contactGets = (fixture: ReturnType<typeof fixtureFor>) => fixture.requests.filter(input => input.method === 'GET' && /\/contact\/messages(?:\?|$)/.test(input.path));
const betaDraftReads = (fixture: ReturnType<typeof fixtureFor>) => fixture.metrics.filter(metric => metric.phase === 'draft-read' && JSON.parse(decodeURIComponent(metric.key.slice('nsh:chat-draft:v1:'.length)))[3] === 'beta');
const betaDraftWrites = (fixture: ReturnType<typeof fixtureFor>) => fixture.metrics.filter(metric => metric.phase === 'draft-written' && JSON.parse(decodeURIComponent(metric.key.slice('nsh:chat-draft:v1:'.length)))[3] === 'beta');
const draftRecords = (app: Awaited<ReturnType<typeof open>>) => Object.entries(app.storage()).filter(([key]) => key.startsWith('nsh:chat-draft:v1:')).map(([, value]) => JSON.parse(value));
async function control(app: Awaited<ReturnType<typeof open>>, action: string) { await app.host.send('contact-card-navigation.test.control', { action }); }
async function destination(app: Awaited<ReturnType<typeof open>>, kind: Kind) {
  if (kind === 'assistant') { await app.waitFor('text:Exact beta destination conversation'); await app.waitFor('id:desktop-assistant-chat'); }
  else { await app.waitFor('id:desktop-schedules-workspace'); await app.waitFor('id:task-editor-desktop'); expect(app.value('id:features-task-name')).toBe(task.name); expect(app.count('id:task-editor-desktop')).toBe(1); }
}
function noTarget(app: Awaited<ReturnType<typeof open>>, fixture: ReturnType<typeof fixtureFor>) {
  expect(app.shows('text:Original alpha retained conversation')).toBe(true);
  expect(app.shows('text:Exact beta destination conversation')).toBe(false); expect(app.shows('id:task-editor-desktop')).toBe(false);
  expect(calls(fixture, 'acquire').filter(call => call.value.target.id === 'beta')).toEqual([]);
  expect(contactGets(fixture).filter(input => input.path.includes('/beta/'))).toEqual([]);
  expect(betaDraftReads(fixture)).toEqual([]); expect(betaDraftWrites(fixture)).toEqual([]);
  expect(fixture.requests.filter(input => input.method !== 'GET' && input.path.includes('/beta/'))).toEqual([]);
}
function clean(app: Awaited<ReturnType<typeof open>>, fixture: ReturnType<typeof fixtureFor>) { expect(fixture.rejected).toEqual([]); expect(app.requests()).toEqual([]); }

for (const platform of ['macos', 'windows'] as const) {
  for (const kind of ['assistant', 'schedule'] as const) {
    test(`${platform} uninstrumented actual App ${kind} card commits the Web destination with exactly one native release`, async () => {
      const { app, fixture } = await launch(platform, kind, {}, {}, false), owner = fixture.writer.held();
      await app.type('id:composer', originalDraft); await app.press('id:desktop-assistant-receipt-' + kind); await destination(app, kind);
      expect(calls(fixture, 'release')).toHaveLength(1); expect(fixture.writer.held().some(grant => owner.some(old => old.grantID === grant.grantID))).toBe(false);
      expect(draftRecords(app).some(record => record.draft === originalDraft)).toBe(true);
      expect(fixture.metrics).toEqual([]); clean(app, fixture);
    });
    test(`${platform} actual App ${kind} waits for the synthetic native release ACK before any destination hydration`, async () => {
      const { app, fixture } = await launch(platform, kind, {}, { holdRelease: true }), owner = fixture.writer.held();
      await app.type('id:composer', originalDraft); await app.press('id:desktop-assistant-receipt-' + kind);
      await app.waitUntil(() => fixture.metrics.some(metric => metric.phase === 'release-ack-held'));
      noTarget(app, fixture); expect(app.value('id:composer')).toBe(originalDraft); expect(app.enabled('id:composer')).toBe(false);
      expect(draftRecords(app).some(record => record.draft === originalDraft && record.pendingSend === null)).toBe(true);
      const written = fixture.metrics.findIndex(metric => metric.phase === 'draft-written');
      expect(written).toBeGreaterThanOrEqual(0); expect(written).toBeLessThan(fixture.metrics.findIndex(metric => metric.phase === 'release-ack-held'));
      expect(calls(fixture, 'release')).toHaveLength(1);
      await control(app, 'release-ack'); await destination(app, kind);
      expect(calls(fixture, 'release')).toHaveLength(1); expect(fixture.writer.held().some(grant => owner.some(old => old.grantID === grant.grantID))).toBe(false);
      if (kind === 'assistant') { expect(contactGets(fixture).at(-1).path).toBe('/api/yuri/assistants/beta/contact/messages?limit=30'); expect(betaDraftReads(fixture)).toHaveLength(1); }
      clean(app, fixture);
    });
    test(`${platform} actual App Settings cancels ${kind} navigation during held release ACK without pretending the old writer is writable`, async () => {
      const { app, fixture } = await launch(platform, kind, {}, { holdRelease: true });
      await app.type('id:composer', originalDraft); await app.press('id:desktop-assistant-receipt-' + kind);
      await app.waitUntil(() => fixture.metrics.some(metric => metric.phase === 'release-ack-held'));
      await app.press('id:desktop-settings'); await app.waitFor('id:desktop-settings-window');
      await control(app, 'release-ack'); await app.waitUntil(() => fixture.metrics.some(metric => metric.phase === 'release-ack-delivered')); await app.wait(180);
      noTarget(app, fixture); expect(app.value('id:composer')).toBe(originalDraft);
      await app.press('id:desktop-settings-close'); await app.waitFor('id:desktop-settings-window', { state: 'gone' }); await app.wait(180);
      noTarget(app, fixture); expect(app.enabled('id:composer')).toBe(false); expect(app.enabled('id:send')).toBe(false);
      expect(calls(fixture, 'release')).toHaveLength(1); expect(calls(fixture, 'acquire')).toHaveLength(1);
      expect(fixture.sends).toEqual([]); expect(draftRecords(app).some(record => record.draft === originalDraft)).toBe(true); clean(app, fixture);
    });
    for (const mode of ['pending', 'unknown'] as const) test(`${platform} actual App ${mode} send vetoes ${kind} card without releasing or replaying original intent`, async () => {
      const { app, fixture } = await launch(platform, kind, { lostSend: mode === 'unknown' }, { holdSend: mode === 'pending' });
      const owner = fixture.writer.held(); await app.type('id:composer', originalDraft); await app.press('id:send');
      await app.waitUntil(() => fixture.sends.length === 1);
      if (mode === 'pending') await app.waitUntil(() => fixture.metrics.some(metric => metric.phase === 'send-ack-held'));
      else await app.waitFor('id:desktop-assistant-send-error-' + fixture.sends[0].body.messageID);
      expect(app.shows('id:desktop-assistant-typing')).toBe(false);
      if (mode === 'pending') {
        fixture.setAlphaWorking(true);
        await app.host.send('runtime.event', { key: 'global', expectedHost: originalScope,
          data: JSON.stringify({ type: 'yuri:contact-turn-start', data: { assistantID: 'alpha', turnID: 'pending-original-turn' } }) });
        expect(app.shows('id:desktop-assistant-typing')).toBe(false);
      }
      const pending = draftRecords(app).find(record => record.pendingSend)?.pendingSend;
      expect(pending.id).toBe(fixture.sends[0].body.messageID); expect(pending.text).toBe(originalDraft);
      let refused = false;
      try { await app.press('id:desktop-assistant-receipt-' + kind); }
      catch (error) {
        if (mode !== 'unknown') throw error;
        expect(String(error)).toContain('is disabled'); expect(app.enabled('id:desktop-assistant-receipt-' + kind)).toBe(false); refused = true;
      }
      expect(refused).toBe(mode === 'unknown'); await app.wait(180);
      noTarget(app, fixture); expect(calls(fixture, 'release')).toEqual([]); expect(calls(fixture, 'acquire')).toHaveLength(1);
      expect(fixture.writer.held()).toEqual(owner); expect(fixture.sends).toHaveLength(1);
      expect(draftRecords(app).find(record => record.pendingSend)?.pendingSend).toEqual(pending);
      expect(contactGets(fixture).some(input => input.path.includes('messageID='))).toBe(false); clean(app, fixture);
      if (mode === 'pending') {
        await control(app, 'send-ack');
        await app.waitFor('id:desktop-assistant-typing');
        expect(app.count('id:transcript')).toBe(1); expect(app.count('id:composer')).toBe(1);
        expect(fixture.sends).toHaveLength(1);
        fixture.setAlphaWorking(false);
        await app.host.send('runtime.event', { key: 'global', expectedHost: originalScope,
          data: JSON.stringify({ type: 'yuri:contact-turn-end', data: { assistantID: 'alpha', turnID: 'pending-original-turn', status: 'complete' } }) });
        await app.waitFor('id:desktop-assistant-typing', { state: 'gone' }); clean(app, fixture);
      }
    });
  }
  test(`${platform} actual App same-contact receipt twice retains the same List, writer, draft and Storage hydration`, async () => {
    const { app, fixture } = await launch(platform, 'assistant', { same: true });
    await app.type('id:composer', originalDraft);
    const owner = fixture.writer.held(), gets = contactGets(fixture).length, hydrates = fixture.metrics.filter(metric => metric.phase === 'draft-read').length;
    for (let count = 0; count < 2; count++) {
      await app.press('id:desktop-assistant-receipt-assistant'); await app.waitUntil(() => app.enabled('id:desktop-assistant-receipt-assistant'));
      expect(app.value('id:composer')).toBe(originalDraft); expect(app.count('id:transcript')).toBe(1); expect(app.count('id:composer')).toBe(1);
    }
    expect(fixture.writer.held()).toEqual(owner); expect(calls(fixture, 'release')).toEqual([]); expect(calls(fixture, 'acquire')).toHaveLength(1);
    expect(contactGets(fixture)).toHaveLength(gets); expect(fixture.metrics.filter(metric => metric.phase === 'draft-read')).toHaveLength(hydrates); clean(app, fixture);
  });
  test(`${platform} actual App retained non-home alpha route opens beta first, never the catalog's first alpha`, async () => {
    const { app, fixture } = await launch(platform, 'assistant', { sessionPath: true });
    await app.press('id:desktop-assistant-receipt-session'); await app.waitFor('id:resource-card-assistant-alpha');
    await app.press('id:resource-card-assistant-alpha'); await app.waitFor('id:desktop-assistant-receipt-assistant'); await app.waitUntil(() => app.enabled('id:composer'));
    const before = contactGets(fixture).length;
    await app.press('id:desktop-assistant-receipt-assistant'); await destination(app, 'assistant');
    expect(contactGets(fixture).slice(before).map(input => input.path)).toEqual(['/api/yuri/assistants/beta/contact/messages?limit=30']);
    expect(fixture.writer.held().map(grant => grant.target)).toEqual([{ kind: 'assistant', id: 'beta' }]); clean(app, fixture);
  });
  test(`${platform} actual App exact beta seed missing from the destination catalog never falls back to first alpha`, async () => {
    const { app, fixture } = await launch(platform, 'assistant', { sessionPath: true });
    await app.press('id:desktop-assistant-receipt-session'); await app.waitFor('id:resource-card-assistant-alpha');
    await app.press('id:resource-card-assistant-alpha'); await app.waitFor('id:desktop-assistant-receipt-assistant'); await app.waitUntil(() => app.enabled('id:composer'));
    const gets = contactGets(fixture).length, snapshots = fixture.requests.filter(input => input.path === '/api/yuri/assistants/snapshot').length;
    // Change only the next genuine reader response. The currently stamped catalog
    // still has beta until the fresh destination owner reads its own snapshot.
    fixture.removeBeta(); await app.press('id:desktop-assistant-receipt-assistant');
    await app.waitUntil(() => fixture.requests.filter(input => input.path === '/api/yuri/assistants/snapshot').length > snapshots);
    await app.waitFor('id:desktop-assistants-workspace'); await app.waitFor('id:desktop-assistants-retry');
    expect(app.shows('id:desktop-assistant-chat')).toBe(false); expect(app.shows('text:Exact beta destination conversation')).toBe(false);
    expect(contactGets(fixture).slice(gets)).toEqual([]); expect(fixture.writer.held()).toEqual([]); expect(betaDraftReads(fixture)).toEqual([]); clean(app, fixture);
  });
  test(`${platform} actual App removed beta invalidates navigation while the native release ACK is held`, async () => {
    const { app, fixture } = await launch(platform, 'assistant', {}, { holdRelease: true });
    await app.type('id:composer', originalDraft); await app.press('id:desktop-assistant-receipt-assistant');
    await app.waitUntil(() => fixture.metrics.some(metric => metric.phase === 'release-ack-held'));
    fixture.removeBeta();
    const before = fixture.requests.filter(input => input.path === '/api/yuri/assistants/snapshot').length;
    await app.host.send('runtime.event', { key: 'global', expectedHost: originalScope, data: JSON.stringify({ type: 'yuri:assistants-changed', data: {} }) });
    await app.clock!.fastForward(200); await app.waitUntil(() => fixture.requests.filter(input => input.path === '/api/yuri/assistants/snapshot').length > before);
    await control(app, 'release-ack'); await app.wait(180);
    noTarget(app, fixture); expect(app.enabled('id:composer')).toBe(false); expect(calls(fixture, 'release')).toHaveLength(1); expect(calls(fixture, 'acquire')).toHaveLength(1); clean(app, fixture);
  });
  test(`${platform} actual App late card catalog cannot commit after a real connection selection changes authority`, async () => {
    const { app, fixture } = await launch(platform, 'assistant', { omitBeta: true });
    fixture.restoreBeta(); await control(app, 'hold-catalog');
    await app.press('id:desktop-assistant-receipt-assistant');
    await app.waitUntil(() => fixture.metrics.some(metric => metric.phase === 'catalog-ack-held'));
    noTarget(app, fixture); expect(calls(fixture, 'release')).toEqual([]);
    await app.press('id:desktop-connections'); await app.press('text:Other synthetic Host');
    await app.waitUntil(() => app.host.calls().some(call => call.name === 'connection.select' && call.data.id === 'other-fixture'));
    await control(app, 'catalog-ack'); await app.waitUntil(() => fixture.metrics.some(metric => metric.phase === 'catalog-ack-delivered')); await app.wait(180);
    expect(app.shows('text:Exact beta destination conversation')).toBe(false); expect(app.shows('id:desktop-assistant-chat')).toBe(false);
    expect(calls(fixture, 'acquire').filter(call => call.value.target.id === 'beta')).toEqual([]); expect(betaDraftReads(fixture)).toEqual([]);
    expect(contactGets(fixture).filter(input => input.path.includes('/beta/'))).toEqual([]);
    expect(fixture.requests.filter(input => input.method !== 'GET' && input.path.includes('/beta/'))).toEqual([]);
    expect(fixture.requests.some(input => input.expectedHost.hostID === 'other-fixture')).toBe(true); clean(app, fixture);
  });
  test(`${platform} actual App late destination contact read cannot publish into a different selected authority`, async () => {
    const { app, fixture } = await launch(platform, 'assistant', {}, { holdBetaRead: true });
    await app.press('id:desktop-assistant-receipt-assistant');
    await app.waitUntil(() => fixture.metrics.some(metric => metric.phase === 'beta-read-ack-held'));
    expect(app.shows('text:Exact beta destination conversation')).toBe(false);
    const betaAcquire = calls(fixture, 'acquire').filter(call => call.value.target.id === 'beta');
    expect(betaAcquire).toHaveLength(1); expect(betaAcquire[0].value.expectedHost).toEqual(originalScope);
    await app.press('id:desktop-connections'); await app.press('text:Other synthetic Host');
    await app.waitUntil(() => app.host.calls().some(call => call.name === 'connection.select' && call.data.id === 'other-fixture'));
    await app.waitFor('id:desktop-assistant-chat', { state: 'gone' });
    const drafts = draftRecords(app), writes = fixture.metrics.filter(metric => metric.phase === 'draft-written').length;
    await control(app, 'beta-read-ack'); await app.waitUntil(() => fixture.metrics.some(metric => metric.phase === 'beta-read-ack-delivered')); await app.wait(180);
    expect(app.shows('text:Exact beta destination conversation')).toBe(false); expect(app.shows('id:desktop-assistant-chat')).toBe(false);
    expect(calls(fixture, 'acquire').filter(call => call.value.target.id === 'beta')).toEqual(betaAcquire);
    expect(fixture.requests.filter(input => input.expectedHost.hostID === 'other-fixture' && input.path.includes('/beta/'))).toEqual([]);
    expect(draftRecords(app)).toEqual(drafts); expect(fixture.metrics.filter(metric => metric.phase === 'draft-written')).toHaveLength(writes); clean(app, fixture);
  });
}
