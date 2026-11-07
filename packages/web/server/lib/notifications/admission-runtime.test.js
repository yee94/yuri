import { afterEach, expect, it, vi } from 'vitest';
import { createNotificationTriggerRuntime } from './runtime.js';
import { createNotificationAdmission, notificationAdmission } from './admission-event.js';

vi.mock('../opencode/native-goal.js', () => ({ getNativeSessionGoal: async () => null }));
const runtimes = [];
afterEach(() => { runtimes.splice(0).forEach(runtime => runtime.dispose()); vi.unstubAllGlobals(); vi.useRealTimers(); });
function setup(overrides = {}) {
  const emitted = [], legacy = [];
  let settings = { nativeNotificationsEnabled: true, notifyOnSubtasks: true };
  const fetcher = vi.fn(async (url) => {
    const id = decodeURIComponent(new URL(url).pathname.split('/').at(-1));
    return Response.json({ data: { id, directory: '/project', title: 'Private title', ...(id === 'child' ? { parentID: 'root' } : {}), metadata: {} } });
  });
  vi.stubGlobal('fetch', fetcher);
  const runtime = createNotificationTriggerRuntime({
    readSettingsFromDisk: async () => settings,
    prepareNotificationLastMessage: async ({ message }) => message ?? '', buildTemplateVariables: async () => ({ session_name: 'Private' }),
    extractLastMessageText: () => 'Private', fetchLastAssistantMessageText: async () => '', resolveNotificationTemplate: value => value,
    shouldApplyResolvedTemplateMessage: () => true, emitDesktopNotification: () => true,
    broadcastUiNotification: value => legacy.push(value), sendPushToAllUiSessions: async () => {}, sendApnsToAllUiSessions: async () => {}, sendLiveActivityEnd: async () => {},
    buildOpenCodeUrl: path => `http://unused.invalid${path}`, getOpenCodeAuthHeaders: () => ({}), loadActiveSessionIds: async () => [],
    publishNotificationAdmission: value => { emitted.push(value); return true; }, ...overrides,
  });
  runtimes.push(runtime);
  const event = (type, body = {}, id = 'boundary') => ({ type, id, location: { directory: '/project' }, data: { sessionID: 'root', ...body } });
  return { runtime, emitted, legacy, fetcher, event, settings: value => { settings = value; } };
}

it('emits all eight content-free admission kinds from real owning decisions, preserving legacy payloads', async () => {
  vi.useFakeTimers();
  const s = setup();
  await s.runtime.maybeSendPushForTrigger(s.event('session.execution.succeeded', {}, 'completed'));
  await s.runtime.maybeSendPushForTrigger(s.event('session.execution.succeeded', { sessionID: 'child' }, 'child-completed'));
  await s.runtime.maybeSendPushForTrigger(s.event('session.execution.failed', { error: 'Private error' }, 'failed'));
  await s.runtime.maybeSendPushForTrigger(s.event('form.created', { form: { id: 'form-id', sessionID: 'root', title: 'Private', fields: [{ key: 'a', type: 'string' }] } }));
  await s.runtime.maybeSendPushForTrigger(s.event('permission.asked', { id: 'permission-id', action: 'Private action' }));
  await vi.advanceTimersByTimeAsync(500);
  await s.runtime.maybeSendPushForTrigger(s.event('rpc.opencode.goal.changed', { goal: { id: 'goal', status: 'complete', objective: 'Private', reason: 'Private', rounds: 1, maxRounds: 50, boot: 'boot', updatedAt: 1 } }));
  await s.runtime.sendScheduledTaskRunNotification({ projectID: 'project', taskID: 'task', runID: 'run', reason: 'scheduled', resultOwner: 'unowned', status: 'success', taskName: 'Private task' });
  await s.runtime.sendContactTurnNotification({ assistantID: 'bot', turnID: 'turn', status: 'complete', name: 'Private name', body: 'Private message' });
  expect(s.emitted.map(value => value.kind).sort()).toEqual(['completion', 'subtask', 'error', 'question', 'permission', 'goal', 'schedule', 'assistant'].sort());
  for (const value of s.emitted) expect(notificationAdmission(value)).toEqual(value);
  expect(JSON.stringify(s.emitted)).not.toMatch(/Private|objective|title|message|body|token/);
  expect(s.emitted.find(value => value.kind === 'subtask').source.parentID).toBe('root');
  expect(s.legacy.some(value => value.kind === 'ready')).toBe(true);
  expect(s.legacy.some(value => value.kind === 'contact' && value.body === 'Private message')).toBe(true);
});

it('requires actual run ID and unowned scheduled decision; manual/takeover/silent/malformed are not success', async () => {
  const s = setup();
  const run = { projectID: 'project', taskID: 'task', runID: 'run', reason: 'scheduled', resultOwner: 'unowned', status: 'success' };
  for (const patch of [{ reason: 'manual' }, { resultOwner: 'assistant' }, { runID: undefined }, { status: 'running' }]) await s.runtime.sendScheduledTaskRunNotification({ ...run, ...patch });
  expect(s.emitted).toEqual([]);
  await s.runtime.sendScheduledTaskRunNotification(run); await s.runtime.sendScheduledTaskRunNotification(run);
  expect(s.emitted).toHaveLength(1);
  await s.runtime.sendScheduledTaskRunNotification({ ...run, runID: 'next-run' }); expect(s.emitted).toHaveLength(2);
  expect(createNotificationAdmission('assistant', { kind: 'assistant', id: 'bot' }, { type: 'assistant', assistantID: 'bot', turnID: 'turn', status: 'complete', publication: 'silent' })).toBeNull();
  const published = { assistantID: 'bot', turnID: 'turn', status: 'complete', body: 'Private' };
  await s.runtime.sendContactTurnNotification(published); await s.runtime.sendContactTurnNotification(published);
  expect(s.emitted.filter(value => value.kind === 'assistant')).toHaveLength(1);
});

it('fails closed on identity read failure, retries only real pending decisions, and drops late results after dispose', async () => {
  const s = setup(); s.fetcher.mockResolvedValueOnce(Response.json({ error: 'unavailable' }, { status: 503 }));
  await s.runtime.sendGoalSettlePush({ sessionId: 'root', directory: '/project', status: 'complete', boundaryID: 'goal', title: 'Private', body: 'Private' });
  expect(s.emitted).toEqual([]);
  await s.runtime.retryNotificationAdmissions(); expect(s.emitted).toHaveLength(1);
  await s.runtime.retryNotificationAdmissions(); expect(s.emitted).toHaveLength(1);
  let finish;
  const delayed = setup(); delayed.fetcher.mockResolvedValueOnce(Response.json({}, { status: 503 }));
  await delayed.runtime.sendGoalSettlePush({ sessionId: 'root', directory: '/project', status: 'complete', boundaryID: 'goal', title: 'Private', body: 'Private' });
  delayed.fetcher.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const pending = delayed.runtime.retryNotificationAdmissions();
  // No timers or real network are needed to test a pending authoritative identity lookup.
  await Promise.resolve(); delayed.runtime.dispose(); finish?.(Response.json({ id: 'root', directory: '/project' }));
  await pending; expect(delayed.emitted).toEqual([]);
});

it('keeps auto-replied questions/permissions and disabled domain settings out of admission', async () => {
  vi.useFakeTimers(); const s = setup();
  await s.runtime.maybeSendPushForTrigger(s.event('form.created', { form: { id: 'q', sessionID: 'root', fields: [{}] } }));
  await s.runtime.maybeSendPushForTrigger(s.event('form.replied', { id: 'q' }));
  await s.runtime.maybeSendPushForTrigger(s.event('permission.asked', { id: 'p' }));
  await s.runtime.maybeSendPushForTrigger(s.event('permission.replied', { id: 'p' }));
  await vi.advanceTimersByTimeAsync(500); expect(s.emitted).toEqual([]);
  s.settings({ notifyOnScheduledTasks: false, notifyOnAssistants: false });
  await s.runtime.sendScheduledTaskRunNotification({ projectID: 'project', taskID: 'task', runID: 'run', reason: 'scheduled', resultOwner: 'unowned', status: 'error' });
  await s.runtime.sendContactTurnNotification({ assistantID: 'bot', turnID: 'turn', status: 'error' }); expect(s.emitted).toEqual([]);
});

it('does not use idle as native success and preserves legacy once-only delivery when explicit runner success arrives later', async () => {
  const s = setup();
  await s.runtime.maybeSendPushForTrigger(s.event('session.idle', {}, 'idle'));
  expect(s.emitted).toEqual([]); expect(s.legacy).toHaveLength(1);
  await s.runtime.maybeSendPushForTrigger(s.event('session.execution.succeeded', {}, 'actual-success'));
  expect(s.emitted).toHaveLength(1); expect(s.legacy).toHaveLength(1);
  await s.runtime.maybeSendPushForTrigger(s.event('session.idle', {}, 'later-idle'));
  expect(s.emitted).toHaveLength(1); expect(s.legacy).toHaveLength(1);
  await s.runtime.maybeSendPushForTrigger(s.event('session.execution.started'));
  await s.runtime.maybeSendPushForTrigger(s.event('session.execution.succeeded', {}, 'next-success'));
  expect(s.emitted).toHaveLength(2); expect(s.legacy).toHaveLength(2);
});

it('uses the existing authoritative family barrier for root and child and never turns a failed activity read into empty success', async () => {
  let active = ['child'], fail = false;
  const s = setup({ loadActiveSessionIds: async () => { if (fail) throw new Error('activity unavailable'); return active; } });
  await s.runtime.maybeSendPushForTrigger(s.event('session.execution.succeeded', {}, 'root-success'));
  expect(s.emitted).toEqual([]);
  active = []; fail = true;
  await s.runtime.maybeSendPushForTrigger(s.event('session.execution.succeeded', { sessionID: 'child' }, 'child-success'));
  expect(s.emitted).toEqual([]);
  fail = false; await s.runtime.maybeSendPushForTrigger(s.event('session.status', { status: { type: 'idle' } }));
  expect(s.emitted.map(value => value.kind).sort()).toEqual(['completion', 'subtask']);
});

it('rejects a late failure decision after a new execution starts, even while settings were unresolved', async () => {
  let finish, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  let first = true;
  const s = setup({ readSettingsFromDisk: async () => {
    if (!first) return { nativeNotificationsEnabled: false };
    first = false; entered(); return new Promise(resolve => { finish = resolve; });
  } });
  const failed = s.runtime.maybeSendPushForTrigger(s.event('session.execution.failed', {}, 'old-failure'));
  await waiting;
  await s.runtime.maybeSendPushForTrigger(s.event('session.execution.started'));
  finish({ nativeNotificationsEnabled: false }); await failed;
  await s.runtime.retryNotificationAdmissions(); expect(s.emitted).toEqual([]);
});

it('rejects an answered prompt while its admitted settings read is in flight', async () => {
  vi.useFakeTimers(); let finish, entered, reads = 0;
  const waiting = new Promise(resolve => { entered = resolve; });
  const s = setup({ readSettingsFromDisk: async () => {
    if (++reads !== 2) return { nativeNotificationsEnabled: false };
    entered(); return new Promise(resolve => { finish = resolve; });
  } });
  await s.runtime.maybeSendPushForTrigger(s.event('form.created', { form: { id: 'q', sessionID: 'root', fields: [{}] } }));
  const advancing = vi.advanceTimersByTimeAsync(500); await waiting;
  await s.runtime.maybeSendPushForTrigger(s.event('form.replied', { id: 'q' }));
  finish({ nativeNotificationsEnabled: false }); await advancing;
  await s.runtime.retryNotificationAdmissions(); expect(s.emitted).toEqual([]);
});

it('retains only safe schedule/Assistant proofs after publication failure and retries domains independently', async () => {
  let unavailable = true; const emitted = [];
  const s = setup({ publishNotificationAdmission: value => { if (unavailable) throw new Error('closed stream'); emitted.push(value); return true; } });
  await s.runtime.sendScheduledTaskRunNotification({ projectID: 'project', taskID: 'task', runID: 'run', reason: 'scheduled', resultOwner: 'unowned', status: 'error', errorMessage: 'Private' });
  await s.runtime.sendContactTurnNotification({ assistantID: 'bot', turnID: 'turn', status: 'complete', body: 'Private' });
  expect(emitted).toEqual([]); unavailable = false;
  await s.runtime.maybeSendPushForTrigger({ type: 'server.connected' });
  expect(emitted.map(value => value.kind)).toEqual(['schedule', 'assistant']);
  expect(JSON.stringify(emitted)).not.toContain('Private');
  await s.runtime.retryNotificationAdmissions(); expect(emitted).toHaveLength(2);
});
