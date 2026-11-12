import { useMemo } from 'react';
import { useGitStore as useLocalGitStore } from '@/stores/useGitStore';
import { useHostRuntime } from '@/contexts/HostRuntimeProvider';
import type { HostRuntimeEntry } from '@/lib/remote-projects/registry';
import type { GitAPI } from './types';

export type ProjectGitState = ReturnType<typeof useLocalGitStore.getState>;
type State = ProjectGitState;

/** Keep the mature Git view/state transitions, but never share directory slots across Hosts. */
export function createProjectGitStoreProjection(entry: HostRuntimeEntry) {
  const prefix = `project-git:${encodeURIComponent(JSON.stringify(entry.queryScope))}:`;
  const key = (directory: string) => prefix + encodeURIComponent(directory);
  const raw = (directory: string) => directory.startsWith(prefix)
    ? decodeURIComponent(directory.slice(prefix.length)) : directory;
  const apis = new WeakMap<object, GitAPI>();
  const api = (git: Parameters<State['fetchStatus']>[1]): GitAPI => {
    let result = apis.get(git);
    if (!result) {
      result = new Proxy(git as GitAPI, { get(target, property, receiver) {
        if (property === 'projectScope') return entry;
        if (property === 'queryDirectory') return raw;
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? (directory: string, ...args: unknown[]) =>
          Reflect.apply(value, target, [raw(directory), ...args]) : value;
      } });
      apis.set(git, result);
    }
    return result;
  };
  const snapshots = new WeakMap<State, State>();
  let last: State | undefined;
  return (state: State): State => {
    const existing = snapshots.get(state);
    if (existing) return existing;
    const directories: State['directories'] = new Map();
    for (const [directory, value] of state.directories) {
      if (directory.startsWith(prefix)) directories.set(raw(directory), value);
    }
    const projected: State = {
      ...state, directories, activeDirectory: state.activeDirectory?.startsWith(prefix) ? raw(state.activeDirectory) : null,
      setActiveDirectory: (d) => state.setActiveDirectory(d ? key(d) : null),
      getDirectoryState: (d) => state.getDirectoryState(key(d)),
      fetchStatus: (d, git, options) => state.fetchStatus(key(d), api(git), options),
      fetchBranches: (d, git, options) => state.fetchBranches(key(d), api(git), options),
      fetchLog: (d, git, count) => state.fetchLog(key(d), api(git), count),
      fetchIdentity: (d, git) => state.fetchIdentity(key(d), api(git)),
      fetchAll: (d, git, options) => state.fetchAll(key(d), api(git), options),
      ensureStatus: (d, git) => state.ensureStatus(key(d), api(git)),
      ensureAll: (d, git) => state.ensureAll(key(d), api(git)),
      moveStatusPathsOptimistically: (d, paths, direction) => state.moveStatusPathsOptimistically(key(d), paths, direction),
      restoreStatus: (d, status) => state.restoreStatus(key(d), status),
      bumpIndexRevision: (d) => state.bumpIndexRevision(key(d)),
      getDiff: (d, path) => state.getDiff(key(d), path),
      setDiff: (d, path, diff) => state.setDiff(key(d), path, diff),
      clearDiffCache: (d) => state.clearDiffCache(key(d)),
      fetchAllDiffs: (d, git) => state.fetchAllDiffs(key(d), api(git)),
      prefetchDiffs: (d, git, paths, options) => state.prefetchDiffs(key(d), api(git), paths, options),
      setLogMaxCount: (d, count) => state.setLogMaxCount(key(d), count),
      refresh: (git, options) => state.fetchAll(key(entry.location.directory), api(git), options),
    };
    // Actions are stable across snapshots; unrelated renders must not restart effects.
    if (last) for (const name of Object.keys(projected) as Array<keyof State>) {
      if (typeof projected[name] === 'function') Reflect.set(projected, name, last[name]);
    }
    last = projected;
    snapshots.set(state, projected);
    return projected;
  };
}

const projections = new WeakMap<HostRuntimeEntry, ReturnType<typeof createProjectGitStoreProjection>>();

export function useGitStore<T>(selector: (state: State) => T): T {
  const host = useHostRuntime();
  const entry = host?.entry.location.hostId ? host.entry : undefined;
  const project = useMemo(() => {
    if (!entry) return (state: State) => state;
    let projection = projections.get(entry);
    if (!projection) { projection = createProjectGitStoreProjection(entry); projections.set(entry, projection); }
    return projection;
  }, [entry]);
  return useLocalGitStore((state) => selector(project(state)));
}
export const useGitStatus = (d: string | null) => useGitStore((s) => d ? s.directories.get(d)?.status ?? null : null);
export const useGitBranches = (d: string | null) => useGitStore((s) => d ? s.directories.get(d)?.branches ?? null : null);
export const useGitLog = (d: string | null) => useGitStore((s) => d ? s.directories.get(d)?.log ?? null : null);
export const useIsGitRepo = (d: string | null) => useGitStore((s) => d ? s.directories.get(d)?.isGitRepo ?? null : null);
export const useGitLoadingStatus = (d: string | null) => useGitStore((s) => d ? s.directories.get(d)?.isLoadingStatus ?? false : false);
export const useGitLoadingLog = (d: string | null) => useGitStore((s) => d ? s.directories.get(d)?.isLoadingLog ?? false : false);
