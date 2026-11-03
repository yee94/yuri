import type { QueryClient } from '@tanstack/react-query';
import { normalizeDirectoryKey } from '@/lib/pathNormalization';
import { getRuntimeGeneration, getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import { fetchSessionShellSnapshot, type SessionShellLoaders } from '@/queries/sessionShellQueries';
import type { ChildStoreManager } from './child-store';
import type { Event } from './types';

type RunningShell = { sessionID: string; directory: string };

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
  return { id: info.id, owner: { sessionID: metadata.sessionID, directory } };
}

function createSessionShellActivity() {
  let running: ReadonlyMap<string, RunningShell> = new Map();
  const listeners = new Set<() => void>();
  const touched = new Set<string>();
  const clearedDirectories = new Set<string>();
  // Bounded terminal receipts prevent a delayed/duplicate create from reviving an exited process.
  const ended = new Set<string>();
  let runtime = `${getRuntimeTransportIdentity()}:${getRuntimeGeneration()}`;
  let epoch = 0;
  let flight: Promise<void> | undefined;

  const publish = (next: Map<string, RunningShell>) => {
    if (next.size === running.size && [...next].every(([id, owner]) => {
      const previous = running.get(id);
      return previous?.sessionID === owner.sessionID && previous.directory === owner.directory;
    })) return;
    running = next;
    listeners.forEach((notify) => notify());
  };
  const clear = () => {
    epoch += 1;
    flight = undefined;
    touched.clear();
    clearedDirectories.clear();
    ended.clear();
    publish(new Map());
  };
  const ensureRuntime = () => {
    const current = `${getRuntimeTransportIdentity()}:${getRuntimeGeneration()}`;
    if (current === runtime) return;
    runtime = current;
    clear();
  };
  const event = (directory: string, payload: Event) => {
    if (!['shell.created', 'shell.exited', 'shell.deleted', 'location.shutdown', 'server.instance.disposed'].includes(payload.type)) return;
    ensureRuntime();
    const next = new Map(running);
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
      const next = new Map(running);
      for (const [id, owner] of next) {
        if (!touched.has(id) && (!directories.has(owner.directory) || snapshots.has(owner.directory))) next.delete(id);
      }
      for (const [directory, shells] of snapshots) for (const info of shells) {
        const shell = ownedShell(info, directory);
        if (shell && !touched.has(shell.id) && !clearedDirectories.has(directory)) next.set(shell.id, shell.owner);
      }
      publish(next);
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
