import React from 'react';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { MobileResizableSheet } from '@/components/ui/MobileResizableSheet';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { RemoteHost } from '@/lib/remote-projects/types';

/** One presentation owner for machine, local-directory and remote-directory steps. */
export function DirectoryExplorerSurface({ open, onOpenChange, mobile, children, footer, trailing, hints, initialFocus, error }: {
  open: boolean; onOpenChange(open: boolean): void; mobile: boolean;
  children: React.ReactNode; footer: React.ReactNode; trailing?: React.ReactNode;
  hints?: React.ReactNode; initialFocus?: false;
  error?: string;
}) {
  const { t } = useI18n();
  const title = t('directoryExplorerDialog.title');
  const headerActions = <div className="flex shrink-0 items-center gap-2">{trailing}<DirectoryErrorIndicator message={error} /></div>;
  if (mobile) return <MobileResizableSheet id="mobile-directory-explorer-sheet" open={open} onOpenChange={onOpenChange}
    title={<h2 className="yuri-directory-title truncate text-foreground">{title}</h2>} trailing={headerActions}
    ariaLabel={title} closeAriaLabel={t('mobile.surface.closeAria')} resizeAriaLabel={t('mobile.sessions.sheet.resizeAria')}
    initiallyExpanded className="yuri-directory-mobile">
    {children}<div className="yuri-directory-footer">{footer}</div>
  </MobileResizableSheet>;
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent presentation="picker" className="yuri-directory-dialog" initialFocus={initialFocus}>
      <DialogHeader className="yuri-directory-header">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <DialogTitle className="yuri-directory-title truncate">{title}</DialogTitle>{headerActions}
        </div>
      </DialogHeader>
      {children}<DialogFooter className="yuri-directory-footer">{hints}{footer}</DialogFooter>
    </DialogContent>
  </Dialog>;
}

function DirectoryErrorIndicator({ message, children }: { message?: string; children?: React.ReactNode }) {
  return <span className="yuri-directory-status-slot" aria-hidden={!message && !children ? true : undefined}>
    {message ? <Tooltip delayDuration={0}>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-[var(--status-error)] hover:text-[var(--status-error)]" aria-label={message}>
          <Icon name="error-warning" className="size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4} positionerClassName="z-[70]" className="max-w-[min(24rem,calc(100vw-2rem))] whitespace-pre-wrap break-words text-left">{message}</TooltipContent>
    </Tooltip> : children}
  </span>;
}

export function DirectoryMachineActions({ pending, failed, canContinue, onNext, onAddSsh }: {
  pending: boolean; failed: boolean; canContinue: boolean; onNext(): void; onAddSsh(): void;
}) {
  const { t } = useI18n();
  return <div className="yuri-directory-machine-actions">
    <Button variant="ghost" size="xs" className="-ml-1.5 gap-2" onClick={onAddSsh}>
      <Icon name="add" className="size-4 shrink-0" />
      {t('settings.remoteInstances.sidebar.actions.addSshInstance')}
    </Button>
    <Button size="xs" className="min-w-16" disabled={!canContinue} aria-busy={pending} onClick={onNext}>
      {t(pending ? 'remoteProjects.state.connecting' : failed ? 'remoteProjects.retry' : 'remoteProjects.next')}
    </Button>
  </div>;
}

export function DirectoryMachineList({ hosts, selectedId, onSelect, pending, error, steps, canContinue, onNext }: {
  hosts: RemoteHost[]; selectedId: string; onSelect(id: string): void;
  pending: boolean; error: Error | null; steps: React.ReactNode;
  canContinue: boolean; onNext(): void;
}) {
  const { t } = useI18n();
  return <div className="yuri-directory-content" onKeyDown={(event) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229 || event.altKey || event.ctrlKey || event.metaKey) return;
    if (!(event.target instanceof HTMLElement) || !event.target.closest('.yuri-directory-entry')) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      if (!event.repeat && canContinue) onNext();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const entries = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('.yuri-directory-entry:not(:disabled)'));
    const index = entries.indexOf(event.target.closest<HTMLButtonElement>('.yuri-directory-entry')!);
    const next = entries[(index + (event.key === 'ArrowDown' ? 1 : -1) + entries.length) % entries.length];
    next?.focus({ preventScroll: true });
    next?.scrollIntoView({ block: 'nearest' });
  }}>
    <div className="yuri-directory-inputs">{steps}</div>
    <ScrollableOverlay outerClassName="yuri-directory-results" className="yuri-directory-list" disableHorizontal>
      <div className={cn('yuri-directory-row', !selectedId && 'bg-interactive-selection')}>
        <button type="button" className="yuri-directory-entry" aria-pressed={!selectedId} autoFocus={!selectedId}
          onFocus={() => { if (selectedId) onSelect(''); }} onClick={() => onSelect('')}>
          <Icon name="computer" className="size-4 shrink-0 text-muted-foreground" />
          <span className="yuri-directory-name flex-1">{t('remoteProjects.local')}</span>
        </button>
        <DirectoryErrorIndicator>{!selectedId ? <Icon name="check" className="size-3.5" /> : null}</DirectoryErrorIndicator>
      </div>
      {hosts.map((host) => <div key={host.id} className={cn('yuri-directory-row', selectedId === host.id && 'bg-interactive-selection')}>
        <button type="button" className="yuri-directory-entry disabled:cursor-not-allowed disabled:opacity-50"
          autoFocus={selectedId === host.id} onFocus={() => { if (selectedId !== host.id) onSelect(host.id); }}
          aria-pressed={selectedId === host.id} disabled={host.state === 'unauthorized' || host.state === 'incompatible'} onClick={() => onSelect(host.id)}>
          <Icon name="computer" className="size-4 shrink-0 text-muted-foreground" />
          <span className="yuri-directory-name min-w-0 flex-1 truncate">{host.name}</span>
          <span className="yuri-directory-name shrink-0 text-muted-foreground">{t(`remoteProjects.state.${host.state}`)}</span>
        </button>
        <DirectoryErrorIndicator message={selectedId === host.id ? error?.message : undefined}>
          {selectedId === host.id ? <Icon name="check" className="size-3.5" /> : null}
        </DirectoryErrorIndicator>
      </div>)}
      {pending ? <p role="status" className="yuri-directory-empty text-muted-foreground">{t('common.loading')}</p> : null}
    </ScrollableOverlay>
  </div>;
}
