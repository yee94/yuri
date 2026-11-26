import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { useDeviceInfo } from '@/lib/device';
import { useI18n } from '@/lib/i18n';
import type { HostRuntimeRegistry } from '@/lib/remote-projects/registry';
import type { RemoteProject } from '@/lib/remote-projects/types';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { normalizeDirectoryKey } from '@/lib/pathNormalization';
import { useRemoteDirectoryExplorerModel } from './useRemoteDirectoryExplorerModel';
import { asDirectoryInput, parentDirectoryInput, trimDirectoryPath } from './remoteDirectoryBrowsePath';
import { partitionByFuzzyQuery } from '@/lib/search/fuzzySearch';
import { DirectoryExplorerSurface } from './DirectoryExplorerViews';

interface Props {
  open: boolean;
  onOpenChange(open: boolean): void;
  forceMobile?: boolean;
  origin?: { x: number; y: number };
  registry: HostRuntimeRegistry;
  hostId: string;
  machinePicker: React.ReactNode;
  onRegistered?(project: RemoteProject): Promise<void>;
  /** Edits this remote workspace's directories on its own Host. */
  editProject?: RemoteProject;
}

/** All filesystem arguments remain physical paths; only transport and query keys carry identity. */
export function RemoteDirectoryExplorerDialog({ open, onOpenChange, forceMobile, origin, registry, hostId, machinePicker, onRegistered, editProject }: Props) {
  const { t } = useI18n();
  const device = useDeviceInfo();
  const workspaceNameId = React.useId();
  const model = useRemoteDirectoryExplorerModel({ open, registry, hostId, onOpenChange, onRegistered, editProject });
  const { input, browse, setPath, pending, error, home, listing, submit, workspaceMode, stagedPaths } = model;
  const stagedKeys = React.useMemo(() => new Set(stagedPaths.map(normalizeDirectoryKey)), [stagedPaths]);
  const entries = React.useMemo(() => partitionByFuzzyQuery(listing.data ?? [], browse.filter, (child) => child.name).matching, [listing.data, browse.filter]);
  const multipleProjectsToggle = editProject ? null : (
    <Button type="button" variant="ghost" size="xs" role="checkbox" aria-checked={workspaceMode} disabled={pending}
      onClick={() => model.setWorkspaceMode(!workspaceMode)}
      className={cn('yuri-directory-hidden-toggle shrink-0', workspaceMode ? 'text-foreground' : 'text-muted-foreground')}>
      <Icon name={workspaceMode ? 'checkbox' : 'checkbox-blank'} className="size-3.5" />
      {t('directoryExplorerDialog.toggle.multipleProjects')}
    </Button>
  );
  const body = <div className="yuri-directory-content">
    <div className="yuri-directory-inputs">
      <fieldset disabled={pending} className="min-w-0">{machinePicker}</fieldset>
      {workspaceMode ? <p data-workspace-machine-hint className="yuri-directory-name pb-1 text-muted-foreground">{t('workspace.paths.sameMachineHint')}</p> : null}
      {workspaceMode && !editProject ? (
        <div className="yuri-directory-workspace-name">
          <label htmlFor={workspaceNameId}>{t('workspace.create.namePlaceholder')}</label>
          <Input id={workspaceNameId} type="text" value={model.workspaceName} onChange={(event) => model.changeWorkspaceName(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); model.saveWorkspace(); } }}
            required disabled={pending} maxLength={80} aria-invalid={model.workspaceNameError || undefined}
            aria-describedby={model.workspaceNameError ? `${workspaceNameId}-error` : undefined} />
          {model.workspaceNameError ? <p id={`${workspaceNameId}-error`} role="alert">{t('workspace.create.nameRequired')}</p> : null}
        </div>
      ) : null}
      <div className="yuri-directory-field">
        <Icon name="folder-add" className="size-4 shrink-0 text-muted-foreground" />
        <Input className="min-w-0 flex-1 font-mono" aria-label={t('directoryExplorerDialog.pathInput.placeholder')} value={input} onChange={(event) => setPath(event.target.value)} disabled={pending} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
      </div>
      {workspaceMode && stagedPaths.length > 0 ? (
        <div className="yuri-directory-chips">
          {stagedPaths.map((stagedPath, index) => (
            <span key={stagedPath} className="yuri-directory-chip" title={stagedPath}>
              <span className="truncate">{stagedPath.split(/[\\/]/).filter(Boolean).at(-1) || stagedPath}</span>
              {index === 0 && stagedPaths.length > 1 ? (
                <span className="shrink-0 text-muted-foreground">· {t('workspace.paths.primaryBadge')}</span>
              ) : editProject && index > 0 ? (
                <Button type="button" variant="ghost" size="xs" disabled={pending} onClick={() => model.makePrimary(stagedPath)}>
                  {t('workspace.paths.setPrimary')}
                </Button>
              ) : null}
              <button type="button" disabled={pending} onClick={() => model.toggleStagedPath(stagedPath)}
                aria-label={t('workspace.paths.removeAria', { path: stagedPath })} className="yuri-directory-chip-remove">
                <Icon name="close" className="size-2.5" />
              </button>
            </span>
          ))}
        </div>
      ) : null}
    </div>
    <ScrollableOverlay className="yuri-directory-list" outerClassName="yuri-directory-results" disableHorizontal>
      {listing.isFetching || home.isPending ? <p role="status" className="yuri-directory-name flex items-center justify-center gap-2 py-3 text-muted-foreground"><Icon name="refresh" className="size-3.5 animate-spin" />{t('directoryExplorerDialog.browse.loading')}</p> : null}
      {!home.isPending && !listing.isPending ? <><div className="yuri-directory-row hover:bg-interactive-hover/50">
        <button type="button" className="yuri-directory-entry" disabled={pending || !browse.directory || browse.directory === '/'} onClick={() => setPath(parentDirectoryInput(browse.directory))} aria-label={t('remoteProjects.parent')}>
          <Icon name="arrow-left-s" className="size-4 shrink-0 text-muted-foreground" /><span className="yuri-directory-name">..</span>
        </button>
      </div>
      {entries.map((child) => {
        const staged = stagedKeys.has(normalizeDirectoryKey(child.path));
        return <div key={child.path} className="yuri-directory-row hover:bg-interactive-hover/50">
          <button type="button" className="yuri-directory-entry" disabled={pending} onClick={() => setPath(asDirectoryInput(child.path))}>
            <Icon name="folder-6" className="size-4 shrink-0 text-muted-foreground" /><span className="yuri-directory-name truncate">{child.name}</span>
          </button>
          {workspaceMode ? (
            <Button type="button" variant="ghost" size="icon" role="checkbox" aria-checked={staged} disabled={pending}
              onClick={() => model.toggleStagedPath(child.path)}
              className={cn('shrink-0', staged ? 'text-foreground' : 'text-muted-foreground hover:text-foreground')}
              title={t('workspace.create.stageDirAria', { name: child.name })} aria-label={t('workspace.create.stageDirAria', { name: child.name })}>
              <Icon name={staged ? 'checkbox' : 'checkbox-blank'} className="h-3.5 w-3.5" />
            </Button>
          ) : null}
        </div>;
      })}</> : null}
    </ScrollableOverlay>
  </div>;
  const directory = trimDirectoryPath(input);
  const footer = workspaceMode ? <div className="yuri-directory-actions">
    {editProject ? <Button variant="ghost" size="xs" disabled={pending} onClick={() => onOpenChange(false)}>{t('projectEditDialog.actions.cancel')}</Button> : null}
    <Button size="xs" disabled={pending || stagedPaths.length === 0} aria-busy={pending} onClick={() => model.saveWorkspace()}>
      {editProject ? t('projectEditDialog.actions.save') : pending ? t('directoryExplorerDialog.actions.adding') : t('workspace.create.submit')}
    </Button>
  </div> : <div className="yuri-directory-actions">
    <Button variant="ghost" size="xs" disabled={pending || !directory} onClick={() => void submit(true)}>{t('directoryExplorerDialog.actions.createAndAdd')}</Button>
    <Button size="xs" disabled={pending || !directory || listing.isError || listing.isPending} onClick={() => void submit(false)}>{t(pending ? 'directoryExplorerDialog.actions.adding' : 'directoryExplorerDialog.actions.addProject')}</Button>
  </div>;
  const changeOpen = (next: boolean) => { if (!pending) onOpenChange(next); };
  return <DirectoryExplorerSurface open={open} onOpenChange={changeOpen} origin={origin} mobile={forceMobile ?? device.isMobile} footer={footer}
    trailing={multipleProjectsToggle} stacked={Boolean(editProject)} title={editProject ? t('workspace.paths.sectionTitle') : undefined}
    error={error?.message || home.error?.message || listing.error?.message}>{body}</DirectoryExplorerSurface>;
}
