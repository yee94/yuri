import React from 'react';
import { useEvent } from '@reactuses/core';
import { MobileSurfaceHeader } from '@/components/ui/MobileSurfaceHeader';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { MobileContextProgressButton } from '@/mobile/chat/MobileContextProgressButton';
import { useI18n } from '@/lib/i18n';
import type { RemoteMobileSession } from './remoteMobileSession';
import { RemoteMobileSessionBoundary } from './remoteMobileBoundary';

export function RemoteMobileHeader({ scope, onOpenSessions, menuOpen, onToggleMenu, surfaceShortcuts }: {
  scope: RemoteMobileSession;
  onOpenSessions: () => void;
  menuOpen: boolean;
  onToggleMenu: () => void;
  surfaceShortcuts?: { activePanel: 'files' | 'changes' | null; changesDirty: boolean; onToggleFiles: () => void; onToggleChanges: () => void };
}) {
  const { t } = useI18n();
  const [metadataOpen, setMetadataOpen] = React.useState(false);
  const closeAndOpenSessions = useEvent(() => { setMetadataOpen(false); onOpenSessions(); });
  const closeAndToggleMenu = useEvent(() => { setMetadataOpen(false); onToggleMenu(); });
  const onMetadataChange = useEvent((open: boolean) => { if (open && menuOpen) onToggleMenu(); setMetadataOpen(open); });
  React.useEffect(() => setMetadataOpen(false), [scope.key, scope.sessionId]);
  const projectLabel = scope.project?.label?.trim() || scope.project?.path.split(/[\\/]/).filter(Boolean).at(-1) || t('mobile.header.noProject');
  return <RemoteMobileSessionBoundary scope={scope}><MobileSurfaceHeader>
    <Button variant="ghost" size="icon" aria-label={t('mobile.sessions.openSheetAria')} onClick={closeAndOpenSessions}><Icon name="folders" className="size-5" /></Button>
    <div className="flex min-w-0 flex-1 flex-col px-2 py-1.5 text-left leading-tight">
      <span className="truncate typography-ui-label text-foreground">{scope.session?.title?.trim() || (scope.sessionId ? t('mobile.sessions.untitled') : projectLabel)}</span>
      <span className="inline-flex min-w-0 items-center gap-1 typography-micro text-muted-foreground"><Icon name="computer" className="size-3 shrink-0" /><span className="truncate">{scope.sessionId ? `${projectLabel} · ` : ''}{scope.host?.name ?? scope.entry?.location.hostId}</span></span>
    </div>
    <MobileContextProgressButton sessionId={scope.sessionId ?? ''} open={metadataOpen} onOpenChange={onMetadataChange} />
    {surfaceShortcuts ? <>
      <Button variant="ghost" size="icon" aria-label={t('mobile.menu.files')} aria-pressed={surfaceShortcuts.activePanel === 'files'} onClick={surfaceShortcuts.onToggleFiles}><Icon name="file-text" className="size-5" /></Button>
      <Button variant="ghost" size="icon" className="relative" aria-label={t('mobile.menu.changes')} aria-pressed={surfaceShortcuts.activePanel === 'changes'} onClick={surfaceShortcuts.onToggleChanges}>
        <Icon name="git-branch" className="size-5" />
        {surfaceShortcuts.changesDirty ? <span className="absolute right-2 top-2 size-2 rounded-full bg-primary" aria-hidden /> : null}
      </Button>
    </> : null}
    <Button variant="ghost" size="icon" aria-label={t('mobile.header.openMenuAria')} aria-controls="mobile-overflow-menu" aria-expanded={menuOpen} aria-haspopup="menu" onClick={closeAndToggleMenu}><Icon name="more-2" className="size-5" /></Button>
  </MobileSurfaceHeader></RemoteMobileSessionBoundary>;
}
