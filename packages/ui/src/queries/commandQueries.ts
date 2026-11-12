import { useQuery, type QueryClient } from '@tanstack/react-query';
import { opencodeClient } from '@/lib/opencode/client';
import { queryClient, queryKeys } from '@/lib/queryRuntime';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import { useProjectsStore } from '@/stores/useProjectsStore';
import type { HostRuntimeEntry } from '@/lib/remote-projects/registry';
import { captureProjectScope } from '@/lib/api/project-scope';
import { useHostRuntime } from '@/contexts/HostRuntimeProvider';

export type CommandScope = 'user' | 'project';

export interface CommandConfig {
  name: string;
  description?: string;
  agent?: string | null;
  model?: string | null;
  source?: string;
  template?: string;
  scope?: CommandScope;
  reference?: string;
}

export interface Command extends CommandConfig {
  isBuiltIn: boolean;
}

const normalizeDirectory = (directory: string | null | undefined): string | null => directory?.trim() || null;

export const resolveConfigQueryDirectory = (): string | null => {
  const activeProject = useProjectsStore.getState().getActiveProject?.();
  return normalizeDirectory(activeProject?.path) ?? normalizeDirectory(opencodeClient.getDirectory());
};

const commandQueryKey = (directory: string | null, transport = getRuntimeTransportIdentity()) =>
  queryKeys.commands.list(directory, transport);

export const commandQueryOptions = (
  directory: string | null = resolveConfigQueryDirectory(),
  transport = getRuntimeTransportIdentity(),
  entry?: HostRuntimeEntry,
) => {
  const normalizedDirectory = entry ? entry.location.directory : normalizeDirectory(directory);
  const scope = captureProjectScope(entry);
  return {
    queryKey: scope.key(commandQueryKey(normalizedDirectory, transport)),
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<Command[]> => {
      const response = await (entry ? scope.fetch : runtimeFetch)('/api/config/commands/metadata', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache',
          ...(normalizedDirectory ? { 'x-opencode-directory': normalizedDirectory } : {}),
        },
        body: JSON.stringify({ catalog: true }),
        query: normalizedDirectory ? { directory: normalizedDirectory } : undefined,
        signal,
      });
      if (!response.ok) {
        throw new Error('Failed to fetch command metadata');
      }
      const data = await response.json() as { commands?: Command[] };
      scope.assertCurrent(signal);
      if (entry && !Array.isArray(data.commands)) throw new Error('Invalid command catalog');
      return Array.isArray(data.commands) ? data.commands : [];
    },
    retry: 2,
  };
};

export const useCommandsQuery = (options: { enabled?: boolean; directory?: string | null } = {}) => {
  const host = useHostRuntime();
  const activeProjectPath = useProjectsStore((state) => state.getActiveProject?.()?.path ?? null);
  const directory = normalizeDirectory(options.directory) ?? normalizeDirectory(activeProjectPath) ?? normalizeDirectory(opencodeClient.getDirectory());
  const enabled = options.enabled !== false && Boolean(directory);
  return useQuery({
    ...commandQueryOptions(directory, undefined, host?.entry),
    enabled,
  });
};

export const readCommandsSnapshot = (
  directory: string | null = resolveConfigQueryDirectory(),
  transport = getRuntimeTransportIdentity(),
): Command[] => queryClient.getQueryData<Command[]>(commandQueryKey(normalizeDirectory(directory), transport)) ?? [];

export const refreshCommandsQuery = async (
  client: Pick<QueryClient, 'fetchQuery' | 'getQueryData'>,
  directory: string | null,
  transport: string,
): Promise<Command[]> => {
  const normalizedDirectory = normalizeDirectory(directory);
  if (getRuntimeTransportIdentity() !== transport) {
    return client.getQueryData<Command[]>(commandQueryKey(normalizedDirectory, transport)) ?? [];
  }
  const options = commandQueryOptions(normalizedDirectory, transport);
  return client.fetchQuery({ ...options, staleTime: 0 });
};
