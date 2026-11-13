import React from 'react';
import { useI18n } from '@/lib/i18n';
import { PROJECT_ICON_MAP } from '@/lib/projectMeta';
import { MobileProjectSurface } from '@/mobile/projects/MobileProjectCard';
import { MobileSessionRow } from '@/mobile/projects/MobileSessionRow';
import { MobileActionSheet } from '@/mobile/projects/MobileRowActionsSheet';
import { formatSessionCompactDateLabel } from './utils';
import type { RemoteProjectShellProps, RemoteSummaryRowProps } from './remoteProjectPresentation';

/** Mobile adapters only translate presentation and user intent; remote IO belongs to the model. */
export function MobileRemoteProjectShell({ project, registry, label, collapsed, sessionCount, iconSlot, actions, children }: RemoteProjectShellProps) {
  const { t } = useI18n();
  const [actionsOpen, setActionsOpen] = React.useState(false);
  const disabled = actions.disabled;
  return <MobileProjectSurface hostRegistry={registry} expanded={!collapsed}
      project={{ id: project.id, name: label, path: project.path, hostId: project.hostId,
        remoteState: project.remoteState, sessionCount, icon: project.icon ? PROJECT_ICON_MAP[project.icon] : undefined }}
      iconSlot={iconSlot} onToggle={actions.toggle} onOpenActions={() => setActionsOpen(true)}>
    {children}
    {actionsOpen ? <MobileActionSheet id={`remote-project-actions:${project.id}`} title={label} open onOpenChange={setActionsOpen} projectMenu items={[
      { id: 'newSession', icon: 'add', label: t('sessions.sidebar.project.actions.newSession'), onClick: actions.newSession, disabled },
      { id: 'newWorktree', icon: 'git-branch', label: t('sessions.sidebar.project.actions.newWorktree'), onClick: actions.newWorktree, disabled },
      { id: 'newFolder', icon: 'folder-add', label: t('remoteProjects.newFolder'), onClick: actions.newFolder, disabled },
      { id: 'sync', icon: 'refresh', label: t('sessions.sidebar.project.actions.syncSessions'), onClick: actions.sync },
      { id: 'edit', icon: 'pencil-ai', label: t('sessions.sidebar.project.actions.edit'), onClick: actions.edit, disabled },
      { id: 'close', icon: 'close', label: t('sessions.sidebar.project.actions.closeProject'), onClick: actions.close, destructive: true, separated: true },
    ]} /> : null}
  </MobileProjectSurface>;
}

export function MobileRemoteSummaryRow({ session, active, search, pending, pinDisabled = pending, pinned, unread, status, dragItem, secondaryMeta, subtitleSuffix, onSelect, onRename, onPin, onUnread, onArchive, onDelete, folders, onFolder }: RemoteSummaryRowProps) {
  const { t } = useI18n();
  const [actionsOpen, setActionsOpen] = React.useState(false);
  const title = session.title ?? t('mobile.sessions.untitled');
  const activityTime = session.time.updated || session.time.created;
  return <>
    <MobileSessionRow session={{ id: session.id, title, active, pinned, unread: Boolean(unread), archived: Boolean(session.time.archived),
      subtitle: [secondaryMeta?.projectLabel, secondaryMeta?.branchLabel?.trim()].filter(Boolean).join(' · ') || undefined,
      activityLabel: activityTime ? formatSessionCompactDateLabel(activityTime) : undefined }} highlightQuery={search} subtitleSuffix={subtitleSuffix}
      indicator={status === 'busy' || status === 'retry' ? 'running' : unread ? 'completed-unread' : 'idle'}
      onSelect={onSelect} onPin={() => { if (!pinDisabled) onPin(); }} onArchive={() => { if (!pending) onArchive(); }} onOpenActions={() => setActionsOpen(true)} />
    {actionsOpen ? <MobileActionSheet id={`remote-session-actions:${JSON.stringify([dragItem.directory, dragItem.id])}`} title={title} open onOpenChange={setActionsOpen} items={[
      { id: 'pin', icon: pinned ? 'unpin' : 'pushpin', label: t(pinned ? 'remoteProjects.unpin' : 'remoteProjects.pin'), onClick: onPin, disabled: pinDisabled },
      { id: 'unread', icon: 'check', label: t(unread ? 'remoteProjects.markRead' : 'remoteProjects.markUnread'), onClick: onUnread, disabled: pending },
      { id: 'rename', icon: 'pencil-ai', label: t('sessions.sidebar.session.menu.rename'), onClick: onRename, disabled: pending },
      { id: 'archive', icon: 'archive', label: t(session.time.archived ? 'remoteProjects.unarchive' : 'sessions.sidebar.bulkActions.archive'), onClick: onArchive, disabled: pending },
      { id: 'unfolder', icon: 'folder-open', label: t('remoteProjects.removeFolder'), onClick: () => onFolder(null), disabled: pending },
      ...folders.map((folder) => ({ id: `folder:${folder.id}`, icon: 'folder-open' as const, label: folder.name, onClick: () => onFolder(folder.id), disabled: pending })),
      { id: 'delete', icon: 'delete-bin', label: t('sessions.sidebar.dialogs.deleteSession.titleAction'), onClick: onDelete, disabled: pending, destructive: true, separated: true },
    ]} /> : null}
  </>;
}
