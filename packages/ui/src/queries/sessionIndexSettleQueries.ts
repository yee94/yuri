import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { useEvent } from '@reactuses/core';
import { toast } from '@/components/ui';
import { formatMessage, useI18nStore, type I18nKey } from '@/lib/i18n';
import {
  settleSession,
  unsettleSession,
  type SessionIndexSession,
  type SessionIndexSnapshot,
} from '@/lib/session-index-api';
import { queryClient } from '@/lib/queryRuntime';
import { getRuntimeGeneration, getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import {
  readSessionIndexSnapshotQuery,
  writeSessionIndexSnapshotQuery,
} from './sessionIndexQueries';

const EMPTY_SETTLED_SESSION_IDS: ReadonlySet<string> = new Set();

let cachedSettledSnapshot: SessionIndexSnapshot | null | undefined;
let cachedSettledIds: ReadonlySet<string> = EMPTY_SETTLED_SESSION_IDS;
let cachedSettledTransport: string | null = null;

const t = (key: I18nKey): string => formatMessage(useI18nStore.getState().dictionary, key);

export const isSessionIndexSettled = (
  session: { time?: { settled?: number | null } } | null | undefined,
): boolean => typeof session?.time?.settled === 'number' && session.time.settled > 0;

export const deriveSettledSessionIdsFromSnapshot = (
  snapshot: SessionIndexSnapshot | null | undefined,
): ReadonlySet<string> => {
  if (!snapshot) return EMPTY_SETTLED_SESSION_IDS;
  const ids = new Set<string>();
  for (const directory of snapshot.directories) {
    for (const session of directory.sessions) {
      if (isSessionIndexSettled(session)) ids.add(session.id);
    }
  }
  return ids.size === 0 ? EMPTY_SETTLED_SESSION_IDS : ids;
};

const sameMembership = (left: ReadonlySet<string>, right: ReadonlySet<string>): boolean => {
  if (left === right) return true;
  if (left.size !== right.size) return false;
  for (const id of left) {
    if (!right.has(id)) return false;
  }
  return true;
};

export const readSettledSessionIds = (
  client: Pick<QueryClient, 'getQueryData'> = queryClient,
  transport = getRuntimeTransportIdentity(),
): ReadonlySet<string> => {
  const snapshot = readSessionIndexSnapshotQuery(client, transport);
  if (snapshot === cachedSettledSnapshot && transport === cachedSettledTransport) {
    return cachedSettledIds;
  }
  const next = deriveSettledSessionIdsFromSnapshot(snapshot);
  cachedSettledSnapshot = snapshot;
  cachedSettledTransport = transport;
  cachedSettledIds = sameMembership(cachedSettledIds, next) ? cachedSettledIds : next;
  return cachedSettledIds;
};

export type TaskIndexMembership = {
  indexedIds: ReadonlySet<string>;
  settledAtById: ReadonlyMap<string, number>;
};

let cachedMembershipSnapshot: SessionIndexSnapshot | null | undefined;
let cachedMembershipTransport: string | null = null;
let cachedMembership: TaskIndexMembership | null = null;

/** Index-held session ids and their settle times; `null` while no snapshot is loaded. */
export const readTaskIndexMembership = (
  client: Pick<QueryClient, 'getQueryData'> = queryClient,
  transport = getRuntimeTransportIdentity(),
): TaskIndexMembership | null => {
  const snapshot = readSessionIndexSnapshotQuery(client, transport);
  if (snapshot === cachedMembershipSnapshot && transport === cachedMembershipTransport) return cachedMembership;
  let next: TaskIndexMembership | null = null;
  if (snapshot) {
    const indexedIds = new Set<string>();
    const settledAtById = new Map<string, number>();
    for (const directory of snapshot.directories) {
      for (const session of directory.sessions) {
        indexedIds.add(session.id);
        if (isSessionIndexSettled(session)) settledAtById.set(session.id, session.time.settled as number);
      }
    }
    next = { indexedIds, settledAtById };
  }
  cachedMembershipSnapshot = snapshot;
  cachedMembershipTransport = transport;
  cachedMembership = next;
  return next;
};

export const patchSessionIndexSettled = (
  snapshot: SessionIndexSnapshot,
  sessionId: string,
  settledAt: number | null,
): SessionIndexSnapshot => {
  let changed = false;
  const directories = snapshot.directories.map((directory) => {
    let directoryChanged = false;
    const sessions = directory.sessions.map((session: SessionIndexSession) => {
      if (session.id !== sessionId) return session;
      if ((isSessionIndexSettled(session) ? session.time.settled : null) === settledAt) return session;
      directoryChanged = true;
      changed = true;
      return { ...session, time: { ...session.time, settled: settledAt } };
    });
    return directoryChanged ? { ...directory, sessions } : directory;
  });
  return changed ? { ...snapshot, directories } : snapshot;
};

type SettleVariables = {
  sessionId: string;
  nextSettled: boolean;
  transport: string;
  generation: number;
  onSuccess?: () => void;
};

type SettleContext = {
  previous: SessionIndexSnapshot | null;
  transport: string;
};

const applyOptimisticSettle = (
  client: Pick<QueryClient, 'getQueryData' | 'setQueryData'>,
  transport: string,
  sessionId: string,
  nextSettled: boolean,
): SessionIndexSnapshot | null => {
  const previous = readSessionIndexSnapshotQuery(client, transport);
  if (!previous) return null;
  const next = patchSessionIndexSettled(previous, sessionId, nextSettled ? Date.now() : null);
  if (next !== previous) {
    writeSessionIndexSnapshotQuery(next, { client, transport, persist: false });
  }
  return previous;
};

const subscribeSettledSessionIds = (onStoreChange: () => void): (() => void) => (
  queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated' && event.type !== 'removed') return;
    const key = event.query.queryKey;
    if (!Array.isArray(key) || key[1] !== 'sessionIndex' || key[2] !== 'snapshot') return;
    onStoreChange();
  })
);

/** Reactive settled-id set derived from the session-index snapshot Query cache. */
export const useSettledSessionIds = (): ReadonlySet<string> => (
  useSyncExternalStore(subscribeSettledSessionIds, () => readSettledSessionIds(), () => EMPTY_SETTLED_SESSION_IDS)
);

export const useTaskIndexMembership = (): TaskIndexMembership | null => (
  useSyncExternalStore(subscribeSettledSessionIds, () => readTaskIndexMembership(), () => null)
);

/**
 * Settle or un-settle a session via the Host index. The optimistic patch is
 * rolled back and surfaced as a toast when the write fails.
 */
export const useSetSessionSettled = (): ((sessionId: string, nextSettled: boolean, options?: { onSuccess?: () => void }) => void) => {
  const client = useQueryClient();
  const mutation = useMutation<void, Error, SettleVariables, SettleContext>({
    mutationKey: ['sessionIndex', 'settle'],
    mutationFn: async ({ sessionId, nextSettled }) => {
      if (nextSettled) await settleSession(sessionId);
      else await unsettleSession(sessionId);
    },
    onMutate: ({ sessionId, nextSettled, transport }) => ({
      previous: applyOptimisticSettle(client, transport, sessionId, nextSettled),
      transport,
    }),
    onSuccess: (_data, variables) => {
      if (variables.transport === getRuntimeTransportIdentity() && variables.generation === getRuntimeGeneration()) {
        variables.onSuccess?.();
      }
    },
    onError: (error, variables, context) => {
      if (context?.previous) {
        writeSessionIndexSnapshotQuery(context.previous, { client, transport: context.transport, persist: false });
      }
      toast.error(error instanceof Error
        ? error.message
        : t(variables.nextSettled
          ? 'sessions.sidebar.session.settle.error'
          : 'sessions.sidebar.session.unsettle.error'));
    },
  });

  return useEvent((sessionId: string, nextSettled: boolean, options?: { onSuccess?: () => void }) => {
    const id = sessionId.trim();
    if (!id) return;
    // Resolve transport at click time so a host switch cannot write against a stale cache key.
    const transport = getRuntimeTransportIdentity();
    const generation = getRuntimeGeneration();
    if (!readSessionIndexSnapshotQuery(client, transport)) return;
    mutation.mutate({ sessionId: id, nextSettled, transport, generation, onSuccess: options?.onSuccess });
  });
};
