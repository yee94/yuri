import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { useDeviceInfo } from '@/lib/device';
import { useI18n } from '@/lib/i18n';
import type { HostRuntimeRegistry } from '@/lib/remote-projects/registry';
import type { RemoteProject } from '@/lib/remote-projects/types';
import { Icon } from '@/components/icon/Icon';
import { useRemoteDirectoryExplorerModel } from './useRemoteDirectoryExplorerModel';
import { DirectoryExplorerSurface } from './DirectoryExplorerViews';

interface Props {
  open: boolean;
  onOpenChange(open: boolean): void;
  forceMobile?: boolean;
  registry: HostRuntimeRegistry;
  hostId: string;
  machinePicker: React.ReactNode;
  onRegistered(project: RemoteProject): Promise<void>;
}

/** All filesystem arguments remain physical paths; only transport and query keys carry identity. */
export function RemoteDirectoryExplorerDialog({ open, onOpenChange, forceMobile, registry, hostId, machinePicker, onRegistered }: Props) {
  const { t } = useI18n();
  const device = useDeviceInfo();
  const { directory, setPath, pending, error, home, listing, submit } = useRemoteDirectoryExplorerModel({ open, registry, hostId, onOpenChange, onRegistered });
  const body = <div className="yuri-directory-content">
    <div className="yuri-directory-inputs">
      <fieldset disabled={pending} className="min-w-0">{machinePicker}</fieldset>
      <div className="yuri-directory-field">
        <Icon name="folder-add" className="size-4 shrink-0 text-muted-foreground" />
        <Input className="min-w-0 flex-1 font-mono" aria-label={t('directoryExplorerDialog.pathInput.placeholder')} value={directory} onChange={(event) => setPath(event.target.value)} disabled={pending} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
      </div>
    </div>
    <ScrollableOverlay className="yuri-directory-list" outerClassName="yuri-directory-results" disableHorizontal>
      {listing.isFetching || home.isPending ? <p role="status" className="yuri-directory-name flex items-center justify-center gap-2 py-3 text-muted-foreground"><Icon name="refresh" className="size-3.5 animate-spin" />{t('directoryExplorerDialog.browse.loading')}</p> : null}
      {!home.isPending && !listing.isPending ? <><div className="yuri-directory-row hover:bg-interactive-hover/50">
        <button type="button" className="yuri-directory-entry" disabled={pending || !directory || directory === '/'} onClick={() => setPath(directory.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]+$/, '') || '/')} aria-label={t('remoteProjects.parent')}>
          <Icon name="arrow-left-s" className="size-4 shrink-0 text-muted-foreground" /><span className="yuri-directory-name">..</span>
        </button>
      </div>
      {listing.data?.map((child) => <div key={child.path} className="yuri-directory-row hover:bg-interactive-hover/50">
        <button type="button" className="yuri-directory-entry" disabled={pending} onClick={() => setPath(child.path)}>
          <Icon name="folder-6" className="size-4 shrink-0 text-muted-foreground" /><span className="yuri-directory-name truncate">{child.name}</span>
        </button>
      </div>)}</> : null}
    </ScrollableOverlay>
  </div>;
  const footer = <div className="yuri-directory-actions">
    <Button variant="ghost" size="xs" disabled={pending || !directory} onClick={() => void submit(true)}>{t('directoryExplorerDialog.actions.createAndAdd')}</Button>
    <Button size="xs" disabled={pending || !directory || listing.isError || listing.isPending} onClick={() => void submit(false)}>{t(pending ? 'directoryExplorerDialog.actions.adding' : 'directoryExplorerDialog.actions.addProject')}</Button>
  </div>;
  const changeOpen = (next: boolean) => { if (!pending) onOpenChange(next); };
  return <DirectoryExplorerSurface open={open} onOpenChange={changeOpen} mobile={forceMobile ?? device.isMobile} footer={footer}
    error={error?.message || home.error?.message || listing.error?.message}>{body}</DirectoryExplorerSurface>;
}
