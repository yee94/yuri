import React from 'react';
import { queryOptions, useQuery, useQueryClient } from '@tanstack/react-query';
import { useHostRuntime, useRemoteSessionDemand } from '@/contexts/HostRuntimeProvider';
import { getRemoteChatOwner } from '@/sync/remote-chat-context';
import { projectLatestTodosFromTranscript } from '@/sync/session-todo-projection';
import { createProjectGitAPI } from '@/lib/gitApiProject';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionNavigationStore } from '@/stores/useSessionNavigationStore';
import { normalizePath } from '@/lib/pathNormalization';
import type { Todo } from '@/lib/opencode/v2-types';
import type { WorktreeMetadata } from '@/types/worktree';
import { mergeWorkStatusSubagents, projectTranscriptSubagents } from './workStatusSubagents';
import { workStatusChildrenQueryOptions } from './workStatusChildrenQuery';
import { useGitStore } from '@/lib/api/useProjectGitStore';
import { remoteSessionActiveQueryOptions } from '@/sync/remote-session-active';

const EMPTY_TODOS: Todo[] = [];
const belongs = (directory: string, root: string) => {
  const path = normalizePath(directory), parent = normalizePath(root);
  return Boolean(path && parent && (path === parent || path.startsWith(`${parent}/`)));
};

/** A visible leaf shares the real chat owner; no Hub child-store or bare-ID fallback. */
export function useRemoteWorkStatus(sessionId: string | null) {
  const host = useHostRuntime();
  if (!host?.entry.location.hostId) throw new Error('Remote work status requires Host scope');
  const { entry, registry } = host;
  const { directory, hubId } = entry.location;
  const hostId = entry.location.hostId!;
  const owner = React.useMemo(() => getRemoteChatOwner(registry, entry), [registry, entry]);
  React.useEffect(() => owner.retain(), [owner]);
  const [error, setError] = React.useState<unknown>();
  React.useEffect(() => sessionId ? owner.state.observe(sessionId, setError) : undefined, [owner, sessionId]);
  const subscribe = React.useMemo(() => (notify: () => void) => sessionId
    ? owner.state.repository.subscribe(owner.state.scope(sessionId), notify) : () => {}, [owner, sessionId]);
  const snapshot = React.useMemo(() => () => sessionId
    ? owner.state.repository.getTranscript(owner.state.scope(sessionId)) : null, [owner, sessionId]);
  const transcript = React.useSyncExternalStore(subscribe, snapshot, snapshot);
  const subscribeMetadata = React.useMemo(() => owner.state.subscribeSnapshot, [owner]);
  const metadataSnapshot = React.useMemo(() => () => owner.state.getSnapshot(sessionId ?? ''), [owner, sessionId]);
  const metadata = React.useSyncExternalStore(subscribeMetadata, metadataSnapshot, metadataSnapshot);
  const projects = useProjectsStore((state) => state.projects);
  const selection = useSessionNavigationStore((state) => state.remoteSession);
  const git = React.useMemo(() => createProjectGitAPI(entry), [entry]);
  const fetchGitStatus = useGitStore((state) => state.fetchStatus);
  const treesOptions = React.useMemo(() => queryOptions({ queryKey: [...entry.queryScope, 'work-status', 'worktrees'],
    queryFn: () => git.listGitWorktrees(directory), staleTime: 30_000 }), [entry, git, directory]);
  const statusOptions = React.useMemo(() => remoteSessionActiveQueryOptions(entry), [entry]);
  const childrenOptions = React.useMemo(() => workStatusChildrenQueryOptions(directory, sessionId ?? '', { entry }), [entry, directory, sessionId]);
  const trees = useQuery(treesOptions);
  const statuses = useQuery(statusOptions);
  const children = useQuery({ ...childrenOptions, enabled: Boolean(sessionId) });
  const client = useQueryClient();
  useRemoteSessionDemand(sessionId, async () => {
    await Promise.all([
      client.fetchQuery({ ...treesOptions, staleTime: 0 }), client.fetchQuery({ ...statusOptions, staleTime: 0 }),
      client.fetchQuery({ ...childrenOptions, staleTime: 0 }),
      fetchGitStatus(directory, git, { silent: true }),
    ]);
    setError(undefined);
  }, setError);
  React.useEffect(() => registry.subscribeEvents(hostId, (event) => {
    if (event.directory && normalizePath(event.directory) !== normalizePath(directory)) return;
    const payload = event.payload as { type?: string };
    const type = payload?.type ?? '';
    if (type.startsWith('session.') && !type.startsWith('session.message.') && !type.startsWith('session.tool.')) {
      if (/status|execution|retry|idle/.test(type)) void client.invalidateQueries({ queryKey: statusOptions.queryKey });
      if (/created|updated|renamed|deleted/.test(type)) void client.invalidateQueries({ queryKey: childrenOptions.queryKey });
    }
    if (type.startsWith('worktree.') || type === 'vcs.branch.updated') {
      void client.invalidateQueries({ queryKey: treesOptions.queryKey });
      void fetchGitStatus(directory, git, { silent: true });
    } else if (/^session\.(execution\.(succeeded|failed|interrupted)|idle)$/.test(type)) {
      void fetchGitStatus(directory, git, { silent: true });
    }
  }), [registry, hostId, directory, client, statusOptions.queryKey, childrenOptions.queryKey, treesOptions.queryKey, fetchGitStatus, git]);
  const project = React.useMemo(() => {
    const candidates = projects.filter((project) => project.hostId === hostId && project.hubId === hubId);
    const selected = selection && selection.location.hostId === hostId && selection.location.hubId === hubId
      ? candidates.find((project) => project.id === selection.projectId) : undefined;
    if (selected) return selected;
    return candidates.filter((project) => belongs(directory, project.path)
      || trees.data?.some((tree) => normalizePath(tree.path) === normalizePath(project.path)))
      .sort((a, b) => b.path.length - a.path.length)[0];
  }, [projects, hostId, hubId, selection, directory, trees.data]);
  const worktree = React.useMemo<WorktreeMetadata | undefined>(() => {
    const tree = trees.data?.filter((tree) => belongs(directory, tree.path)).sort((a, b) => b.path.length - a.path.length)[0];
    if (!tree) return undefined;
    return { ...tree, projectDirectory: project?.path ?? directory, label: tree.name, worktreeStatus: 'ready' };
  }, [trees.data, directory, project?.path]);
  const subagents = React.useMemo(() => {
    const busy = new Set(Object.keys(statuses.data ?? {}));
    return mergeWorkStatusSubagents(transcript ? projectTranscriptSubagents(transcript) : [],
      (children.data ?? []).map((child) => ({ ...child, busy: busy.has(child.id) })), busy);
  }, [statuses.data, transcript, children.data]);
  const remoteTodos = React.useMemo(() => ({
    todos: (transcript ? projectLatestTodosFromTranscript(transcript, metadata.session?.revert?.messageID) : undefined) ?? EMPTY_TODOS,
    isWorking: metadata.status?.type === 'busy' || metadata.status?.type === 'retry',
  }), [transcript, metadata.session?.revert?.messageID, metadata.status]);
  const retry = async () => {
    setError(undefined);
    await Promise.allSettled([trees.refetch(), statuses.refetch(), children.refetch(),
      sessionId ? owner.state.refreshMetadata(sessionId) : Promise.resolve()]);
  };
  return { project, worktree, subagents, remoteTodos, stateKey: entry.key, error: error ?? trees.error ?? statuses.error ?? children.error, retry };
}
