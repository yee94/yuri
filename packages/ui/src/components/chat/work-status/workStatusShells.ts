import { queryOptions } from '@tanstack/react-query';
import { opencodeClient } from '@/lib/opencode/client';
import { queryKeys } from '@/lib/queryRuntime';

export type WorkStatusShell = {
  id: string;
  directory: string;
  startedAt?: number;
};

export function workStatusShellInfoQueryOptions(directory: string, shellID: string) {
  return queryOptions({
    queryKey: queryKeys.workStatusShell.info(directory, shellID),
    queryFn: async ({ signal }) => {
      const response = await opencodeClient.getScopedSdkClient(directory).shell.get(
        { id: shellID, location: { directory } },
        { signal },
      );
      const data = response?.data;
      if (!data || typeof data.command !== 'string') throw new Error('shell.get returned no data');
      return { command: data.command, status: data.status, exit: data.exit };
    },
    staleTime: 30_000,
  });
}
