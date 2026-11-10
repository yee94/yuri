import { isVSCodeRuntime } from '@/lib/desktop';
import { subscribeYuriEvents } from '@/lib/yuriEvents';
import { getRuntimeGeneration, isRuntimeEndpointIdentityChange, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { syncGlobalSessionsForDirectories, useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { forceRefreshProjectWorktreeCatalog, type ProjectRef, type WorktreeCatalogRefreshResult } from './worktreeManager';
import { resolveGitPrimaryRoot } from '@/lib/gitApi';

const normalizePath = (value: string): string => value.replace(/\\/g, '/').replace(/\/+$/, '') || '/';

type WorktreeTopologyCoordinatorDependencies = {
  isVSCode: () => boolean;
  getProjects: () => ProjectRef[];
  getCatalog: () => Map<string, Array<{ path: string; worktreeRoot?: string; relativePath?: string }>>;
  getActiveDirectories: () => string[];
  needsSessionSync?: (directory: string) => boolean;
  refresh: (project: ProjectRef, options: { isCurrent: () => boolean; refreshBatch: object }) => Promise<WorktreeCatalogRefreshResult>;
  resolveRepository?: (directory: string) => Promise<string>;
  syncAdded: (directories: string[]) => Promise<unknown>;
  subscribeProjects: (listener: () => void) => () => void;
  subscribeCatalog: (listener: () => void) => () => void;
  subscribeSessions: (listener: () => void) => () => void;
  subscribeEvents: (listener: (event: { type: string; projectDirectory?: string }) => void) => () => void;
  subscribeRuntime: (listener: (identityChanged: boolean) => void) => () => void;
  generation: () => number;
  setTimer: (handler: () => void, timeout?: number) => ReturnType<typeof setTimeout>;
  clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
};

export const createWorktreeTopologyCoordinator = (dependencies: WorktreeTopologyCoordinatorDependencies) => {
  let started = false;
  let readyEpoch = 0;
  let lifecycleEpoch = 0;
  let active = 0;
  let receivedReady = false;
  const activeProjects = new Set<string>();
  const queued = new Map<string, { project: ProjectRef; refreshBatch: object; version: number }>();
  const repositories = new Map<string, string>();
  const versions = new Map<string, number>();
  const timers = new Map<string, { timer: ReturnType<typeof setTimeout>; epoch: number }>();
  const syncTimers = new Set<ReturnType<typeof setTimeout>>();
  const suppressedUnknown = new Set<string>();
  const retries = new Map<string, number>();
  const pendingSessionSync = new Set<string>();
  const unknownCandidates = new Set<string>();
  const completedProjects = new Set<string>();
  let registrySignature = '';
  const cleanups: Array<() => void> = [];

  const schedule = (project: ProjectRef, delay = 150, reusePending = false, refreshBatch: object = {}) => {
    const key = normalizePath(project.path);
    if (reusePending && (activeProjects.has(key) || queued.has(key) || timers.has(key))) return;
    const version = (versions.get(key) ?? 0) + 1;
    versions.set(key, version);
    const existing = timers.get(key);
    if (existing) dependencies.clearTimer(existing.timer);
    const epoch = lifecycleEpoch;
    const timer = dependencies.setTimer(() => {
      if (!started || epoch !== lifecycleEpoch) return;
      timers.delete(key);
      queued.set(key, { project, refreshBatch, version });
      drain(epoch);
    }, delay);
    timers.set(key, { timer, epoch });
  };
  const drain = (expectedEpoch = lifecycleEpoch) => {
    if (!started || expectedEpoch !== lifecycleEpoch) return;
    while (active < 2 && queued.size > 0) {
      const next = [...queued.entries()].find(([key]) => !activeProjects.has(key));
      if (!next) break;
      const [key, { project, refreshBatch, version }] = next;
      queued.delete(key);
      active += 1;
      activeProjects.add(key);
      const generation = dependencies.generation();
      const epoch = lifecycleEpoch;
      const isCurrent = () => started && epoch === lifecycleEpoch && generation === dependencies.generation() && versions.get(key) === version;
      void dependencies.refresh(project, { isCurrent, refreshBatch }).then((result) => {
        if (!isCurrent()) return;
        if (result.repositoryDirectory) repositories.set(key, normalizePath(result.repositoryDirectory));
        completedProjects.add(key);
        for (const directory of result.addedDirectories) {
          const path = normalizePath(directory);
          if (!dependencies.needsSessionSync || dependencies.needsSessionSync(path)) pendingSessionSync.add(path);
        }
        if (dependencies.needsSessionSync) {
          for (const worktree of result.worktrees) {
            const directory = normalizePath(worktree.path);
            if (dependencies.needsSessionSync(directory)) pendingSessionSync.add(directory);
          }
        }
        flushPendingSessionSync(epoch, generation);
        suppressRecoveredUnknowns();
      }).then(() => {
        if (isCurrent()) retries.delete(key);
      }).catch(() => {
        if (!isCurrent()) return;
        const attempt = (retries.get(key) ?? 0) + 1;
        retries.set(key, attempt);
        if (started && epoch === lifecycleEpoch) schedule(project, [1_000, 2_000, 5_000, 15_000, 30_000][Math.min(attempt - 1, 4)]);
      }).finally(() => {
        if (epoch !== lifecycleEpoch) return;
        active -= 1;
        activeProjects.delete(key);
        drain(epoch);
      });
    }
  };
  const flushPendingSessionSync = (epoch: number, generation: number) => {
    if (pendingSessionSync.size === 0) return;
    const directories = [...pendingSessionSync];
    pendingSessionSync.clear();
    void dependencies.syncAdded(directories).catch(() => {
      if (started && epoch === lifecycleEpoch && generation === dependencies.generation()) {
        for (const directory of directories) pendingSessionSync.add(directory);
        const timer = dependencies.setTimer(() => {
          syncTimers.delete(timer);
          if (started && epoch === lifecycleEpoch) flushPendingSessionSync(epoch, generation);
        }, 1_000);
        syncTimers.add(timer);
      }
    });
  };
  const suppressRecoveredUnknowns = () => {
    if (completedProjects.size !== dependencies.getProjects().length) return;
    const catalog = dependencies.getCatalog();
    for (const signature of unknownCandidates) {
      const directory = signature.slice(signature.indexOf(':') + 1);
      const known = [...catalog.entries()].some(([root, worktrees]) => normalizePath(root) === directory || worktrees.some((worktree) => normalizePath(worktree.path) === directory));
      if (!known) suppressedUnknown.add(signature);
    }
  };
  const reconcileAll = () => {
    completedProjects.clear();
    const refreshBatch = {};
    for (const project of dependencies.getProjects()) schedule(project, 0, true, refreshBatch);
  };
  const recoverUnknownDirectories = () => {
    const catalog = dependencies.getCatalog();
    const projects = dependencies.getProjects();
    // Recovery candidates: live active session directories and session-index
    // snapshot directories (cachedDirectories). Membership is semantic — a new
    // Set/array with the same members must not force extra catalog refresh.
    const nextMembers = new Set<string>();
    for (const directory of dependencies.getActiveDirectories()) {
      if (!directory.trim()) continue;
      nextMembers.add(normalizePath(directory));
    }
    // Drop bookkeeping for directories that left the candidate set so a later
    // reappearance can recover again within the same ready epoch.
    for (const signature of [...unknownCandidates]) {
      const directory = signature.slice(signature.indexOf(':') + 1);
      if (!nextMembers.has(directory)) unknownCandidates.delete(signature);
    }
    for (const signature of [...suppressedUnknown]) {
      const directory = signature.slice(signature.indexOf(':') + 1);
      if (!nextMembers.has(directory)) suppressedUnknown.delete(signature);
    }
    for (const normalized of nextMembers) {
      const project = projects.find((candidate) => {
        const root = normalizePath(candidate.path);
        const known = catalog.get(root)?.some((worktree) => normalizePath(worktree.path) === normalized);
        return normalized === root || known;
      });
      if (!project) {
        const signature = `${readyEpoch}:${normalized}`;
        if (!suppressedUnknown.has(signature) && !unknownCandidates.has(signature)) {
          unknownCandidates.add(signature);
          reconcileAll();
        }
      }
    }
  };
  const advanceRecoveryEpoch = () => {
    lifecycleEpoch += 1;
    suppressedUnknown.clear();
    unknownCandidates.clear();
    retries.clear();
    pendingSessionSync.clear();
    completedProjects.clear();
    for (const entry of timers.values()) dependencies.clearTimer(entry.timer);
    timers.clear();
    for (const timer of syncTimers) dependencies.clearTimer(timer);
    syncTimers.clear();
    queued.clear();
    activeProjects.clear();
    active = 0;
    repositories.clear(); versions.clear();
  };
  const start = () => {
    if (started || dependencies.isVSCode()) return;
    started = true;
    receivedReady = false;
    cleanups.push(dependencies.subscribeEvents((event) => {
      if (event.type === 'event-stream-ready') {
        // Reuse pending startup enumeration, but repair completed projects too:
        // a late subscriber's first ready may already be a real reconnect.
        if (!receivedReady) { receivedReady = true; reconcileAll(); return; }
        readyEpoch += 1;
        advanceRecoveryEpoch();
        reconcileAll();
      }
      if (event.type === 'worktree-topology-changed' && event.projectDirectory) {
        const root = normalizePath(event.projectDirectory);
        const refreshBatch = {};
        const repository = repositories.get(root);
        const catalog = dependencies.getCatalog();
        for (const project of dependencies.getProjects()) {
          const directory = normalizePath(project.path);
          const sharesCheckout = catalog.get(directory)?.some((entry) =>
            normalizePath(entry.worktreeRoot ?? entry.path) === root
            || (entry.relativePath && directory === `${root}/${entry.relativePath}`));
          const related = repository && repositories.has(directory) ? repositories.get(directory) === repository : sharesCheckout;
          if (directory === root || related) schedule(project, 150, false, refreshBatch);
        }
        if (dependencies.resolveRepository) {
          const epoch = lifecycleEpoch;
          const generation = dependencies.generation();
          void (async () => {
            const resolved = repository ?? normalizePath(await dependencies.resolveRepository!(root));
            for (const project of dependencies.getProjects()) {
              const directory = normalizePath(project.path);
              if (repository && repositories.has(directory)) continue;
              try {
                const identity = repositories.get(directory) ?? normalizePath(await dependencies.resolveRepository!(directory));
                if (!started || epoch !== lifecycleEpoch || generation !== dependencies.generation()) return;
                repositories.set(directory, identity);
                if (identity === resolved) schedule(project, 150, false, refreshBatch);
              } catch {
                if (started && epoch === lifecycleEpoch && generation === dependencies.generation()) schedule(project);
              }
            }
          })().catch(() => {
            if (started && epoch === lifecycleEpoch && generation === dependencies.generation()) reconcileAll();
          });
        }
      }
    }));
    registrySignature = dependencies.getProjects().map((project) => `${project.id}\u0000${normalizePath(project.path)}`).sort().join('\n');
    cleanups.push(dependencies.subscribeProjects(() => {
      const next = dependencies.getProjects().map((project) => `${project.id}\u0000${normalizePath(project.path)}`).sort().join('\n');
      if (next !== registrySignature) { registrySignature = next; advanceRecoveryEpoch(); reconcileAll(); recoverUnknownDirectories(); }
    }));
    cleanups.push(dependencies.subscribeCatalog(recoverUnknownDirectories));
    cleanups.push(dependencies.subscribeSessions(recoverUnknownDirectories));
    cleanups.push(dependencies.subscribeRuntime((identityChanged) => {
      if (identityChanged) {
        receivedReady = false;
        readyEpoch += 1;
        advanceRecoveryEpoch();
        reconcileAll();
      }
    }));
    reconcileAll();
    recoverUnknownDirectories();
  };
  const stop = () => {
    started = false;
    advanceRecoveryEpoch();
    for (const { timer } of timers.values()) dependencies.clearTimer(timer);
    timers.clear(); queued.clear(); active = 0;
    while (cleanups.length) cleanups.pop()?.();
  };
  return { start, stop, reconcileAll };
};

let singleton: ReturnType<typeof createWorktreeTopologyCoordinator> | null = null;
let references = 0;

export const startWorktreeTopologySync = (): (() => void) => {
  if (!singleton) {
    singleton = createWorktreeTopologyCoordinator({
      isVSCode: isVSCodeRuntime,
      getProjects: () => useProjectsStore.getState().projects,
      getCatalog: () => useSessionUIStore.getState().availableWorktreesByProject,
      getActiveDirectories: () => {
        const state = useGlobalSessionsStore.getState();
        const directories: string[] = [];
        for (const session of state.activeSessions) {
          if (typeof session.directory === 'string') directories.push(session.directory);
        }
        for (const directory of state.cachedDirectories) directories.push(directory);
        return directories;
      },
      needsSessionSync: (directory) => {
        const state = useGlobalSessionsStore.getState();
        const path = normalizePath(directory);
        return !state.loadedDirectories.has(path) && !state.loadingDirectories.has(path)
          && !state.refreshingDirectories.has(path);
      },
      refresh: forceRefreshProjectWorktreeCatalog,
      resolveRepository: resolveGitPrimaryRoot,
      syncAdded: (directories) => syncGlobalSessionsForDirectories(directories, useGlobalSessionsStore.getState().activeSessions),
      subscribeProjects: (listener) => useProjectsStore.subscribe(listener),
      subscribeCatalog: (listener) => useSessionUIStore.subscribe((state, previous) => { if (state.availableWorktreesByProject !== previous.availableWorktreesByProject) listener(); }),
      subscribeSessions: (listener) => useGlobalSessionsStore.subscribe((state, previous) => {
        if (state.activeSessions === previous.activeSessions && state.cachedDirectories === previous.cachedDirectories) return;
        listener();
      }),
      subscribeEvents: subscribeYuriEvents,
      subscribeRuntime: (listener) => subscribeRuntimeEndpointChanged((detail) => listener(isRuntimeEndpointIdentityChange(detail))),
      generation: getRuntimeGeneration,
      setTimer: (handler, timeout) => globalThis.setTimeout(handler, timeout),
      clearTimer: (timer) => globalThis.clearTimeout(timer),
    });
  }
  references += 1;
  singleton.start();
  return () => {
    references = Math.max(0, references - 1);
    if (references === 0) singleton?.stop();
  };
};
