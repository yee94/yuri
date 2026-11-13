import React from 'react';
import { useEvent } from '@reactuses/core';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { useI18n } from '@/lib/i18n';
import { HostRuntimeProvider } from '@/contexts/HostRuntimeProvider';
import { NewWorktreeDialog } from '../NewWorktreeDialog';
import { useMobileNavigationStore } from '@/mobile/useMobileNavigationStore';
import { useRemoteProjectSectionModel, type RemoteProjectSectionOptions } from './hooks/useRemoteProjectSectionModel';
import { RemoteProjectShell, RemoteSummaryRow } from './RemoteProjectRows';
import { derivePinnedSessions, listInProgressHomeSessions } from './pinnedSessions';
import type { RemoteSummaryRowProps } from './remoteProjectPresentation';
import { locationSessionKey } from '@/lib/remote-projects/location';
import type { PinnedItem } from './SidebarPinnedSessions';
import { MobileRemoteSummaryRow } from './RemoteProjectMobileViews';
import { RemoteProjectIcon } from './RemoteProjectResources';
import { RemoteSessionGroups } from './RemoteSessionGroups';
import { RemoteMobileSessionGroups } from './RemoteMobileSessionGroups';
import { toast } from '@/components/ui';

export const RemoteProjectSection = React.memo(function RemoteProjectSection(props: RemoteProjectSectionOptions & {
  onActivityItems?: (projectId: string, items: PinnedItem[]) => void;
}) {
  const { project, registry, mobile = false } = props;
  const { t } = useI18n();
  const model = useRemoteProjectSectionModel(props);
  const { data, pending, editor } = model;
  const { online, snapshot } = data;
  React.useEffect(() => {
    if (data.error) toast.error(data.error, { id: `remote-project:${project.id}:load` });
  }, [data.error, project.id]);
  const publishActivity = useEvent(() => {
    if (!props.onActivityItems) return;
    const sessions = data.rows.map(({ session }) => session);
    const sessionsById = new Map(sessions.map((session) => [session.id, session]));
    const running = new Set(sessions.filter((session) => {
      const status = (session.metadata as { yuri?: { sessionStatus?: { type?: string } } } | undefined)?.yuri?.sessionStatus?.type;
      return online && (status === 'busy' || status === 'retry');
    }).map((session) => session.id));
    const unseen = Object.fromEntries(Object.entries(snapshot?.unread?.sessions ?? {}).map(([id, value]) => [id, value.unreadCount]));
    const attention = listInProgressHomeSessions(sessions, data.pinnedIds, running, unseen);
    // Pin membership is Host-owned; the display order lives with the connected server, so no Host order is read here.
    const pinnedRoots = derivePinnedSessions(sessions.filter((session) => !session.time?.archived
      && !(session as { parentID?: string | null }).parentID), data.pinnedIds);
    const pinnedSet = new Set(pinnedRoots.map((session) => session.id));
    props.onActivityItems(project.id, [...pinnedRoots, ...attention].map((session) => {
      const original = sessionsById.get(session.id)!;
      const directory = session.directory || project.path;
      const identity = locationSessionKey({ hubId: registry.hubId, hostId: project.hostId, directory }, session.id);
      const rowProps = model.sessionProps(original, directory);
      // The pinned list sorts by identity (the key stored in the connected server's `__pinned__` order).
      const dragProps: RemoteSummaryRowProps = pinnedSet.has(session.id) ? { ...rowProps, dragItem: { directory, id: identity } } : rowProps;
      return { node: { session: { ...session, id: identity }, children: [], worktree: null }, projectId: project.id, groupDirectory: directory,
        identity, remoteSessionId: session.id, pinned: pinnedSet.has(session.id),
        secondaryMeta: { projectLabel: model.projectProps.label },
        content: mobile ? <MobileRemoteSummaryRow {...rowProps} />
          : <RemoteSummaryRow {...dragProps} depth={0} /> };
    }));
  });
  React.useLayoutEffect(() => { publishActivity(); }, [publishActivity, data.rows, data.pinnedIds, snapshot, online, pending, model.selectedSession, project, registry, props.onActivityItems, mobile]);
  const { onActivityItems } = props;
  React.useEffect(() => () => onActivityItems?.(project.id, []), [project.id, onActivityItems]);
  if (data.hidden) return null;
  return <RemoteProjectShell {...model.projectProps} mobile={mobile}
    iconSlot={project.iconImage ? <RemoteProjectIcon project={project} registry={registry} className={mobile ? 'size-6' : 'size-4'} /> : undefined}>
    <div className="min-w-0" data-remote-project={project.id} hidden={model.projectProps.collapsed}>
      {model.bulk.count ? <div className="flex flex-wrap items-center gap-1">
        <Button size="xs" disabled={!online || pending} onClick={model.bulk.archive}>{t('sessions.sidebar.bulkActions.archive')}</Button>
        <Button size="xs" variant="destructive" disabled={!online || pending} onClick={model.bulk.delete}>{t('sessions.sidebar.bulkActions.delete')}</Button>
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
    {model.deleteTargets ? <Dialog open onOpenChange={(open) => { if (!open) model.dismissDelete(); }}><DialogContent showCloseButton={false} className="max-w-sm">
      <DialogHeader><DialogTitle>{t(model.deleteTargets.length === 1 ? 'sessions.sidebar.dialogs.deleteSession.title' : 'sessions.sidebar.dialogs.deleteSessions.title')}</DialogTitle>
        <DialogDescription>{model.deleteTargets.length === 1
          ? t('sessions.sidebar.dialogs.deleteSession.single', { sessionTitle: model.deleteTargets[0].title || t('sessions.sidebar.session.untitled') })
          : t('sessions.sidebar.dialogs.deleteSessions.pluralDescription', { count: model.deleteTargets.length })}</DialogDescription>
        <DialogDescription>{t('sessions.sidebar.sessionDialogs.delete.note')}</DialogDescription>
      </DialogHeader>
      <DialogFooter><Button variant="ghost" disabled={pending} onClick={model.dismissDelete}>{t('sessions.sidebar.dialogs.cancel')}</Button>
        <Button disabled={pending || !online} onClick={model.confirmDelete}>{t('sessions.sidebar.bulkActions.delete')}</Button></DialogFooter>
    </DialogContent></Dialog> : null}
    {model.worktreeOpen ? <HostRuntimeProvider registry={registry} location={{ hubId: registry.hubId, hostId: project.hostId, directory: project.path }}><NewWorktreeDialog projectId={project.id} open onOpenChange={model.setWorktreeOpen} onWorktreeCreated={() => { if (mobile) useMobileNavigationStore.getState().openRemoteProject(); }} /></HostRuntimeProvider> : null}
  </RemoteProjectShell>;
});
