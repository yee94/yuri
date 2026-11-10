import { queryOptions, type QueryClient } from '@tanstack/react-query';
import type { ShellInfo } from '@opencode/client';
import { opencodeClient } from '@/lib/opencode/client';
import { queryClient } from '@/lib/queryRuntime';
import { normalizeDirectoryKey } from '@/lib/pathNormalization';
import { getRuntimeGeneration, getRuntimeTransportIdentity } from '@/lib/runtime-switch';

export type SessionShellLoaders = {
  locations: (signal: AbortSignal) => Promise<readonly { directory: string }[]>;
  shells: (directory: string, signal: AbortSignal) => Promise<readonly ShellInfo[]>;
  latestUser?: (directory: string, sessionID: string, signal: AbortSignal) => Promise<number | null>;
};

export function latestShellOwnerUserQueryOptions(directory: string, sessionID: string, load = async (
  directory: string, sessionID: string, signal: AbortSignal,
): Promise<number | null> => {
  const page = await opencodeClient.getScopedSdkClient(directory).message.list(
    { sessionID, type: 'user', order: 'desc', limit: 1 }, { signal },
  );
  if (!Array.isArray(page.data)) throw new Error('session user boundary is unavailable');
  const user = page.data[0];
  if (!user) return null;
  if (user.type !== 'user' || !Number.isFinite(user.time.created)) throw new Error('invalid session user boundary');
  return user.time.created;
}) {
  return queryOptions({
    queryKey: [getRuntimeTransportIdentity(), 'shellOwnerLatestUser', getRuntimeGeneration(), normalizeDirectoryKey(directory), sessionID],
    queryFn: ({ signal }) => load(directory, sessionID, signal),
    staleTime: 0,
    gcTime: 5 * 60_000,
    retry: false,
  });
}

const defaultLoaders: SessionShellLoaders = {
  locations: (signal) => opencodeClient.getSdkClient().debug.location.list({ signal }),
  shells: async (directory, signal) => (await opencodeClient.getScopedSdkClient(directory)
    .shell.list({ location: { directory } }, { signal })).data,
};

export function sessionShellSnapshotQueryOptions(loaders: SessionShellLoaders = defaultLoaders) {
  const transport = getRuntimeTransportIdentity();
  const generation = getRuntimeGeneration();
  const assertCurrent = () => {
    if (transport !== getRuntimeTransportIdentity() || generation !== getRuntimeGeneration()) {
      throw new Error('session shell runtime changed');
    }
  };
  return queryOptions({
    queryKey: [transport, 'sessionShells', generation],
    queryFn: async ({ signal }) => {
      assertCurrent();
      // Inventory does not boot Locations. Never probe historical/sidebar directories.
      const locations = await loaders.locations(signal);
      assertCurrent();
      const directories = [...new Set(locations.map(({ directory }) => normalizeDirectoryKey(directory)))];
      const snapshots = new Map<string, readonly ShellInfo[]>();
      let cursor = 0;
      await Promise.all(Array.from({ length: Math.min(2, directories.length) }, async () => {
        while (cursor < directories.length) {
          assertCurrent();
          signal.throwIfAborted();
          const directory = directories[cursor++];
          try {
            const shells = await loaders.shells(directory, signal);
            assertCurrent();
            if (!Array.isArray(shells)) throw new Error('session shell inventory is unavailable');
            snapshots.set(directory, shells);
          } catch {
            // A failed directory stays unknown; successful directories still converge.
          }
        }
      }));
      assertCurrent();
      signal.throwIfAborted();
      return { directories: new Set(directories), snapshots };
    },
    staleTime: 0,
    gcTime: 5 * 60_000,
    retry: false,
  });
}

export function fetchSessionShellSnapshot(client: QueryClient = queryClient, loaders?: SessionShellLoaders) {
  return client.fetchQuery(sessionShellSnapshotQueryOptions(loaders));
}
