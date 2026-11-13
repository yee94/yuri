import { useQuery } from '@tanstack/react-query';
import { useDetectedWorktreeMetadata } from '@/hooks/useDetectedWorktreeRoot';
import { useHostRuntime } from '@/contexts/HostRuntimeProvider';
import { captureProjectScope } from './project-scope';
import type { WorktreeMetadata } from '@/types/worktree';

export function useProjectWorktreeMetadata(directory: string | undefined, storeMetadata: WorktreeMetadata | undefined, branch: string | undefined) {
  const host = useHostRuntime();
  const entry = host?.entry.location.hostId ? host.entry : undefined;
  const local = useDetectedWorktreeMetadata(entry ? undefined : directory, entry ? undefined : storeMetadata, entry ? undefined : branch);
  const scope = captureProjectScope(entry);
  const remote = useQuery({
    queryKey: scope.key(['project-worktree-metadata', directory, branch]),
    enabled: Boolean(entry && directory),
    queryFn: async ({ signal }): Promise<WorktreeMetadata | null> => {
      if (!directory || !entry) throw new Error('Project worktree scope required');
      const [primary, top] = await Promise.all(['primary-root', 'toplevel'].map((route) => scope.json<{ root: string }>(`/api/git/${route}`, {
        query: { directory }, headers: { 'x-opencode-directory': directory }, signal,
      })));
      if (!primary.root || !top.root || primary.root === top.root) return null;
      return { source: 'sdk', path: top.root, projectDirectory: primary.root, branch: branch ?? '', label: branch || top.root,
        worktreeRoot: top.root, worktreeStatus: 'ready', headState: branch ? 'branch' : 'unborn', worktreeSource: 'existing' };
    },
    staleTime: 30_000,
  });
  return entry ? remote.data ?? undefined : local;
}
