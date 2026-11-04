import React from 'react';
import { GuiPluginCommands } from '@/components/gui-plugins/GuiPluginCommands';
import { useEvent, useEventListener } from '@reactuses/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useGlobalSessionsStore, resolveGlobalSessionDirectory } from '@/stores/useGlobalSessionsStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useDeviceInfo } from '@/lib/device';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { getContextFileOpenFailureMessage, validateContextFileOpen } from '@/lib/contextFileOpenGuard';
import { toast } from '@/components/ui';
import type { Session } from '@/lib/opencode/v2-types';
import { createWorktreeSession } from '@/lib/worktreeSessionCreator';
import { formatShortcutForDisplay, getEffectiveShortcutCombo } from '@/lib/shortcuts';
import { canUseElectronDesktopIPC, invokeDesktop, isDesktopShell, isVSCodeRuntime, isWebRuntime } from '@/lib/desktop';
import { SETTINGS_PAGE_METADATA, type SettingsRuntimeContext } from '@/lib/settings/metadata';
import { scoreByFuzzyQuery } from '@/lib/search/fuzzySearch';
import { isMacOS, truncatePathMiddle } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { sessionEvents } from '@/lib/sessionEvents';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { commandPaletteFileSearchQueryOptions, scoreCommandPaletteFiles } from './commandPaletteFilesState';
import { openAndCreateTerminalTab } from '@/lib/terminalTabShortcuts';
import { Kbd } from '@/components/ui/kbd';
import './command-palette.css';
import { useMobileAppActions } from '@/apps/mobileAppContext';
import { useMobileNavigationStore } from '@/mobile/useMobileNavigationStore';
import { resolveProjectForSessionDirectory } from '@/lib/projectResolution';
import { sessionTitleSearchQueryOptions } from '@/queries/sessionTitleSearchQueries';
import { sessionContentSearchQueryOptions, type SessionContentSearchHit } from '@/queries/sessionContentSearchQueries';
import { focusChatMessage } from '@/components/chat/hooks/useChatTurnNavigation';
import { getRuntimeGeneration, getRuntimeTransportIdentity, getRuntimeKey } from '@/lib/runtime-switch';
import { useSetupTourStore } from '@/stores/useSetupTourStore';
import { consumeMatchingPress, markMatchingPress } from './matchingPress';
import { MobileDetailNavigation } from '@/mobile/MobileDetailNavigation';

type CommandEntry = {
  id: string;
  title: string;
  shortcutId?: string;
  searchText: string;
  onSelect: () => void;
};

type CommandPaletteResultProps = {
  title: React.ReactNode;
  description?: React.ReactNode;
  trailing?: React.ReactNode;
};

const CommandPaletteResult: React.FC<CommandPaletteResultProps> = ({ title, description, trailing }) => (
  <>
    <div className="flex min-w-0 flex-1 items-baseline gap-4">
      <span
        className={
          description
            ? 'yuri-global-search-result-title min-w-0 max-w-[62%] shrink-0 truncate text-foreground'
            : 'yuri-global-search-result-title min-w-0 flex-1 truncate text-foreground'
        }
      >
        {title}
      </span>
      {description ? (
        <span className="yuri-global-search-result-detail min-w-0 flex-1 truncate text-muted-foreground/65">
          {description}
        </span>
      ) : null}
    </div>
    {trailing ? (
      <div className="ml-auto flex shrink-0 items-center pl-2 text-muted-foreground/50">
        {trailing}
      </div>
    ) : null}
  </>
);

const ITEM_CLASS = 'yuri-global-search-compact';

const groupHeading = (title: string, count: number) => (
  <span className="flex items-baseline gap-2">
    <span>{title}</span>
    <span className="yuri-global-search-group-count">{count}</span>
  </span>
);

const SEARCH_MARK_CLASS = 'rounded-[3px] bg-[color-mix(in_srgb,var(--primary-base)_28%,transparent)] font-[inherit] text-foreground';

/** Cherry-style mark: every whitespace term, case-insensitive, on the text that is actually shown. */
function highlightSearchText(text: string, query: string): React.ReactNode {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length || !text) return text;
  const escaped = terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(`(${escaped.join('|')})`, 'gi');
  return text.split(pattern).map((part, index) => (
    terms.includes(part.toLowerCase())
      ? <mark key={index} className={SEARCH_MARK_CLASS}>{part}</mark>
      : <span key={index}>{part}</span>
  ));
}

const normalizePath = (value: string): string => {
  if (!value) return '';
  const raw = value.replace(/\\/g, '/');
  const hadUncPrefix = raw.startsWith('//');
  let normalized = raw.replace(/\/+/g, '/');
  if (hadUncPrefix && !normalized.startsWith('//')) normalized = `/${normalized}`;
  const isUnixRoot = normalized === '/';
  const isWindowsDriveRoot = /^[A-Za-z]:\/$/.test(normalized);
  if (!isUnixRoot && !isWindowsDriveRoot) normalized = normalized.replace(/\/+$/, '');
  return normalized;
};

const EMPTY_ACTIVE_SESSIONS: Session[] = [];

export const CommandPalette = React.memo(function CommandPalette({ presentation = 'dialog', onBack }: { presentation?: 'dialog' | 'page'; onBack?: () => void }) {
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const conversationTimeFormatter = new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' });
  const mobileActions = useMobileAppActions();

  const isCommandPaletteOpen = useUIStore((s) => s.isCommandPaletteOpen);
  const [retainResults, setRetainResults] = React.useState(isCommandPaletteOpen);
  const setCommandPaletteOpen = useUIStore((s) => s.setCommandPaletteOpen);
  const setActiveMainTab = useUIStore((s) => s.setActiveMainTab);
  const setSettingsDialogOpen = useUIStore((s) => s.setSettingsDialogOpen);
  const setSettingsPage = useUIStore((s) => s.setSettingsPage);
  const setSessionSwitcherOpen = useUIStore((s) => s.setSessionSwitcherOpen);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const toggleContextPanel = useUIStore((s) => s.toggleContextPanel);
  const toggleBottomTerminal = useUIStore((s) => s.toggleBottomTerminal);
  const openContextOverview = useUIStore((s) => s.openContextOverview);
  const openContextFile = useUIStore((s) => s.openContextFile);
  const shortcutOverrides = useUIStore((s) => s.shortcutOverrides);

  const openNewSessionDraft = useSessionUIStore((s) => s.openNewSessionDraft);
  const setCurrentSession = useSessionUIStore((s) => s.setCurrentSession);

  const observeResults = isCommandPaletteOpen || retainResults;
  const currentSessionId = useSessionUIStore((s) => observeResults ? s.currentSessionId : null);
  const currentSessionDirectory = useSessionUIStore((s) => observeResults ? s.currentSessionDirectory : null);
  const activeSessions = useGlobalSessionsStore((s) => observeResults ? s.activeSessions : EMPTY_ACTIVE_SESSIONS);
  const sessionsStatus = useGlobalSessionsStore((s) => observeResults ? s.status : 'idle');
  const currentDirectory = useDirectoryStore((s) => s.currentDirectory);
  const activeProject = useProjectsStore((s) => s.getActiveProject());
  const projects = useProjectsStore((s) => s.projects);
  const effectiveDirectory = useEffectiveDirectory();
  const { files: filesApi } = useRuntimeAPIs();
  const { isMobile: deviceIsMobile } = useDeviceInfo();
  const isMobile = presentation === 'page' || deviceIsMobile;
  const mac = isMacOS();
  const popupRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const updateViewport = useEvent(() => {
    if (!isMobile || !isCommandPaletteOpen || !popupRef.current) return;
    const viewport = window.visualViewport;
    popupRef.current.style.setProperty('--search-viewport-height', `${viewport?.height ?? window.innerHeight}px`);
    popupRef.current.style.setProperty('--search-viewport-top', `${viewport?.offsetTop ?? 0}px`);
  });
  useEventListener('resize', updateViewport, () => isMobile && isCommandPaletteOpen ? window.visualViewport ?? window : null);
  useEventListener('scroll', updateViewport, () => isMobile && isCommandPaletteOpen ? window.visualViewport : null);
  React.useEffect(() => { updateViewport(); }, [isMobile, isCommandPaletteOpen]);
  React.useEffect(() => {
    if (presentation === 'page' && isCommandPaletteOpen) inputRef.current?.focus({ preventScroll: true });
  }, [presentation, isCommandPaletteOpen]);

  const [query, setQuery] = React.useState('');
  const [expandedSearchGroups, setExpandedSearchGroups] = React.useState<{ query: string; groups: string[] }>({ query: '', groups: [] });
  const debouncedQuery = useDebouncedValue(query, 200);
  const trimmedQuery = debouncedQuery.trim();
  const liveTrimmed = query.trim();

  // Clear query on open (not close) so content stays visible through the
  // close animation instead of emptying mid-flight.
  React.useEffect(() => {
    if (isCommandPaletteOpen) {
      setQuery('');
      setExpandedSearchGroups({ query: '', groups: [] });
      setRetainResults(true);
    }
  }, [isCommandPaletteOpen]);

  const close = useEvent(() => setCommandPaletteOpen(false));
  const run = useEvent(
    (fn: () => void | Promise<void>) => () => {
      close();
      void fn();
    },
  );

  // ---------------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------------
  const commands = React.useMemo<CommandEntry[]>(() => {
    const list: CommandEntry[] = [
      {
        id: 'new-session',
        title: t('commandPalette.item.newSession'),
        shortcutId: 'new_chat',
        searchText: t('commandPalette.item.newSession'),
        onSelect: run(() => {
          setActiveMainTab('chat');
          setSessionSwitcherOpen(false);
          openNewSessionDraft();
        }),
      },
      {
        id: 'new-worktree',
        title: t('commandPalette.item.newWorktreeDraft'),
        shortcutId: 'new_chat_worktree',
        searchText: t('commandPalette.item.newWorktreeDraft'),
        onSelect: run(() => {
          void createWorktreeSession();
        }),
      },
      {
        id: 'add-project',
        title: t('commandPalette.item.addProject'),
        searchText: t('commandPalette.item.addProject'),
        onSelect: run(() => {
          sessionEvents.requestDirectoryDialog();
        }),
      },
      {
        id: 'toggle-sidebar',
        title: isMobile
          ? t('commandPalette.item.showSessionSwitcher')
          : t('commandPalette.item.toggleSidebar'),
        shortcutId: 'toggle_sidebar',
        searchText: isMobile
          ? t('commandPalette.item.showSessionSwitcher')
          : t('commandPalette.item.toggleSidebar'),
        onSelect: run(() => {
          if (isMobile) {
            const { isSessionSwitcherOpen } = useUIStore.getState();
            setSessionSwitcherOpen(!isSessionSwitcherOpen);
          } else {
            toggleSidebar();
          }
        }),
      },
      {
        id: 'toggle-right-sidebar',
        title: t('commandPalette.item.toggleRightSidebar'),
        shortcutId: 'toggle_right_sidebar',
        searchText: t('commandPalette.item.toggleRightSidebar'),
        onSelect: run(() => { if (effectiveDirectory) toggleContextPanel(effectiveDirectory); }),
      },
      {
        id: 'toggle-terminal',
        title: t('commandPalette.item.toggleTerminal'),
        shortcutId: 'toggle_terminal',
        searchText: t('commandPalette.item.toggleTerminal'),
        onSelect: run(() => toggleBottomTerminal()),
      },
      {
        id: 'new-terminal-tab',
        title: t('commandPalette.item.newTerminalTab'),
        shortcutId: 'open_new_terminal',
        searchText: t('commandPalette.item.newTerminalTab'),
        onSelect: run(() => {
          if (!effectiveDirectory) {
            return;
          }
          openAndCreateTerminalTab(effectiveDirectory);
        }),
      },
      {
        id: 'context-usage',
        title: t('commandPalette.item.showContextUsage'),
        searchText: t('commandPalette.item.showContextUsage'),
        onSelect: run(() => {
          if (currentDirectory) openContextOverview(currentDirectory);
        }),
      },
      {
        id: 'open-settings',
        title: t('commandPalette.item.openSettings'),
        shortcutId: 'open_settings',
        searchText: t('commandPalette.item.openSettings'),
        onSelect: run(() => setSettingsDialogOpen(true)),
      },
    ];
    if (!isVSCodeRuntime()) {
      list.push({
        id: 'setup-tour',
        title: t('tour.open'),
        searchText: t('tour.open'),
        onSelect: run(() => {
          setSettingsDialogOpen(false);
          useSetupTourStore.getState().open(getRuntimeKey());
        }),
      });
    }
    if (canUseElectronDesktopIPC()) {
      list.splice(1, 0, {
        id: 'new-mini-chat',
        title: t('commandPalette.item.newMiniChat'),
        shortcutId: 'new_mini_chat',
        searchText: t('commandPalette.item.newMiniChat'),
        onSelect: run(() => {
          void invokeDesktop('desktop_open_draft_mini_chat_window', {
            directory: normalizePath(currentDirectory || activeProject?.path || ''),
            projectId: activeProject?.id ?? null,
          }).catch((error) => {
            console.warn('[command-palette] failed to open draft mini chat window', error);
          });
        }),
      });
    }

    return list;
  }, [
    t,
    run,
    isMobile,
    setActiveMainTab,
    setSessionSwitcherOpen,
    openNewSessionDraft,
    toggleSidebar,
    toggleContextPanel,
    toggleBottomTerminal,
    currentDirectory,
    effectiveDirectory,
    openContextOverview,
    setSettingsDialogOpen,
    activeProject?.id,
    activeProject?.path,
  ]);

  // ---------------------------------------------------------------------------
  // Settings sub-pages (only show when there's a query)
  // ---------------------------------------------------------------------------
  const settingsRuntimeCtx = React.useMemo<SettingsRuntimeContext>(() => {
    const isDesktop = isDesktopShell();
    return { isVSCode: isVSCodeRuntime(), isWeb: !isDesktop && isWebRuntime(), isDesktop, isMobile };
  }, [isMobile]);

  const settingsEntries = React.useMemo<CommandEntry[]>(() => {
    return SETTINGS_PAGE_METADATA
      .filter((p) => p.slug !== 'home')
      .filter((p) => (p.isAvailable ? p.isAvailable(settingsRuntimeCtx) : true))
      .map((page) => {
        const keywords = (page.keywords ?? []).join(' ');
        return {
          id: `settings:${page.slug}`,
          title: page.title,
          searchText: `${page.title} ${page.group} ${keywords}`,
          onSelect: run(() => {
            setSettingsPage(page.slug);
            setSettingsDialogOpen(true);
          }),
        } satisfies CommandEntry;
      });
  }, [settingsRuntimeCtx, run, setSettingsPage, setSettingsDialogOpen]);

  // ---------------------------------------------------------------------------
  // Sessions
  // ---------------------------------------------------------------------------
  const sortedActiveSessions = React.useMemo(() => {
    const getUpdated = (s: Session) =>
      (typeof s.time?.updated === 'number' ? s.time.updated : 0) ||
      (typeof s.time?.created === 'number' ? s.time.created : 0);
    return [...activeSessions].sort((a, b) => getUpdated(b) - getUpdated(a));
  }, [activeSessions]);

  const worktreeMetadata = useSessionUIStore((s) => s.worktreeMetadata);
  const availableWorktreesByProject = useSessionUIStore((s) => s.availableWorktreesByProject);

  // ---------------------------------------------------------------------------
  // File search
  // ---------------------------------------------------------------------------
  const fileSearchDirectory = React.useMemo(
    () => currentSessionId && currentSessionDirectory
      && resolveProjectForSessionDirectory(projects, availableWorktreesByProject, currentSessionDirectory)
      ? normalizePath(currentSessionDirectory) : null,
    [currentSessionId, currentSessionDirectory, projects, availableWorktreesByProject],
  );
  const transport = getRuntimeTransportIdentity();
  const generation = getRuntimeGeneration();
  const contentScope = React.useMemo(() => ({ transport, generation, directory: '' }), [transport, generation]);
  const fileSearchOptions = React.useMemo(
    () => commandPaletteFileSearchQueryOptions(filesApi, fileSearchDirectory, trimmedQuery, contentScope),
    [filesApi, fileSearchDirectory, trimmedQuery, contentScope],
  );

  // ---------------------------------------------------------------------------
  // Filter visible items
  // ---------------------------------------------------------------------------
  const hasQuery = liveTrimmed.length > 0;

  const scoredCommands = React.useMemo(() => {
    if (!hasQuery) return commands.map((item) => ({ item, score: 0 }));
    return scoreByFuzzyQuery(commands, liveTrimmed, (c) => c.searchText, {
      limit: 7,
      noFuzzy: true,
    });
  }, [commands, liveTrimmed, hasQuery]);

  const scoredSettings = React.useMemo(() => {
    if (!hasQuery) return [];
    return scoreByFuzzyQuery(settingsEntries, liveTrimmed, (c) => c.searchText, {
      limit: 7,
      noFuzzy: true,
    });
  }, [settingsEntries, liveTrimmed, hasQuery]);

  const searchEnabled = isCommandPaletteOpen && liveTrimmed === trimmedQuery;
  const titleSearchOptions = React.useMemo(() => sessionTitleSearchQueryOptions(trimmedQuery, { transport }), [trimmedQuery, transport]);
  const titleSearchQuery = useQuery({
    ...titleSearchOptions,
    enabled: searchEnabled && (trimmedQuery.length > 0 || presentation === 'page'),
  });
  const navigationKey = JSON.stringify([contentScope.transport, contentScope.generation, liveTrimmed, isCommandPaletteOpen]);
  const [navigationSnapshot, setNavigationSnapshot] = React.useState<{ key: string; hits: SessionContentSearchHit[]; sessions: Session[] } | null>(null);
  const frozenResults = navigationSnapshot?.key === navigationKey ? navigationSnapshot : null;
  if (navigationSnapshot && !frozenResults) setNavigationSnapshot(null);
  const contentSearchOptions = React.useMemo(
    () => sessionContentSearchQueryOptions(trimmedQuery, { scope: contentScope }),
    [trimmedQuery, contentScope],
  );
  const contentSearchQuery = useQuery({
    ...contentSearchOptions,
    enabled: searchEnabled && trimmedQuery.length > 0,
  });
  const fileSearchQuery = useQuery({
    ...fileSearchOptions,
    enabled: searchEnabled && trimmedQuery.length > 0 && fileSearchDirectory !== null
      && !titleSearchQuery.isPending && !contentSearchQuery.isPending,
  });
  React.useEffect(() => {
    if (searchEnabled) return;
    // Disabling an observer does not abort its request. Stop obsolete searches
    // during the debounce/exit window while retaining settled cached rows.
    for (const queryKey of [titleSearchOptions.queryKey, contentSearchOptions.queryKey, fileSearchOptions.queryKey]) {
      void queryClient.cancelQueries({ queryKey, exact: true });
    }
  }, [queryClient, searchEnabled, titleSearchOptions, contentSearchOptions, fileSearchOptions]);
  const contentHits = React.useMemo<SessionContentSearchHit[]>(
    () => frozenResults?.hits ?? contentSearchQuery.data ?? [],
    [frozenResults, contentSearchQuery.data],
  );
  const contentSearchFailed = hasQuery && liveTrimmed === trimmedQuery && contentSearchQuery.isError;
  const titleSearchReady = hasQuery && liveTrimmed === trimmedQuery && titleSearchQuery.isSuccess;
  const titleSearchFailed = (hasQuery || presentation === 'page') && liveTrimmed === trimmedQuery && titleSearchQuery.isError;
  const localTitleMatches = React.useMemo(() => {
    if (!titleSearchFailed) return [];
    return scoreByFuzzyQuery(sortedActiveSessions, liveTrimmed, (session) => session.title || '', {
      limit: 30,
      threshold: 0.2,
    }).map(({ item }) => item);
  }, [titleSearchFailed, sortedActiveSessions, liveTrimmed]);

  const visibleTitleSessions = React.useMemo(() => {
    if (frozenResults) return frozenResults.sessions;
    if (!hasQuery) {
      if (presentation === 'page' && !trimmedQuery && titleSearchQuery.isSuccess) return titleSearchQuery.data;
      return sortedActiveSessions.slice(0, presentation === 'page' ? 30 : 9);
    }
    if (!titleSearchReady) return titleSearchFailed ? localTitleMatches : [];
    return titleSearchQuery.data ?? [];
  }, [
    hasQuery,
    sortedActiveSessions,
    titleSearchReady,
    titleSearchFailed,
    localTitleMatches,
    titleSearchQuery.data,
    titleSearchQuery.isSuccess,
    presentation,
    trimmedQuery,
    frozenResults,
  ]);

  const scoredFiles = React.useMemo(() => {
    if (!isCommandPaletteOpen && !retainResults) return [];
    if (liveTrimmed !== trimmedQuery) return [];
    return scoreCommandPaletteFiles(fileSearchQuery.data ?? [], trimmedQuery);
  }, [isCommandPaletteOpen, retainResults, fileSearchQuery.data, trimmedQuery, liveTrimmed]);

  // ---------------------------------------------------------------------------
  // Projects
  // ---------------------------------------------------------------------------
  const scoredProjects = React.useMemo(() => {
    if (!hasQuery) return [];
    const projectEntries = projects.map((project) => ({
      ...project,
      displayName: project.label || project.path.split('/').pop() || project.path,
      searchText: `${project.label || ''} ${project.path}`,
    }));
    return scoreByFuzzyQuery(projectEntries, liveTrimmed, (p) => p.searchText, {
      limit: 7,
      threshold: 0.4,
    });
  }, [projects, liveTrimmed, hasQuery]);

  const expansionKey = JSON.stringify([contentScope.transport, contentScope.generation, liveTrimmed]);
  const expandedGroups = expandedSearchGroups.query === expansionKey ? expandedSearchGroups.groups : [];
  const previewGroup = <T,>(group: string, items: T[]): T[] => (
    hasQuery && !expandedGroups.includes(group) ? items.slice(0, 5) : items
  );
  const visibleCommands = previewGroup('commands', scoredCommands.map((x) => x.item));
  const visibleSettings = previewGroup('settings', scoredSettings.map((x) => x.item));
  const conversationResults = React.useMemo(() => {
    const hitsBySession = new Map<string, SessionContentSearchHit>();
    for (const hit of contentHits) {
      const previous = hitsBySession.get(hit.sessionID);
      if (!previous || hit.createdAt > previous.createdAt
        || (hit.createdAt === previous.createdAt && hit.messageID > previous.messageID)) {
        hitsBySession.set(hit.sessionID, hit);
      }
    }
    const rows: { session: Session; hit?: SessionContentSearchHit }[] = [];
    const known = new Map(activeSessions.map((session) => [session.id, session]));
    for (const session of visibleTitleSessions) {
      rows.push({ session, hit: hitsBySession.get(session.id) });
      hitsBySession.delete(session.id);
    }
    for (const hit of hitsBySession.values()) {
      rows.push({ session: known.get(hit.sessionID) ?? {
        id: hit.sessionID, title: hit.title ?? '', directory: hit.directory, location: { directory: hit.directory },
      } as Session, hit });
    }
    return rows;
  }, [visibleTitleSessions, contentHits, activeSessions]);
  const visibleConversations = previewGroup('sessions', conversationResults);
  const visibleFiles = hasQuery ? previewGroup('files', scoredFiles.map((x) => x.item)) : [];
  const visibleProjects = hasQuery ? previewGroup('projects', scoredProjects.map((x) => x.item)) : [];
  const groupFooter = (group: string, total: number, visible: number) => total > visible ? (
    <CommandItem
      value={`more:${group}`}
      onSelect={() => setExpandedSearchGroups({ query: expansionKey, groups: [...expandedGroups, group] })}
      className={`${ITEM_CLASS} text-muted-foreground`}
    >
      {t('commandPalette.group.showMore', { count: total - visible })}
    </CommandItem>
  ) : null;

  const groupOrder = React.useMemo<('commands' | 'settings' | 'sessions' | 'files' | 'projects')[]>(() => {
    if (!hasQuery) return ['sessions', 'commands'];
    const best = (arr: { score: number }[]): number => (arr.length ? arr[0].score : Infinity);
    const groups: { key: 'commands' | 'settings' | 'files' | 'projects'; score: number }[] = [
      { key: 'commands', score: best(scoredCommands) },
      { key: 'settings', score: best(scoredSettings) },
      { key: 'files', score: best(scoredFiles) },
      { key: 'projects', score: best(scoredProjects) },
    ];
    groups.sort((a, b) => a.score - b.score);
    return ['sessions', ...groups.map((group) => group.key)];
  }, [hasQuery, scoredCommands, scoredSettings, scoredFiles, scoredProjects]);

  const handleOpenSession = useEvent((session: Session, messageID?: string) => {
    close();
    setActiveMainTab('chat');
    setSessionSwitcherOpen(false);
    const directory = resolveGlobalSessionDirectory(session) || '';
    if (mobileActions) {
      useMobileNavigationStore.getState().openSession({ sessionId: session.id, directory });
    } else {
      void setCurrentSession(session.id, directory);
    }
    if (messageID) focusChatMessage(messageID);
  });

  const handleOpenContentHit = useEvent((hit: SessionContentSearchHit) => {
    const known = sortedActiveSessions.find((session) => session.id === hit.sessionID)
      ?? visibleTitleSessions.find((session) => session.id === hit.sessionID);
    const session = known ?? {
      id: hit.sessionID,
      title: hit.title ?? '',
      directory: hit.directory,
      location: { directory: hit.directory },
    } as Session;
    handleOpenSession(session, hit.messageID);
  });

  const handleOpenFile = useEvent(async (filePath: string) => {
    const file = fileSearchQuery.data?.find((item) => item.path === filePath);
    if (!file) return;
    const transport = getRuntimeTransportIdentity();
    const generation = getRuntimeGeneration();
    const validation = await validateContextFileOpen(filesApi, filePath);
    if (transport !== getRuntimeTransportIdentity() || generation !== getRuntimeGeneration()) return;
    if (!validation.ok) {
      toast.error(getContextFileOpenFailureMessage(validation.reason));
      return;
    }
    if (mobileActions) mobileActions.openFile({ path: filePath });
    else openContextFile(file.directory, filePath);
    close();
  });

  const handleOpenProject = useEvent((projectId: string, projectPath: string) => {
    close();
    const target = { selectedProjectId: projectId, directoryOverride: projectPath };
    if (mobileActions) useMobileNavigationStore.getState().openDraft(target);
    else openNewSessionDraft(target);
  });

  const shortcut = (actionId: string) =>
    formatShortcutForDisplay(getEffectiveShortcutCombo(actionId, shortcutOverrides));

  const swallowUnsettled = (event: React.KeyboardEvent) => {
    if (!resultsSettled && (event.key === 'Enter' || event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      event.stopPropagation();
      return true;
    }
    return false;
  };

  const handleNumberShortcut = useEvent((event: React.KeyboardEvent) => {
    if (swallowUnsettled(event)) return;
    if (!frozenResults && !event.nativeEvent.isComposing && ['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key)) {
      setNavigationSnapshot({ key: navigationKey, hits: contentHits, sessions: visibleTitleSessions });
    }
    if (isMobile || event.nativeEvent.isComposing || event.altKey || event.shiftKey) return;
    if (mac ? (!event.metaKey || event.ctrlKey) : (!event.ctrlKey || event.metaKey)) return;
    if (!/^[1-9]$/.test(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat || !resultsSettled) return;
    const result = visibleConversations[Number(event.key) - 1];
    if (result?.hit) handleOpenContentHit(result.hit);
    else if (result) handleOpenSession(result.session);
  });

  const projectForSession = (session: Session) => {
    const directory = normalizePath(worktreeMetadata.get(session.id)?.projectDirectory || resolveGlobalSessionDirectory(session) || '');
    const project = resolveProjectForSessionDirectory(projects, availableWorktreesByProject, directory);
    return project?.label || (project?.path || directory).split('/').pop() || '';
  };

  const fileSearchFailed = hasQuery && liveTrimmed === trimmedQuery && fileSearchQuery.isError;
  const fileSearchPending = hasQuery && liveTrimmed === trimmedQuery
    && fileSearchQuery.isFetching && !fileSearchQuery.isSuccess;
  const remoteResultsPending = hasQuery && (
    liveTrimmed !== trimmedQuery
    || (titleSearchQuery.isFetching && !titleSearchQuery.isSuccess)
    || (contentScope !== null && contentSearchQuery.isFetching && !contentSearchQuery.isSuccess)
  );
  const [committedQuery, setCommittedQuery] = React.useState(trimmedQuery);
  if (!remoteResultsPending && committedQuery !== trimmedQuery) setCommittedQuery(trimmedQuery);
  const resultsSettled = !hasQuery || (committedQuery === trimmedQuery && !remoteResultsPending);

  const searchInput = (
    <CommandInput
      ref={inputRef}
      variant={isMobile ? 'mobileGlass' : 'default'}
      className="font-normal"
      aria-label={t('commandPalette.title')}
      inputMode="search"
      autoComplete="off"
      autoCorrect="off"
      spellCheck={false}
      value={query}
      onValueChange={(value) => {
        setNavigationSnapshot(null);
        setQuery(value);
        setExpandedSearchGroups({ query: '', groups: [] });
      }}
      placeholder={t('commandPalette.input.placeholder')}
    />
  );

  const content = (
        <Command
          loop
          shouldFilter={false}
          style={{ '--yuri-search-shortcut-width': mac ? '1.75rem' : '3rem' } as React.CSSProperties}
          onKeyDownCapture={handleNumberShortcut}
          onPointerDownCapture={(event) => {
            const row = (event.target as Element).closest('[cmdk-item]');
            if (isMobile && row) markMatchingPress({ currentTarget: row });
          }}
          onPointerCancelCapture={(event) => {
            const row = (event.target as Element).closest('[cmdk-item]');
            if (isMobile && row) consumeMatchingPress({ currentTarget: row, detail: 1 });
          }}
          onClickCapture={(event) => {
            const row = (event.target as Element).closest('[cmdk-item]');
            if (isMobile && row && event.detail > 0 && !consumeMatchingPress({ currentTarget: row, detail: event.detail })) {
              event.preventDefault();
              event.stopPropagation();
            }
          }}
          className="max-h-full min-h-0 rounded-[inherit] bg-transparent [&_[cmdk-group]]:px-0 [&_[cmdk-item][data-selected=true]]:!bg-[color-mix(in_srgb,var(--interactive-selection)_40%,transparent)] [&_[cmdk-item]:hover]:!bg-[color-mix(in_srgb,var(--interactive-selection)_40%,transparent)]"
        >
          {isMobile ? (
            <MobileDetailNavigation
              title={searchInput}
              backAriaLabel={t('header.actions.backAria')}
              onBack={onBack ?? close}
            />
          ) : searchInput}
          <CommandList aria-label={t('commandPalette.title')} className="yuri-global-search-results overscroll-contain">
            {resultsSettled && !fileSearchPending && !fileSearchFailed && !titleSearchFailed && !contentSearchFailed && sessionsStatus !== 'loading' && sessionsStatus !== 'error' ? (
              <CommandEmpty className="py-10 text-center typography-meta text-muted-foreground">
                {t('commandPalette.empty.noResults')}
              </CommandEmpty>
            ) : null}

            {isCommandPaletteOpen && resultsSettled ? <GuiPluginCommands query={liveTrimmed} onSelect={close} /> : null}
            {resultsSettled ? groupOrder.map((groupKey) => {
              if (groupKey === 'commands' && visibleCommands.length > 0) {
                return (
                  <CommandGroup key="commands" heading={groupHeading(t('settings.page.commands.title'), scoredCommands.length)}>
                    {visibleCommands.map((cmd) => (
                      <CommandItem
                        key={cmd.id}
                        value={cmd.id}
                        onSelect={cmd.onSelect}
                        className={ITEM_CLASS}
                      >
                        <CommandPaletteResult
                          title={highlightSearchText(cmd.title, liveTrimmed)}
                          trailing={!isMobile && cmd.shortcutId ? (
                            <Kbd variant="hint">
                              {shortcut(cmd.shortcutId)}
                            </Kbd>
                          ) : undefined}
                        />
                      </CommandItem>
                    ))}
                    {groupFooter('commands', scoredCommands.length, visibleCommands.length)}
                  </CommandGroup>
                );
              }
              if (groupKey === 'settings' && visibleSettings.length > 0) {
                return (
                  <CommandGroup key="settings" heading={groupHeading(t('settings.view.home.title'), scoredSettings.length)}>
                    {visibleSettings.map((cmd) => (
                      <CommandItem
                        key={cmd.id}
                        value={cmd.id}
                        onSelect={cmd.onSelect}
                        className={ITEM_CLASS}
                      >
                        <CommandPaletteResult title={highlightSearchText(cmd.title, liveTrimmed)} />
                      </CommandItem>
                    ))}
                    {groupFooter('settings', scoredSettings.length, visibleSettings.length)}
                  </CommandGroup>
                );
              }
              if (groupKey === 'sessions' && visibleConversations.length > 0) {
                return (
                  <CommandGroup key="sessions" heading={groupHeading(t('layout.mainTab.chat'), conversationResults.length)}>
                    {visibleConversations.map(({ session, hit }, index) => {
                      const title = hit?.title || session.title || t('commandPalette.session.untitled');
                      const project = projectForSession(session);
                      const timestamp = hit?.createdAt ?? session.time?.updated ?? session.time?.created;
                      const date = new Date(timestamp ?? NaN);
                      const hasTime = Number.isFinite(date.getTime());
                      return (
                        <CommandItem
                          key={hit ? `message:${session.id}:${hit.messageID}` : `session:${session.id}`}
                          value={hit ? `message:${session.id}:${hit.messageID}` : `session:${session.id}`}
                          onSelect={() => hit ? handleOpenContentHit(hit) : handleOpenSession(session)}
                          className="yuri-global-search-session"
                          aria-keyshortcuts={!isMobile && index < 9 ? `${mac ? 'Meta' : 'Control'}+${index + 1}` : undefined}
                        >
                          <div className="min-w-0">
                            <div className="yuri-global-search-session-heading">
                              <span className="yuri-global-search-session-title min-w-0 truncate text-foreground" title={title}>{highlightSearchText(title, liveTrimmed)}</span>
                              {hasTime ? (
                                <time dateTime={date.toISOString()} title={date.toLocaleString(locale)} className="yuri-global-search-session-time shrink-0 whitespace-nowrap text-muted-foreground">
                                  {conversationTimeFormatter.format(date)}
                                </time>
                              ) : null}
                            </div>
                            {hit ? (
                              <span className="yuri-global-search-session-excerpt text-muted-foreground">
                                <span className="yuri-global-search-session-speaker">{t(hit.role === 'user' ? 'commandPalette.message.user' : 'commandPalette.message.assistant')}: </span>
                                {highlightSearchText(hit.snippet.replace(/\s+/g, ' '), liveTrimmed)}
                              </span>
                            ) : null}
                          </div>
                          <span className="yuri-global-search-session-project min-w-0 truncate text-muted-foreground" title={project}>{project}</span>
                          {!isMobile && index < 9 ? <Kbd variant="hint" className="yuri-global-search-session-shortcut justify-self-end">{mac ? '⌘' : 'Ctrl+'}{index + 1}</Kbd> : null}
                        </CommandItem>
                      );
                    })}
                    {groupFooter('sessions', conversationResults.length, visibleConversations.length)}
                  </CommandGroup>
                );
              }
              if (groupKey === 'files' && visibleFiles.length > 0) {
                return (
                  <CommandGroup key="files" heading={groupHeading(t('layout.mainTab.files'), scoredFiles.length)}>
                    {visibleFiles.map((file) => {
                      const display = truncatePathMiddle(file.path, {
                        maxLength: 80,
                      });
                      return (
                        <CommandItem
                          key={`file:${file.path}`}
                          value={`file:${file.path}`}
                          onSelect={() => {
                            void handleOpenFile(file.path);
                          }}
                          className={ITEM_CLASS}
                        >
                          <CommandPaletteResult
                            title={highlightSearchText(file.name, liveTrimmed)}
                            description={display !== file.name ? highlightSearchText(display, liveTrimmed) : undefined}
                          />
                        </CommandItem>
                      );
                    })}
                    {groupFooter('files', scoredFiles.length, visibleFiles.length)}
                  </CommandGroup>
                );
              }
              if (groupKey === 'projects' && visibleProjects.length > 0) {
                return (
                  <CommandGroup key="projects" heading={groupHeading(t('sessions.sidebar.projectsTitle'), scoredProjects.length)}>
                    {visibleProjects.map((project) => {
                      const displayName = project.displayName;
                      return (
                        <CommandItem
                          key={`project:${project.id}`}
                          value={`project:${project.id}`}
                          onSelect={() => handleOpenProject(project.id, project.path)}
                          className={ITEM_CLASS}
                        >
                          <CommandPaletteResult
                            title={highlightSearchText(displayName, liveTrimmed)}
                            description={highlightSearchText(truncatePathMiddle(project.path, { maxLength: 80 }), liveTrimmed)}
                          />
                        </CommandItem>
                      );
                    })}
                    {groupFooter('projects', scoredProjects.length, visibleProjects.length)}
                  </CommandGroup>
                );
              }
              return null;
            }) : (
              <div role="status" className="px-3 py-10 text-center typography-meta text-muted-foreground">{t('common.loading')}</div>
            )}

            {resultsSettled && sessionsStatus === 'loading' ? <div role="status" className="px-3 py-4 text-center typography-meta text-muted-foreground">{t('common.loading')}</div> : null}
            {resultsSettled && sessionsStatus === 'error' ? <div role="alert" className="px-3 py-4 typography-meta text-[var(--status-error)]">{t('commandPalette.error.sessions')}</div> : null}
            {resultsSettled && titleSearchFailed ? <div role="alert" className="px-3 py-4 typography-meta text-[var(--status-error)]">{t('commandPalette.error.sessions')}</div> : null}
            {resultsSettled && contentSearchFailed ? <div role="alert" className="px-3 py-4 typography-meta text-[var(--status-error)]">{t('commandPalette.error.messages')}</div> : null}
            {resultsSettled && fileSearchPending ? <div data-file-search-pending role="status" className="px-4 py-2 text-xs text-muted-foreground">{t('common.loading')}</div> : null}
            {resultsSettled && fileSearchFailed ? <div data-file-search-notice role="status" className="px-4 py-2 text-xs text-muted-foreground">{t('commandPalette.error.files')}</div> : null}
          </CommandList>
        </Command>
  );

  if (presentation === 'page') {
    return (
      <section ref={popupRef} data-global-search="true" data-page-scroll-lock="true" aria-label={t('commandPalette.title')} className="yuri-global-search-page flex min-h-0 w-full flex-col bg-background text-foreground">
        {content}
      </section>
    );
  }

  return (
    <Dialog open={isCommandPaletteOpen} onOpenChange={setCommandPaletteOpen} onOpenChangeComplete={(open) => { if (!open) setRetainResults(false); }}>
      <DialogContent
        ref={popupRef}
        initialFocus={inputRef}
        data-global-search="true"
        data-mobile={isMobile}
        data-page-scroll-lock="true"
        presentation={isMobile ? 'default' : 'picker'}
        className={isMobile
          ? 'yuri-global-search-page yuri-global-search-mobile fixed inset-0 z-50 m-0 flex max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-0 bg-background p-0'
          : 'yuri-global-search z-50 w-[min(56rem,calc(100vw-3rem))]'}
        containerClassName="block p-0"
        overlayClassName="bg-transparent dark:bg-transparent"
        showCloseButton={false}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{t('commandPalette.title')}</DialogTitle>
          <DialogDescription>{t('commandPalette.description')}</DialogDescription>
        </DialogHeader>
        {content}
      </DialogContent>
    </Dialog>
  );
});
