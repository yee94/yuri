import * as React from 'react';
import { useEvent } from '@reactuses/core';

import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useCurrentSessionEntity } from '@/sync/sync-context';
import { useHostRuntime } from '@/contexts/HostRuntimeProvider';
import type { HostRuntimeContextValue } from '@/contexts/hostRuntimeContext';
import { useSessionNavigationStore } from '@/stores/useSessionNavigationStore';

import { MobileChatHeader } from './MobileChatHeader';
import { MobileContextProgressButton } from './MobileContextProgressButton';
import { useMobileTranscriptSyncHint, useRemoteMobileTranscriptSyncHint } from './useMobileTranscriptSyncHint';

export type MobileChatScreenProps = {
  /** Empty string = new-session draft mode (no entity/status lookups). */
  sessionId: string;
  /** Session workspace. Required so the sync hint reads the same transcript as ChatView. */
  directory?: string | null;
  title?: string;
  onBack: () => void;
  onOpenMenu: () => void;
  /** Close the overflow menu without toggling (used when switching to context). */
  onCloseMenu?: () => void;
  menuOpen?: boolean;
  children: React.ReactNode;
  className?: string;
};

/**
 * Second-level mobile shell around the existing primary ChatView. The shell
 * owns floating navigation and atmospheric edge chrome while ChatView keeps
 * message, composer, draft, and send behavior.
 */
export function MobileChatScreen(props: MobileChatScreenProps) {
  const host = useHostRuntime();
  return host?.entry.location.hostId ? <RemoteMobileChatScreen {...props} host={host} /> : <LocalMobileChatScreen {...props} />;
}

function LocalMobileChatScreen({ sessionId, directory, title, ...props }: MobileChatScreenProps) {
  const { t } = useI18n();
  const isDraft = sessionId.length === 0;
  const session = useCurrentSessionEntity(isDraft ? null : sessionId);
  const resolvedTitle = isDraft ? title?.trim() || t('mobile.menu.newSession') : title?.trim() || session?.title?.trim() || t('mobile.sessions.untitled');
  const syncHint = useMobileTranscriptSyncHint(isDraft ? '' : sessionId, directory || undefined);
  return <MobileChatScreenContent {...props} sessionId={sessionId} title={resolvedTitle} syncHint={syncHint} />;
}

function RemoteMobileChatScreen({ host, sessionId, title, ...props }: MobileChatScreenProps & { host: HostRuntimeContextValue }) {
  const selectedId = useSessionNavigationStore((state) => {
    const selected = state.remoteSession;
    return selected?.location.hubId === host.entry.location.hubId && selected.location.hostId === host.entry.location.hostId && selected.location.directory === host.entry.location.directory ? selected.sessionId : null;
  });
  const effectiveSessionId = sessionId || selectedId || '';
  const syncHint = useRemoteMobileTranscriptSyncHint(host, effectiveSessionId);
  return <MobileChatScreenContent {...props} sessionId={effectiveSessionId} title={title} syncHint={syncHint} />;
}

function MobileChatScreenContent({
  sessionId,
  title,
  onBack,
  onOpenMenu,
  onCloseMenu,
  menuOpen = false,
  children,
  className,
  syncHint,
}: MobileChatScreenProps & { syncHint: string | null }) {
  const { t } = useI18n();
  const [contextOpen, setContextOpen] = React.useState(false);

  // Overflow menu and context panel are mutually exclusive. Switching from one
  // trigger to the other closes the first and opens the second in the same tap.
  const handleContextOpenChange = useEvent((open: boolean) => {
    if (open && menuOpen) {
      onCloseMenu?.();
    }
    setContextOpen(open);
  });

  const handleOpenMenu = useEvent(() => {
    if (contextOpen) setContextOpen(false);
    onOpenMenu();
  });

  const headerElevated = menuOpen || contextOpen;

  return (
    <main
      className={cn(
        'mobile-chat-screen relative isolate flex h-full min-h-0 w-full flex-col overflow-hidden bg-background text-foreground',
        className,
      )}
    >
      <MobileChatHeader
        title={title || t(sessionId ? 'mobile.sessions.untitled' : 'mobile.menu.newSession')}
        subtitle={syncHint}
        onBack={onBack}
        onOpenMenu={handleOpenMenu}
        menuOpen={menuOpen}
        elevated={headerElevated}
        trailing={(
          <MobileContextProgressButton
            sessionId={sessionId}
            open={contextOpen}
            onOpenChange={handleContextOpenChange}
          />
        )}
      />

      <div
        className={cn(
          // Prompt host stays page-background solid; only a short top fade
          // softens into the message list. The input CARD is elevated solid.
          'mobile-chat-screen__content relative h-full min-h-0 flex-1',
          '[&_[data-scrollbar=chat]>.yuri-chat-scroll-content]:pt-[calc(max(0.625rem,var(--yuri-safe-area-top,0px))+var(--yuri-mobile-detail-navigation-height)+1.25rem)]',
        )}
      >
        {children}
      </div>
    </main>
  );
}
