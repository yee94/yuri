import { expect, open, test } from 'nsh/test';
import { createHost } from './host.js';
import { desktopJournalMethods } from '../desktop-journal-host.js';

const assistantID = 'alpha';
const generation = 9;
type ReadRequest = { path: string; method: string; body: { generation: number; ordinal: number; messageID: string }; writerGrant: string; expectedHost: unknown };
type MeasurementMetric = { phase: string; value: { bounds: { size: { width: number; height: number } }; pagePosition: { x: number; y: number } } | null };
function message(ordinal: number) {
  const text = 'Contact read original message ' + ordinal + '\n' + 'Native original conversation body. '.repeat(16);
  return { messageID: 'read-message-' + ordinal, assistantID, ordinal, role: 'assistant', turnID: 'read-turn-' + ordinal,
    bubbleIndex: 0, status: 'complete', text, parts: [{ type: 'text', text }], createdAt: 1000 + ordinal };
}
function contactFixture(count = 24) {
  const original = createHost(), reads: ReadRequest[] = [], rejected: string[] = [], metrics: MeasurementMetric[] = [];
  let messages = Array.from({ length: count }, (_, index) => message(index + 1));
  let revision = 41, messageReads = 0, snapshotReads = 0, loseReadACK = false;
  const bot = { id: assistantID, name: 'Read contact', revision: 1, enabled: true, pinnedAt: null, unreadCount: 24,
    effectiveWorkspacePath: '/fixture/project', providerID: 'fixture', modelID: 'model', agent: 'build' };
  const names = [...desktopJournalMethods, ...Object.keys(original.writer.handlers), 'appearance.reset', 'appearance.apply',
    'native.diagnostics.status', 'notification.status', 'notification.launch.peek', 'connection.list', 'connection.select',
    'runtime.stream', 'runtime.stop', 'runtime.request', 'desktop.window.closeDecision'];
  const handlers = Object.fromEntries(names.map(name => [name, async (input: unknown) => {
    if (name === 'runtime.request') {
      const request = input as ReadRequest;
      if (request.path === '/api/yuri/assistants/alpha/contact/read' && request.method === 'POST') {
        original.writer.assertWrite(request, { kind: 'assistant', id: assistantID });
        reads.push(request);
        if (loseReadACK) throw new Error('Synthetic lost read response after verified dispatch');
        return { status: 200, body: { assistantID, changed: true, unreadCount: 0, readWatermark: request.body, readTip: request.body, revision: 42 } };
      }
      if (request.path === '/api/yuri/assistants/capability') return { status: 200, body: { enabled: true, supported: true } };
      if (request.path === '/api/yuri/assistants/snapshot') { snapshotReads++; return { status: 200, body: { enabled: true, revision, assistants: [bot] } }; }
      if (request.path === '/api/yuri/assistants/alpha/contact/messages?limit=30') { messageReads++; return { status: 200, body: { generation, revision, complete: true, messages } }; }
      if (request.method !== 'GET' && request.path !== '/api/config/commands/metadata') { rejected.push(request.path); throw new Error('Unexpected contact read fixture mutation'); }
    }
    return original.call(name, input ?? {});
  }]));
  handlers['contact-read.test.metric'] = async (value: unknown) => { metrics.push(value as MeasurementMetric); };
  return { ...original, handlers, reads, rejected, metrics,
    get messageReads() { return messageReads; },
    get snapshotReads() { return snapshotReads; },
    loseReadACK() { loseReadACK = true; },
    append() { revision++; messages = [...messages, message(messages.length + 1)]; },
  };
}

async function launch(platform: 'macos' | 'windows', params = {}, fixture = contactFixture()) {
  const app = await open('../../ContactReadRoot.tsx', { platform, width: 1440, height: 1000, clock: {}, host: { params, handlers: fixture.handlers } });
  await app.waitFor('id:new-session-composer');
  await app.press('id:desktop-assistants');
  await app.waitFor('id:desktop-assistant-read-marker');
  await app.waitUntil(() => app.enabled('id:composer'));
  return { app, fixture };
}
async function returnToLatest(app: Awaited<ReturnType<typeof open>>) {
  await app.scroll('id:transcript', -240);
  await settleAtLatest(app);
}
async function settleAtLatest(app: Awaited<ReturnType<typeof open>>) {
  for (let attempt = 0; attempt < 8; attempt++) {
    try { await app.scroll('id:transcript', 100_000); }
    catch (error) {
      if (error instanceof Error && error.message.includes('cannot scroll by 100000')) return;
      throw error;
    }
  }
}
async function waitForReads(app: Awaited<ReturnType<typeof open>>, fixture: ReturnType<typeof contactFixture>, count: number) {
  await app.waitUntil(() => fixture.reads.length === count).catch(error => { throw new Error(error.message + '\nActual public ref measurements: ' + JSON.stringify(fixture.metrics)); });
}
async function notify(app: Awaited<ReturnType<typeof open>>) {
  await app.host.send('runtime.event', { key: 'global', data: JSON.stringify({ type: 'yuri:assistants-changed', data: {} }) });
}

for (const platform of ['macos', 'windows'] as const) {
  test(platform + ' uninstrumented production App independently proves the exact read POST and native verified grant', async () => {
    const fixture = contactFixture();
    const app = await open('../../App.tsx', { platform, width: 1440, height: 1000, clock: {}, host: { handlers: fixture.handlers } });
    await app.waitFor('id:new-session-composer'); await app.press('id:desktop-assistants');
    await app.waitFor('id:desktop-assistant-read-marker'); await app.waitUntil(() => app.enabled('id:composer'));
    await returnToLatest(app); await waitForReads(app, fixture, 1);
    expect(fixture.reads[0].body).toEqual({ generation: 9, ordinal: 24, messageID: 'read-message-24' });
    expect(fixture.reads[0].writerGrant).toBe(fixture.writer.held().find(value => value.target.kind === 'assistant').grantID);
    expect(fixture.writer.calls.filter(call => call.name === 'acquire')).toHaveLength(1);
    expect(fixture.metrics).toEqual([]);
    expect(fixture.rejected).toEqual([]); expect(app.requests()).toEqual([]);
  });

  test(platform + ' actual YuriNativeApp emits an exact contact read POST through its original verified writer', async () => {
    const { app, fixture } = await launch(platform);
    await returnToLatest(app);
    await waitForReads(app, fixture, 1);
    expect(fixture.reads.map(input => input.body)).toEqual([{ generation: 9, ordinal: 24, messageID: 'read-message-24' }]);
    const grant = fixture.writer.held().find(value => value.target.kind === 'assistant');
    expect(grant.target).toEqual({ kind: 'assistant', id: 'alpha' });
    expect(fixture.reads[0].writerGrant).toBe(grant.grantID);
    expect(fixture.reads[0].expectedHost).toEqual({ hostID: 'desktop-fixture', lease: 'desktop-fixture-lease-0' });
    expect(fixture.writer.calls.filter(call => call.name === 'acquire')).toHaveLength(1);
    const markerMeasurements = () => fixture.metrics.filter(event => event.phase === 'measure' && event.value?.bounds.size.width === 1 && event.value.bounds.size.height === 1).length;
    const before = markerMeasurements(); expect(before).toBeGreaterThan(0);
    const beforeSnapshots = fixture.metrics.filter(event => event.phase === 'snapshot').length;
    const marker = fixture.metrics.filter(event => event.phase === 'measure' && event.value?.bounds.size.width === 1 && event.value.bounds.size.height === 1).at(-1)?.value;
    const viewport = fixture.metrics.filter(event => event.phase === 'measure' && event.value && event.value.bounds.size.width > 1).at(-1)?.value;
    expect(marker.pagePosition.x - viewport.pagePosition.x).toBe(32);
    expect(Math.abs(viewport.pagePosition.y + viewport.bounds.size.height - marker.pagePosition.y - marker.bounds.size.height - 48)).toBeLessThan(1.1);
    for (let index = 0; index < 50; index++) await app.type('id:composer', ' ');
    await app.clock!.fastForward(60_000);
    expect(fixture.reads).toHaveLength(1);
    expect(markerMeasurements()).toBe(before);
    expect(fixture.metrics.filter(event => event.phase === 'snapshot').length).toBe(beforeSnapshots);
    expect(fixture.rejected).toEqual([]);
    expect(app.requests()).toEqual([]);
  });

  test(platform + ' original List away from latest and unseen latest marker sends no read for a newly authoritative message', async () => {
    const { app, fixture } = await launch(platform);
    await returnToLatest(app); await waitForReads(app, fixture, 1);
    await app.scroll('id:transcript', -1800);
    expect(app.shows('id:desktop-assistant-read-marker')).toBe(false);
    const before = fixture.messageReads;
    fixture.append(); await notify(app);
    await app.waitUntil(() => fixture.messageReads > before); await app.wait(200);
    expect(fixture.reads).toHaveLength(1);
    expect(app.shows('id:desktop-assistant-read-marker')).toBe(false);
    await app.clock!.fastForward(30_000);
    expect(fixture.reads).toHaveLength(1);
    await settleAtLatest(app);
    await waitForReads(app, fixture, 2);
    expect(fixture.reads[1].body).toEqual({ generation: 9, ordinal: 25, messageID: 'read-message-25' });
    expect(fixture.reads[1].writerGrant).toBe(fixture.reads[0].writerGrant);
    expect(fixture.rejected).toEqual([]); expect(app.requests()).toEqual([]);
  });

  test(platform + ' Settings blocks the actual controller after a delayed real marker measurement, then resumes with a fresh check', async () => {
    const { app, fixture } = await launch(platform, { holdReadMeasure: true });
    await returnToLatest(app);
    await app.waitUntil(() => fixture.metrics.some(event => event.phase === 'held'));
    expect(fixture.reads).toEqual([]);
    const grant = fixture.writer.held();
    await app.press('id:desktop-settings'); await app.waitFor('id:desktop-settings-window');
    await app.host.send('contact-read.test.control', { action: 'release' }); await app.wait(100);
    expect(fixture.reads).toEqual([]);
    expect(fixture.writer.held()).toEqual(grant);
    await app.press('id:desktop-settings-close');
    await app.waitFor('id:desktop-settings-window', { state: 'gone' });
    await waitForReads(app, fixture, 1);
    expect(fixture.reads[0].body).toEqual({ generation: 9, ordinal: 24, messageID: 'read-message-24' });
    expect(fixture.reads[0].writerGrant).toBe(grant[0].grantID);
    expect(fixture.writer.calls.filter(call => call.name === 'acquire')).toHaveLength(1);
    expect(fixture.rejected).toEqual([]); expect(app.requests()).toEqual([]);
  });

  test(platform + ' lost read ACK retains the same native writer lock and never replays on timers, complete catalogs or focus/layout checks', async () => {
    const fixture = contactFixture(); fixture.loseReadACK();
    const { app } = await launch(platform, {}, fixture);
    await returnToLatest(app); await waitForReads(app, fixture, 1);
    const grant = fixture.writer.held();
    await app.clock!.fastForward(60_000);
    const beforeHistory = fixture.messageReads, beforeCatalog = fixture.snapshotReads;
    fixture.append(); await notify(app);
    await app.waitUntil(() => fixture.snapshotReads > beforeCatalog); await app.wait(200);
    expect(fixture.messageReads).toBe(beforeHistory);
    await app.setViewport(1420, 980);
    await app.press('id:desktop-settings'); await app.waitFor('id:desktop-settings-window');
    await app.press('id:desktop-settings-close'); await app.waitFor('id:desktop-settings-window', { state: 'gone' });
    await app.clock!.fastForward(60_000);
    expect(fixture.reads).toHaveLength(1);
    expect(fixture.writer.held()).toEqual(grant);
    expect(fixture.writer.calls.filter(call => call.name === 'acquire')).toHaveLength(1);
    expect(fixture.writer.calls.filter(call => call.name === 'release' || call.name === 'renew')).toEqual([]);
    await app.host.send('desktop.window.closeRequested', { ticket: 'contact-read-unknown', windowID: 'synthetic-writer-window', generation: 1, reason: 'close' });
    await app.waitUntil(() => app.host.calls().some(call => call.name === 'desktop.window.closeDecision'));
    expect(app.host.calls().filter(call => call.name === 'desktop.window.closeDecision').at(-1)?.data).toMatchObject({ approved: false });
    expect(fixture.rejected).toEqual([]); expect(app.requests()).toEqual([]);
  });

  test(platform + ' short-contact production root acknowledges its actual initial frame without any scroll gesture', async () => {
    const fixture = contactFixture(1);
    const app = await open('../../App.tsx', { platform, width: 1440, height: 1000, clock: {}, host: { handlers: fixture.handlers } });
    await app.waitFor('id:new-session-composer'); await app.press('id:desktop-assistants');
    await app.waitFor('id:desktop-assistant-read-marker');
    await waitForReads(app, fixture, 1);
    expect(fixture.reads[0].body).toEqual({ generation: 9, ordinal: 1, messageID: 'read-message-1' });
    expect(fixture.reads[0].writerGrant).toBe(fixture.writer.held().find(value => value.target.kind === 'assistant').grantID);
    expect(fixture.writer.calls.filter(call => call.name === 'acquire')).toHaveLength(1);
    await app.setViewport(1420, 980);
    await app.clock!.fastForward(60_000);
    expect(app.shows('id:desktop-assistant-read-marker')).toBe(true);
    await expect(app.scroll('id:transcript', -10)).rejects.toThrow('cannot scroll by -10: it is at 0 of 0');
    await expect(app.scroll('id:transcript', 10)).rejects.toThrow('cannot scroll by 10: it is at 0 of 0');
    expect(fixture.reads).toHaveLength(1);
    expect(fixture.metrics).toEqual([]); expect(fixture.rejected).toEqual([]);
    expect(app.requests()).toEqual([]);
  });

  test(platform + ' short-contact modal revokes a delayed actual snapshot until a fresh original List read', async () => {
    const { app, fixture } = await launch(platform, { holdReadSnapshot: true }, contactFixture(1));
    await app.waitUntil(() => fixture.metrics.some(event => event.phase === 'heldSnapshot'));
    expect(fixture.reads).toEqual([]);
    const grant = fixture.writer.held();
    await app.press('id:desktop-settings'); await app.waitFor('id:desktop-settings-window');
    await app.host.send('contact-read.test.control', { action: 'release' }); await app.wait(100);
    expect(fixture.reads).toEqual([]);
    expect(fixture.writer.held()).toEqual(grant);
    const snapshots = fixture.metrics.filter(event => event.phase === 'snapshot').length;
    await app.press('id:desktop-settings-close'); await app.waitFor('id:desktop-settings-window', { state: 'gone' });
    await waitForReads(app, fixture, 1);
    expect(fixture.metrics.filter(event => event.phase === 'snapshot').length).toBeGreaterThan(snapshots);
    expect(fixture.reads[0].body).toEqual({ generation: 9, ordinal: 1, messageID: 'read-message-1' });
    expect(fixture.reads[0].writerGrant).toBe(grant[0].grantID);
    expect(fixture.writer.calls.filter(call => call.name === 'acquire')).toHaveLength(1);
    expect(fixture.rejected).toEqual([]); expect(app.requests()).toEqual([]);
  });

  test(platform + ' retired contact owner and original List ref reject a late actual short snapshot', async () => {
    const { app, fixture } = await launch(platform, { holdReadSnapshot: true }, contactFixture(1));
    await app.waitUntil(() => fixture.metrics.some(event => event.phase === 'heldSnapshot'));
    await app.press('id:desktop-schedules');
    await app.waitFor('id:desktop-assistant-read-marker', { state: 'gone' });
    await app.host.send('contact-read.test.control', { action: 'release' }); await app.wait(100);
    expect(fixture.reads).toEqual([]);
    await app.press('id:desktop-assistants'); await app.waitFor('id:desktop-assistant-read-marker');
    await waitForReads(app, fixture, 1);
    expect(fixture.reads[0].body).toEqual({ generation: 9, ordinal: 1, messageID: 'read-message-1' });
    expect(fixture.reads[0].writerGrant).toBe(fixture.writer.held().find(value => value.target.kind === 'assistant').grantID);
    expect(fixture.rejected).toEqual([]); expect(app.requests()).toEqual([]);
  });

  test(platform + ' a newer short-contact layout rejects an old snapshot even when its position is unchanged', async () => {
    const { app, fixture } = await launch(platform, { holdReadSnapshot: true }, contactFixture(1));
    await app.waitUntil(() => fixture.metrics.some(event => event.phase === 'heldSnapshot'));
    await app.setViewport(1420, 980);
    const held = fixture.metrics.filter(event => event.phase === 'heldSnapshot').length;
    await app.host.send('contact-read.test.control', { action: 'releaseSnapshotOne' });
    await app.waitUntil(() => fixture.metrics.filter(event => event.phase === 'heldSnapshot').length > held);
    expect(fixture.reads).toEqual([]);
    await app.host.send('contact-read.test.control', { action: 'release' });
    await waitForReads(app, fixture, 1);
    expect(fixture.reads[0].body).toEqual({ generation: 9, ordinal: 1, messageID: 'read-message-1' });
    expect(fixture.rejected).toEqual([]); expect(app.requests()).toEqual([]);
  });

  test(platform + ' original user scroll wins over a delayed snapshot without automatic return', async () => {
    const { app, fixture } = await launch(platform, { holdReadSnapshot: true });
    await app.waitUntil(() => fixture.metrics.some(event => event.phase === 'heldSnapshot'));
    await app.scroll('id:transcript', -1800);
    expect(app.shows('id:desktop-assistant-read-marker')).toBe(false);
    await app.host.send('contact-read.test.control', { action: 'release' }); await app.wait(100);
    await app.clock!.fastForward(30_000);
    expect(fixture.reads).toEqual([]);
    expect(app.shows('id:desktop-assistant-read-marker')).toBe(false);
    await settleAtLatest(app); await waitForReads(app, fixture, 1);
    expect(fixture.reads[0].body).toEqual({ generation: 9, ordinal: 24, messageID: 'read-message-24' });
    expect(fixture.writer.calls.filter(call => call.name === 'acquire')).toHaveLength(1);
    expect(fixture.rejected).toEqual([]); expect(app.requests()).toEqual([]);
  });

  test(platform + ' a new authoritative short-contact position rejects the pending old-position snapshot', async () => {
    const { app, fixture } = await launch(platform, { holdReadSnapshot: true }, contactFixture(1));
    await app.waitUntil(() => fixture.metrics.some(event => event.phase === 'heldSnapshot'));
    const historyReads = fixture.messageReads;
    fixture.append(); await notify(app);
    await app.waitUntil(() => fixture.messageReads > historyReads);
    await app.waitFor('text:' + message(2).text.replace(/\s+/g, ' ').trim());
    const held = fixture.metrics.filter(event => event.phase === 'heldSnapshot').length;
    await app.host.send('contact-read.test.control', { action: 'releaseSnapshotOne' });
    await app.waitUntil(() => fixture.metrics.filter(event => event.phase === 'heldSnapshot').length > held);
    expect(fixture.reads).toEqual([]);
    await app.host.send('contact-read.test.control', { action: 'release' });
    await waitForReads(app, fixture, 1);
    expect(fixture.reads[0].body).toEqual({ generation: 9, ordinal: 2, messageID: 'read-message-2' });
    expect(fixture.writer.calls.filter(call => call.name === 'acquire')).toHaveLength(1);
    expect(fixture.rejected).toEqual([]); expect(app.requests()).toEqual([]);
  });
}
