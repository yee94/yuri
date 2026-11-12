import React from 'react';
import { useEvent } from '@reactuses/core';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { toast } from '@/components/ui';
import { Icon } from "@/components/icon/Icon";
import { cn } from '@/lib/utils';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useDeviceInfo } from '@/lib/device';
import { isDesktopShell } from '@/lib/desktop';
import { useUIStore } from '@/stores/useUIStore';
import { useTerminalStore } from '@/stores/useTerminalStore';
import { useDesktopSshStore } from '@/stores/useDesktopSshStore';
import { openExternalUrl } from '@/lib/url';
import { useI18n } from '@/lib/i18n';
import {
  getProjectActionsState,
  type YuriProjectAction,
  type ProjectRef,
} from '@/lib/yuriConfig';
import {
  normalizeProjectActionDirectory,
  PROJECT_ACTIONS_UPDATED_EVENT,
  PROJECT_ACTION_ICON_MAP,
  resolveProjectActionDesktopForwardUrl,
  toProjectActionRunKey,
} from '@/lib/projectActions';
import { detectDevServerCommand, readPackageJsonScripts } from '@/lib/detectDevServer';
import { connectTerminalStream, createProjectTerminalAPI } from '@/lib/terminalApi';
import type { HostRuntimeEntry } from '@/lib/remote-projects/registry';
import { locationKey, normalizeLocationStateKey } from '@/lib/remote-projects/location';
import { captureProjectScope } from '@/lib/api/project-scope';
import { useRemoteProjectRuntime } from '@/queries/remoteProjectQueries';
import type { TerminalAPI } from '@/lib/api/types';

type UrlWatchEntry = {
  lastSeenChunkId: number | null;
  openedUrl: boolean;
  tail: string;
  openInPreview: boolean;
};

const sleep = (ms: number): Promise<void> => {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
};

interface ProjectActionsButtonProps {
  projectRef: ProjectRef | null;
  directory: string;
  className?: string;
  compact?: boolean;
  allowMobile?: boolean;
  scope?: HostRuntimeEntry;
}

const ANSI_ESCAPE_PREFIX = String.fromCharCode(27);
const ANSI_ESCAPE_PATTERN = new RegExp(`${ANSI_ESCAPE_PREFIX}\\[[0-9;?]*[ -/]*[@-~]`, 'g');
const URL_GLOBAL_PATTERN = /https?:\/\/[^\s<>'"`]+/gi;
const AUTO_DISCOVER_ACTION_ID = '__yuri_auto_discover_preview__';
const AUTO_DISCOVER_PREVIEW_WAIT_TIMEOUT_MS = 15_000;

const stripControlChars = (value: string): string => {
  let next = '';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const isControl = (code >= 0 && code <= 8)
      || code === 11
      || code === 12
      || (code >= 14 && code <= 31)
      || code === 127;
    if (!isControl) {
      next += value[index];
    }
  }
  return next;
};

const normalizeManualOpenUrl = (value: string | undefined): string | null => {
  const raw = (value || '').trim();
  if (!raw) {
    return null;
  }

  const candidate = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
};

const extractBestUrl = (value: string): string | null => {
  const cleaned = value.replace(ANSI_ESCAPE_PATTERN, '');
  const matches = cleaned.match(URL_GLOBAL_PATTERN);
  if (!matches || matches.length === 0) {
    return null;
  }

  const normalized = matches
    .map((entry) => entry.replace(/[),.;]+$/, ''))
    .filter(Boolean);

  if (normalized.length === 0) {
    return null;
  }

  const portCandidates: Array<{ raw: string; parsed: URL }> = [];
  for (const candidate of normalized) {
    try {
      const parsed = new URL(candidate);
      if (parsed.port && parsed.port.length > 0) {
        portCandidates.push({ raw: candidate, parsed });
      }
    } catch {
      // noop
    }
  }

  if (portCandidates.length > 0) {
    const scoreCandidate = (entry: { raw: string; parsed: URL }): number => {
      const { parsed } = entry;
      const host = parsed.hostname.toLowerCase();
      const isLocalHost = host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '::1';
      const normalizedPath = parsed.pathname || '/';
      const pathSegments = normalizedPath.split('/').filter(Boolean).length;
      const hasRootPath = normalizedPath === '/' || normalizedPath === '';
      const hasQueryOrHash = Boolean(parsed.search || parsed.hash);

      let score = 0;
      if (isLocalHost) score += 50;
      if (hasRootPath) score += 30;
      score -= Math.min(pathSegments * 5, 20);
      if (hasQueryOrHash) score -= 10;
      return score;
    };

    portCandidates.sort((a, b) => scoreCandidate(b) - scoreCandidate(a));
    return portCandidates[0]?.parsed.origin ?? portCandidates[0]?.raw ?? null;
  }

  return normalized[0] ?? null;
};

export const ProjectActionsButton = (props: ProjectActionsButtonProps) => {
  const remote = !!props.projectRef?.hostId;
  const { registry } = useRemoteProjectRuntime(remote && !props.scope);
  const hostId = props.projectRef?.hostId;
  const hostSubscription = React.useMemo(() => ({
    subscribe: (listener: () => void) => registry && hostId ? registry.subscribeHost(hostId, listener) : () => {},
    snapshot: () => registry && hostId ? registry.getHost(hostId) : undefined,
  }), [registry, hostId]);
  React.useSyncExternalStore(hostSubscription.subscribe, hostSubscription.snapshot, hostSubscription.snapshot);
  const directory = props.directory || props.projectRef?.path || '';
  const entry = props.scope ? (registry?.hubId === props.scope.location.hubId ? registry.resolve(props.scope.location) : props.scope) : (remote && registry && registry.hubId === props.projectRef?.hubId
    ? registry.resolve({ hubId: registry.hubId, hostId: props.projectRef.hostId, directory }) : undefined);
  const key = entry ? `${entry.key}:${entry.connectionGeneration}` : (remote ? JSON.stringify([props.projectRef?.hubId, props.projectRef?.hostId, directory]) : directory);
  return <ProjectActionsButtonContent key={key} {...props} scope={entry} />;
};

const ProjectActionsButtonContent = ({
  projectRef,
  directory,
  className,
  compact = false,
  allowMobile = false,
  scope,
}: ProjectActionsButtonProps) => {
  const { t } = useI18n();
  const { terminal: localTerminal, runtime } = useRuntimeAPIs();
  const scopedTerminal = React.useRef<ReturnType<typeof createProjectTerminalAPI> | null>(null);
  const activeScope = React.useRef(true);
  const assertScope = () => {
    if (!activeScope.current) throw new DOMException('Project action scope superseded', 'AbortError');
    if (projectRef?.hostId && (!scope || scope.location.hostId !== projectRef.hostId || scope.location.hubId !== projectRef.hubId)) {
      throw new Error(t('remoteProjects.host-unavailable'));
    }
    if (scope && scope.location.directory !== (directory || projectRef?.path || '')) throw new Error(t('remoteProjects.host-unavailable'));
    if (scope) captureProjectScope(scope).assertCurrent();
  };
  const getScopedTerminal = useEvent(() => {
    assertScope();
    if (!scope) throw new Error(t('remoteProjects.host-unavailable'));
    return scopedTerminal.current ??= createProjectTerminalAPI(scope);
  });
  const terminal = React.useMemo<Pick<TerminalAPI, 'createSession' | 'sendInput' | 'close' | 'forceKill'>>(() => scope || projectRef?.hostId ? {
    createSession: (options: { cwd: string }) => getScopedTerminal().createTerminalSession(options),
    sendInput: (id: string, data: string) => getScopedTerminal().sendTerminalInput(id, data),
    close: (id: string) => getScopedTerminal().closeTerminal(id),
  } : localTerminal, [scope, projectRef?.hostId, localTerminal, getScopedTerminal]);
  const { isMobile } = useDeviceInfo();
  const isDesktopShellApp = React.useMemo(() => isDesktopShell(), []);
  const desktopSshInstances = useDesktopSshStore((state) => state.instances);
  const loadDesktopSsh = useDesktopSshStore((state) => state.load);

  const setBottomTerminalOpen = useUIStore((state) => state.setBottomTerminalOpen);
  const setActiveMainTab = useUIStore((state) => state.setActiveMainTab);
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);
  const setSettingsDialogOpen = useUIStore((state) => state.setSettingsDialogOpen);
  const setSettingsProjectsSelectedId = useUIStore((state) => state.setSettingsProjectsSelectedId);
  const openContextPreview = useUIStore((state) => state.openContextPreview);

  const terminalSessions = useTerminalStore((state) => state.sessions);
  const ensureDirectory = useTerminalStore((state) => state.ensureDirectory);
  const setTabLabel = useTerminalStore((state) => state.setTabLabel);
  const setTabIconKey = useTerminalStore((state) => state.setTabIconKey);
  const setActiveTab = useTerminalStore((state) => state.setActiveTab);
  const setConnecting = useTerminalStore((state) => state.setConnecting);
  const setTabSessionId = useTerminalStore((state) => state.setTabSessionId);
  const setTabPreviewUrl = useTerminalStore((state) => state.setTabPreviewUrl);
  const projectActionRuns = useTerminalStore((state) => state.projectActionRuns);
  const setProjectActionRun = useTerminalStore((state) => state.setProjectActionRun);
  const updateProjectActionRunStatus = useTerminalStore((state) => state.updateProjectActionRunStatus);
  const removeProjectActionRun = useTerminalStore((state) => state.removeProjectActionRun);

  const [actions, setActions] = React.useState<YuriProjectAction[]>([]);
  const [selectedActionId, setSelectedActionId] = React.useState<string | null>(null);
  const [isLoading, setIsLoading] = React.useState(false);
  const tabByKeyRef = React.useRef<Record<string, string>>({});
  const urlWatchByRunKeyRef = React.useRef<Record<string, UrlWatchEntry>>({});
  const streamCleanupByRunKeyRef = React.useRef<Record<string, () => void>>({});
  const previewWaitTimeoutByRunKeyRef = React.useRef<Record<string, number>>({});
  const loadRequestIdRef = React.useRef(0);
  const pendingRunsRef = React.useRef(new Set<string>());

  const projectId = projectRef?.id ?? null;
  const projectPath = projectRef?.path ?? '';

  const stableProjectRef = React.useMemo(() => {
    if (!projectId) {
      return null;
    }
    return { id: projectId, path: projectPath, hostId: projectRef?.hostId, hubId: projectRef?.hubId };
  }, [projectId, projectPath, projectRef?.hostId, projectRef?.hubId]);

  React.useEffect(() => {
    activeScope.current = true;
    const cleanups = streamCleanupByRunKeyRef.current;
    const timers = previewWaitTimeoutByRunKeyRef.current;
    return () => {
      activeScope.current = false;
      loadRequestIdRef.current += 1;
      Object.values(cleanups).forEach((cleanup) => cleanup());
      Object.values(timers).forEach((timer) => window.clearTimeout(timer));
      scopedTerminal.current?.dispose();
      scopedTerminal.current = null;
    };
  }, [scope]);

  React.useEffect(() => {
    if (!isDesktopShellApp || scope || projectRef?.hostId) {
      return;
    }
    void loadDesktopSsh().catch(() => undefined);
  }, [isDesktopShellApp, loadDesktopSsh, scope, projectRef?.hostId]);

  const openExternal = useEvent(async (url: string) => {
    await openExternalUrl(url);
  });

  const loadActions = useEvent(async () => {
    if (!stableProjectRef) {
      return;
    }

    const requestId = loadRequestIdRef.current + 1;
    loadRequestIdRef.current = requestId;

    setIsLoading(true);
    try {
      assertScope();
      const state = await getProjectActionsState(stableProjectRef, scope);
      if (loadRequestIdRef.current !== requestId) {
        return;
      }
      const filtered = state.actions;
      setActions(filtered);
      setSelectedActionId((current) => {
        if (current === AUTO_DISCOVER_ACTION_ID) {
          return current;
        }
        if (current && filtered.some((entry) => entry.id === current)) {
          return current;
        }
        return null;
      });
    } catch {
      if (loadRequestIdRef.current !== requestId) {
        return;
      }
      // Keep last known actions while next project loads or transient fetch fails.
    } finally {
      if (loadRequestIdRef.current === requestId) {
        setIsLoading(false);
      }
    }
  });

  const rawDirectory = directory || stableProjectRef?.path || '';
  // This variable is a UI identity. Every API below uses rawDirectory instead.
  const normalizedDirectory = React.useMemo(() => {
    if (scope) return normalizeLocationStateKey(locationKey({ ...scope.location, directory: rawDirectory }));
    if (stableProjectRef?.hostId) return stableProjectRef.hubId ? normalizeLocationStateKey(locationKey({ hubId: stableProjectRef.hubId, hostId: stableProjectRef.hostId, directory: rawDirectory })) : '';
    return normalizeProjectActionDirectory(rawDirectory);
  }, [rawDirectory, stableProjectRef, scope]);

  const selectedAction = React.useMemo(() => {
    if (!selectedActionId) {
      return null;
    }
    return actions.find((entry) => entry.id === selectedActionId) ?? null;
  }, [actions, selectedActionId]);

  const autoDiscoverAction = React.useMemo<YuriProjectAction>(() => ({
    id: AUTO_DISCOVER_ACTION_ID,
    name: t('projectActions.actions.autoDiscover'),
    command: '',
    icon: 'search',
    autoOpenUrl: true,
  }), [t]);

  const canUseAutoDiscover = !isMobile;
  const displayActions = React.useMemo(
    () => canUseAutoDiscover ? [autoDiscoverAction, ...actions] : actions,
    [actions, autoDiscoverAction, canUseAutoDiscover]
  );

  React.useEffect(() => {
    void loadActions();
  }, [loadActions, stableProjectRef, scope]);

  React.useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string }>).detail;
      if (!projectId) {
        return;
      }
      if (detail?.projectId && detail.projectId !== projectId) {
        return;
      }
      void loadActions();
    };

    window.addEventListener(PROJECT_ACTIONS_UPDATED_EVENT, handler);
    return () => {
      window.removeEventListener(PROJECT_ACTIONS_UPDATED_EVENT, handler);
    };
  }, [loadActions, projectId]);

  React.useEffect(() => {
    if (!selectedActionId) {
      return;
    }
    if (selectedActionId === AUTO_DISCOVER_ACTION_ID && canUseAutoDiscover) {
      return;
    }
    if (!actions.some((entry) => entry.id === selectedActionId)) {
      setSelectedActionId(null);
    }
  }, [actions, canUseAutoDiscover, selectedActionId]);

  React.useEffect(() => {
    for (const [key, entry] of Object.entries(projectActionRuns)) {
      if (entry.directory !== normalizedDirectory) continue;
      const directoryState = terminalSessions.get(entry.directory);
      const tab = directoryState?.tabs.find((item) => item.id === entry.tabId);
      if (!tab || tab.terminalSessionId !== entry.sessionId) {
        removeProjectActionRun(key);
      }
    }
  }, [normalizedDirectory, projectActionRuns, removeProjectActionRun, terminalSessions]);

  React.useEffect(() => {
    for (const [runKey, entry] of Object.entries(projectActionRuns)) {
      if (entry.directory !== normalizedDirectory) continue;
      const watch = urlWatchByRunKeyRef.current[runKey] ?? { lastSeenChunkId: null, openedUrl: false, tail: '', openInPreview: false };
      urlWatchByRunKeyRef.current[runKey] = watch;
      const action = displayActions.find((item) => item.id === entry.actionId);
      if (!action) {
        continue;
      }

      const directoryState = terminalSessions.get(entry.directory);
      const tab = directoryState?.tabs.find((item) => item.id === entry.tabId);
      if (!tab || !Array.isArray(tab.bufferChunks) || tab.bufferChunks.length === 0) {
        continue;
      }

      const nextChunks = tab.bufferChunks.filter((chunk) => {
        if (watch.lastSeenChunkId === null) {
          return true;
        }
        return chunk.id > watch.lastSeenChunkId;
      });

      if (nextChunks.length === 0) {
        continue;
      }

      const combined = nextChunks.map((chunk) => chunk.data).join('');
      const textForScan = `${watch.tail}${combined}`;
      const maybeUrl = !watch.openedUrl && action.autoOpenUrl === true ? extractBestUrl(textForScan) : null;
      const lastChunkId = nextChunks[nextChunks.length - 1]?.id ?? watch.lastSeenChunkId;

      watch.lastSeenChunkId = lastChunkId;
      watch.tail = textForScan.slice(-512);

      if (maybeUrl) {
        watch.openedUrl = true;
        if (watch.openInPreview) {
          const run = projectActionRuns[runKey];
          if (run) {
            setTabPreviewUrl(run.directory, run.tabId, maybeUrl, { locked: false, autoOpened: false });
            if (run.status === 'waiting-for-preview') {
              updateProjectActionRunStatus(runKey, 'running');
            }
            window.clearTimeout(previewWaitTimeoutByRunKeyRef.current[runKey]);
            delete previewWaitTimeoutByRunKeyRef.current[runKey];
            openContextPreview(run.directory, maybeUrl);
          }
        } else if (scope || stableProjectRef?.hostId) {
          setTabPreviewUrl(entry.directory, entry.tabId, maybeUrl, { locked: false, autoOpened: true });
          openContextPreview(entry.directory, maybeUrl);
        } else {
          void openExternal(maybeUrl);
          toast.success(t('projectActions.toast.openedUrlFromOutput'));
        }
      }
      urlWatchByRunKeyRef.current[runKey] = watch;
    }

    for (const runKey of Object.keys(urlWatchByRunKeyRef.current)) {
      if (!projectActionRuns[runKey]) {
        delete urlWatchByRunKeyRef.current[runKey];
        window.clearTimeout(previewWaitTimeoutByRunKeyRef.current[runKey]);
        delete previewWaitTimeoutByRunKeyRef.current[runKey];
      }
    }

  }, [normalizedDirectory, scope, stableProjectRef?.hostId, displayActions, openContextPreview, openExternal, projectActionRuns, setTabPreviewUrl, t, terminalSessions, updateProjectActionRunStatus]);

  const getOrCreateActionTab = useEvent(async (action: YuriProjectAction, options: { revealTerminal?: boolean } = {}) => {
    if (!normalizedDirectory) {
      throw new Error(t('projectActions.error.noActiveDirectory'));
    }

    const key = toProjectActionRunKey(normalizedDirectory, action.id);
    ensureDirectory(normalizedDirectory);

    const currentStore = useTerminalStore.getState();
    const existingDirectoryState = currentStore.getDirectoryState(normalizedDirectory);

    let tabId = tabByKeyRef.current[key] || null;
    const hasTab = tabId
      ? Boolean(existingDirectoryState?.tabs.some((entry) => entry.id === tabId))
      : false;

    if (!tabId || !hasTab) {
      tabId = currentStore.createTab(normalizedDirectory);
      tabByKeyRef.current[key] = tabId;
    }

    setTabLabel(normalizedDirectory, tabId, `Action: ${action.name}`);
    setTabIconKey(normalizedDirectory, tabId, action.icon || 'play');
    if (options.revealTerminal !== false) {
      setActiveTab(normalizedDirectory, tabId);
      setBottomTerminalOpen(true);
      setActiveMainTab('terminal');
    }

    const stateAfterTab = useTerminalStore.getState().getDirectoryState(normalizedDirectory);
    const tab = stateAfterTab?.tabs.find((entry) => entry.id === tabId);
    return {
      key,
      tabId,
      sessionId: tab?.terminalSessionId ?? null,
    };
  });

  const runAction = useEvent(async (action: YuriProjectAction) => {
    if (runtime.isVSCode || (!allowMobile && isMobile)) {
      return;
    }

    if (!normalizedDirectory) {
      toast.error(t('projectActions.error.noActiveDirectoryForAction'));
      return;
    }

    const runKey = toProjectActionRunKey(normalizedDirectory, action.id);
    const existingRun = projectActionRuns[runKey];
    if (existingRun && existingRun.status === 'running') {
      return;
    }
    if (pendingRunsRef.current.has(runKey)) return;
    pendingRunsRef.current.add(runKey);

    try {
      assertScope();
      const discovered = action.id === AUTO_DISCOVER_ACTION_ID
        ? await (async (): Promise<YuriProjectAction> => {
          const [actionsState, scripts] = await Promise.all([
            getProjectActionsState({ ...stableProjectRef, id: stableProjectRef?.id ?? '', path: rawDirectory }, scope),
            readPackageJsonScripts(rawDirectory, scope),
          ]);
          const devServer = await detectDevServerCommand(rawDirectory, actionsState.actions, scripts, scope);
          if (!devServer) {
            throw new Error(t('contextPanel.preview.noDevServer'));
          }
          return {
            id: AUTO_DISCOVER_ACTION_ID,
            name: t('projectActions.actions.autoDiscover'),
            command: devServer.command,
            icon: 'search',
            autoOpenUrl: true,
            openUrl: devServer.previewUrlHint || '',
          };
        })()
        : action;

      const hasCustomOpenUrl = discovered.autoOpenUrl === true && (discovered.openUrl || '').trim().length > 0;
      assertScope();
      const { key, tabId, sessionId } = await getOrCreateActionTab(discovered, { revealTerminal: !hasCustomOpenUrl && action.id !== AUTO_DISCOVER_ACTION_ID });
      let activeSessionId = sessionId;
      let createdSession = false;

      if (!activeSessionId) {
        setConnecting(normalizedDirectory, tabId, true);
        try {
          const created = await terminal.createSession({ cwd: rawDirectory });
          assertScope();
          activeSessionId = created.sessionId;
          createdSession = true;
          setTabSessionId(normalizedDirectory, tabId, activeSessionId);
        } finally {
          setConnecting(normalizedDirectory, tabId, false);
        }
      }

      if (!activeSessionId) {
        throw new Error(t('projectActions.error.failedToCreateTerminalSession'));
      }

      if (createdSession) {
        await sleep(350);
      }
      assertScope();

      if (discovered.id === AUTO_DISCOVER_ACTION_ID) {
        streamCleanupByRunKeyRef.current[key]?.();
        setConnecting(normalizedDirectory, tabId, true);
        streamCleanupByRunKeyRef.current[key] = (scope ? getScopedTerminal().connectTerminalStream : connectTerminalStream)(
          activeSessionId,
          (event) => {
            if (!activeScope.current) return;
            try { assertScope(); } catch { return; }
            if (event.type === 'data' && typeof event.data === 'string' && event.data.length > 0) {
              useTerminalStore.getState().appendToBuffer(normalizedDirectory, tabId, event.data);
            }
            if (event.type === 'exit') {
              useTerminalStore.getState().setTabLifecycle(normalizedDirectory, tabId, 'exited');
              useTerminalStore.getState().setConnecting(normalizedDirectory, tabId, false);
              useTerminalStore.getState().removeProjectActionRun(key);
              delete urlWatchByRunKeyRef.current[key];
              streamCleanupByRunKeyRef.current[key]?.();
              delete streamCleanupByRunKeyRef.current[key];
              window.clearTimeout(previewWaitTimeoutByRunKeyRef.current[key]);
              delete previewWaitTimeoutByRunKeyRef.current[key];
            }
          },
          () => {
            if (!activeScope.current) return;
            useTerminalStore.getState().setConnecting(normalizedDirectory, tabId, false);
          },
          { maxRetries: 60, initialRetryDelay: 250, maxRetryDelay: 2000, connectionTimeout: 5000 },
        );
      }

      const hasDesktopForwardSelection = discovered.autoOpenUrl === true
        && !scope
        && isDesktopShellApp
        && (discovered.desktopOpenSshForward || '').trim().length > 0;
      const manualOpenUrl = discovered.autoOpenUrl ? normalizeManualOpenUrl(discovered.openUrl) : null;
      const desktopForwardUrl = discovered.autoOpenUrl && isDesktopShellApp && !scope
        ? resolveProjectActionDesktopForwardUrl(discovered.desktopOpenSshForward, desktopSshInstances)
        : null;

      setProjectActionRun({
        key,
        directory: normalizedDirectory,
        actionId: discovered.id,
        tabId,
        sessionId: activeSessionId,
        status: discovered.id === AUTO_DISCOVER_ACTION_ID && !manualOpenUrl ? 'waiting-for-preview' : 'running',
      });
      window.clearTimeout(previewWaitTimeoutByRunKeyRef.current[key]);
      delete previewWaitTimeoutByRunKeyRef.current[key];
      if (discovered.id === AUTO_DISCOVER_ACTION_ID && !manualOpenUrl) {
        previewWaitTimeoutByRunKeyRef.current[key] = window.setTimeout(() => {
          useTerminalStore.getState().updateProjectActionRunStatus(key, 'running');
          delete previewWaitTimeoutByRunKeyRef.current[key];
        }, AUTO_DISCOVER_PREVIEW_WAIT_TIMEOUT_MS);
      }

      if (desktopForwardUrl) {
        setTabPreviewUrl(normalizedDirectory, tabId, null, { locked: true });
        void openExternal(desktopForwardUrl);
        toast.success(t('projectActions.toast.openedForwardedUrl'));
      } else if (manualOpenUrl) {
        setTabPreviewUrl(normalizedDirectory, tabId, manualOpenUrl, { locked: true, autoOpened: true });
        openContextPreview(normalizedDirectory, manualOpenUrl);
        toast.success(t('projectActions.toast.openedActionUrl'));
      } else if (hasCustomOpenUrl) {
        setTabPreviewUrl(normalizedDirectory, tabId, null, { locked: true });
        toast.error(t('projectActions.error.invalidCustomUrlFormat'));
      } else if (hasDesktopForwardSelection) {
        setTabPreviewUrl(normalizedDirectory, tabId, null, { locked: true });
        toast.error(t('projectActions.error.selectedDesktopSshForwardUnavailable'));
      } else {
        setTabPreviewUrl(normalizedDirectory, tabId, null, { locked: false, autoOpened: false });
      }

      urlWatchByRunKeyRef.current[key] = {
        lastSeenChunkId: null,
        openedUrl: Boolean(desktopForwardUrl) || Boolean(manualOpenUrl) || hasCustomOpenUrl,
        tail: '',
        openInPreview: discovered.id === AUTO_DISCOVER_ACTION_ID,
      };

      const normalizedCommand = stripControlChars(discovered.command.trim().replace(/\r\n|\r/g, '\n'));
      assertScope();
      await terminal.sendInput(activeSessionId, `${normalizedCommand}\r`);
    } catch (error) {
      removeProjectActionRun(runKey);
      delete urlWatchByRunKeyRef.current[runKey];
      streamCleanupByRunKeyRef.current[runKey]?.();
      delete streamCleanupByRunKeyRef.current[runKey];
      window.clearTimeout(previewWaitTimeoutByRunKeyRef.current[runKey]);
      delete previewWaitTimeoutByRunKeyRef.current[runKey];
      toast.error(error instanceof Error ? error.message : t('projectActions.error.failedToRunAction'));
    } finally {
      pendingRunsRef.current.delete(runKey);
    }
  });

  const stopAction = useEvent(async (action: YuriProjectAction) => {
    const runKey = toProjectActionRunKey(normalizedDirectory, action.id);
    const activeRun = projectActionRuns[runKey];
    if (!activeRun) {
      return;
    }

    updateProjectActionRunStatus(runKey, 'stopping');

    try {
      await terminal.sendInput(activeRun.sessionId, '\x03');
    } catch (error) {
      if (scope || stableProjectRef?.hostId) {
        updateProjectActionRunStatus(runKey, 'running');
        toast.error(error instanceof Error ? error.message : t('projectActions.error.failedToRunAction'));
        return;
      }
      // noop
    }

    await new Promise((resolve) => {
      window.setTimeout(resolve, 1000);
    });

    const afterTab = useTerminalStore.getState().getDirectoryState(activeRun.directory)?.tabs
      .find((entry) => entry.id === activeRun.tabId);

    const sessionStillSame = afterTab?.terminalSessionId === activeRun.sessionId;

    if (sessionStillSame) {
      if (scope || stableProjectRef?.hostId) {
        try {
          assertScope();
          await terminal.close(activeRun.sessionId);
        } catch (error) {
          updateProjectActionRunStatus(runKey, 'running');
          toast.error(error instanceof Error ? error.message : t('projectActions.error.failedToRunAction'));
          return;
        }
        setTabSessionId(activeRun.directory, activeRun.tabId, null);
      } else {
        if (typeof terminal.forceKill === 'function') {
          try {
            await terminal.forceKill({ sessionId: activeRun.sessionId });
          } catch {
            // noop
          }
        } else {
          try {
            await terminal.close(activeRun.sessionId);
          } catch {
            // noop
          }
        }
        setTabSessionId(activeRun.directory, activeRun.tabId, null);
      }
    }

    removeProjectActionRun(runKey);
    delete urlWatchByRunKeyRef.current[runKey];
    streamCleanupByRunKeyRef.current[runKey]?.();
    delete streamCleanupByRunKeyRef.current[runKey];
    window.clearTimeout(previewWaitTimeoutByRunKeyRef.current[runKey]);
    delete previewWaitTimeoutByRunKeyRef.current[runKey];
  });

  const handlePrimaryClick = useEvent(() => {
    const action = selectedAction ?? displayActions[0];
    if (!action) {
      return;
    }
    const runKey = toProjectActionRunKey(normalizedDirectory, action.id);
    const runningEntry = projectActionRuns[runKey];
    if (runningEntry?.status === 'stopping') {
      return;
    }
    if (runningEntry) {
      void stopAction(action);
      return;
    }
    void runAction(action);
  });

  const handleSelectAction = useEvent((action: YuriProjectAction, toggleStopIfRunning = false) => {
    setSelectedActionId(action.id);

    if (!toggleStopIfRunning) {
      void runAction(action);
      return;
    }

    const runKey = toProjectActionRunKey(normalizedDirectory, action.id);
    const runningEntry = projectActionRuns[runKey];
    if (runningEntry?.status === 'stopping') {
      return;
    }
    if (runningEntry) {
      void stopAction(action);
      return;
    }
    void runAction(action);
  });

  const openProjectActionsSettings = useEvent(() => {
    if (!stableProjectRef?.id) {
      return;
    }
    if (scope || stableProjectRef.hostId) {
      toast.info(t('remoteProjects.configurationReadOnly'));
      setSettingsPage('remoteInstances');
      setSettingsDialogOpen(true);
      return;
    }
    setSettingsProjectsSelectedId(stableProjectRef.id);
    setSettingsPage('projects');
    setSettingsDialogOpen(true);
  });

  if (runtime.isVSCode || (!allowMobile && isMobile) || !stableProjectRef || !normalizedDirectory) {
    return null;
  }

  const resolvedSelected = selectedAction ?? displayActions[0] ?? null;
  if (!resolvedSelected) {
    return null;
  }

  const selectedIconKey = (resolvedSelected.icon || 'play') as keyof typeof PROJECT_ACTION_ICON_MAP;
  const selectedIconName = resolvedSelected.id === AUTO_DISCOVER_ACTION_ID
    ? 'search'
    : PROJECT_ACTION_ICON_MAP[selectedIconKey] || 'play';
  const selectedRunKey = toProjectActionRunKey(normalizedDirectory, resolvedSelected.id);
  const selectedRunning = projectActionRuns[selectedRunKey];
  const isStoppingSelected = selectedRunning?.status === 'stopping';
  const isWaitingForSelectedPreview = selectedRunning?.status === 'waiting-for-preview';
  const selectedRunPreviewUrl = selectedRunning
    ? terminalSessions.get(selectedRunning.directory)?.tabs.find((tab) => tab.id === selectedRunning.tabId)?.previewUrl ?? null
    : null;
  const showSelectedPreviewButton = Boolean(selectedRunning && selectedRunPreviewUrl);
  const handleOpenSelectedPreview = () => {
    if (!selectedRunning || !selectedRunPreviewUrl) {
      return;
    }
    openContextPreview(selectedRunning.directory, selectedRunPreviewUrl);
  };

  if (compact) {
    return (
      <div className="inline-flex items-center">
        <button
          type="button"
          disabled={isLoading || isStoppingSelected}
          className={cn(
            'app-region-no-drag inline-flex h-9 w-9 items-center justify-center rounded-[10px] [corner-shape:squircle] supports-[corner-shape:squircle]:rounded-[50px] p-2',
            'typography-ui-label font-medium text-muted-foreground hover:bg-interactive-hover hover:text-foreground transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
            'disabled:cursor-not-allowed',
            className
          )}
          onClick={handlePrimaryClick}
          aria-label={selectedRunning
            ? t('projectActions.actions.stopNamedAria', { name: resolvedSelected.name })
            : t('projectActions.actions.runNamedAria', { name: resolvedSelected.name })}
        >
          {isStoppingSelected || isWaitingForSelectedPreview
            ? <Icon name="loader-4" className="h-5 w-5 animate-spin text-[var(--status-warning)]" />
            : selectedRunning
              ? <Icon name="stop" className="h-5 w-5 text-[var(--status-warning)]" />
              : <Icon name={selectedIconName} className="h-5 w-5" />}
        </button>
        {showSelectedPreviewButton ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="app-region-no-drag -ml-1 inline-flex h-9 w-7 items-center justify-center rounded-[10px] text-muted-foreground hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                aria-label={t('projectActions.actions.openPreview')}
                onClick={handleOpenSelectedPreview}
              >
                <Icon name="global" className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent sideOffset={6}>{t('projectActions.actions.openPreview')}</TooltipContent>
          </Tooltip>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="app-region-no-drag -ml-1 inline-flex h-9 w-5 items-center justify-center rounded-[10px] text-muted-foreground hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              aria-label={t('projectActions.actions.chooseActionAria')}
            >
              <Icon name="arrow-down-s" className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52 max-h-[70vh] overflow-y-auto">
            <DropdownMenuItem className="flex items-center gap-2" onClick={openProjectActionsSettings}>
              <Icon name="add" className="h-4 w-4" />
              <span className="typography-ui-label text-foreground">{t('projectActions.actions.addNewAction')}</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {displayActions.map((entry) => {
              const iconKey = (entry.icon || 'play') as keyof typeof PROJECT_ACTION_ICON_MAP;
              const iconName = entry.id === AUTO_DISCOVER_ACTION_ID
                ? 'search'
                : PROJECT_ACTION_ICON_MAP[iconKey] || 'play';
              const runKey = toProjectActionRunKey(normalizedDirectory, entry.id);
              const runState = projectActionRuns[runKey];
              const isRunning = Boolean(runState);
              const isStopping = runState?.status === 'stopping';

              return (
                <DropdownMenuItem
                  key={entry.id}
                  className="flex items-center gap-2"
                  onClick={() => {
                    handleSelectAction(entry, true);
                  }}
                >
                  <Icon name={iconName} className="h-4 w-4" />
                  <span className="typography-ui-label text-foreground truncate">{entry.name}</span>
                  {isStopping || runState?.status === 'waiting-for-preview'
                    ? <Icon name="loader-4" className="ml-auto h-4 w-4 animate-spin text-[var(--status-warning)]" />
                    : isRunning
                      ? <Icon name="stop" className="ml-auto h-4 w-4 text-[var(--status-warning)]" />
                      : null}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'app-region-no-drag inline-flex shrink-0 items-center self-center rounded-[9px] [corner-shape:squircle] supports-[corner-shape:squircle]:rounded-[50px]',
        'bg-[var(--surface-elevated)] overflow-hidden',
        'border border-border/60',
        compact ? 'h-9' : 'h-7',
        className
      )}
    >
      <button
        type="button"
        onClick={handlePrimaryClick}
        disabled={isLoading || isStoppingSelected}
        className={cn(
          'inline-flex h-full items-center justify-center typography-ui-label font-medium text-foreground hover:bg-interactive-hover',
          compact ? 'w-9 px-0' : 'px-2.5',
          'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed'
        )}
        aria-label={selectedRunning
          ? t('projectActions.actions.stopNamedAria', { name: resolvedSelected.name })
          : t('projectActions.actions.runNamedAria', { name: resolvedSelected.name })}
      >
        <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center">
          {isStoppingSelected || isWaitingForSelectedPreview
            ? <Icon name="loader-4" className="h-4 w-4 animate-spin text-[var(--status-warning)]" />
            : selectedRunning
              ? <Icon name="stop" className="h-4 w-4 text-[var(--status-warning)]" />
              : <Icon name={selectedIconName} className="h-4 w-4" />}
        </span>
      </button>

      {showSelectedPreviewButton ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={handleOpenSelectedPreview}
              className={cn(
                compact ? 'inline-flex h-full w-8 items-center justify-center' : 'inline-flex h-full w-7 items-center justify-center',
                'border-l border-[var(--interactive-border)] text-foreground',
                'hover:bg-interactive-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary'
              )}
              aria-label={t('projectActions.actions.openPreview')}
            >
              <Icon name="global" className="h-4 w-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent sideOffset={6}>{t('projectActions.actions.openPreview')}</TooltipContent>
        </Tooltip>
      ) : null}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn(
              compact ? 'inline-flex h-full w-8 items-center justify-center' : 'inline-flex h-full w-7 items-center justify-center',
              'border-l border-[var(--interactive-border)] text-muted-foreground',
              'hover:bg-interactive-hover hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary'
            )}
            aria-label={t('projectActions.actions.chooseActionAria')}
          >
            <Icon name="arrow-down-s" className="h-4 w-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-52 max-h-[70vh] overflow-y-auto">
          <DropdownMenuItem className="flex items-center gap-2" onClick={openProjectActionsSettings}>
            <Icon name="add" className="h-4 w-4" />
            <span className="typography-ui-label text-foreground">{t('projectActions.actions.addNewAction')}</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {displayActions.map((entry) => {
            const iconKey = (entry.icon || 'play') as keyof typeof PROJECT_ACTION_ICON_MAP;
            const iconName = entry.id === AUTO_DISCOVER_ACTION_ID
              ? 'search'
              : PROJECT_ACTION_ICON_MAP[iconKey] || 'play';
            const runKey = toProjectActionRunKey(normalizedDirectory, entry.id);
            const runState = projectActionRuns[runKey];
            const isRunning = Boolean(runState);
            const isStopping = runState?.status === 'stopping';

            return (
              <DropdownMenuItem
                key={entry.id}
                className="flex items-center gap-2"
                onClick={() => {
                  handleSelectAction(entry, true);
                }}
              >
                <Icon name={iconName} className="h-4 w-4" />
                <span className="typography-ui-label text-foreground truncate">{entry.name}</span>
                {isStopping || runState?.status === 'waiting-for-preview'
                  ? <Icon name="loader-4" className="ml-auto h-4 w-4 animate-spin text-[var(--status-warning)]" />
                  : isRunning
                    ? <Icon name="stop" className="ml-auto h-4 w-4 text-[var(--status-warning)]" />
                    : null}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
};
