import React from 'react';
import { Menu as BaseMenu } from '@base-ui/react/menu';
import { useEvent } from '@reactuses/core';
import type { Session } from '@/lib/opencode/v2-types';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Icon } from '@/components/icon/Icon';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useGlobalSessionStatus } from '@/sync/sync-context';
import { useSessionUnseenCount } from '@/sync/notification-store';
import { useSwitcherItems, type SwitcherItem } from '@/components/session/sidebar/hooks/useSwitcherItems';
import { useUIStore } from '@/stores/useUIStore';
import { resolveGlobalSessionDirectory } from '@/stores/useGlobalSessionsStore';
import { formatSessionCompactDateLabel } from './sidebar/utils';
import type { SessionNode } from './sidebar/types';
import { useI18n } from '@/lib/i18n';
import { formatSessionChangeCounts, readSessionChangeSummary } from '@/lib/sessionChangeSummary';
import { cn } from '@/lib/utils';
import { useQuery } from '@tanstack/react-query';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionNavigationStore } from '@/stores/useSessionNavigationStore';
import { useRemoteProjectRuntime, useRemoteHostSummaries, ensureRemoteHostCatalog } from '@/queries/remoteProjectQueries';
import { useRemoteHost } from '@/contexts/HostRuntimeProvider';
import { openRemoteProjectSession } from '@/router/openRemoteProjectSession';
import type { RemoteProject } from '@/lib/remote-projects/types';
import type { HostRuntimeRegistry } from '@/lib/remote-projects/registry';
import { resolveRemoteProjectOwner, type RemoteHostSummaries } from '@/lib/remote-projects/summaries';
import type { SessionIndexSession } from '@/lib/session-index-api';
import { queryClient } from '@/lib/queryRuntime';
import { projectSession } from '@/lib/opencode/v2-types';
import { compareSessionsByPinnedAndTime } from './sidebar/utils';
import { Button } from '@/components/ui/button';
import { gitBranchesQueryOptions } from '@/queries/gitBranchQueries';

type SecondaryMeta = SwitcherItem['secondaryMeta'];

type SwitcherVariant = 'default' | 'compact';

type SessionSwitcherDropdownProps = {
  children: React.ReactNode;
  variant?: SwitcherVariant;
  scopeProjectId?: string | null;
  align?: 'start' | 'center' | 'end';
};

export function SessionSwitcherDropdown({
  children,
  variant = 'default',
  scopeProjectId = null,
  align = 'start',
}: SessionSwitcherDropdownProps): React.ReactElement {
  const isOpen = useUIStore((state) => state.isSessionDropdownOpen);
  const setOpen = useUIStore((state) => state.setSessionDropdownOpen);

  return (
    <DropdownMenu open={isOpen} onOpenChange={setOpen} modal={false}>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent
        align={align}
        sideOffset={6}
        className={cn(
          'overflow-hidden p-1 max-w-[calc(100vw-32px)]',
          variant === 'compact' ? 'w-[280px]' : 'w-[360px]',
        )}
      >
        {isOpen ? (
          <SwitcherContent
            onSelect={() => setOpen(false)}
            variant={variant}
            scopeProjectId={scopeProjectId}
          />
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type SwitcherContentProps = {
  onSelect: () => void;
  variant: SwitcherVariant;
  scopeProjectId: string | null;
};

function SwitcherContent({ onSelect, variant, scopeProjectId }: SwitcherContentProps): React.ReactElement {
  const project = useProjectsStore((state) => state.projects.find((entry) => entry.id === (scopeProjectId ?? state.activeProjectId)));
  return project?.hostId
    ? <RemoteSwitcherContent key={`${project.hubId}:${project.hostId}:${project.id}`} projectId={project.id} hostId={project.hostId} hubId={project.hubId} onSelect={onSelect} variant={variant} />
    : <LocalSwitcherContent onSelect={onSelect} variant={variant} scopeProjectId={scopeProjectId} />;
}

function LocalSwitcherContent({ onSelect, variant, scopeProjectId }: SwitcherContentProps): React.ReactElement {
  const items = useSwitcherItems(true, { scopeProjectId });
  const openNewSessionDraft = useSessionUIStore((state) => state.openNewSessionDraft);
  const setActiveMainTab = useUIStore((state) => state.setActiveMainTab);
  const { t } = useI18n();

  const handleNewSession = useEvent(() => {
    setActiveMainTab('chat');
    onSelect();
    openNewSessionDraft();
  });

  const [expandedParents, setExpandedParents] = React.useState<Set<string>>(new Set());
  const toggleParent = useEvent((sessionId: string) => {
    setExpandedParents((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
      }
      return next;
    });
  });

  return (
    <div className="max-h-[60vh] overflow-y-auto">
      <div className="space-y-0.5">
        <BaseMenu.Item
          onClick={handleNewSession}
          className={cn(
            'group relative flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 outline-hidden select-none',
            'data-[highlighted]:bg-interactive-hover hover:bg-interactive-hover',
          )}
        >
          <Icon name="chat-new" className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
          <span className="truncate text-[14px] font-normal leading-tight text-foreground">
            {t('sessions.sidebar.header.actions.newSession')}
          </span>
        </BaseMenu.Item>
        {items.length === 0 ? (
          <div className="px-3 py-4 text-center typography-meta text-muted-foreground">
            {t('sessions.switcher.empty')}
          </div>
        ) : (
          items.map((item) => (
            <SwitcherNode
              key={item.node.session.id}
              item={item}
              depth={0}
              variant={variant}
              expandedParents={expandedParents}
              toggleParent={toggleParent}
              closeDropdown={onSelect}
            />
          ))
        )}
      </div>
    </div>
  );
}

type SwitcherNodeProps = {
  item: { node: SessionNode; projectId: string | null; groupDirectory: string | null; secondaryMeta: SecondaryMeta };
  depth: number;
  variant: SwitcherVariant;
  expandedParents: Set<string>;
  toggleParent: (sessionId: string) => void;
  closeDropdown: () => void;
};

function RemoteSwitcherContent({ projectId, hostId, hubId, onSelect, variant }: { projectId: string; hostId: string; hubId?: string; onSelect(): void; variant: SwitcherVariant }): React.ReactElement {
  const runtime = useRemoteProjectRuntime(true);
  const project = !hubId || hubId === runtime.catalog?.hubId ? runtime.catalog?.projects.find((candidate) => candidate.id === projectId && candidate.hostId === hostId) : undefined;
  const { t } = useI18n();
  const [error, setError] = React.useState<string | null>(null);
  const retry = useEvent(async () => {
    try { await ensureRemoteHostCatalog(); setError(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  });
  return runtime.registry && project
    ? <RemoteSwitcherList registry={runtime.registry} project={project} onSelect={onSelect} variant={variant} />
    : <div role="alert" className="px-3 py-4 typography-meta text-muted-foreground">{error ?? runtime.error?.message ?? t('remoteProjects.host-unavailable')}<Button size="xs" variant="ghost" onClick={() => void retry()}>{t('remoteProjects.retry')}</Button></div>;
}

function RemoteSwitcherList({ registry, project, onSelect, variant }: { registry: HostRuntimeRegistry; project: RemoteProject; onSelect(): void; variant: SwitcherVariant }): React.ReactElement {
  const { t } = useI18n();
  const host = useRemoteHost(registry, project.hostId);
  const summaries = useRemoteHostSummaries(registry, project.hostId);
  const projects = useProjectsStore((state) => state.projects);
  const selected = useSessionNavigationStore((state) => state.remoteSession);
  const mobile = useUIStore((state) => state.isMobile);
  const snapshot = summaries.data;
  const online = host?.state === 'connected' && project.remoteState === 'ok' && !snapshot?.stale;
  const rows = React.useMemo(() => {
    const pinned = new Set(snapshot?.pinnedSessionIds ?? []);
    const owners = new Map<string, boolean>();
    const ownsDirectory = (directory: string) => {
      if (!owners.has(directory)) owners.set(directory, resolveRemoteProjectOwner(projects, registry.hubId, project.hostId, directory, snapshot?.worktrees)?.id === project.id);
      return owners.get(directory);
    };
    return (snapshot?.directories ?? []).flatMap(({ directory, sessions }) => sessions.filter((session) => !session.parentID && !session.time.archived)
      .map((session) => ({ session, directory: session.directory || directory })))
      .filter(({ directory }) => ownsDirectory(directory))
      .sort((a, b) => compareSessionsByPinnedAndTime(a.session, b.session, pinned)).slice(0, 7);
  }, [snapshot, projects, project.hostId, project.id, registry.hubId]);
  const [error, setError] = React.useState<string | null>(null);
  const navigate = useEvent((sessionId: string | null, directory: string) => {
    try {
      if (resolveRemoteProjectOwner(projects, registry.hubId, project.hostId, directory, snapshot?.worktrees)?.id !== project.id) throw new Error(t('remoteProjects.host-unavailable'));
      openRemoteProjectSession(project, registry, sessionId, directory, mobile);
      onSelect();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  });
  const newDirectory = selected?.projectId === project.id && selected.location.hostId === project.hostId && selected.location.hubId === registry.hubId ? selected.location.directory : project.path;
  return <div className="max-h-[60vh] overflow-y-auto"><div className="space-y-0.5">
    <BaseMenu.Item onClick={() => navigate(null, newDirectory)} className="group relative flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 outline-hidden select-none data-[highlighted]:bg-interactive-hover hover:bg-interactive-hover">
      <Icon name="chat-new" className="h-4 w-4 flex-shrink-0 text-muted-foreground" /><span className="truncate text-[14px] font-normal leading-tight text-foreground">{t('sessions.sidebar.header.actions.newSession')}</span>
    </BaseMenu.Item>
    {!online ? <div role="status" className="px-3 typography-meta text-muted-foreground">{t(`remoteProjects.state.${host?.state ?? 'offline'}`)} · {t('remoteProjects.unknown')}</div> : null}
    {summaries.error || error ? <div role="alert" className="px-3 typography-meta text-destructive">{error ?? summaries.error?.message}<Button size="xs" variant="ghost" onClick={() => { setError(null); void summaries.refetch(); }}>{t('remoteProjects.retry')}</Button></div> : null}
    {!rows.length && snapshot ? <div className="px-3 py-4 text-center typography-meta text-muted-foreground">{t('sessions.switcher.empty')}</div> : null}
    {rows.map(({ session, directory }) => <RemoteSwitcherNode key={`${directory}:${session.id}`} {...{ registry, project, projects, session, directory, variant, snapshot, online, navigate, selected }} depth={0} ancestors={[]} />)}
  </div></div>;
}

type RemoteSwitcherNodeProps = {
  registry: HostRuntimeRegistry; project: RemoteProject; session: SessionIndexSession; directory: string;
  projects: ReturnType<typeof useProjectsStore.getState>['projects'];
  variant: SwitcherVariant; snapshot?: RemoteHostSummaries; online: boolean;
  navigate(id: string | null, directory: string): void;
  selected: ReturnType<typeof useSessionNavigationStore.getState>['remoteSession'];
  depth: number; ancestors: string[];
};

function RemoteSwitcherNode({ registry, project, projects, session, directory, variant, snapshot, online, navigate, selected, depth, ancestors }: RemoteSwitcherNodeProps): React.ReactElement {
  const { t } = useI18n();
  const [expanded, setExpanded] = React.useState(false);
  const [limit, setLimit] = React.useState(30);
  const entry = registry.resolve({ hubId: registry.hubId, hostId: project.hostId, directory });
  const branchOptions = React.useMemo(() => ({ ...gitBranchesQueryOptions(directory, undefined, undefined, undefined, entry), enabled: false, staleTime: Infinity, gcTime: Infinity }), [entry, directory]);
  const branch = useQuery(branchOptions, queryClient).data?.current;
  const children = useQuery<{ sessions: SessionIndexSession[]; hasMore: boolean }>({
    queryKey: [...entry.queryScope, 'navigation-children', session.id, limit],
    enabled: expanded && online,
    staleTime: 30_000,
    gcTime: Infinity,
    placeholderData: (previous, previousQuery) => previousQuery && entry.queryScope.every((part, index) => previousQuery.queryKey[index] === part) && previousQuery.queryKey[entry.queryScope.length + 1] === session.id ? previous : undefined,
    queryFn: async ({ signal }) => {
      const sessions: SessionIndexSession[] = [];
      let cursor: string | undefined;
      let hasMore = false;
      for (let page = 0; page < Math.ceil(limit / 30); page++) {
        const response = await entry.sdk().session.list({ directory, parentID: session.id, limit: 30, ...(cursor ? { cursor } : {}) }, { signal });
        registry.assertCurrent();
        entry.sdk();
        if (!Array.isArray(response.data)) throw new Error('Remote child session list returned no data');
        sessions.push(...response.data.map(projectSession).filter((child) => !child.time?.archived).map((child) => ({ ...child, directory: child.directory || directory, time: child.time ?? {} })));
        const next: string | undefined = response.cursor?.next || undefined;
        hasMore = Boolean(next && next !== cursor);
        if (!hasMore) break;
        cursor = next;
      }
      return { sessions, hasMore };
    },
  }, queryClient);
  const invalidate = useEvent(({ directory: eventDirectory, payload }: { directory?: string; payload: unknown }) => {
    if (eventDirectory && eventDirectory !== directory) return;
    if (payload && typeof payload === 'object' && 'type' in payload && typeof payload.type === 'string' && /^(session\.(created|updated|deleted|status)|yuri:session-metadata)$/.test(payload.type)) {
      void queryClient.invalidateQueries({ queryKey: [...entry.queryScope, 'navigation-children', session.id, limit], exact: true });
    }
  });
  React.useEffect(() => {
    if (expanded && online) return registry.subscribeEvents(project.hostId, invalidate);
  }, [registry, project.hostId, directory, expanded, online, invalidate]);
  const cached = snapshot?.directories.flatMap((item) => item.sessions.filter((child) => child.parentID === session.id).map((child) => ({ ...child, directory: child.directory || item.directory }))) ?? [];
  const childRows = (children.data?.sessions ?? cached).filter((child) => child.id !== session.id && !ancestors.includes(child.id)
    && resolveRemoteProjectOwner(projects, registry.hubId, project.hostId, child.directory || directory, snapshot?.worktrees)?.id === project.id);
  const status = (session.metadata as { yuri?: { sessionStatus?: { type?: string } } } | undefined)?.yuri?.sessionStatus?.type;
  const isActive = selected?.projectId === project.id && selected.location.hubId === registry.hubId && selected.location.hostId === project.hostId && selected.location.directory === directory && selected.sessionId === session.id;
  return <>
    <SwitcherRowView session={session} depth={depth} variant={variant} secondaryMeta={{ projectLabel: project.label ?? project.path.split(/[\\/]/).filter(Boolean).at(-1), branchLabel: branch }} hasChildren={Boolean(session.hasChildren || childRows.length || depth > 0)} isExpanded={expanded} onToggleExpand={() => setExpanded((value) => !value)} isActive={isActive} unseenCount={snapshot?.unread?.sessions[session.id]?.unreadCount ?? 0} statusType={online ? status ?? 'idle' : 'unknown'} handleSelect={() => navigate(session.id, directory)} />
    {expanded ? <>
      {children.error ? <div role="alert" className="px-3 typography-meta text-destructive">{children.error.message}<Button size="xs" variant="ghost" disabled={!online} onClick={() => void children.refetch()}>{t('remoteProjects.retry')}</Button></div> : null}
      {childRows.map((child) => <RemoteSwitcherNode key={child.id} {...{ registry, project, projects, variant, snapshot, online, navigate, selected }} directory={child.directory || directory} session={child} depth={depth + 1} ancestors={[...ancestors, session.id]} />)}
      {children.data?.hasMore ? <Button size="xs" variant="ghost" disabled={!online || children.isFetching} onClick={() => setLimit((value) => value + 30)}>{t('remoteProjects.showMore')}</Button> : null}
    </> : null}
  </>;
}

function SwitcherNode({ item, depth, variant, expandedParents, toggleParent, closeDropdown }: SwitcherNodeProps): React.ReactElement {
  const { node, secondaryMeta } = item;
  const session = node.session;
  const hasChildren = node.children.length > 0;
  const isExpanded = expandedParents.has(session.id);

  return (
    <>
      <SwitcherRow
        session={session}
        depth={depth}
        variant={variant}
        secondaryMeta={secondaryMeta}
        hasChildren={hasChildren}
        isExpanded={isExpanded}
        onToggleExpand={hasChildren ? () => toggleParent(session.id) : undefined}
        closeDropdown={closeDropdown}
      />
      {hasChildren && isExpanded
        ? node.children.map((childNode) => (
            <SwitcherNode
              key={childNode.session.id}
              item={{ node: childNode, projectId: item.projectId, groupDirectory: item.groupDirectory, secondaryMeta }}
              depth={depth + 1}
              variant={variant}
              expandedParents={expandedParents}
              toggleParent={toggleParent}
              closeDropdown={closeDropdown}
            />
          ))
        : null}
    </>
  );
}

type SwitcherRowProps = {
  session: Session;
  depth: number;
  variant: SwitcherVariant;
  secondaryMeta: SecondaryMeta;
  hasChildren: boolean;
  isExpanded: boolean;
  onToggleExpand?: () => void;
  closeDropdown: () => void;
};

function SwitcherRow({ session, depth, variant, secondaryMeta, hasChildren, isExpanded, onToggleExpand, closeDropdown }: SwitcherRowProps): React.ReactElement {
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const setCurrentSession = useSessionUIStore((state) => state.setCurrentSession);

  const sessionStatus = useGlobalSessionStatus(session.id);
  const unseenCount = useSessionUnseenCount(session.id);

  const isActive = currentSessionId === session.id;
  const handleSelect = useEvent(() => {
    if (!isActive) setCurrentSession(session.id, resolveGlobalSessionDirectory(session) ?? null);
    closeDropdown();
  });
  return <SwitcherRowView {...{ session, depth, variant, secondaryMeta, hasChildren, isExpanded, onToggleExpand, isActive, unseenCount, statusType: sessionStatus?.type ?? 'idle', handleSelect }} />;
}

function SwitcherRowView({ session, depth, variant, secondaryMeta, hasChildren, isExpanded, onToggleExpand, isActive, unseenCount, statusType, handleSelect }: Omit<SwitcherRowProps, 'closeDropdown'> & { isActive: boolean; unseenCount: number; statusType: string; handleSelect(): void }): React.ReactElement {
  const { t } = useI18n();
  const sessionTitle = session.title?.trim() || t('sessions.sidebar.session.untitled');
  const sessionChangeCounts = formatSessionChangeCounts(readSessionChangeSummary(session));
  const isSubtask = Boolean((session as Session & { parentID?: string | null }).parentID);
  const needsAttention = unseenCount > 0 && !isSubtask;
  const isStreaming = statusType === 'busy' || statusType === 'retry';
  const showUnreadDot = !isStreaming && needsAttention;

  const timestamp = session.time?.updated || session.time?.created || Date.now();
  const timeLabel = formatSessionCompactDateLabel(timestamp);

  const projectLabel = secondaryMeta?.projectLabel?.trim() || null;
  const rawBranchLabel = secondaryMeta?.branchLabel?.trim() || null;
  const branchLabel = rawBranchLabel && rawBranchLabel !== 'HEAD' ? rawBranchLabel : null;

  return (
    <BaseMenu.Item
      onClick={(event) => {
        if ((event.target as HTMLElement | null)?.closest('[data-switcher-expand]')) {
          event.preventDefault();
          return;
        }
        handleSelect();
      }}
      data-slot="session-switcher-item"
      className={cn(
        'group relative flex w-full cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 outline-hidden select-none',
        'data-[highlighted]:bg-interactive-hover hover:bg-interactive-hover',
      )}
      style={{ paddingLeft: 8 + depth * 12 }}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-1.5">
          {variant === 'compact' && hasChildren ? (
            <span
              role="button"
              tabIndex={-1}
              data-switcher-expand
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onToggleExpand?.();
              }}
              className="inline-flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center rounded text-muted-foreground/70 hover:text-foreground"
              aria-label={isExpanded ? t('sessions.sidebar.session.subsessions.collapse') : t('sessions.sidebar.session.subsessions.expand')}
            >
              {isExpanded ? <Icon name="arrow-down-s" className="h-3.5 w-3.5" /> : <Icon name="arrow-right-s" className="h-3.5 w-3.5" />}
            </span>
          ) : null}
          <span className={cn('min-w-0 truncate text-[14px] font-normal leading-tight', isActive ? 'text-primary' : 'text-foreground')}>
            {sessionTitle}
          </span>
          {sessionChangeCounts ? (
            <span className="shrink-0 text-[12px] tabular-nums text-muted-foreground">{sessionChangeCounts}</span>
          ) : null}
        </div>
        {variant === 'default' ? (
          <div
            className="flex min-w-0 items-center gap-1.5 truncate text-muted-foreground/70 leading-tight"
            style={{ fontSize: 'calc(var(--text-ui-label) * 0.85)' }}
          >
            {hasChildren ? (
              <span
                role="button"
                tabIndex={-1}
                data-switcher-expand
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onToggleExpand?.();
                }}
                className="inline-flex h-3 w-3 flex-shrink-0 items-center justify-center rounded text-muted-foreground/70 hover:text-foreground"
                aria-label={isExpanded ? t('sessions.sidebar.session.subsessions.collapse') : t('sessions.sidebar.session.subsessions.expand')}
              >
                {isExpanded ? <Icon name="arrow-down-s" className="h-3 w-3" /> : <Icon name="arrow-right-s" className="h-3 w-3" />}
              </span>
            ) : null}
            <span className="flex-shrink-0">{timeLabel}</span>
            {projectLabel ? <span className="truncate">{projectLabel}</span> : null}
            {branchLabel ? (
              <span className="inline-flex min-w-0 items-center gap-0.5">
                <Icon name="git-branch" className="h-3 w-3 flex-shrink-0 text-muted-foreground/70" />
                <span className="truncate">{branchLabel}</span>
              </span>
            ) : null}
          </div>
        ) : null}
      </div>

      {isStreaming || showUnreadDot ? (
        <span className="flex h-3 w-3 flex-shrink-0 items-center justify-center self-center">
          {isStreaming ? (
            <span
              className="h-1.5 w-1.5 rounded-full bg-primary animate-busy-pulse"
              aria-label={t('sessions.sidebar.session.status.active')}
              title={t('sessions.sidebar.session.status.active')}
            />
          ) : (
            <span
              className="h-1.5 w-1.5 rounded-full bg-[var(--status-info)]"
              aria-label={t('sessions.sidebar.session.status.unread')}
              title={t('sessions.sidebar.session.status.unread')}
            />
          )}
        </span>
      ) : null}
    </BaseMenu.Item>
  );
}
