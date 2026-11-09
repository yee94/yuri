import { beforeEach, expect, it, vi } from 'vitest';
import { createHost as schedulesHost } from './tests/schedules-host.js';
import { createHost as assistantsHost } from './tests/assistants-host.js';
import { createHost as settingsHost } from './tests/assistants-settings-host.js';
import { bindRequest } from './runtime';
import { assistantPreview, assistantScheduledTasks, clearAssistantHistory, mutateAssistant, readAssistantSnapshot } from './assistants-core';
import { readBotCreationDefaults } from './features-bot-defaults';
import { record } from './model';

const h = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('nsh', () => ({ host: { available: () => true, call: h.call } }));
beforeEach(() => { h.call.mockReset(); });
function fixture(create: typeof schedulesHost) {
  const host = create(), snapshot = host.call('connection.list', {}), scope = snapshot.runtimeScope;
  h.call.mockImplementation((name, input) => host.call(name, input));
  const send = bindRequest(scope);
  const fence = { request: send, current: () => {
    const current = host.call('settings.fixture.scopeAudit', {}).runtimeScope;
    return current.hostID === scope.hostID && current.lease === scope.lease;
  } };
  return { host, send, fence };
}

it('schedule catalog, two toggles, opaque paging, session directories, run and delete keep exact synthetic wire and counts', async () => {
  const f = fixture(schedulesHost), catalog = record(await f.send('/api/yuri/scheduled-tasks'));
  expect(catalog.tasks).toHaveLength(2);
  expect(catalog.failedProjectIds).toEqual([]);
  const toggled = (enabled: boolean) => f.send('/api/projects/project/scheduled-tasks', 'PATCH', { task: { id: 'daily', enabled } });
  expect(record(await toggled(false)).task).toMatchObject({ id: 'daily', enabled: false });
  expect(record(await toggled(true)).task).toMatchObject({ id: 'daily', enabled: true });
  const first = record(await f.send('/api/yuri/scheduled-task-runs?limit=20'));
  expect(first).toMatchObject({ nextCursor: 'opaque+/=', complete: false, runs: [{ id: 'newest', sessionId: 'session-newest', directory: '/workspace/recorded-worktree' }] });
  expect(await f.send('/api/yuri/scheduled-task-runs?limit=20&before=' + encodeURIComponent(String(first.nextCursor)))).toMatchObject({ nextCursor: null, complete: true, runs: [{ id: 'older' }] });
  expect(await f.send('/api/yuri/scheduled-task-runs?limit=20&projectId=project&taskId=daily')).toMatchObject({ runs: [{ projectId: 'project', taskId: 'daily' }] });
  expect(await f.send('/api/projects/project/scheduled-tasks/daily/run', 'POST')).toMatchObject({ ok: true, sessionId: 'newly-started', task: { id: 'daily' } });
  expect(await f.send('/fixture/schedules/audit')).toMatchObject({ toggles: 2, runs: 1, deletes: 0 });
  expect(await f.send('/api/projects/project/scheduled-tasks/daily', 'DELETE')).toMatchObject({ tasks: [{ id: 'paused' }], schedulerSynced: true });
  expect(await f.send('/fixture/schedules/audit')).toMatchObject({ toggles: 2, runs: 1, deletes: 1 });
});

it('Assistant catalog preserves authoritative preview; cancel has zero deletion, failed revision-scoped delete retains the bot', async () => {
  const f = fixture(assistantsHost), snapshot = await readAssistantSnapshot(f.fence);
  const bot = record((snapshot.assistants as unknown[])[0]);
  expect(assistantPreview(bot, key => key)).toBe('Authoritative latest reply');
  expect(await f.send('/fixture/assistants/audit')).toMatchObject({ deleteAttempts: 0 });
  await expect(mutateAssistant(f.fence, bot, null)).rejects.toThrow('HTTP 500: delete_test_failure');
  expect(await f.send('/fixture/assistants/audit')).toMatchObject({ deleteAttempts: 1 });
  expect((await readAssistantSnapshot(f.fence)).assistants).toEqual(snapshot.assistants);
  expect(await f.send('/api/yuri/assistants/a/scheduled-tasks')).toEqual({ tasks: [], complete: true });
  expect(await f.send('/api/yuri/assistants/a/channels/wecom')).toMatchObject({ status: 'disabled', configured: false, hasSecret: false });
  const deletes = h.call.mock.calls.filter(([name, input]) => name === 'runtime.request' && input.method === 'DELETE');
  expect(deletes).toHaveLength(1); expect(deletes[0][1].body).toEqual({ expectedRevision: 1 });
});

it('Bot settings retains catalog/channel failures, linked task directory, authoritative transfer, empty-secret save and one acknowledged wipe', async () => {
  const f = fixture(settingsHost);
  await expect(readAssistantSnapshot(f.fence)).rejects.toThrow('HTTP 503: fixture_catalog_offline');
  const snapshot = await readAssistantSnapshot(f.fence), bot = record((snapshot.assistants as unknown[])[0]);
  const tasks = assistantScheduledTasks(record(await f.send('/api/yuri/assistants/bot%2Fa/scheduled-tasks')));
  expect(tasks.incomplete).toBe(false); expect(tasks.tasks[0]).toMatchObject({ projectId: 'project', taskID: 'daily', task: { execution: { prompt: 'Fixture linked schedule prompt' } } });
  const channelPath = '/api/yuri/assistants/bot%2Fa/channels/feishu';
  await expect(f.send(channelPath)).rejects.toThrow('HTTP 503: fixture_channel_offline');
  expect(await f.send(channelPath)).toMatchObject({ transferSources: [{ assistantID: 'other', revision: 'r1', clientID: 'imported-client' }] });
  expect(await f.send('/fixture/assistants-settings/audit')).toMatchObject({ transfers: 0, channelWrites: 0, clearAttempts: 0 });
  expect(await f.send(channelPath + '/transfer', 'POST', { sourceAssistantID: 'other', revision: 'r1' })).toMatchObject({ status: 'connected', hasSecret: true, clientID: 'imported-client', ownerID: 'imported-owner' });
  await f.send(channelPath, 'PUT', { clientID: 'imported-client', ownerID: 'imported-owner', language: 'en' });
  expect(await f.send('/fixture/assistants-settings/audit')).toMatchObject({ transfers: 1, channelWrites: 1, clearAttempts: 0 });
  expect(await clearAssistantHistory(f.fence, bot)).toEqual({ assistantID: 'bot/a', reset: true, historyCleared: true, generation: 2 });
  expect(await f.send('/fixture/assistants-settings/audit')).toMatchObject({ transfers: 1, channelWrites: 1, clearAttempts: 1, contactReads: 0 });
  expect(await f.send('/api/yuri/assistants/bot%2Fa/contact/messages?limit=1')).toEqual({ messages: [], nextCursor: null, complete: true, generation: 2, revision: 4 });
  expect(await readBotCreationDefaults(f.send)).toEqual({ name: '', model: { providerID: 'fixture', modelID: 'native-model', variant: '' } });
  expect(await f.send('/fixture/assistants-settings/audit')).toMatchObject({ transfers: 1, channelWrites: 1, clearAttempts: 1, contactReads: 1 });
});

it.each([
  ['/api/yuri/scheduled-tasks', 'POST', undefined],
  ['/api/yuri/scheduled-task-runs?limit=20&before=guessed', 'GET', undefined],
  ['/api/yuri/scheduled-task-runs?limit=20&projectId=other&taskId=daily', 'GET', undefined],
  ['/api/yuri/scheduled-task-runs?limit=20&projectId=project', 'GET', undefined],
  ['/api/yuri/scheduled-task-runs?limit=20&limit=20', 'GET', undefined],
  ['/api/projects/other/scheduled-tasks', 'PATCH', { task: { id: 'daily', enabled: false } }],
  ['/api/projects/project/scheduled-tasks', 'PATCH', { task: { id: 'daily', enabled: false }, extra: true }],
  ['/api/projects/project/scheduled-tasks', 'PATCH', { task: { id: 'paused', enabled: true } }],
  ['/api/projects/project/scheduled-tasks/daily/run', 'POST', {}],
  ['/api/projects/project/scheduled-tasks/daily?directory=%2Fother', 'DELETE', undefined],
] as const)('strict schedule fixture rejects malformed method/scope/body without mutations: %s', async (path, method, body) => {
  const f = fixture(schedulesHost);
  await expect(f.send(path, method, body)).rejects.toThrow();
  expect(await f.send('/fixture/schedules/audit')).toMatchObject({ toggles: 0, runs: 0, deletes: 0 });
});

it.each([
  ['/api/yuri/assistants/bot%2Fa/channels/feishu/transfer', 'GET', undefined],
  ['/api/yuri/assistants/bot%2Fa/channels/feishu/transfer', 'POST', { sourceAssistantID: 'other', revision: 'stale' }],
  ['/api/yuri/assistants/bot%2Fa/channels/feishu/transfer', 'POST', { sourceAssistantID: 'other', revision: 'r1', extra: true }],
  ['/api/yuri/assistants/bot%2Fa/channels/feishu', 'PUT', { clientID: 'imported-client', ownerID: 'imported-owner', language: 'en' }],
  ['/api/yuri/assistants/bot%2Fa/contact/reset', 'POST', {}],
  ['/api/yuri/assistants/bot%2Fa/contact/reset?directory=%2Fother', 'POST', undefined],
  ['/api/config/catalog/providers?directory=%2Fother', 'GET', undefined],
  ['/api/config/catalog/providers?directory=%2Fworkspace%2Fproject&unknown=1', 'GET', undefined],
  ['/api/config/catalog/providers', 'POST', {}],
  ['/api/config/settings/bootstrap', 'PUT', {}],
  ['/api/config', 'GET', {}],
  ['/api/yuri/assistants/bot%2Fa/contact/messages', 'GET', undefined],
  ['/api/yuri/assistants/bot%2Fa/contact/messages?limit=2', 'GET', undefined],
  ['/api/yuri/assistants/bot%2Fa/contact/messages?limit=1&limit=1', 'GET', undefined],
  ['/api/yuri/assistants/bot%2Fa/contact/messages?limit=1&before=guessed', 'GET', undefined],
  ['/api/yuri/assistants/bot%2Fa/contact/messages?limit=1', 'POST', undefined],
  ['/api/yuri/assistants/bot%2Fa/contact/messages?limit=1', 'GET', {}],
  ['/api/yuri/assistants/other/contact/messages?limit=1', 'GET', undefined],
  ['/fixture/assistants-settings/reset-scenario', 'GET', undefined],
  ['/fixture/assistants-settings/reset-scenario', 'PUT', { mode: 'unknown', extra: true }],
  ['/fixture/assistants-settings/reset-scenario', 'PUT', { mode: 'unknown-accept-empty' }],
] as const)('strict Bot settings fixture rejects unexpected writes/query/directory without transfer or wipe: %s', async (path, method, body) => {
  const f = fixture(settingsHost);
  await expect(f.send(path, method, body)).rejects.toThrow();
  expect(await f.send('/fixture/assistants-settings/audit')).toMatchObject({ transfers: 0, channelWrites: 0, clearAttempts: 0 });
});

it.each([
  ['/api/yuri/assistants/a', 'DELETE', { expectedRevision: 2 }],
  ['/api/yuri/assistants/a', 'DELETE', { expectedRevision: 1, extra: true }],
  ['/api/yuri/assistants/a?scope=other', 'DELETE', { expectedRevision: 1 }],
  ['/api/yuri/assistants/snapshot', 'PUT', {}],
  ['/api/yuri/assistants/unknown/channels/wecom', 'GET', undefined],
  ['/api/yuri/assistants/a/channels/wecom', 'PUT', {}],
] as const)('strict Assistant fixture refuses unexpected identities and writes: %s', async (path, method, body) => {
  const f = fixture(assistantsHost);
  await expect(f.send(path, method, body)).rejects.toThrow();
  expect(await f.send('/fixture/assistants/audit')).toMatchObject({ deleteAttempts: 0 });
});
