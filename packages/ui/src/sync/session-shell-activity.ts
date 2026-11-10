import type { QueryClient } from '@tanstack/react-query';
import { normalizeDirectoryKey } from '@/lib/pathNormalization';
import { getRuntimeGeneration, getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import { fetchSessionShellSnapshot, latestShellOwnerUserQueryOptions, type SessionShellLoaders } from '@/queries/sessionShellQueries';
import { queryClient } from '@/lib/queryRuntime';
import type { ChildStoreManager } from './child-store';
import type { Event } from './types';

type RunningShell = { sessionID: string; directory: string; startedAt?: number };

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function ownedShell(value: unknown, directory: string): { id: string; owner: RunningShell } | undefined {
  const info = record(value);
  const metadata = record(info?.metadata);
  if (info?.status !== 'running' || typeof info.id !== 'string' || !info.id
    || typeof metadata?.sessionID !== 'string' || !metadata.sessionID) return;
  // User-entered session shells carry this marker and do not wake the Agent on completion.
  if (metadata.background === true) return;
  const started = record(info.time)?.started;
  return { id: info.id, owner: { sessionID: metadata.sessionID, directory,
    startedAt: typeof started === 'number' && Number.isFinite(started) ? started : undefined } };
}

function createSessionShellActivity() {
  let inventory = new Map<string, RunningShell>();
  let running: ReadonlyMap<string, RunningShell> = new Map();
  const latestUsers = new Map<string, number | null>();
  const userRevisions = new Map<string, number>();
  const userFlights = new Map<string, Promise<void>>();
  const listeners = new Set<() => void>();
  const touched = new Set<string>();
  const clearedDirectories = new Set<string>();
  // Bounded terminal receipts prevent a delayed/duplicate create from reviving an exited process.
  const ended = new Set<string>();
  let runtime = `${getRuntimeTransportIdentity()}:${getRuntimeGeneration()}`;
  let epoch = 0;
  let flight: Promise<void> | undefined;

  const publish = (next: Map<string, RunningShell>) => {
    inventory = next;
    const owners = new Set([...inventory.values()].map(owner => owner.sessionID));
    for (const id of latestUsers.keys()) if (!owners.has(id)) latestUsers.delete(id);
    for (const id of userRevisions.keys()) if (!owners.has(id)) userRevisions.delete(id);
    const visible = new Map([...next].filter(([, owner]) => {
      const boundary = latestUsers.get(owner.sessionID);
      return boundary == null || (owner.startedAt !== undefined && owner.startedAt >= boundary);
    }));
    if (visible.size === running.size && [...visible].every(([id, owner]) => {
      const previous = running.get(id);
      return previous?.sessionID === owner.sessionID && previous.directory === owner.directory && previous.startedAt === owner.startedAt;
    })) return;
    running = visible;
    listeners.forEach((notify) => notify());
  };
  const clear = () => {
    epoch += 1;
    flight = undefined;
    touched.clear();
    clearedDirectories.clear();
    ended.clear();
    latestUsers.clear();
    userRevisions.clear();
    userFlights.clear();
    publish(new Map());
  };
  const ensureRuntime = () => {
    const current = `${getRuntimeTransportIdentity()}:${getRuntimeGeneration()}`;
    if (current === runtime) return;
    runtime = current;
    clear();
  };
  const refreshUser = (directory: string, sessionID: string, client: QueryClient = queryClient,
    load?: SessionShellLoaders['latestUser']): Promise<void> => {
    const existing = userFlights.get(sessionID);
    if (existing) return existing;
    const capturedEpoch = epoch;
    const capturedRuntime = runtime;
    const current = () => capturedEpoch === epoch
      && capturedRuntime === `${getRuntimeTransportIdentity()}:${getRuntimeGeneration()}`;
    const revision = userRevisions.get(sessionID) ?? 0;
    const request: Promise<void> = client.fetchQuery(latestShellOwnerUserQueryOptions(directory, sessionID, load)).then(boundary => {
      if (!current() || revision !== (userRevisions.get(sessionID) ?? 0)) return;
      if (![...inventory.values()].some(owner => owner.sessionID === sessionID && owner.directory === directory)) return;
      latestUsers.set(sessionID, boundary);
      publish(inventory);
    }).catch(() => {
      // Failed boundary reads preserve the last known round and live inventory.
    }).finally(() => {
      if (userFlights.get(sessionID) !== request) return;
      userFlights.delete(sessionID);
      if (current() && revision !== (userRevisions.get(sessionID) ?? 0)
        && [...inventory.values()].some(owner => owner.sessionID === sessionID && owner.directory === directory)) {
        return refreshUser(directory, sessionID, client, load);
      }
    });
    userFlights.set(sessionID, request);
    return request;
  };
  const event = (directory: string, payload: Event) => {
    if (!['shell.created', 'shell.exited', 'shell.deleted', 'session.inbox.delivered', 'location.shutdown', 'server.instance.disposed'].includes(payload.type)) return;
    ensureRuntime();
    if (payload.type === 'session.inbox.delivered') {
      const id = payload.properties?.sessionID;
      if (typeof id !== 'string' || ![...inventory.values()].some(owner => owner.sessionID === id)) return;
      userRevisions.set(id, (userRevisions.get(id) ?? 0) + 1);
      void refreshUser(normalizeDirectoryKey(directory), id);
      return;
    }
    const next = new Map(inventory);
    if (payload.type === 'server.instance.disposed' || payload.type === 'location.shutdown') {
      const own = payload.properties?.directory;
      const scope = normalizeDirectoryKey(typeof own === 'string' ? own : directory);
      if (flight) clearedDirectories.add(scope);
      for (const [id, owner] of next) if (owner.directory === scope) {
        if (flight) touched.add(id);
        next.delete(id);
      }
    } else if (payload.type === 'shell.created') {
      const shell = ownedShell(payload.properties?.info, normalizeDirectoryKey(directory));
      if (!shell || ended.has(shell.id)) return;
      if (flight) touched.add(shell.id);
      next.set(shell.id, shell.owner);
      if (!latestUsers.has(shell.owner.sessionID)) void refreshUser(shell.owner.directory, shell.owner.sessionID);
    } else {
      const id = payload.properties?.id;
      if (typeof id !== 'string') return;
      if (flight) touched.add(id);
      ended.add(id);
      if (ended.size > 2048) ended.delete(ended.values().next().value!);
      next.delete(id);
    }
    publish(next);
  };
  const refresh = (client?: QueryClient, loaders?: SessionShellLoaders): Promise<void> => {
    ensureRuntime();
    if (flight) return flight;
    const capturedEpoch = epoch;
    const capturedRuntime = runtime;
    touched.clear();
    clearedDirectories.clear();
    flight = fetchSessionShellSnapshot(client, loaders).then(({ directories, snapshots }) => {
      if (capturedEpoch !== epoch || capturedRuntime !== `${getRuntimeTransportIdentity()}:${getRuntimeGeneration()}`) return;
      const next = new Map(inventory);
      for (const [id, owner] of next) {
        if (!touched.has(id) && (!directories.has(owner.directory) || snapshots.has(owner.directory))) next.delete(id);
      }
      for (const [directory, shells] of snapshots) for (const info of shells) {
        const shell = ownedShell(info, directory);
        if (shell && !touched.has(shell.id) && !clearedDirectories.has(directory)) next.set(shell.id, shell.owner);
      }
      publish(next);
      const owners = [...new Map([...inventory.values()].map(owner => [owner.sessionID, owner])).values()];
      let cursor = 0;
      return Promise.all(Array.from({ length: Math.min(2, owners.length) }, async () => {
        while (cursor < owners.length && capturedEpoch === epoch && capturedRuntime === runtime) {
          const owner = owners[cursor++];
          await refreshUser(owner.directory, owner.sessionID, client, loaders?.latestUser);
        }
      })).then(() => undefined);
    }).finally(() => {
      if (capturedEpoch === epoch) {
        flight = undefined;
        touched.clear();
        clearedDirectories.clear();
      }
    });
    return flight;
  };
  return {
    read: () => running,
    subscribe: (notify: () => void) => { listeners.add(notify); return () => { listeners.delete(notify); }; },
    event,
    refresh,
    clear,
  };
}

const activities = new WeakMap<ChildStoreManager, ReturnType<typeof createSessionShellActivity>>();
export function getSessionShellActivity(children: ChildStoreManager) {
  let activity = activities.get(children);
  if (!activity) { activity = createSessionShellActivity(); activities.set(children, activity); }
  return activity;
}
