import { queryOptions } from '@tanstack/react-query';
import type { HostRuntimeEntry } from '@/lib/remote-projects/registry';
import type { SessionStatus } from '@/lib/opencode/v2-types';

/** Process-global membership shared by visible panes of the same fenced Host. */
export function remoteSessionActiveQueryOptions(entry: HostRuntimeEntry) {
  const [transport, hubId, hostId, , connectionGeneration] = entry.queryScope;
  return queryOptions({
    queryKey: [transport, 'remote-session-active', hubId, hostId, connectionGeneration],
    queryFn: async ({ signal }) => {
      entry.sdk();
      const result = await entry.service().getSessionActive(signal);
      entry.sdk();
      if (result.state !== 'supported') throw new Error(`Remote session active membership ${result.state}`);
      return result.membership;
    },
    staleTime: 0,
    gcTime: Infinity,
    retry: false,
  });
}

export function remoteSessionStatus(running: boolean, previous?: SessionStatus): SessionStatus {
  if (!running) return { type: 'idle' };
  // A live retry owns its account/action metadata until its scheduled resume.
  if (previous?.type === 'retry' && previous.next > Date.now()) return previous;
  return { type: 'busy' };
}
