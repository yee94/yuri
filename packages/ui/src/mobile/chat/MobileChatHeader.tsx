import { memo, useMemo, type ReactNode } from 'react';
import { skipToken, useQuery, type UseQueryOptions } from '@tanstack/react-query';
import { useEvent } from '@reactuses/core';

import { useI18n } from '@/lib/i18n';
import { MobileDetailNavigation } from '@/mobile/MobileDetailNavigation';
import { GuiPluginTitlebarItems } from '@/components/gui-plugins/GuiPluginTitlebarItems';
import { useHostRuntime } from '@/contexts/HostRuntimeProvider';
import { RemoteHostIndicator } from '@/components/session/RemoteHostIndicator';
import { useSessionNavigationStore } from '@/stores/useSessionNavigationStore';
import { useRemoteHostSummaries } from '@/queries/remoteProjectQueries';
import { queryClient } from '@/lib/queryRuntime';
import type { SessionInfo } from '@/lib/opencode/v2-types';
import type { HostRuntimeEntry } from '@/lib/remote-projects/registry';

export type MobileChatHeaderProps = {
  title: string;
  subtitle?: string | null;
  onBack: () => void;
  onOpenMenu: () => void;
  /** Whether the overflow menu is open — elevates the more button for re-tap close. */
  menuOpen?: boolean;
  /** Raise the whole header above modal backdrops (menu or context panel). */
  elevated?: boolean;
  /** Extra floating actions before the overflow menu (e.g. context ring). */
  trailing?: ReactNode;
};

/** Safe-area-aware navigation bar for the mobile chat page. */
export function MobileChatHeader({
  title,
  subtitle,
  onBack,
  onOpenMenu,
  menuOpen = false,
  elevated = false,
  trailing,
}: MobileChatHeaderProps) {
  const { t } = useI18n();
  const host = useHostRuntime();
  const handleBack = useEvent(onBack);
  const handleOpenMenu = useEvent(onOpenMenu);

  return (
    <MobileDetailNavigation
      title={host?.entry.location.hostId ? <RemoteMobileChatTitle host={host} /> : title}
      subtitle={subtitle}
      backAriaLabel={t('header.actions.backAria')}
      onBack={handleBack}
      overlay
      collapsible
      elevated={elevated || menuOpen}
      trailing={<><GuiPluginTitlebarItems mobile />{trailing}</>}
      actions={[{
        icon: 'more-2',
        ariaLabel: t('mobile.menu.titleAria'),
        onClick: handleOpenMenu,
        pressed: menuOpen,
      }]}
    />
  );
}

function RemoteMobileChatTitle({ host }: { host: NonNullable<ReturnType<typeof useHostRuntime>> }) {
  const { t } = useI18n();
  const { location } = host.entry;
  const selection = useSessionNavigationStore((state) => state.remoteSession?.location.hubId === location.hubId && state.remoteSession.location.hostId === location.hostId && state.remoteSession.location.directory === location.directory ? state.remoteSession : null);
  const sessionId = selection?.sessionId;
  const summaries = useRemoteHostSummaries(host.registry, location.hostId);
  const session = summaries.data?.directories.find((directory) => directory.directory === location.directory)?.sessions.find((session) => session.id === sessionId);
  return <span className="inline-flex max-w-full items-center gap-1"><span className="truncate">{sessionId ? <RemoteMobileSessionTitle entry={host.entry} sessionId={sessionId} fallback={session?.title || t('mobile.sessions.untitled')} /> : selection?.draft?.title || t('mobile.menu.newSession')}</span><RemoteHostIndicator registry={host.registry} hostId={location.hostId!} showName /></span>;
}

const RemoteMobileSessionTitle = memo(function RemoteMobileSessionTitle({ entry, sessionId, fallback }: { entry: HostRuntimeEntry; sessionId: string; fallback: string }) {
  const options = useMemo<UseQueryOptions<SessionInfo, Error, string | null>>(() => ({
    queryKey: [...entry.queryScope, 'chat', sessionId, 'session'],
    queryFn: skipToken,
    enabled: false,
    staleTime: Infinity,
    gcTime: Infinity,
    select: (session) => session.id === sessionId ? session.title?.trim() || null : null,
  }), [entry, sessionId]);
  const title = useQuery(options, queryClient).data;
  return <>{title ?? fallback}</>;
});
