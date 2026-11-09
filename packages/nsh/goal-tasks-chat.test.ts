import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { decodeNativeGoal } from './chat-goal-model';
import { createHost } from './tests/goal-tasks-chat-host.js';
import { formatEffortLabel } from '../ui/src/components/chat/mobileControlsUtils';
import { notificationAuthorized, notificationConfiguration, notificationStatus } from './notification-core';
import { createNotificationSettingsTransport } from './notification-preferences-core';
import { createNotificationRootController } from './notification-root-core';
import { createNativeAppearanceSync } from './appearance-core';
import { prepareInteractionEngineDriver } from './tests/chat-interaction-engine-driver';

const stateHarness = vi.hoisted(() => ({
  call: vi.fn(), storage: new Map<string, string>(),
  listeners: new Map<string, Set<(payload: unknown) => void>>(),
  cleanups: [] as Array<() => void>, disposers: [] as Array<() => void>,
}));
vi.mock('nsh', () => ({
  batch: <T>(work: () => T) => work(), untracked: <T>(work: () => T) => work(),
  signal: <T>(initial: T) => { let value = initial; return Object.assign(() => value, { set: (next: T) => { value = next; } }); },
  locale: () => 'en', lifecycle: () => 'active',
  Storage: {
    getItem: async (key: string) => stateHarness.storage.get(key) ?? null,
    setItem: async (key: string, value: string) => { stateHarness.storage.set(key, value); },
  },
  effect: (work: () => void | (() => void)) => { const stop = work(); if (stop) stateHarness.disposers.push(stop); },
  cleanup: (work: () => void) => stateHarness.cleanups.push(work),
  host: { available: () => true, call: stateHarness.call,
    on: (name: string, work: (payload: unknown) => void) => {
      const listeners = stateHarness.listeners.get(name) ?? new Set(); listeners.add(work); stateHarness.listeners.set(name, listeners);
      return () => { listeners.delete(work); };
    },
  },
}));

const cwd = path.dirname(fileURLToPath(import.meta.url));
const scope = 'directory=%2Fworkspace%2Fproject';
const rpc = '/api/rpc/opencode.goal/get?location%5Bdirectory%5D=%2Fworkspace%2Fproject';
const command = `/api/session/ses_1/command?${scope}`;
const objective = 'Synthetic busy Goal objective';
const queuedText = 'Synthetic ordinary queued follow-up';
const longSelection = {
  modelID: 'synthetic-long-model',
  modelName: 'Synthetic exceptionally long reasoning model display name',
  variant: 'extended-reasoning-high',
};
const longEffortLabel = formatEffortLabel(longSelection.variant);
const longSelectionLabel = `${longSelection.modelName} ${longEffortLabel}`;
const receipt = (pause = 0, resume = 0, clear = 0, objective = 0, prompt = 0) => `GOAL_FIXTURE pause=${pause} resume=${resume} clear=${clear} objective=${objective} prompt=${prompt} selection=0 faults=0`;

/** Bundles only the synthetic Host; the test target is the unmodified production App. */
function runApp(steps: string[], selection: { modelID?: string; modelName?: string; variant?: string } = {}) {
  const driver = prepareInteractionEngineDriver(cwd, 'App.tsx', 'tests/goal-tasks-chat-host.js', steps, selection);
  try {
    const fixture = driver.bundleHost();
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', driver.testFile, '--web-host', fixture], {
      cwd, encoding: 'utf8', timeout: 60_000,
    });
    expect(result.error, result.stdout + result.stderr).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally { driver.dispose(); }
}

const chatSteps = (modelName = 'Native test model') => [
  'await app.waitFor("text:Native conversation");',
  'await app.press("id:project-session-ses_1 >> nth=0");',
  'await app.waitFor("id:chat-goal-row");',
  'await app.waitFor("text:Synthetic existing Goal");',
  `await app.waitFor(${JSON.stringify(`text:${modelName}`)});`,
  'await app.waitFor("id:stop");',
  'expect(app.value("id:composer")).toBe("");',
  'expect(app.count("id:send")).toBe(0);',
  'expect(app.shows("id:chat-goal-chip")).toBe(true);',
];
const openChat = chatSteps();
function metadataReceipt(value: string) {
  return [
    'await app.press("id:chat-header-root >> id:chat-header-metadata");',
    `await app.waitFor(${JSON.stringify(`text:${value}`)});`,
    'await app.press("id:chat-header-root >> id:chat-header-metadata");',
    'await app.waitUntil(() => !app.shows("id:chat-metadata-panel"));',
  ];
}

describe('production App Goal/Tasks/Changes (headless engine, not UIKit or real Host evidence)', () => {
  test('composer Tasks and Changes open from their own production triggers without requiring a Goal row', () => {
    runApp([
      'await app.waitFor("text:Native conversation");',
      'await app.press("id:project-session-ses_1 >> nth=0");',
      'await app.waitFor("id:composer-tasks");',
      'await app.press("id:composer-tasks");',
      'await app.waitFor("id:composer-tasks-popover");',
      'await app.press("id:composer-changes");',
      'await app.waitFor("id:composer-changed-files");',
      'expect(app.count("id:composer-tasks-popover")).toBe(0);',
    ]);
  });
  test('existing authoritative Goal opens details and pauses/resumes/clears through one native owner', () => {
    runApp([...openChat,
      'expect(app.count("id:chat-goal-panel")).toBe(0);',
      'await app.press("id:chat-goal-details");',
      'await app.waitFor("id:chat-goal-panel");',
      `await app.waitFor(${JSON.stringify(`text:${receipt()}`)});`,
      'await app.press("id:chat-goal-panel-toggle");',
      'await app.waitUntil(() => !app.shows("id:chat-goal-panel"));',
      'await app.press("id:chat-goal-details");',
      `await app.waitFor(${JSON.stringify(`text:${receipt(1)}`)});`,
      'expect(app.shows("text:Paused")).toBe(true);',
      'await app.press("id:chat-goal-panel-close");',
      'await app.waitUntil(() => !app.shows("id:chat-goal-panel"));',
      'await app.press("id:chat-goal-toggle");',
      'await app.waitFor("text:Active");',
      'await app.press("id:chat-goal-details");',
      `await app.waitFor(${JSON.stringify(`text:${receipt(1, 1)}`)});`,
      'await app.press("id:chat-goal-panel-clear");',
      'await app.waitUntil(() => !app.shows("id:chat-goal-row") && !app.shows("id:chat-goal-panel"));',
      'expect(app.count("id:chat-goal-chip")).toBe(0);',
      'expect(app.count("id:chat-queue")).toBe(0);',
      ...metadataReceipt(receipt(1, 1, 1)),
    ]);
  }, 75_000);

  test('busy typed /goal dispatches a command, not prompt/inbox; ordinary queue leaves session selection unchanged', () => {
    runApp([...openChat,
      `await app.type("id:composer", ${JSON.stringify(`/goal ${objective}`)});`,
      'await app.press("id:send");',
      'await app.waitUntil(() => app.value("id:composer") === "");',
      'await app.waitFor("id:stop");',
      `await app.waitFor(${JSON.stringify(`text:${objective}`)});`,
      'expect(app.count("id:chat-queue")).toBe(0);',
      'expect(app.count("id:transcript >> text:/goal Synthetic busy Goal objective")).toBe(0);',
      'expect(app.count("id:transcript >> text:Synthetic busy Goal objective")).toBe(0);',
      'await app.press("id:chat-goal-details");',
      `await app.waitFor(${JSON.stringify(`text:${receipt(0, 0, 0, 1)}`)});`,
      'await app.press("id:chat-goal-panel-close");',
      'await app.waitUntil(() => !app.shows("id:chat-goal-panel"));',
      `await app.type("id:composer", ${JSON.stringify(queuedText)});`,
      'await app.press("id:send");',
      'await app.waitUntil(() => app.value("id:composer") === "");',
      'await app.waitFor("id:stop");',
      'await app.waitFor("id:chat-queue");',
      `await app.waitFor(${JSON.stringify(`id:chat-queue >> text:${queuedText}`)});`,
      'expect(app.shows("text:Native test model")).toBe(true);',
      'expect(app.shows("label:build")).toBe(true);',
      ...metadataReceipt(receipt(0, 0, 0, 1, 1)),
    ]);
  }, 75_000);

  test('Tasks and Changes are mutually exclusive and closed surfaces have zero mounted native rows', () => {
    runApp([...openChat,
      'await app.waitFor("id:composer-tasks");',
      'await app.waitFor("id:composer-changes");',
      'expect(app.count("id:composer-tasks-list")).toBe(0);',
      'expect(app.count("id:composer-task-synthetic-active:1")).toBe(0);',
      'expect(app.count("id:composer-changed-files")).toBe(0);',
      'expect(app.count("id:composer-change-synthetic-goal.txt")).toBe(0);',
      'await app.press("id:composer-tasks");',
      'await app.waitFor("id:composer-task-synthetic-active:1");',
      'expect(app.shows("id:composer-tasks-popover")).toBe(true);',
      'expect(app.count("id:composer-change-synthetic-goal.txt")).toBe(0);',
      'await app.press("id:composer-changes");',
      'await app.waitFor("id:composer-change-synthetic-goal.txt");',
      'expect(app.count("id:composer-tasks-popover")).toBe(0);',
      'expect(app.count("id:composer-task-synthetic-active:1")).toBe(0);',
      'await app.press("id:composer-tasks");',
      'await app.waitFor("id:composer-task-synthetic-active:1");',
      'expect(app.count("id:composer-changed-files")).toBe(0);',
      'expect(app.count("id:composer-change-synthetic-goal.txt")).toBe(0);',
      'await app.press("id:composer-tasks");',
      'await app.waitUntil(() => !app.shows("id:composer-tasks-popover"));',
      'expect(app.count("id:composer-tasks-list")).toBe(0);',
      'expect(app.count("id:composer-task-synthetic-active:1")).toBe(0);',
      'await app.press("id:composer-changes");',
      'await app.waitFor("id:composer-change-synthetic-tasks.txt");',
      'await app.press("id:composer-changes");',
      'await app.waitUntil(() => !app.shows("id:composer-changed-files"));',
      'expect(app.count("id:composer-change-synthetic-goal.txt")).toBe(0);',
      'expect(app.count("id:composer-change-synthetic-tasks.txt")).toBe(0);',
      'await app.type("id:composer", "Synthetic input after both popovers closed");',
      'expect(app.count("id:composer-tasks-list")).toBe(0);',
      'expect(app.count("id:composer-task-synthetic-active:1")).toBe(0);',
      'expect(app.count("id:composer-change-synthetic-goal.txt")).toBe(0);',
      'expect(app.count("id:composer-change-synthetic-tasks.txt")).toBe(0);',
      ...metadataReceipt(receipt()),
    ]);
  }, 75_000);

  test.each([320, 375, 402])('production toolbar at %ipt keeps Goal, long model/variant and stop/send accessible', width => {
    runApp([
      `await app.setViewport(${width}, 874);`,
      ...chatSteps(longSelection.modelName),
      'expect(app.enabled("id:stop")).toBe(true);',
      'expect(app.shows("id:chat-agent-selection")).toBe(true);',
      'expect(app.shows("label:build")).toBe(true);',
      `expect(app.shows(${JSON.stringify(`label:${longSelectionLabel}`)})).toBe(true);`,
      `expect(app.shows(${JSON.stringify(`id:chat-selection >> text:${longEffortLabel}`)})).toBe(true);`,
      'expect(app.enabled("id:chat-selection")).toBe(true);',
      `await app.type("id:composer", ${JSON.stringify(queuedText)});`,
      'await app.waitFor("id:send");',
      'expect(app.enabled("id:send")).toBe(true);',
      'expect(app.count("id:stop")).toBe(0);',
      'expect(app.shows("id:chat-goal-chip")).toBe(true);',
      `expect(app.shows(${JSON.stringify(`label:${longSelectionLabel}`)})).toBe(true);`,
      'await app.press("id:send");',
      'await app.waitUntil(() => app.value("id:composer") === "");',
      'await app.waitFor("id:stop");',
      'expect(app.enabled("id:stop")).toBe(true);',
      `await app.waitFor(${JSON.stringify(`id:chat-queue >> text:${queuedText}`)});`,
      ...metadataReceipt(receipt(0, 0, 0, 0, 1)),
      'expect(app.shows("id:stop")).toBe(true);',
      'expect(app.shows("id:chat-goal-chip")).toBe(true);',
      `expect(app.shows(${JSON.stringify(`label:${longSelectionLabel}`)})).toBe(true);`,
      'await app.press("id:chat-selection");',
      `await app.waitFor(${JSON.stringify(`id:model-provider-group-fixture >> id:model-fixture-${longSelection.modelID}`)});`,
      `expect(app.texts()).toContain(${JSON.stringify(longSelection.modelName)});`,
      `expect(app.texts()).toContain(${JSON.stringify(longEffortLabel)});`,
      `expect(app.shows(${JSON.stringify(`id:model-provider-group-fixture >> id:model-variant-fixture-${longSelection.modelID}`)})).toBe(true);`,
    ], longSelection);
  }, 75_000);
});

describe('Goal/Tasks synthetic Host contract (no NSH engine)', () => {
  test('supplies native runtime authority and only the exact read-only diagnostic/import bootstrap seams', () => {
    const host = createHost(), scope = host.call('connection.list').runtimeScope;
    expect(scope).toEqual({ hostID: host.call('connection.list').selected, lease: 'synthetic-goal-tasks-lease' });
    expect(host.call('native.diagnostics.status')).toEqual({ schemaVersion: 2, mode: 'event-recorder', enabled: false, recordingLease: null, eventCount: 0, maxEntries: 500, maxBytes: 262144 });
    expect(host.call('runtime.request', { path: '/api/yuri/history-import/jobs', method: 'GET', expectedHost: scope })).toEqual({ status: 200, body: [] });
    expect(() => host.call('native.diagnostics.status', { enabled: true })).toThrow('diagnostics status arguments');
    expect(() => host.call('runtime.request', { path: '/api/yuri/history-import/jobs', method: 'GET', expectedHost: { ...scope, lease: 'stale' } })).toThrow('history import read scope');
    expect(() => host.call('runtime.request', { path: '/api/yuri/history-import/jobs', method: 'POST', expectedHost: scope })).toThrow('write POST');
  });
  test('accepts only the confirmed synthetic notification configure wire and returns a lease, not OS authorization', () => {
    const host = createHost(), hostID = host.call('connection.list').selected;
    const settings = host.call('runtime.request', { path: '/api/config/settings', method: 'GET', expectedHost: host.call('connection.list').runtimeScope }).body;
    const configuration = notificationConfiguration(hostID, settings, 'en');
    expect(configuration).toEqual({ hostID, enabled: false, mode: 'hidden-only',
      events: ['completion', 'error', 'question', 'permission', 'schedule', 'assistant', 'goal'], language: 'en' });
    const first = host.call('notification.configure', configuration);
    expect(first).toEqual({ lease: 'goal-tasks-memory-notification-lease' });
    expect(host.call('notification.configure', configuration)).toEqual(first);
    expect(() => notificationStatus(first)).toThrow('notification_invalid_status');
    expect(notificationAuthorized(notificationStatus({ authorization: 'unknown', alert: 'unknown', sound: 'unknown', badge: 'unknown', backgroundPush: false }))).toBe(false);
    expect(host.call('runtime.request', { path: `/api/git/status?${scope}&mode=light`, expectedHost: host.call('connection.list').runtimeScope }).body.current).toBe(receipt());
  });

  test('rejects unconfirmed or non-exact notification configurations and all five other capabilities with observable faults', () => {
    const host = createHost(), hostID = host.call('connection.list').selected;
    const configuration = notificationConfiguration(hostID, {}, 'en');
    let rejected = 0;
    const reject = (name: string, input: unknown) => {
      expect(() => host.call(name, input)).toThrow('Goal fixture rejected'); rejected++;
      expect(host.call('runtime.request', { path: `/api/git/status?${scope}&mode=light`, expectedHost: host.call('connection.list').runtimeScope }).body.current).toBe(receipt().replace('faults=0', `faults=${rejected}`));
    };
    reject('notification.configure', configuration);
    host.call('runtime.request', { path: '/api/config/settings', method: 'GET', expectedHost: host.call('connection.list').runtimeScope });
    expect(host.call('notification.configure', configuration)).toEqual({ lease: 'goal-tasks-memory-notification-lease' });
    for (const key of Object.keys(configuration)) {
      reject('notification.configure', Object.fromEntries(Object.entries(configuration).filter(([field]) => field !== key)));
    }
    for (const input of [
      null, [], { ...configuration, hostID: 'other-host' }, { ...configuration, enabled: true }, { ...configuration, enabled: 'false' },
      { ...configuration, mode: 'always' }, { ...configuration, language: 'ja' }, { ...configuration, events: [] },
      { ...configuration, events: [...configuration.events, 'subtask'] }, { ...configuration, events: [...configuration.events].reverse() },
      { ...configuration, events: ['completion', 'completion'] }, { ...configuration, events: ['unknown'] }, { ...configuration, events: 'completion' },
      { ...configuration, lease: 'injected' }, { ...configuration, url: 'https://outside.example.invalid' },
    ]) reject('notification.configure', input);
    for (const name of ['notification.status', 'notification.request', 'notification.openSettings', 'notification.live', 'notification.test', 'notification.unknown']) reject(name, {});
    expect(host.call('notification.configure', configuration)).toEqual({ lease: 'goal-tasks-memory-notification-lease' });
  });

  test('long toolbar selection stays complete in synthetic authority and catalog without changing protocol', () => {
    const host = createHost(longSelection);
    expect(host.call('runtime.request', { path: `/api/session/ses_1?${scope}`, expectedHost: host.call('connection.list').runtimeScope }).body.data.model).toEqual({ id: longSelection.modelID, providerID: 'fixture', variant: longSelection.variant });
    const model = host.call('runtime.request', { path: `/api/config/catalog/providers?${scope}`, expectedHost: host.call('connection.list').runtimeScope }).body.providers[0].models[longSelection.modelID];
    expect(model.name).toBe(longSelection.modelName); expect(model.variants).toHaveProperty(longSelection.variant);
    expect(host.call('runtime.request', { path: `/api/git/status?${scope}&mode=light`, expectedHost: host.call('connection.list').runtimeScope }).body.current).toBe(receipt());
  });
  test('keeps Host identity stable during a run and gives each new run a distinct draft partition', () => {
    const first = createHost(), second = createHost();
    const saved = first.call('connection.list');
    expect(first.call('connection.list').selected).toBe(saved.selected);
    expect(second.call('connection.list').selected).not.toBe(saved.selected);
  });
  test('returns complete decodable RPC authority and exact native 204 transitions', () => {
    const host = createHost();
    const read = () => host.call('runtime.request', { path: rpc, method: 'POST', body: { input: { sessionID: 'ses_1' } }, expectedHost: host.call('connection.list').runtimeScope });
    expect(decodeNativeGoal(read().body.output)).toMatchObject({ status: 'active', rounds: 2, maxRounds: 20, stalls: 0, boot: 'synthetic-process', updatedAt: 1000 });
    for (const [text, status] of [['pause', 'paused'], ['resume', 'active'], ['clear', null]]) {
      expect(host.call('runtime.request', { path: command, method: 'POST', body: { name: 'goal', text }, expectedHost: host.call('connection.list').runtimeScope })).toEqual({ status: 204, body: null });
      const goal = decodeNativeGoal(read().body.output);
      expect(goal?.status ?? null).toBe(status);
    }
  });

  test('busy Goal and ordinary queue are disjoint, with observable zero-selection receipts', () => {
    const host = createHost();
    expect(host.call('runtime.request', { path: command, method: 'POST', body: { name: 'goal', text: objective, delivery: 'queue' }, expectedHost: host.call('connection.list').runtimeScope }).status).toBe(204);
    expect(host.call('runtime.request', { path: `/api/session/ses_1/inbox?${scope}`, expectedHost: host.call('connection.list').runtimeScope }).body.data).toEqual([]);
    host.call('runtime.request', { path: `/api/session/ses_1/prompt?${scope}`, method: 'POST', body: { id: 'synthetic-queued', text: queuedText, delivery: 'queue' }, expectedHost: host.call('connection.list').runtimeScope });
    expect(host.call('runtime.request', { path: `/api/git/status?${scope}&mode=light`, expectedHost: host.call('connection.list').runtimeScope }).body.current).toBe(receipt(0, 0, 0, 1, 1));
    expect(host.call('runtime.request', { path: `/api/session/ses_1/inbox?${scope}`, expectedHost: host.call('connection.list').runtimeScope }).body.data).toHaveLength(1);
  });

  test('rejects non-synthetic scopes, native calls, prompt Goal and selection writes without forwarding', () => {
    const host = createHost();
    for (const [name, input] of [
      ['runtime.request', { path: command.replace('ses_1', 'real-session'), method: 'POST', body: { name: 'goal', text: 'clear' } }],
      ['runtime.request', { path: command, method: 'POST', body: { name: 'goal', text: 'pause', delivery: 'queue' } }],
      ['runtime.request', { path: `/api/session/ses_1/model?${scope}`, method: 'POST', body: { model: { id: 'other' } } }],
      ['runtime.request', { path: `/api/session/ses_1/prompt?${scope}`, method: 'POST', body: { id: 'bad', text: `/goal ${objective}`, delivery: 'queue' } }],
      ['runtime.request', { path: '/api/fs/read?path=%2Freal-file' }],
      ['runtime.request', { path: `/api/git/status?${scope}`, method: 'POST' }],
      ['connection.select', { id: 'real-host' }],
      ['speech.segment', { text: 'Do not synthesize audio' }],
    ] as const) expect(() => host.call(name, { ...input, ...(name === 'runtime.request' ? { expectedHost: host.call('connection.list').runtimeScope } : {}) })).toThrow('Goal fixture rejected');
  });
});

describe('Goal/Tasks fixture real createChat state (no NSH engine)', () => {
  const target = { kind: 'session' as const, id: 'ses_1', title: 'Native conversation', directory: '/workspace/project' };
  const flush = async () => { for (let count = 0; count < 100; count++) await Promise.resolve(); };
  beforeEach(() => {
    vi.resetModules(); vi.useFakeTimers(); stateHarness.storage.clear(); stateHarness.listeners.clear();
    stateHarness.cleanups = []; stateHarness.disposers = [];
    const fixture = createHost(); stateHarness.call.mockReset().mockImplementation(fixture.call);
  });
  afterEach(async () => {
    stateHarness.disposers.forEach(stop => stop()); stateHarness.cleanups.forEach(stop => stop());
    await flush(); vi.clearAllTimers(); vi.useRealTimers();
  });
  async function openChat() {
    const state = await import('./state'); await state.loadConnections();
    const chat = state.createChat(target, { followUpBehavior: () => null }); await chat.draftReady; await flush();
    return chat;
  }
  test('root adapter initializes exactly three settings GETs and one disabled configure without native faults or OS authorization', async () => {
    const state = await import('./state'); await state.loadConnections();
    const selected = state.app.connection()!;
    const notificationScope = { hostID: selected.id, generation: state.epoch() };
    const read = async () => stateHarness.call('runtime.request', { path: '/api/config/settings', method: 'GET', expectedHost: state.app.runtimeScope() }).body;
    const appearance = createNativeAppearanceSync({
      readSettings: read,
      readThemes: async () => stateHarness.call('runtime.request', { path: '/api/config/themes', method: 'GET', expectedHost: state.app.runtimeScope() }).body,
      reset: async scope => stateHarness.call('appearance.reset', { hostID: scope?.hostID ?? null }).revision,
      apply: async (scope, revision, value) => stateHarness.call('appearance.apply', { hostID: scope.hostID, revision, mode: value.mode, cssVars: value.cssVars, fonts: value.fonts }),
      changed: () => {}, failed: error => { expect(error).toBe(''); },
    });
    const transport = createNotificationSettingsTransport({ scope: () => notificationScope, language: () => 'en',
      read, call: async (name, input) => stateHarness.call(name, input), write: async () => { throw new Error('Unexpected root settings write'); } });
    const root = createNotificationRootController({ transport, scope: () => notificationScope, sessions: state.app.sessions,
      resolve: () => [], open: () => { throw new Error('Unexpected notification navigation'); }, changed: () => {} });
    try {
      appearance.setScope({ ...notificationScope, url: selected.url });
      root.bind(notificationScope, 'en', true);
      await Promise.all([state.refresh(), appearance.refresh()]); await flush();
      expect(state.app.online()).toBe(true);
      expect(root.state()).toEqual({ ready: true, refreshing: false, error: null, recovery: 'unsupported' });
      expect(transport.confirmed()?.preferences).toEqual({});
      expect(stateHarness.call.mock.calls.filter(([name, input]) => name === 'runtime.request' && input.path === '/api/config/settings')).toEqual([
        ['runtime.request', { path: '/api/config/settings', method: 'GET', expectedHost: state.app.runtimeScope() }],
        ['runtime.request', { path: '/api/config/settings', method: 'GET', expectedHost: state.app.runtimeScope() }],
        ['runtime.request', { path: '/api/config/settings', method: 'GET', expectedHost: state.app.runtimeScope() }],
      ]);
      expect(stateHarness.call.mock.calls.filter(([name]) => name.startsWith('notification.'))).toEqual([
        ['notification.configure', { hostID: selected.id, enabled: false, mode: 'hidden-only',
          events: ['completion', 'error', 'question', 'permission', 'schedule', 'assistant', 'goal'], language: 'en' }],
      ]);
      const reads = stateHarness.call.mock.calls.length;
      for (const type of ['session.text.delta', 'session.execution.succeeded', 'session.execution.failed']) {
        root.onEvent({ key: 'global', type, id: 'synthetic-event', directory: '/workspace/project', body: { sessionID: 'ses_1' } }, notificationScope);
      }
      await flush(); expect(stateHarness.call).toHaveBeenCalledTimes(reads);
      expect(stateHarness.call('runtime.request', { path: `/api/git/status?${scope}&mode=light`, expectedHost: state.app.runtimeScope() }).body.current).toBe(receipt());
    } finally { root.dispose(); appearance.setScope(null); }
  });

  test('same exact fixture resolves authoritative busy with empty hydrated input and no pending recovery', async () => {
    const chat = await openChat();
    expect({ busy: chat.busy(), active: chat.active(), draft: chat.draft(), draftStatus: chat.draftStatus(),
      files: chat.attachments(), pending: chat.pendingSend(), queueEdit: chat.queueEdit(), error: chat.error() }).toEqual({
      busy: true, active: true, draft: '', draftStatus: 'ready', files: [], pending: null, queueEdit: null, error: '',
    });
    expect(stateHarness.call.mock.calls.some(([name, input]) => name === 'runtime.request' && input.path === '/api/session/active')).toBe(true);
    expect(chat.busy() && !chat.draft().trim() && chat.attachments().length === 0).toBe(true);
    const application = readFileSync(path.join(cwd, 'application.tsx'), 'utf8');
    expect(application).toContain('canAbort={chat.busy()}');
    expect(application).toContain('hasContent={!!chat.draft().trim() || chat.attachments().length > 0}');
    const send = readFileSync(path.join(cwd, 'composer-send.tsx'), 'utf8');
    expect(send).toContain('when={props.canAbort && !props.hasContent && !!props.onStop}');
  });
  test.each([
    { draft: 'Synthetic input after both popovers closed', attachments: [] },
    { draft: '', attachments: [{ uri: 'attachment://synthetic', name: 'synthetic.txt', mime: 'text/plain' }] },
  ])('restored content $draft leaves busy true but selects send rather than stop', async ({ draft, attachments }) => {
    const { draftKey } = await import('./drafts');
    const hostID = stateHarness.call('connection.list').selected;
    stateHarness.storage.set(draftKey(hostID, target), JSON.stringify({ version: 1, revision: 1,
      draft, references: [], attachments, pendingSend: null, queueEdit: null }));
    const chat = await openChat();
    expect(chat.busy()).toBe(true); expect(chat.active()).toBe(true);
    expect(chat.draft()).toBe(draft); expect(chat.attachments()).toEqual(attachments);
    expect(chat.busy() && !chat.draft().trim() && chat.attachments().length === 0).toBe(false);
    expect(chat.error()).toBe('');
  });
  test('new fixture Host cannot inherit another run draft or attachment from shared Storage', async () => {
    const { draftKey } = await import('./drafts');
    const previousHostID = stateHarness.call('connection.list').selected;
    stateHarness.storage.set(draftKey(previousHostID, target), JSON.stringify({ version: 1, revision: 1,
      draft: 'Synthetic input from a previous run', references: [],
      attachments: [{ uri: 'attachment://previous', name: 'previous.txt', mime: 'text/plain' }], pendingSend: null, queueEdit: null }));
    const next = createHost(); stateHarness.call.mockImplementation(next.call);
    expect(next.call('connection.list').selected).not.toBe(previousHostID);
    const chat = await openChat();
    expect(chat.draft()).toBe(''); expect(chat.attachments()).toEqual([]);
    expect(chat.busy()).toBe(true); expect(chat.active()).toBe(true);
    expect(chat.draftStatus()).toBe('ready');
  });
  test('historical in-progress tasks do not manufacture busy without active-membership authority', async () => {
    const fixture = createHost();
    stateHarness.call.mockImplementation((name, input) => name === 'runtime.request' && input.path === '/api/session/active'
      ? { status: 200, body: { data: {} } } : fixture.call(name, input));
    const chat = await openChat();
    expect(chat.tasks().some(todo => todo.status === 'in_progress')).toBe(true);
    expect(chat.busy()).toBe(false); expect(chat.draft()).toBe(''); expect(chat.error()).toBe('');
  });
  test('real busy send uses native Goal queue command, then ordinary queue, without selection writes', async () => {
    const chat = await openChat(); chat.goal.observe(); await flush();
    expect(chat.busy()).toBe(true);
    chat.setDraftText(`/goal ${objective}`); expect(await chat.send()).toBe(true); await flush();
    expect(chat.draft()).toBe(''); expect(chat.inbox()).toEqual([]);
    expect(chat.goal.state().goal?.objective).toBe(objective);
    chat.setDraftText(queuedText); expect(await chat.send()).toBe(true); await flush();
    expect(chat.draft()).toBe(''); expect(chat.inbox()).toHaveLength(1);
    expect(stateHarness.call('runtime.request', { path: `/api/git/status?${scope}&mode=light`, expectedHost: stateHarness.call('connection.list').runtimeScope }).body.current).toBe(receipt(0, 0, 0, 1, 1));
  });
});
