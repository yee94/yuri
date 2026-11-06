import { QueryClient } from '@tanstack/react-query';
import type { ShellInfo } from '@opencode/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ChildStoreManager } from './child-store';
import { getSessionShellActivity } from './session-shell-activity';
import { getSessionActivityReader } from './session-activity';
import { handleEvent } from './sync-context';
import { normalizeOpenCodeEvent, toLegacyEventShape } from './opencode-event-normalizer';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useGlobalSessionStatusStore } from './global-session-status';
import type { Session } from '@/lib/opencode/v2-types';
import type { SessionShellLoaders } from '@/queries/sessionShellQueries';
import { queryClient } from '@/lib/queryRuntime';

const runtime = vi.hoisted(() => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [] })));
  return { generation: 0, transport: 'shell-test' };
});
vi.mock('@/lib/runtime-switch', async (original) => ({
  ...await original<typeof import('@/lib/runtime-switch')>(),
  getRuntimeGeneration: () => runtime.generation,
  getRuntimeTransportIdentity: () => runtime.transport,
}));

let client: QueryClient;
beforeEach(() => {
  client = new QueryClient();
  runtime.generation += 1;
  useGlobalSessionsStore.setState({ activeSessions: [] });
  useGlobalSessionStatusStore.setState({ statusById: new Map() });
});
afterEach(() => { client.clear(); vi.restoreAllMocks(); });

function shell(id: string, sessionID = 'parent', metadata = {}): ShellInfo {
  return { id, status: 'running', command: 'run tests', cwd: '/workspace', shell: 'sh', file: '/output',
    metadata: { sessionID, ...metadata }, time: { started: 1 } };
}
function loaders(shells: readonly ShellInfo[], directories = ['/workspace']): SessionShellLoaders {
  return { locations: vi.fn(async () => directories.map(directory => ({ directory }))), shells: vi.fn(async () => shells) };
}
function dispatch(children: ChildStoreManager, type: string, data: Record<string, unknown>, directory = '/workspace') {
  const normalized = normalizeOpenCodeEvent({ type, data, created: 100, location: { directory } });
  if (normalized.action !== 'emit') throw new Error('invalid fixture');
  handleEvent(directory, toLegacyEventShape(normalized.event), children, {
    sessionDirectoryById: new Map(), messageSessionById: new Map(), sessionMessageIdsById: new Map(),
  });
}

test('native shell events keep an idle session and its ancestors active and count alongside a subagent', () => {
  const children = new ChildStoreManager();
  const store = children.ensureChild('/workspace', { bootstrap: false });
  store.setState({ session: [{ id: 'parent' }, { id: 'child', parentID: 'parent' }] as Session[],
    session_status: { parent: { type: 'idle' }, child: { type: 'busy' } } });
  const reader = getSessionActivityReader(children);
  const notify = vi.fn();
  const unsubscribe = reader.subscribe(notify);
  dispatch(children, 'shell.created', { info: shell('sh_one') });
  expect(reader.readBackgroundCount('parent')).toBe(2);
  expect(reader.read().has('parent')).toBe(true);
  const activeSet = reader.read();
  dispatch(children, 'shell.created', { info: shell('sh_two', 'child') });
  expect(reader.read()).toBe(activeSet);
  expect(reader.readBackgroundCount('parent')).toBe(3);
  expect(reader.readBackgroundCount('child')).toBe(1);
  const scope = { childSessionIDs: new Set(['child']), shellIDs: new Set(['sh_one', 'sh_two']) };
  expect(reader.readBackgroundCount('parent', scope)).toBe(3);
  expect(reader.readBackgroundCount('parent', { childSessionIDs: new Set(), shellIDs: new Set(['sh_unrelated']) })).toBe(0);
  store.setState({ session_status: { parent: { type: 'idle' }, child: { type: 'idle' } } });
  expect(reader.readBackgroundCount('parent')).toBe(2);
  dispatch(children, 'shell.exited', { id: 'sh_one', status: 'timeout' });
  expect(reader.readBackgroundCount('parent')).toBe(1);
  dispatch(children, 'shell.deleted', { id: 'sh_two' });
  expect(reader.read().size).toBe(0);
  expect(store.getState().session_status.parent.type).toBe('idle');
  expect(notify).toHaveBeenCalled();
  unsubscribe();
});

test('unopened directories, duplicates, delayed creates and non-Agent shells never require a child store', () => {
  const children = new ChildStoreManager();
  const reader = getSessionActivityReader(children);
  const notify = vi.fn();
  const unsubscribe = reader.subscribe(notify);
  dispatch(children, 'shell.created', { info: shell('sh_one') });
  expect(children.children.size).toBe(0);
  expect(reader.read().has('parent')).toBe(true);
  notify.mockClear();
  for (let i = 0; i < 50; i++) dispatch(children, 'shell.created', { info: shell('sh_one') });
  dispatch(children, 'shell.created', { info: shell('sh_user', 'parent', { background: true }) });
  dispatch(children, 'shell.created', { info: { ...shell('sh_unowned'), metadata: {} } });
  expect(notify).not.toHaveBeenCalled();
  expect(reader.readBackgroundCount('parent')).toBe(1);
  dispatch(children, 'shell.exited', { id: 'sh_one', status: 'exited' });
  dispatch(children, 'shell.created', { info: shell('sh_one') });
  expect(reader.read().size).toBe(0);
  unsubscribe();
});

test('bootstrap/reconnect replaces successful scopes, preserves failed scopes and clears unloaded ones', async () => {
  const children = new ChildStoreManager();
  const activity = getSessionShellActivity(children);
  dispatch(children, 'shell.created', { info: shell('sh_old') });
  dispatch(children, 'shell.created', { info: shell('sh_failed') }, '/failed');
  dispatch(children, 'shell.created', { info: shell('sh_gone') }, '/gone');
  const load: SessionShellLoaders = {
    locations: async () => [{ directory: '/workspace/' }, { directory: '/failed' }],
    shells: async (directory) => {
      if (directory === '/failed') throw new Error('offline');
      return [shell('sh_current'), shell('sh_user', 'parent', { background: true })];
    },
  };
  await activity.refresh(client, load);
  expect([...activity.read().keys()].sort()).toEqual(['sh_current', 'sh_failed']);
  const previous = activity.read();
  await expect(activity.refresh(client, { ...load, locations: async () => { throw new Error('offline'); } })).rejects.toThrow('offline');
  expect(activity.read()).toBe(previous);
  await activity.refresh(client, loaders([]));
  expect(activity.read().size).toBe(0);
  expect(children.children.size).toBe(0);
});

test('cold snapshots count only shells started in the latest authored user round, without changing execution or subagents', async () => {
  const children = new ChildStoreManager();
  const store = children.ensureChild('/workspace', { bootstrap: false });
  store.setState({ session: [{ id: 'parent' }, { id: 'child', parentID: 'parent' }] as Session[],
    session_status: { parent: { type: 'idle' }, child: { type: 'busy' } } });
  const activity = getSessionShellActivity(children);
  const reader = getSessionActivityReader(children);
  const unsubscribe = reader.subscribe(() => {});
  const load = loaders([100, 200, 250].map(started => ({ ...shell(`sh_${started}`), time: { started } })));
  load.latestUser = vi.fn(async () => 200);
  await activity.refresh(client, load);
  expect([...activity.read().keys()]).toEqual(['sh_200', 'sh_250']);
  expect(reader.readBackgroundCount('parent')).toBe(3);
  expect(reader.readBackgroundCount('parent', { childSessionIDs: new Set(), shellIDs: new Set(['sh_100']) })).toBe(0);
  expect(store.getState().session_status.parent.type).toBe('idle');
  expect(load.latestUser).toHaveBeenCalledTimes(1);
  load.latestUser = async () => { throw new Error('offline'); };
  await activity.refresh(client, load);
  expect([...activity.read().keys()]).toEqual(['sh_200', 'sh_250']);
  unsubscribe();
});

test('only a consumed authored user boundary retires old shell indicators; queueing and synthetic completion do not', async () => {
  const children = new ChildStoreManager();
  const activity = getSessionShellActivity(children);
  await activity.refresh(client, { ...loaders([{ ...shell('sh_old'), time: { started: 150 } }]), latestUser: async () => 100 });
  const readUser = vi.spyOn(queryClient, 'fetchQuery').mockResolvedValue(100);
  dispatch(children, 'session.inbox.enqueued', { sessionID: 'parent', inboxID: 'queued' });
  expect(readUser).not.toHaveBeenCalled();
  expect(activity.read().has('sh_old')).toBe(true);
  dispatch(children, 'session.inbox.delivered', { sessionID: 'parent', inboxID: 'synthetic' });
  await vi.waitFor(() => expect(readUser).toHaveBeenCalledTimes(1));
  expect(activity.read().has('sh_old')).toBe(true);
  readUser.mockResolvedValue(200);
  dispatch(children, 'session.inbox.delivered', { sessionID: 'parent', inboxID: 'new-user' });
  await vi.waitFor(() => expect(readUser).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(activity.read().size).toBe(0));
  dispatch(children, 'shell.created', { info: { ...shell('sh_new'), time: { started: 250 } } });
  expect([...activity.read().keys()]).toEqual(['sh_new']);
  // Filtering affects presentation only: the old process still accepts its terminal receipt.
  dispatch(children, 'shell.exited', { id: 'sh_old', status: 'exited' });
  expect([...activity.read().keys()]).toEqual(['sh_new']);
});

test('a delivered input during a user-boundary read forces a fresh read instead of restoring an older round', async () => {
  const children = new ChildStoreManager();
  const activity = getSessionShellActivity(children);
  let resolve!: (value: number) => void;
  const latestUser = vi.fn<NonNullable<SessionShellLoaders['latestUser']>>()
    .mockImplementationOnce(() => new Promise<number>(done => { resolve = done; }))
    .mockResolvedValue(300);
  const refresh = activity.refresh(client, { ...loaders([{ ...shell('sh_old'), time: { started: 200 } }]), latestUser });
  await vi.waitFor(() => expect(latestUser).toHaveBeenCalledTimes(1));
  dispatch(children, 'session.inbox.delivered', { sessionID: 'parent', inboxID: 'new-user' });
  resolve(100);
  await refresh;
  expect(latestUser).toHaveBeenCalledTimes(2);
  expect(activity.read().size).toBe(0);
});

test('round recovery bounds owner reads, shares same-owner shells and releases them on runtime teardown', async () => {
  const children = new ChildStoreManager();
  const activity = getSessionShellActivity(children);
  let inFlight = 0;
  let maximum = 0;
  const latestUser = vi.fn<NonNullable<SessionShellLoaders['latestUser']>>(async () => {
    inFlight += 1;
    maximum = Math.max(maximum, inFlight);
    await Promise.resolve();
    inFlight -= 1;
    return 100;
  });
  const processes = Array.from({ length: 51 }, (_, index) => ({ ...shell(`sh_${index}`, `owner-${index % 10}`), time: { started: 200 } }));
  await activity.refresh(client, { ...loaders(processes), latestUser });
  expect(latestUser).toHaveBeenCalledTimes(10);
  expect(maximum).toBeLessThanOrEqual(2);
  expect(activity.read().size).toBe(51);
  const resolveReads: Array<(value: number) => void> = [];
  const late = activity.refresh(client, { ...loaders(processes), latestUser: () => new Promise<number>(done => { resolveReads.push(done); }) });
  await vi.waitFor(() => expect(resolveReads).toHaveLength(2));
  activity.clear();
  resolveReads.forEach(resolve => resolve(300));
  await late;
  expect(activity.read().size).toBe(0);
});

test('events during a shared snapshot win, including unseen exit receipts and location shutdown', async () => {
  const children = new ChildStoreManager();
  const activity = getSessionShellActivity(children);
  let resolve!: (value: readonly ShellInfo[]) => void;
  const load = loaders([]);
  load.shells = vi.fn(() => new Promise<readonly ShellInfo[]>(done => { resolve = done; }));
  const first = activity.refresh(client, load);
  expect(activity.refresh(client, load)).toBe(first);
  await vi.waitFor(() => expect(load.shells).toHaveBeenCalledTimes(1));
  dispatch(children, 'shell.exited', { id: 'sh_unseen', status: 'exited' });
  dispatch(children, 'shell.created', { info: shell('sh_new') });
  resolve([shell('sh_unseen')]);
  await first;
  expect([...activity.read().keys()]).toEqual(['sh_new']);
  const next = activity.refresh(client, load);
  await vi.waitFor(() => expect(load.shells).toHaveBeenCalledTimes(2));
  dispatch(children, 'location.shutdown', { directory: '/workspace' });
  resolve([shell('sh_old')]);
  await next;
  expect(activity.read().size).toBe(0);
});

test.each(['dispose', 'runtime'] as const)('%s fences a delayed snapshot and never revives old work', async (reason) => {
  const children = new ChildStoreManager();
  const activity = getSessionShellActivity(children);
  let resolve!: (value: readonly ShellInfo[]) => void;
  const load = loaders([]);
  load.shells = vi.fn(() => new Promise<readonly ShellInfo[]>(done => { resolve = done; }));
  const flight = activity.refresh(client, load);
  await vi.waitFor(() => expect(load.shells).toHaveBeenCalledTimes(1));
  if (reason === 'dispose') activity.clear();
  else runtime.generation += 1;
  resolve([shell('sh_old')]);
  if (reason === 'runtime') await expect(flight).rejects.toThrow('runtime changed');
  else await flight;
  expect(activity.read().size).toBe(0);
  dispatch(children, 'shell.created', { info: shell('sh_new') });
  expect([...activity.read().keys()]).toEqual(['sh_new']);
});

test('shell lifecycle and unrelated token updates never rescan a 2000-session catalog for 100 consumers', () => {
  const children = new ChildStoreManager();
  const store = children.ensureChild('/workspace', { bootstrap: false });
  let visits = 0;
  store.setState({ session: Array.from({ length: 2000 }, (_, i) => ({
    get id() { visits += 1; return `session-${i}`; },
    parentID: i ? 'session-0' : undefined,
  })) as Session[] });
  const reader = getSessionActivityReader(children);
  const unsubscribes = Array.from({ length: 100 }, () => reader.subscribe(() => {}));
  visits = 0;
  for (let i = 0; i < 50; i++) {
    dispatch(children, 'shell.created', { info: shell(`sh_${i}`, 'session-1999') });
    store.setState({ session_status_observed_at: { 'session-1999': i } });
    reader.read();
  }
  expect(reader.readBackgroundCount('session-0')).toBe(50);
  expect(visits).toBe(0);
  unsubscribes.forEach(unsubscribe => unsubscribe());
});
