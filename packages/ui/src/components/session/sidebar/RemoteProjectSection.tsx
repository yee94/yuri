import React from 'react';
import { useEvent } from '@reactuses/core';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { useI18n } from '@/lib/i18n';
import { HostRuntimeProvider } from '@/contexts/HostRuntimeProvider';
import { NewWorktreeDialog } from '../NewWorktreeDialog';
import { useMobileNavigationStore } from '@/mobile/useMobileNavigationStore';
import { useRemoteProjectSectionModel, type RemoteProjectSectionOptions } from './hooks/useRemoteProjectSectionModel';
import { RemoteProjectShell, RemoteSummaryRow } from './RemoteProjectRows';
import { listInProgressHomeSessions } from './pinnedSessions';
import { locationSessionKey } from '@/lib/remote-projects/location';
import type { PinnedItem } from './SidebarPinnedSessions';
import { RemoteProjectIcon } from './RemoteProjectResources';
import { RemoteSessionGroups } from './RemoteSessionGroups';
import { RemoteMobileSessionGroups } from './RemoteMobileSessionGroups';

export const RemoteProjectSection = React.memo(function RemoteProjectSection(props: RemoteProjectSectionOptions & {
  onActivityItems?: (projectId: string, items: PinnedItem[]) => void;
}) {
  const { project, registry, mobile = false } = props;
  const { t } = useI18n();
  const model = useRemoteProjectSectionModel(props);
  const { data, pending, editor } = model;
  const { online, snapshot, host } = data;
  const publishActivity = useEvent(() => {
    if (!props.onActivityItems) return;
    const sessions = data.rows.map(({ session }) => session);
    const running = new Set(sessions.filter((session) => {
      const status = model.sessionProps(session, session.directory || project.path).status;
      return online && (status === 'busy' || status === 'retry');
    }).map((session) => session.id));
    const unseen = Object.fromEntries(Object.entries(snapshot?.unread?.sessions ?? {}).map(([id, value]) => [id, value.unreadCount]));
    const attention = listInProgressHomeSessions(sessions, data.pinnedIds, running, unseen);
    props.onActivityItems(project.id, attention.map((session) => {
      const original = sessions.find((candidate) => candidate.id === session.id)!;
      const directory = session.directory || project.path;
      return { node: { session, children: [], worktree: null }, projectId: project.id, groupDirectory: directory,
        identity: locationSessionKey({ hubId: registry.hubId, hostId: project.hostId, directory }, session.id),
        secondaryMeta: { projectLabel: model.projectProps.label },
        content: <RemoteSummaryRow {...model.sessionProps(original, directory)} depth={0} /> };
    }));
  });
  React.useLayoutEffect(() => { publishActivity(); }, [publishActivity, data.rows, data.pinnedIds, snapshot, online, pending, model.selectedSession, project, registry, props.onActivityItems]);
  const { onActivityItems } = props;
  React.useEffect(() => () => onActivityItems?.(project.id, []), [project.id, onActivityItems]);
  if (data.hidden) return null;
  return <RemoteProjectShell {...model.projectProps} mobile={mobile}
    iconSlot={project.iconImage ? <RemoteProjectIcon project={project} registry={registry} className={mobile ? 'size-6' : 'size-4'} /> : undefined}>
    <div className="min-w-0" data-remote-project={project.id} hidden={model.projectProps.collapsed}>
      {!online ? <p className="text-xs text-muted-foreground">{t(`remoteProjects.state.${host?.state ?? 'offline'}`)} · {t('remoteProjects.unknown')}{snapshot?.lastSyncedAt ? ` · ${t('remoteProjects.lastSync', { time: new Date(snapshot.lastSyncedAt).toLocaleString() })}` : ''}</p> : null}
      {model.error ? <p role="alert" className="break-words text-xs text-destructive">{model.error}<Button size="xs" variant="ghost" onClick={() => void data.refresh()}>{t('remoteProjects.retry')}</Button></p> : null}
      {model.bulk.count ? <div className="flex flex-wrap items-center gap-1">
        <Button size="xs" disabled={!online || pending} onClick={model.bulk.archive}>{t('sessions.sidebar.bulkActions.archive')}</Button>
        <Button size="xs" disabled={!online || pending} onClick={() => model.newFolder()}>{t('remoteProjects.newFolder')}</Button>
        {model.bulk.folders.map((folder) => <Button key={folder.id} size="xs" variant="ghost" disabled={!online || pending} onClick={folder.move}>{folder.name}</Button>)}
        <Button size="xs" variant="ghost" onClick={model.bulk.clear}>{t('sessions.sidebar.dialogs.cancel')}</Button>
      </div> : null}
      {mobile ? <RemoteMobileSessionGroups model={model} project={project} /> : <RemoteSessionGroups model={model} project={project} registry={registry} />}
      {editor ? <Dialog open onOpenChange={(open) => { if (!open && !pending) model.setEditor(null); }}><DialogContent><DialogHeader><DialogTitle>{t(editor.kind === 'title' ? 'sessions.sidebar.session.menu.rename' : editor.kind === 'project' ? 'sessions.sidebar.project.actions.edit' : 'remoteProjects.newFolder')}</DialogTitle></DialogHeader>
        <form onSubmit={(event) => { event.preventDefault(); model.saveEditor(); }}><Input aria-label={t('sessions.sidebar.session.menu.rename')} value={editor.value} onChange={(event) => model.setEditor({ ...editor, value: event.target.value })} autoFocus disabled={pending} />
          {editor.kind === 'project' ? <><Input aria-label={t('remoteProjects.icon')} value={model.projectIcon} onChange={(event) => model.setProjectIcon(event.target.value)} /><Input aria-label={t('remoteProjects.color')} value={model.projectColor} onChange={(event) => model.setProjectColor(event.target.value)} /></> : null}
          <DialogFooter><Button type="submit" disabled={pending || !online || !editor.value.trim()}>{t('sessions.sidebar.session.rename.save')}</Button></DialogFooter></form>
      </DialogContent></Dialog> : null}
    </div>
    {model.worktreeOpen ? <HostRuntimeProvider registry={registry} location={{ hubId: registry.hubId, hostId: project.hostId, directory: project.path }}><NewWorktreeDialog projectId={project.id} open onOpenChange={model.setWorktreeOpen} onWorktreeCreated={() => { if (mobile) useMobileNavigationStore.getState().openRemoteProject(); }} /></HostRuntimeProvider> : null}
  </RemoteProjectShell>;
});
