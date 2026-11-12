import React from 'react';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { MobileResizableSheet } from '@/components/ui/MobileResizableSheet';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { RemoteHost } from '@/lib/remote-projects/types';

/** One presentation owner for machine, local-directory and remote-directory steps. */
export function DirectoryExplorerSurface({ open, onOpenChange, mobile, children, footer, trailing, hints, initialFocus }: {
  open: boolean; onOpenChange(open: boolean): void; mobile: boolean;
  children: React.ReactNode; footer: React.ReactNode; trailing?: React.ReactNode;
  hints?: React.ReactNode; initialFocus?: false;
}) {
  const { t } = useI18n();
  const title = t('directoryExplorerDialog.title');
  if (mobile) return <MobileResizableSheet id="mobile-directory-explorer-sheet" open={open} onOpenChange={onOpenChange}
    title={<h2 className="yuri-directory-title truncate text-foreground">{title}</h2>} trailing={trailing}
    ariaLabel={title} closeAriaLabel={t('mobile.surface.closeAria')} resizeAriaLabel={t('mobile.sessions.sheet.resizeAria')}
    initiallyExpanded className="yuri-directory-mobile">
    {children}<div className="yuri-directory-footer">{footer}</div>
  </MobileResizableSheet>;
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent presentation="picker" className="yuri-directory-dialog" initialFocus={initialFocus}>
      <DialogHeader className="yuri-directory-header">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <DialogTitle className="yuri-directory-title truncate">{title}</DialogTitle>{trailing}
        </div>
      </DialogHeader>
      {children}<DialogFooter className="yuri-directory-footer">{hints}{footer}</DialogFooter>
    </DialogContent>
  </Dialog>;
}

export function DirectoryMachineList({ hosts, selectedId, onSelect, pending, error, onRetry, steps }: {
  hosts: RemoteHost[]; selectedId: string; onSelect(id: string): void;
  pending: boolean; error: Error | null; onRetry(): void; steps: React.ReactNode;
}) {
  const { t } = useI18n();
  return <div className="yuri-directory-content">
    <div className="yuri-directory-inputs">{steps}
      {error ? <p role="alert" className="typography-micro text-destructive">{error.message}
        <Button size="xs" variant="ghost" onClick={onRetry}>{t('remoteProjects.retry')}</Button>
      </p> : null}
    </div>
    <ScrollableOverlay outerClassName="yuri-directory-results" className="yuri-directory-list" disableHorizontal>
      <div className={cn('yuri-directory-row', !selectedId && 'bg-interactive-selection')}>
        <button type="button" className="yuri-directory-entry" aria-pressed={!selectedId} onClick={() => onSelect('')}>
          <Icon name="computer" className="size-4 shrink-0 text-muted-foreground" />
          <span className="yuri-directory-name flex-1">{t('remoteProjects.local')}</span>
          {!selectedId ? <Icon name="check" className="size-4 shrink-0" /> : null}
        </button>
      </div>
      {hosts.map((host) => <div key={host.id} className={cn('yuri-directory-row', selectedId === host.id && 'bg-interactive-selection')}>
        <button type="button" className="yuri-directory-entry disabled:cursor-not-allowed disabled:opacity-50"
          aria-pressed={selectedId === host.id} disabled={host.state === 'unauthorized' || host.state === 'incompatible'} onClick={() => onSelect(host.id)}>
          <Icon name="computer" className="size-4 shrink-0 text-muted-foreground" />
          <span className="yuri-directory-name min-w-0 flex-1 truncate">{host.name}</span>
          <span className="shrink-0 typography-micro text-muted-foreground">{t(`remoteProjects.state.${host.state}`)}</span>
          {selectedId === host.id ? <Icon name="check" className="size-4 shrink-0" /> : null}
        </button>
      </div>)}
      {pending ? <p role="status" className="yuri-directory-empty text-muted-foreground">{t('common.loading')}</p> : null}
    </ScrollableOverlay>
  </div>;
}
