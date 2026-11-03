import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { opencodeClient } from '@/lib/opencode/client';
import { Goal } from '@opencode/schema/goal';
import { Schema } from 'effect';
import { queryClient } from '@/lib/queryRuntime';
import { getRuntimeTransportIdentity, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';

const decodeGoal = Schema.decodeUnknownSync(Schema.NullOr(Goal.State));

const goalKey = (sessionID: string, directory?: string, transport = getRuntimeTransportIdentity()) =>
  [transport, 'session-goal', directory?.trim() || null, sessionID] as const;

export const sessionGoalQueryOptions = (sessionID: string, directory?: string, transport = getRuntimeTransportIdentity()) => ({
  queryKey: goalKey(sessionID, directory, transport),
  queryFn: async ({ signal }: { signal: AbortSignal }): Promise<Goal.State | null> => {
    const client = directory ? opencodeClient.getScopedSdkClient(directory) : opencodeClient.getSdkClient();
    const goal = await client.rpc(Goal.Definition).get({ sessionID }, {
      ...(directory ? { location: { directory } } : {}), signal,
    });
    signal.throwIfAborted();
    return decodeGoal(goal);
  },
});

export const useSessionGoalQuery = (sessionID: string, directory?: string) => {
  const transport = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeTransportIdentity, getRuntimeTransportIdentity);
  return useQuery({ ...sessionGoalQueryOptions(sessionID, directory, transport), enabled: Boolean(sessionID), refetchOnMount: 'always' });
};

export const refreshSessionGoal = (sessionID: string, directory?: string) =>
  queryClient.invalidateQueries({ queryKey: goalKey(sessionID, directory) });

export function handleSessionGoalEvent(directory: string, event: { type: string; properties?: unknown }): boolean {
  if (event.type === 'server.connected' || event.type === 'global.disposed') {
    void queryClient.invalidateQueries({ queryKey: [getRuntimeTransportIdentity(), 'session-goal'] });
    return false;
  }
  if (event.type !== 'rpc.opencode.goal.changed') return false;
  const parsed = Schema.decodeUnknownExit(Goal.Definition.events.changed.schema)(event.properties);
  if (parsed._tag === 'Failure') return true;
  const key = goalKey(parsed.value.sessionID, directory);
  // Cancel an older GET before installing the newer native event snapshot.
  void queryClient.cancelQueries({ queryKey: key });
  queryClient.setQueryData(key, parsed.value.goal);
  return true;
}
