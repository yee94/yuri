import { Scroll, Text, View, signal } from 'nsh';
import { Button, Input, NavPage } from 'nsh/base';
import { t } from '../core/i18n';
import { colors, space } from '../core/theme';
import { Icon } from '../core/Icon';
import { EmptyState, QuietButton, Surface, actionMenu, alpha, confirm } from '../core/ui';
import { showToast } from '../core/toast';
import {
  addProject,
  appError,
  archiveSessionWithUndo,
  catalogIssues,
  connections,
  copySessionLink,
  deleteSessionWithUndo,
  liveStatus,
  loadMore,
  markRead,
  paginationFor,
  projectSortOrder,
  projects as projectCatalog,
  refreshCatalog,
  refreshSessionRecord,
  removeProject,
  renameSession,
  requestSmartTitle,
  setActiveProject,
  setViewingSession,
  switchConnection,
  syncProject,
  togglePin,
  updateProjectMeta,
  worktreesFor,
  type Worktree,
} from '../core/store';
import {
  hostAvailable,
  remoteArchive,
  remoteDelete,
  remoteHubId,
  remoteLoadMore,
  remoteMarkRead,
  remoteProjectFor,
  remoteProjectMeta,
  remoteRemoveProject,
  remoteRename,
  remoteRequestSmartTitle,
  remoteSessionRow,
  remoteSyncProject,
  remoteSyncTranscript,
  remoteTogglePin,
} from '../core/remote';
import {
  bucketVisibleCountFor,
  filterProjects,
  homeModel,
  isPaginationId,
  parsePaginationId,
  showFewerSessions,
  showMoreSessions,
  toggleProjectExpanded,
  toggleWorktreeExpanded,
  type Node,
  type ProjectItem,
  type WorktreeGroup,
} from './model';
import { ProjectList } from './ProjectList';
import { ProjectSurface } from './ProjectSurface';
import { PinnedSurface } from './PinnedSurface';
import { ActionsSheet, type SheetItem } from './ActionsSheet';
import { AddProjectSheet, RenameSheet } from './ProjectSheets';
import { DeleteWorktreeSheet, NewWorktreeSheet } from './WorktreeSheets';
import { ProjectEditSheet } from './ProjectEditSheet';
import { openConnect, openNewSession, openSearch, openSession, openSettingsPage, tabBarInset } from '../shell/nav';

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

const runningNode = (node: Node): boolean => {
  if (node.remote) {
    const row = remoteSessionRow(node.remote.hostId, node.remote.sessionID);
    return row?.remoteStatus === 'busy' || row?.remoteStatus === 'retry';
  }
  const status = liveStatus(node.id);
  return status?.type === 'busy' || status?.type === 'retry';
};

/** The projects tab: pinned work, every project's workspaces and their sessions. */
export function ProjectsPage() {
  const query = signal('');
  const pinnedClosed = signal(false);
  const actionsOpen = signal(false);
  const actionsTitle = signal('');
  const actionsItems = signal<SheetItem[]>([]);
  const renameTarget = signal<Node | null>(null);
  const renameDraft = signal('');
  const addOpen = signal(false);
  const addPath = signal('');
  const busy = signal(false);
  const localError = signal('');
  const worktreeProject = signal<ProjectItem | null>(null);
  const worktreeDelete = signal<{ project: ProjectItem; group: WorktreeGroup } | null>(null);
  const editTarget = signal<ProjectItem | null>(null);

  const model = () => homeModel();
  const items = () => filterProjects(model().projects, query());
  const highlight = () => query().trim();

  const matches = (node: Node) => {
    const value = query().trim().toLowerCase();
    if (!value) return true;
    return [node.title, node.subtitle ?? '', node.id, node.machine ?? ''].some((field) =>
      field.toLowerCase().includes(value),
    );
  };
  const pinned = () => model().pinned.filter(matches);
  const inProgress = () => model().inProgress.filter(matches);

  const showActions = (title: string, list: SheetItem[]) => {
    actionsTitle.set(title);
    actionsItems.set(list);
    actionsOpen.set(true);
  };

  const remoteTarget = (node: Node) => {
    if (!node.remote) return undefined;
    const project = remoteProjectFor(node.remote.projectId);
    return {
      hubId: remoteHubId(),
      hostId: node.remote.hostId,
      projectId: node.remote.projectId,
      ...(project?.remoteProjectId ? { remoteProjectId: project.remoteProjectId } : {}),
      ...(project?.instanceId ? { instanceId: project.instanceId } : {}),
    };
  };

  const startDraft = (project: ProjectItem, directory?: string) => {
    setActiveProject(project.id);
    const target = project.remote
      ? {
          hubId: remoteHubId(),
          hostId: project.remote.hostId,
          projectId: project.id,
          ...(project.remote.remoteProjectId ? { remoteProjectId: project.remote.remoteProjectId } : {}),
          ...(project.remote.instanceId ? { instanceId: project.remote.instanceId } : {}),
        }
      : undefined;
    openNewSession(directory ?? project.path, target);
  };

  const selectNode = (node: Node) => {
    if (isPaginationId(node.id)) {
      const parsed = parsePaginationId(node.id);
      if (!parsed) return;
      if (parsed.kind === 'more') {
        showMoreSessions(parsed.projectId, parsed.bucketKey);
        const project = model().projects.find((entry) => entry.id === parsed.projectId);
        if (project?.remote) {
          // Web asks for the next remote page only once the slice covers what is cached.
          const bucket = project.worktrees.find((group) => group.path === node.directory);
          if (bucketVisibleCountFor(parsed.projectId, parsed.bucketKey) >= (bucket?.sessionCount ?? 0)) {
            void remoteLoadMore(project.remote.hostId, parsed.bucketKey);
          }
        } else if (paginationFor(node.directory).hasMore) {
          void loadMore(node.directory);
        }
      } else {
        showFewerSessions(parsed.projectId, parsed.bucketKey);
      }
      return;
    }
    const project = model().projects.find((entry) =>
      node.remote ? entry.id === node.remote.projectId : entry.worktrees.some((group) => group.path === node.directory),
    );
    if (project) setActiveProject(project.id);
    if (node.remote) void remoteMarkRead(node.remote.hostId, node.remote.sessionID, false).catch(() => undefined);
    else void markRead(node.id, false);
    setViewingSession(node.id);
    openSession({
      id: node.id,
      title: node.title,
      directory: node.directory,
      ...(node.remote ? { remote: remoteTarget(node)! } : {}),
    });
  };

  const pinNode = (node: Node) => {
    if (isPaginationId(node.id)) return;
    if (node.remote) {
      void remoteTogglePin(node.remote.hostId, node.remote.sessionID, node.pinned).catch((error) =>
        showToast({ message: errorText(error) }),
      );
      return;
    }
    void togglePin(node.id);
  };

  const archiveNode = (node: Node) => {
    if (isPaginationId(node.id)) return;
    if (!node.remote) {
      void archiveSessionWithUndo(node.id, { onViewArchived: () => openSettingsPage('archived-sessions') });
      return;
    }
    const remote = node.remote;
    void (async () => {
      try {
        await remoteArchive(remote.hostId, remote.sessionID, remote.directory, true);
        const toast = showToast({
          message: t('sessions.sidebar.session.archive.success'),
          actionLabel: t('sessions.sidebar.undo'),
          onAction: () => {
            void (async () => {
              try {
                await remoteArchive(remote.hostId, remote.sessionID, remote.directory, false);
              } catch (error) {
                showToast({ message: errorText(error) });
              }
            })();
          },
        });
        void toast;
      } catch (error) {
        showToast({ message: errorText(error) });
      }
    })();
  };

  const markUnreadNode = (node: Node, unread: boolean) => {
    if (node.remote) {
      void remoteMarkRead(node.remote.hostId, node.remote.sessionID, unread).catch((error) =>
        showToast({ message: errorText(error) }),
      );
      return;
    }
    void markRead(node.id, unread);
  };

  const removeNode = async (node: Node) => {
    const confirmed = await confirm({
      title: t('sessions.sidebar.dialogs.deleteSession.title'),
      message: t('sessions.sidebar.dialogs.deleteSession.single', { sessionTitle: node.title }),
      confirmLabel: t('sessions.sidebar.dialogs.deleteSession.titleAction'),
      cancelLabel: t('gitView.common.cancel'),
      destructive: true,
    });
    if (!confirmed) return;
    if (!node.remote) {
      await deleteSessionWithUndo(node.id);
      return;
    }
    try {
      await remoteDelete(node.remote.hostId, node.remote.sessionID, node.remote.directory);
      await refreshCatalog();
      showToast({ message: t('sessions.sidebar.session.delete.success') });
    } catch (error) {
      showToast({ message: errorText(error) });
    }
  };

  const refreshNode = async (node: Node) => {
    try {
      if (node.remote) {
        await remoteSyncTranscript(node.remote.hostId, node.remote.sessionID, node.remote.directory);
        showToast({ message: t('sessions.sidebar.session.menu.refreshTranscriptSuccess') });
        return;
      }
      await refreshSessionRecord(node.id);
    } catch (error) {
      showToast({ message: errorText(error) });
    }
  };

  const openSessionActions = (node: Node) => {
    if (isPaginationId(node.id)) return;
    const isPinned = node.pinned;
    const unread = node.unread;
    const running = runningNode(node);
    showActions(node.title, [
      {
        id: 'pin',
        icon: isPinned ? 'unpin' : 'pushpin',
        label: t(isPinned ? 'sessions.sidebar.session.menu.unpin' : 'sessions.sidebar.session.menu.pin'),
        onPress: () => pinNode(node),
      },
      {
        id: 'read',
        icon: unread ? 'mail-open' : 'mail',
        label: t(unread ? 'sessions.sidebar.session.menu.markRead' : 'sessions.sidebar.session.menu.markUnread'),
        onPress: () => markUnreadNode(node, !unread),
      },
      {
        id: 'rename',
        icon: 'pencil-ai',
        label: t('sessions.sidebar.session.menu.rename'),
        onPress: () => {
          renameDraft.set(node.title);
          renameTarget.set(node);
        },
      },
      ...(node.share
        ? [
            {
              id: 'copyLink',
              icon: 'file-copy' as const,
              label: t('sessions.sidebar.session.menu.copyLink'),
              onPress: () => void copySessionLink(node.share),
            },
          ]
        : []),
      {
        id: 'refresh',
        icon: 'refresh' as const,
        label: t('sessions.sidebar.session.menu.refreshTranscript'),
        disabled: running,
        busy: running,
        onPress: () => void refreshNode(node),
      },
      {
        id: 'archive',
        icon: 'archive',
        label: t('sessions.sidebar.bulkActions.archive'),
        onPress: () => archiveNode(node),
      },
      {
        id: 'delete',
        icon: 'delete-bin',
        label: t('sessions.sidebar.bulkActions.delete'),
        destructive: true,
        separated: true,
        onPress: () => void removeNode(node),
      },
    ]);
  };

  const closeProject = async (project: ProjectItem) => {
    const confirmed = await confirm({
      title: t('sessions.sidebar.project.actions.closeProject'),
      message: t('mobile.projects.closeConfirmMessage', { title: project.name }),
      confirmLabel: t('mobile.sessions.confirmRemoveProject'),
      cancelLabel: t('gitView.common.cancel'),
      destructive: true,
    });
    if (!confirmed) return;
    if (project.remote) {
      const remote = remoteProjectFor(project.id);
      if (remote) {
        try {
          await remoteRemoveProject(remote);
        } catch (error) {
          showToast({ message: errorText(error) });
        }
      }
      return;
    }
    await removeProject(project.id);
    void refreshCatalog();
  };

  const syncProjectSessions = (project: ProjectItem) => {
    if (project.remote) {
      const remote = remoteProjectFor(project.id);
      if (remote) {
        void remoteSyncProject(remote).catch((error) => showToast({ message: errorText(error) }));
      }
      return;
    }
    const entry = projectCatalog().find((value) => value.id === project.id);
    if (entry) void syncProject(entry);
  };

  const openProjectActions = (project: ProjectItem) => {
    showActions(project.name, [
      {
        id: 'newSession',
        icon: 'add',
        label: t('sessions.sidebar.project.actions.newSession'),
        onPress: () => startDraft(project),
      },
      ...(project.git
        ? [
            {
              id: 'newWorktree',
              icon: 'node-tree' as const,
              label: t('sessions.sidebar.project.actions.newWorktree'),
              disabled: Boolean(project.remote) && !hostAvailable(project.remote!.hostId),
              onPress: () => worktreeProject.set(project),
            },
          ]
        : []),
      {
        id: 'syncSessions',
        icon: 'refresh',
        label: t('sessions.sidebar.project.actions.syncSessions'),
        onPress: () => syncProjectSessions(project),
      },
      {
        id: 'edit',
        icon: 'pencil-ai',
        label: t('sessions.sidebar.project.actions.edit'),
        onPress: () => editTarget.set(project),
      },
      {
        id: 'closeProject',
        icon: 'close',
        label: t('sessions.sidebar.project.actions.closeProject'),
        destructive: true,
        separated: true,
        onPress: () => void closeProject(project),
      },
    ]);
  };

  const openWorktreeActions = (project: ProjectItem, group: WorktreeGroup) => {
    showActions(group.name, [
      {
        id: 'newSession',
        icon: 'add',
        label: t('sessions.sidebar.project.actions.newSession'),
        onPress: () => startDraft(project, group.path),
      },
      {
        id: 'deleteWorktree',
        icon: 'delete-bin',
        label: t('sessions.sidebar.group.actions.deleteWorktree'),
        destructive: true,
        separated: true,
        onPress: () => worktreeDelete.set({ project, group }),
      },
    ]);
  };

  const openAddMenu = async () => {
    const instances = connections();
    const action = await actionMenu({
      actions: [
        { id: 'chat', label: t('mobile.projects.menu.newChat') },
        { id: 'project', label: t('mobile.projects.menu.newProject') },
        { id: 'connect', label: t('mobile.projects.menu.scanQr') },
        ...instances.map((entry) => ({ id: `instance:${entry.id}`, label: entry.label })),
      ],
    });
    if (!action) return;
    if (action === 'chat') {
      const current = model().projects[0];
      if (current) startDraft(current);
      else addOpen.set(true);
      return;
    }
    if (action === 'project') {
      addOpen.set(true);
      return;
    }
    if (action === 'connect') {
      openConnect();
      return;
    }
    if (action.startsWith('instance:')) {
      try {
        await switchConnection(action.slice('instance:'.length));
        void refreshCatalog();
      } catch (error) {
        localError.set(errorText(error));
      }
    }
  };

  const submitAdd = async () => {
    const path = addPath().trim();
    if (!path || busy()) return;
    busy.set(true);
    localError.set('');
    try {
      const project = await addProject(path);
      if (project) {
        addOpen.set(false);
        addPath.set('');
        void refreshCatalog();
      }
    } finally {
      busy.set(false);
    }
  };

  const saveRename = async () => {
    const target = renameTarget();
    if (!target || busy()) return;
    const title = renameDraft().trim();
    if (!title) return;
    busy.set(true);
    try {
      if (target.remote) {
        await remoteRename(target.remote.hostId, target.remote.sessionID, target.remote.directory, title);
      } else {
        await renameSession(target.id, title);
      }
      renameTarget.set(null);
    } catch (error) {
      showToast({ message: errorText(error) });
    } finally {
      busy.set(false);
    }
  };

  const useSmartTitle = async () => {
    const target = renameTarget();
    if (!target || busy()) return;
    renameTarget.set(null);
    try {
      if (target.remote) {
        const row = remoteSessionRow(target.remote.hostId, target.remote.sessionID);
        await remoteRequestSmartTitle(
          target.remote.hostId,
          target.remote.sessionID,
          target.remote.directory,
          row?.activity ?? Date.now(),
        );
      } else {
        await requestSmartTitle(target.id);
      }
    } catch (error) {
      showToast({ message: errorText(error) });
    }
  };

  const worktreeSheetProject = () => {
    const project = worktreeProject();
    if (!project) return { path: '' };
    const remote = project.remote ? remoteProjectFor(project.id) : undefined;
    return { path: project.path, ...(remote ? { remote } : {}) };
  };

  const deleteSheetTree = (): Worktree | null => {
    const target = worktreeDelete();
    if (!target) return null;
    if (target.project.remote) {
      return { path: target.group.path, name: target.group.name, branch: '' };
    }
    return (
      worktreesFor(target.project.path).find((tree) => tree.path === target.group.path) ?? {
        path: target.group.path,
        name: target.group.name,
        branch: target.group.name,
      }
    );
  };

  const saveProjectEdit = async (meta: { label: string; icon: string | null; color: string | null }) => {
    const project = editTarget();
    if (!project || busy()) return;
    busy.set(true);
    try {
      if (project.remote) {
        const remote = remoteProjectFor(project.id);
        if (remote) await remoteProjectMeta(remote, meta);
      } else {
        await updateProjectMeta(project.id, meta);
      }
      editTarget.set(null);
    } catch (error) {
      showToast({ message: errorText(error) });
    } finally {
      busy.set(false);
    }
  };

  return (
    <NavPage
      title={t('mobile.sessions.section.projects')}
      headerLargeTitle
      class="flex-1"
      style={{ backgroundColor: colors.background() }}
      headerRight={
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
          <Button
            testID="global-search-button"
            onPress={() => openSearch()}
            accessibilityLabel={t('commandPalette.title')}
            style={{ width: 36, height: 36, alignItems: 'center', justifyContent: 'center' }}
          >
            <Icon name="search" size={19} />
          </Button>
          <Button
            onPress={() => void openAddMenu()}
            accessibilityLabel={t('mobile.projects.menu.label')}
            style={{ width: 36, height: 36, alignItems: 'center', justifyContent: 'center' }}
          >
            <Icon name="add" size={22} />
          </Button>
        </View>
      }
    >
      <Scroll
        class="flex-1"
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        contentStyle={{ paddingBottom: tabBarInset() + 28 }}
      >
        <View
          style={{
            width: '100%',
            maxWidth: 452,
            alignSelf: 'center',
            paddingHorizontal: space.pageInset,
            gap: space.pageGap,
          }}
        >
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
              paddingHorizontal: 12,
              minHeight: 40,
              borderRadius: 20,
              backgroundColor: alpha(colors.muted(), 0.9),
              backdropFilter: 'blur(18px) saturate(1.3)',
              glassEffect: 'regular',
            }}
          >
            <Icon name="search" size={15} tone="muted" />
            <Input
              testID="projects-search"
              value={query()}
              onChange={(event) => query.set(event.value)}
              placeholder={t('mobile.sessions.search.placeholder')}
              autoCapitalize="none"
              autoCorrect={false}
              style={{
                flex: 1,
                minHeight: 38,
                fontSize: 14,
                color: colors.foreground(),
                placeholderColor: colors.mutedForeground(),
              }}
            />
            <If when={query().length > 0}>
              <Button
                onPress={() => query.set('')}
                accessibilityLabel={t('gitView.common.cancel')}
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: 13,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: alpha(colors.mutedForeground(), 0.16),
                }}
              >
                <Icon name="close" size={12} tone="muted" />
              </Button>
            </If>
          </View>

          <If when={!!catalogIssues()}>
            <Surface style={{ padding: 14, gap: 8 }}>
              <Text style={{ fontSize: 13, color: colors.mutedForeground() }}>{t('commandPalette.index.partial')}</Text>
              <QuietButton label={() => t('layout.browserProvider.retry')} onPress={() => void refreshCatalog()} />
            </Surface>
          </If>

          <If when={!!(localError() || appError())}>
            <Surface style={{ padding: 14, gap: 8 }}>
              <Text style={{ fontSize: 13, color: colors.destructive() }}>{localError() || appError()}</Text>
              <QuietButton
                label={() => t('layout.browserProvider.retry')}
                onPress={() => {
                  localError.set('');
                  void refreshCatalog();
                }}
              />
            </Surface>
          </If>

          <If when={items().length === 0 && !query().trim()}>
            <Surface>
              <EmptyState
                icon="folder-add"
                title={t('mobile.sessions.empty.noProjectsTitle')}
                description={t('mobile.sessions.empty.noProjectsDescription')}
                action={{
                  label: t('sessions.sidebar.header.actions.addProject'),
                  icon: 'folder-add',
                  onPress: () => addOpen.set(true),
                }}
              />
            </Surface>
          </If>

          <PinnedSurface
            pinned={pinned}
            inProgress={inProgress}
            collapsed={pinnedClosed}
            highlight={highlight}
            onToggle={() => pinnedClosed.set(!pinnedClosed())}
            onSelect={selectNode}
            onPin={pinNode}
            onArchive={archiveNode}
            onOpenActions={openSessionActions}
          />

          <ProjectList items={items} canReorder={() => !query().trim() && projectSortOrder() === 'manual'}>
            {(project, drag) => (
              <ProjectSurface
                project={project}
                drag={drag}
                startDrag={(event) => event.pageX > 0 && event.pageX < 110}
                highlight={highlight}
                onToggle={() => toggleProjectExpanded(project().id)}
                onOpenActions={() => openProjectActions(project())}
                onToggleWorktree={(group) => toggleWorktreeExpanded(`${project().id}::${group.id}`)}
                onOpenWorktreeActions={(group) => openWorktreeActions(project(), group)}
                onNewWorktreeSession={(group) => startDraft(project(), group.path)}
                onDeleteWorktree={(group) => worktreeDelete.set({ project: project(), group })}
                onSelect={selectNode}
                onPin={pinNode}
                onArchive={archiveNode}
                onOpenSessionActions={openSessionActions}
              />
            )}
          </ProjectList>

          <If when={items().length === 0 && !!query().trim()}>
            <View style={{ paddingVertical: 24, gap: 6 }}>
              <Text style={{ textAlign: 'center', fontSize: 14, fontWeight: '600', color: colors.foreground() }}>
                {t('sessions.sidebar.empty.noMatches.title')}
              </Text>
              <Text style={{ textAlign: 'center', fontSize: 12, color: colors.mutedForeground() }}>
                {t('sessions.sidebar.empty.noMatches.description')}
              </Text>
            </View>
          </If>
        </View>
      </Scroll>

      <ActionsSheet
        open={actionsOpen}
        title={actionsTitle}
        items={actionsItems}
        onOpenChange={(open) => actionsOpen.set(open)}
      />

      <RenameSheet
        open={() => !!renameTarget()}
        draft={renameDraft}
        setDraft={(value) => renameDraft.set(value)}
        busy={busy}
        onClose={() => renameTarget.set(null)}
        onSave={() => void saveRename()}
        onSmartTitle={() => void useSmartTitle()}
      />

      <AddProjectSheet
        open={addOpen}
        path={addPath}
        setPath={(value) => addPath.set(value)}
        busy={busy}
        error={() => localError()}
        onClose={() => addOpen.set(false)}
        onSubmit={() => void submitAdd()}
      />

      <NewWorktreeSheet
        open={() => !!worktreeProject()}
        project={worktreeSheetProject}
        busy={busy}
        onClose={() => worktreeProject.set(null)}
        onCreated={(path, remote) => {
          const project = worktreeProject();
          worktreeProject.set(null);
          if (project) {
            void refreshCatalog();
            startDraft(project, path);
          }
          void remote;
        }}
      />

      <DeleteWorktreeSheet
        open={() => !!worktreeDelete()}
        project={() => {
          const target = worktreeDelete();
          const remote = target?.project.remote ? remoteProjectFor(target.project.id) : undefined;
          return { path: target?.project.path ?? '', ...(remote ? { remote } : {}) };
        }}
        tree={deleteSheetTree}
        onClose={() => worktreeDelete.set(null)}
        onDeleted={() => {
          worktreeDelete.set(null);
          void refreshCatalog();
        }}
      />

      <ProjectEditSheet
        project={editTarget}
        busy={busy}
        onClose={() => editTarget.set(null)}
        onSave={(meta) => void saveProjectEdit(meta)}
      />
    </NavPage>
  );
}
