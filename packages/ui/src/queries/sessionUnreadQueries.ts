import { replaceEqualDeep } from '@tanstack/react-query';
import { queryClient } from '@/lib/queryRuntime';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeGeneration, getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import type { HostRuntimeEntry } from '@/lib/remote-projects/registry';
import { remoteHostSummariesKey } from '@/lib/remote-projects/summaries';

export type SessionUnreadEntry = {
  directory: string;
  unreadCount: number;
  hasError: boolean;
  manual: boolean;
  revision: number;
};
export type SessionUnreadSnapshot = { revision: number; sessions: Record<string, SessionUnreadEntry> };
export const sessionUnreadKey = (transport = getRuntimeTransportIdentity(), entry?: HostRuntimeEntry) => entry?.location.hostId
  ? ['session-unread', transport, entry.location.hubId, entry.location.hostId, entry.connectionGeneration] as const
  : ['session-unread', transport] as const;
const endpoint = '/api/yuri/session-unread';
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const parse = async (response: Response): Promise<SessionUnreadSnapshot> => {
  if (!response.ok) throw new Error(`Session unread: ${response.status}`);
  const value = await response.json();
  if (!integer(value?.revision) || !value.sessions || typeof value.sessions !== 'object' || Array.isArray(value.sessions)
    || !Object.values(value.sessions).every((entry) => {
      if (!entry || typeof entry !== 'object') return false;
      const row = entry as Record<string, unknown>;
      return typeof row.directory === 'string' && integer(row.unreadCount) && integer(row.revision)
        && row.revision <= value.revision && typeof row.hasError === 'boolean' && typeof row.manual === 'boolean';
    })) throw new Error('Invalid session unread snapshot');
  return value;
};
export const sessionUnreadQueryOptions = (transport = getRuntimeTransportIdentity(), entry?: HostRuntimeEntry) => ({
  queryKey: sessionUnreadKey(transport, entry),
  queryFn: async ({ signal }: { signal: AbortSignal }) => {
    const snapshot = await parse(await (entry?.fetch ?? runtimeFetch)(endpoint, { signal }));
    entry?.sdk();
    return snapshot;
  },
  staleTime: 0,
  retry: 2,
  structuralSharing: (oldData: unknown, newData: unknown) => {
    const previous = oldData as SessionUnreadSnapshot | undefined;
    const next = newData as SessionUnreadSnapshot;
    return previous && previous.revision > next.revision ? previous : replaceEqualDeep(previous, next);
  },
});

/** Capture the observed row revision before queueing; a delayed read cannot erase a new mark. */
export async function saveSessionUnread(id: string, unread: boolean, expectedRevision?: number, entry?: HostRuntimeEntry): Promise<SessionUnreadSnapshot> {
  const transport = getRuntimeTransportIdentity();
  const generation = getRuntimeGeneration();
  const current = () => transport === getRuntimeTransportIdentity() && generation === getRuntimeGeneration();
  const snapshot = await parse(await (entry?.fetch ?? runtimeFetch)(`${endpoint}/${encodeURIComponent(id)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ unread, ...(!unread ? { expectedRevision: expectedRevision ?? 0 } : {}) }),
  }));
  if (!current()) throw new Error('Runtime changed');
  entry?.sdk();
  queryClient.setQueryData<SessionUnreadSnapshot>(sessionUnreadKey(transport, entry), previous => (
    previous && previous.revision > snapshot.revision ? previous : snapshot
  ));
  if (entry?.location.hostId) void queryClient.invalidateQueries({ queryKey: remoteHostSummariesKey(transport, entry.location.hubId, entry.location.hostId) });
  return snapshot;
}
