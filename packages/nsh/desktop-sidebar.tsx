import { cleanup, Clipboard, computed, effect, keymap, lifecycle, Scroll, signal, Text, token, untracked, View, type Signal, type JSX, type ViewRef } from 'nsh';
import { AlertDialog, Button, ContextMenu, Input, Menu, MenuItem, MenuSeparator, Submenu, TextView, Tooltip } from 'nsh/base';
import { Icon } from './Icon';
import { language, t } from './i18n';
import { id, type ChatTarget, type Project } from './model';
import { native } from './runtime';
import { sameRuntimeScope } from './runtime-scope';
import { createDesktopDocuments, type DesktopDocumentState } from './desktop-documents';
import { app, epoch } from './state';
import { createProjectsController, orderedProjectSessions, type ProjectsNavigation } from './projects';
import { projectsInProgress } from './projects-attention';
import { readProjectsBlocking } from './projects-attention-blocking';
import { ProjectsSessionIndicator } from './projects-attention-indicator';
import { resolveMobileSessionIndicator } from '../ui/src/mobile/projects/mobileSessionIndicator';
import { normalizeDirectoryKey } from '../ui/src/lib/pathNormalization';
import { createDesktopSidebarNavigation, createDesktopSidebarSwitcherSource, desktopSidebarNavigation, type DesktopSidebarActionsRef } from './desktop-sidebar-navigation';
import { createDesktopSidebarDrag, desktopSidebarDragKey, type DesktopSidebarDragTarget } from './desktop-sidebar-drag';
import { createDesktopSidebarOrder, type DesktopSidebarOrderIntent, type DesktopSidebarOrderState } from './desktop-sidebar-order';
import { desktopSidebarOutline, type DesktopSidebarOutlineRow } from './desktop-sidebar-tree';
import { sidebarSessionKey } from './projects-sidebar';
import type { SessionFolder } from '../ui/src/components/session/sidebar/session-folder-core';
import type { DesktopSidebarNavigationTarget } from './desktop-sidebar-navigation';
import { DesktopSidebarDragRow, DesktopSidebarMouseSurface } from './desktop-sidebar-drag-row';
import { desktopSidebarDragBindings } from './desktop-sidebar-drag-row';
import { AssistantAvatar } from './assistants-avatar-live';
import { desktopSidebarNavigationStatus, desktopSidebarPadding, desktopSidebarRelativeTime, desktopSidebarRunning, desktopSidebarSessionStateKey, type DesktopSidebarAuthority } from './desktop-sidebar-projection';
import { DesktopSidebarIndicator, desktopSidebarTheme } from './desktop-sidebar-indicator';
import { desktopSidebarReadAllArchived } from './desktop-sidebar-archived';
export type { DesktopSidebarAuthority, DesktopSidebarContact, DesktopSidebarSessionState } from './desktop-sidebar-projection';
import {
  DESKTOP_SIDEBAR_INITIAL_COUNT, DESKTOP_SIDEBAR_PAGE_INCREMENT,
  desktopSidebarProjects, desktopSidebarScope, desktopSidebarSelected, desktopSidebarWindow,
  type DesktopSidebarGroup,
} from './desktop-sidebar-model';

export interface DesktopSidebarProps {
  /** Existing root/catalog/live owners publish only known fields for this exact Host scope. */
  authority?: DesktopSidebarAuthority | null;
  /** Window/controller lifetime demand, NOT modal admission, row visibility or the selected route.
   * False releases its controller/subscriptions but retains this Host's fold preferences.
   * Background revokes operations; a new Host generation creates a fresh data owner. */
  active: boolean;
  /** Dialogs revoke user actions without releasing the controller, rows, folds or drafts. */
  interactive?: boolean;
  /** Rows only. Keep active=true when the interactive window hides its sidebar. */
  visible?: boolean;
  selectedTarget?: ChatTarget | null;
  selectedSection?: 'chat' | 'assistants' | 'schedules' | 'settings' | 'connections';
  navigation: ProjectsNavigation;
  /** Opens the existing unsent draft route; this component never creates a remote session. */
  onNewSession: (project?: Project) => void;
  /** Existing draft owner must retain this exact membership until first-session admission. */
  onNewSessionInFolder?: (project: Project, folder: { scope: string; id: string }) => void;
  onAssistants: () => void;
  onSchedules: () => void;
  onSettings: () => void;
  onConnections: () => void;
  /** Opens the window's shortcut help Dialog, not the editable shortcut settings page.
   * Until the shell provides that owner, the help control is visibly disabled. */
  onShortcuts?: () => void;
  onSearch: () => void;
  onSessionSwitcher: () => void;
  /** Optional imperative owner for the shell's centralized shortcuts. Never installs keys here.
   * Cleanup clears this holder only if it still points to this exact owner. */
  actionsRef?: DesktopSidebarActionsRef;
}

type Controller = ReturnType<typeof createProjectsController>;
type Row = ReturnType<Controller['sessions']>[number];
type IconName = Parameters<typeof Icon>[0]['name'];
const rowClass = 'flex-row items-center gap-1.5 rounded-lg px-2 hover:bg-foreground/3.5 dark:hover:bg-foreground/8 active:bg-foreground/6 focus-visible:ring-2 focus-visible:ring-ring';
const menuClass = 'min-w-48 rounded-lg bg-card border border-border p-1 shadow-lg';
const menuItemClass = 'flex-row items-center gap-2 rounded-md px-2 py-2 hover:bg-secondary active:bg-accent disabled:opacity-50';
const compactButton = 'items-center justify-center rounded-md hover:bg-card active:bg-accent';
const reveal = 'invisible group-hover:visible group-focus-within:visible';
const quickButton = `${compactButton} focus-visible:ring-2 focus-visible:ring-ring`;

/** Long-lived desktop sibling of the content pane. Width belongs to the shell (about 260pt).
 * Host scopes never reuse row state or callbacks, even when session IDs happen to collide. */
export function DesktopSidebar(props: DesktopSidebarProps) {
  const scopes = computed(() => {
    app.runtimeScope();
    const key = desktopSidebarScope(app.connection(), epoch());
    return key ? [key] : [];
  });
  return <View testID="desktop-sidebar" role="navigation" disabled={props.interactive === false} accessibilityLabel={t('sessions.sidebar.projectsTitle')} class="flex-1 min-w-0 bg-muted">
    <Each of={scopes()}>{scope => <DesktopSidebarHost {...props} scope={scope()} />}</Each>
    <If when={!app.connection()}><Button class={`${rowClass} py-2`} onPress={() => { if (props.active && props.interactive !== false && lifecycle() === 'active') props.onConnections(); }}><Icon name="plug" size={16} /><Text class="text-sm text-foreground">{t('mobile.connect.saved.title')}</Text></Button></If>
  </View>;
}

function DesktopSidebarHost(props: DesktopSidebarProps & { scope: string }) {
  // Route changes do not remount these view preferences. A hidden sidebar may release
  // its data owner, but cannot borrow collapse/selection state from a different Host.
  const collapsed = signal<string[]>([]), expandedTrees = signal<string[]>([]), pinnedClosed = signal(false), progressClosed = signal(false);
  const counts = signal<Record<string, number>>({});
  const expandedSessions = signal<string[]>([]), archivedOpen = signal<string[]>([]);
  return <If when={props.active}><DesktopSidebarPanel {...props} view={{ collapsed, expandedTrees, pinnedClosed, progressClosed, counts, expandedSessions, archivedOpen }} /></If>;
}

type ViewState = {
  collapsed: Signal<string[]>;
  expandedTrees: Signal<string[]>;
  pinnedClosed: Signal<boolean>;
  progressClosed: Signal<boolean>;
  counts: Signal<Record<string, number>>;
  expandedSessions: Signal<string[]>;
  archivedOpen: Signal<string[]>;
};

function DesktopSidebarPanel(props: DesktopSidebarProps & { scope: string; view: ViewState }) {
  const controller = createProjectsController({ detailReads: () => props.visible !== false }), menu = signal('');
  const rename = signal<Row | null>(null), title = signal('');
  const renameContext = signal('');
  const folderEditor = signal<{ scope: string; folder?: SessionFolder; parentId?: string; session?: Row; created?: SessionFolder } | null>(null), folderName = signal('');
  const exported = signal<{ filename: string; content: string } | null>(null);
  const copyStatus = signal('');
  const documentState = signal<DesktopDocumentState>({ phase: 'idle' });
  let documents: ReturnType<typeof createDesktopDocuments> | undefined;
  let documentValue: { filename: string; content: string } | null = null;
  const confirming = signal(false);
  const archivedDeleteFailed = signal(false);
  let interactionRevision = 0;
  let alive = true;
  const authority = () => alive && props.active && lifecycle() === 'active' && props.scope === desktopSidebarScope(app.connection(), epoch()) && controller.current();
  const can = () => authority() && props.interactive !== false;
  const rendering = () => authority() && props.visible !== false;
  const admitted = () => can() && props.visible !== false;
  const retireDocument = () => { documents?.dispose(); documents = undefined; documentValue = null; documentState.set({ phase: 'idle' }); };
  cleanup(retireDocument);
  effect(() => { const value = exported(); if (!rendering() || value !== documentValue) untracked(retireDocument); });
  async function saveDocument() {
    const value = exported(), scope = app.runtimeScope();
    if (!admitted() || !value) return;
    if (!scope) { documentState.set({ phase: 'error', error: 'documents_scope_required' }); return; }
    if (!documents) {
      documentValue = value;
      documents = createDesktopDocuments({ scope, document: value, native, id,
        current: () => rendering() && exported() === value && sameRuntimeScope(app.runtimeScope(), scope),
        changed: state => documentState.set(state),
      });
    }
    await documents.save();
  }
  cleanup(() => { alive = false; controller.dispose(); });
  const invoke = (action: () => void) => { if (admitted()) action(); };
  const pins = computed(() => new Set(controller.pins()));
  const ownRunning = computed(() => new Set(controller.running()));
  const running = computed(() => desktopSidebarRunning([...controller.sessions(), ...controller.retainedSessions()], ownRunning(), props.authority, props.scope));
  const navigationStatus = computed(() => desktopSidebarNavigationStatus(props.authority, props.scope));
  const sessionState = (row: Row) => props.authority?.scope === props.scope ? props.authority.sessions?.get(desktopSidebarSessionStateKey(row)) : undefined;
  const permissionCounts = computed(() => {
    const counts = new Map<string, number>();
    for (const [directory, value] of Object.entries(controller.attention().blockingByDirectory)) for (const [id, requests] of Object.entries(value.permissions.bySession)) counts.set(desktopSidebarSessionStateKey({ directory, id }), requests.length);
    return counts;
  });
  const unread = computed(() => {
    const values = { ...controller.attention().unseenBySession };
    if (props.authority?.scope === props.scope) for (const row of controller.sessions()) {
      const count = sessionState(row)?.unreadCount;
      if (count !== undefined && Number.isSafeInteger(count) && count >= 0) values[row.id] = count;
    }
    return values;
  });
  const sections = computed(() => desktopSidebarProjects(app.projects(), controller.byDirectory(), controller.orderedWorktrees));
  const secondary = computed(() => {
    const metadata = new Map<string, { project: string; branch: string }>();
    for (const section of sections()) for (const group of section.groups) metadata.set(normalizeDirectoryKey(group.directory), { project: section.project.name, branch: group.tree?.branch ?? '' });
    return metadata;
  });
  const pinned = computed(() => orderedProjectSessions(controller.sessions().filter(row => pins().has(row.id)), '__pinned__', controller.order(), controller.pins()));
  const inProgress = computed(() => projectsInProgress(controller.sessions(), controller.pins(), [...running()], unread()));
  const sidebar = controller.sidebar, sidebarState = computed(sidebar.snapshot);
  const archivedScope = (project: Project) => `__archived__:${project.path}`;
  function scopeRows(scope: string): Row[] {
    if (!scope.startsWith('__archived__:')) return controller.byDirectory().get(scope) ?? [];
    const project = app.projects().find(project => archivedScope(project) === scope); if (!project) return [];
    const directories = new Set([project.path, ...controller.orderedWorktrees(project).map(tree => tree.path)]);
    const rows = [...directories].flatMap(directory => sidebarState().archived[directory]?.rows ?? []).filter(row => !controller.hiddenSessionIDs().has(row.id));
    return orderedProjectSessions(rows, scope, controller.order(), controller.pins());
  }
  const outlines = computed(() => {
    const values = new Map<string, ReturnType<typeof desktopSidebarOutline>>();
    for (const section of sections()) for (const scope of [...section.groups.map(group => group.directory), archivedScope(section.project)]) {
      values.set(scope, desktopSidebarOutline({ roots: scopeRows(scope), scope, state: sidebarState(), expanded: new Set(props.view.expandedSessions()), count: props.view.counts()[scope] ?? DESKTOP_SIDEBAR_INITIAL_COUNT, running: running(), pins: pins(), selected: props.selectedTarget, hidden: controller.hiddenSessionIDs() }));
    }
    return values;
  });
  const projectTargets = computed(() => {
    const targets: DesktopSidebarNavigationTarget[] = [];
    for (const section of sections()) {
      if (props.view.collapsed().includes(section.project.id)) continue;
      const scopes = section.groups.filter(group => !group.tree || props.view.expandedTrees().includes(group.directory)).map(group => group.directory);
      if (props.view.archivedOpen().includes(section.project.id)) scopes.push(archivedScope(section.project));
      for (const scope of scopes) for (const row of outlines().get(scope)?.rows ?? []) if (row.kind === 'session') targets.push({ scope: 'project', context: scope, projectId: section.project.id, sessionId: row.session.id, directory: row.session.directory, row: { kind: 'session', ...row.session } });
    }
    return targets;
  });
  const sortState = signal<DesktopSidebarOrderState>({ pending: false, failure: null });
  const dragState = signal<{ active: string | null; over: string | null }>({ active: null, over: null });
  const geometry = new Map<string, { row: DesktopSidebarDragTarget; node: ViewRef }>();
  const projectFor = (scope: string) => app.projects().find(project => normalizeDirectoryKey(project.path) === normalizeDirectoryKey(scope));
  function rankRows(intent: DesktopSidebarOrderIntent) {
    if (intent.kind === 'worktree') { const project = projectFor(intent.scope); return project ? controller.orderedWorktrees(project).map(tree => tree.path) : []; }
    const rows = intent.scope === '__pinned__'
      ? orderedProjectSessions(controller.sessions().filter(row => pins().has(row.id)), intent.scope, controller.order(), controller.pins())
      : scopeRows(intent.scope);
    const ids = rows.map(row => row.id);
    const known = new Set(ids);
    return [...ids, ...(controller.order()?.sessionOrderByScope[intent.scope] ?? []).filter(id => !known.has(id))];
  }
  const sorting = createDesktopSidebarOrder({ current: can, generation: () => desktopSidebarScope(app.connection(), epoch()) ?? '',
    read: async intent => {
      if (intent.kind === 'session') await controller.loadOrder();
      else { const project = projectFor(intent.scope); if (!project) throw new Error(t('chat.chatInput.toast.reloadFailed')); await controller.loadTreeOrder(project); }
      return rankRows(intent);
    },
    commit: async intent => {
      if (!admitted()) return;
      if (intent.kind === 'session') await controller.reorder(intent.scope, intent.active, intent.over, intent.scope.startsWith('__archived__:') ? scopeRows(intent.scope) : undefined);
      else { const project = projectFor(intent.scope); if (!project) throw new Error(t('chat.chatInput.toast.reloadFailed')); await controller.reorderWorktree(project, intent.active, intent.over); }
      if (controller.error()) throw new Error(controller.error());
    },
    snapshot: intent => intent.kind === 'session' ? controller.order()?.sessionOrderByScope[intent.scope] ?? [] : rankRows(intent),
    changed: state => sortState.set(state), conflict: () => t('chat.chatInput.toast.reloadFailed'),
  });
  const drag = createDesktopSidebarDrag({ current: () => admitted() && !sortState().pending && !sidebarState().pending.some(key => key.endsWith('-write')) && !menu() && !rename() && !folderEditor() && !exported() && !confirming(), generation: () => props.scope,
    targets: () => [...geometry.values()].map(value => value.row),
    measure: async row => {
      const captured = geometry.get(desktopSidebarDragKey(row)); if (!captured) return null;
      const measured = await captured.node.measure();
      if (!measured || geometry.get(desktopSidebarDragKey(row)) !== captured) return null;
      return { left: measured.pagePosition.x, top: measured.pagePosition.y, width: measured.bounds.size.width, height: measured.bounds.size.height };
    },
    changed: state => { const old = dragState(); if (old.active !== state.active || old.over !== state.over) dragState.set(state); },
    commit: intent => {
      if (!admitted()) return;
      if (intent.kind === 'project') void sidebar.reorderProjects(intent.active, intent.over);
      else if (intent.kind === 'folder') void sidebar.folders(intent.scope, { kind: 'reorder', active: intent.active, over: intent.over });
      else if (intent.kind === 'session' && intent.targetKind === 'folder') {
        const row = scopeRows(intent.scope).find(row => row.id === intent.active);
        if (row) void sidebar.folders(intent.scope, { kind: 'member', sessionId: intent.active, folderId: intent.over, directory: row.directory });
      }
      else void sorting.run(intent);
    },
  });
  const navigationSnapshot = computed(() => desktopSidebarNavigation({
    pinned: pinned(), inProgress: inProgress(), sections: sections(), pinnedClosed: props.view.pinnedClosed(), progressClosed: props.view.progressClosed(),
    collapsed: new Set(props.view.collapsed()), expandedTrees: new Set(props.view.expandedTrees()), counts: props.view.counts(),
    initialCount: DESKTOP_SIDEBAR_INITIAL_COUNT, pins: pins(), running: running(), selected: props.selectedTarget,
    projectTargets: projectTargets(),
  }));
  const switcherSource = createDesktopSidebarSwitcherSource({ current: authority,
    snapshot: () => {
      const snapshot = sidebar.snapshot(), branches = new Map<string, string | null>();
      for (const trees of Object.values(controller.worktrees())) for (const tree of trees) branches.set(normalizeDirectoryKey(tree.path), tree.branch || null);
      return { sessions: controller.retainedSessions(), projects: app.projects(), pinnedSessionIDs: controller.pins(), branches,
        ready: controller.catalogReady(), loading: controller.catalogLoading() || snapshot.pending.some(key => key.startsWith('children:')),
        error: controller.error() || Object.entries(snapshot.errors).find(([key, value]) => key.startsWith('children:') && value)?.[1] || '' };
    },
    status: row => running().has(row.id) ? 'running' : (unread()[row.id] ?? 0) > 0 ? 'unread' : null,
    retry: async () => {
      if (!authority()) return;
      await controller.refresh(); if (!authority()) return;
      const retained = controller.retainedSessions();
      for (const [key, error] of Object.entries(sidebar.snapshot().errors)) if (key.startsWith('children:') && error && authority()) {
        const parent = retained.find(row => `children:${sidebarSessionKey(row)}` === key);
        if (parent) await sidebar.loadChildren(parent);
      }
    },
  });
  const focusRevision = signal(0);
  const navigationOwner = createDesktopSidebarNavigation({ current: () => can() && !menu() && !rename() && !folderEditor() && !exported() && !confirming() && !dragState().active && !sortState().pending,
    switcherSource,
    snapshot: navigationSnapshot, selected: () => props.selectedTarget,
    focusChanged: () => focusRevision.set(focusRevision() + 1),
    activate: target => { if (can()) props.navigation.onOpenChat(target.row); },
  });
  const selectedRepresentation = computed(() => {
    focusRevision();
    const focus = navigationOwner.focused();
    return focus && desktopSidebarSelected(focus.row, props.selectedTarget)
      ? focus : navigationSnapshot().all.find(target => desktopSidebarSelected(target.row, props.selectedTarget));
  });
  if (props.actionsRef) { props.actionsRef.current = navigationOwner.actions; props.actionsRef.set?.(navigationOwner.actions); }
  cleanup(() => {
    navigationOwner.dispose(); drag.cancel(); sorting.cancel(); geometry.clear();
    if (props.actionsRef?.current === navigationOwner.actions) { props.actionsRef.current = null; props.actionsRef.set?.(null); }
  });
  effect(() => { if (!can()) untracked(() => { interactionRevision++; menu.set(''); confirming.set(false); drag.cancel(); sorting.pause(); }); });
  effect(() => { if (props.visible === false) untracked(() => { interactionRevision++; menu.set(''); rename.set(null); folderEditor.set(null); exported.set(null); confirming.set(false); drag.cancel(); }); });
  effect(() => { sections(); pinned(); outlines(); props.view.pinnedClosed(); props.view.progressClosed(); props.view.collapsed(); props.view.expandedTrees(); props.view.counts(); untracked(() => drag.cancel()); });
  const attemptedTrees = new Set<string>();
  const toggle = (state: Signal<string[]>, key: string) => state.set(state().includes(key) ? state().filter(value => value !== key) : [...state(), key]);
  effect(() => {
    if (!authority()) { untracked(() => menu.set('')); return; }
    untracked(() => { void controller.refresh(); void sidebar.loadFolders(); });
  });
  effect(() => {
    const projects = app.projects(), closed = props.view.collapsed();
    if (!authority() || props.visible === false) return;
    untracked(() => {
      const needed = projects.filter(project => !closed.includes(project.id) && !attemptedTrees.has(project.path));
      void loadTrees(needed);
    });
  });
  async function loadTrees(projects: readonly Project[]) {
    for (let index = 0; index < projects.length && authority() && props.visible !== false; index += 2) {
      const batch = projects.slice(index, index + 2); batch.forEach(project => attemptedTrees.add(project.path));
      await Promise.all(batch.map(project => controller.loadWorktrees(project)));
    }
  }
  async function retryReads() {
    if (!admitted()) return;
    await controller.refresh();
    if (!admitted()) return;
    await loadTrees(app.projects().filter(project => !props.view.collapsed().includes(project.id)));
    if (admitted()) await sidebar.loadFolders();
  }
  function editFolder(scope: string, folder?: SessionFolder, parentId?: string, session?: Row) {
    if (!admitted()) return; menu.set(''); folderEditor.set({ scope, folder, parentId, session }); folderName.set(folder?.name ?? t('sessions.sidebar.folder.newFolderName'));
  }
  async function saveFolder() {
    const edit = folderEditor(); if (!admitted() || !edit || !folderName().trim()) return;
    if (edit.folder) {
      const saved = await sidebar.folders(edit.scope, { kind: 'rename', id: edit.folder.id, name: folderName() });
      if (authority() && saved && folderEditor() === edit) folderEditor.set(null);
      return;
    }
    let currentEdit = edit, folder = edit.created;
    if (!folder) {
      folder = sidebar.newFolder(folderName(), edit.parentId ?? null);
      const saved = await sidebar.folders(edit.scope, { kind: 'create', folder });
      if (!authority() || !saved || folderEditor() !== edit) return;
      currentEdit = { ...edit, created: folder }; folderEditor.set(currentEdit);
    }
    if (edit.session && !await sidebar.folders(edit.scope, { kind: 'member', sessionId: edit.session.id, folderId: folder.id, directory: edit.session.directory })) return;
    if (authority() && folderEditor() === currentEdit) folderEditor.set(null);
  }
  function retrySidebar(key: string) {
    if (!admitted()) return;
    if (sidebarState().unknown.includes(key)) { void sidebar.retry(key); return; }
    if (key === 'folders' || key === 'folders-write') { void sidebar.loadFolders(); return; }
    if (key === 'projects-read' || key === 'projects-write') { void sidebar.loadProjects(); return; }
    if (key.startsWith('archived:')) { void sidebar.loadArchived(key.slice('archived:'.length)); return; }
    if (key.startsWith('children:')) {
      const rows = [...controller.sessions(), ...Object.values(sidebarState().children).flatMap(page => page.rows), ...Object.values(sidebarState().archived).flatMap(page => page.rows)];
      const row = rows.find(row => `children:${sidebarSessionKey(row)}` === key); if (row) void sidebar.loadChildren(row);
    }
  }
  async function exportRow(row: Row) {
    if (!admitted() || confirming()) return; const revision = ++interactionRevision; confirming.set(true);
    try {
      const result = await AlertDialog.show({ title: t('sessions.sidebar.session.export.dialog.title'), actions: [
        { id: 'all', label: t('sessions.sidebar.session.export.dialog.includeSubtasks') }, { id: 'root', label: t('sessions.sidebar.session.export.dialog.confirm') }, { id: 'cancel', label: t('sessions.sidebar.dialogs.cancel'), role: 'cancel' },
      ] });
      if (!can() || revision !== interactionRevision || result.action === 'cancel') return;
      const value = await sidebar.exportMarkdown(row, result.action === 'all', language()); if (can() && revision === interactionRevision && value) { copyStatus.set(''); exported.set(value); }
    } finally { if (revision === interactionRevision) confirming.set(false); }
  }
  async function deleteFolder(scope: string, folder: SessionFolder) {
    if (!admitted() || confirming()) return; const revision = ++interactionRevision; confirming.set(true);
    try {
      const descendants = new Set([folder.id]), folders = sidebarState().folders?.foldersMap[scope] ?? [];
      for (let prior = -1; prior !== descendants.size;) { prior = descendants.size; for (const child of folders) if (child.parentId && descendants.has(child.parentId)) descendants.add(child.id); }
      const count = descendants.size - 1;
      const result = await AlertDialog.show({ title: t('sessions.sidebar.dialogs.deleteFolder.title'), description: t(count === 0 ? 'sessions.sidebar.dialogs.deleteFolder.withContentsNoSubfolders' : count === 1 ? 'sessions.sidebar.dialogs.deleteFolder.withOneSubfolder' : 'sessions.sidebar.dialogs.deleteFolder.withManySubfolders', { folderName: folder.name, count }), actions: [
        { id: 'delete', label: t('sessions.sidebar.folderItem.deleteFolderAria', { folderName: folder.name }), role: 'destructive' }, { id: 'cancel', label: t('sessions.sidebar.dialogs.cancel'), role: 'cancel' },
      ] });
      if (can() && revision === interactionRevision && result.action === 'delete') await sidebar.folders(scope, { kind: 'delete', id: folder.id });
    } finally { if (revision === interactionRevision) confirming.set(false); }
  }
  async function confirmArchive(row: Row) {
    if (!admitted() || confirming()) return;
    const revision = ++interactionRevision; confirming.set(true);
    try {
      const result = await AlertDialog.show({ title: t('sessions.sidebar.dialogs.archiveSession.title'), description: t('sessions.sidebar.dialogs.archiveSession.single', { sessionTitle: row.title }), actions: [
        { id: 'archive', label: t('sessions.sidebar.bulkActions.archive') }, { id: 'cancel', label: t('sessions.sidebar.dialogs.cancel'), role: 'cancel' },
      ] });
      if (can() && revision === interactionRevision && result.action === 'archive') await controller.mutate(row, 'archive');
    } finally { if (revision === interactionRevision) confirming.set(false); }
  }
  async function confirmDelete(row: Row) {
    if (!admitted() || confirming()) return;
    const revision = ++interactionRevision; confirming.set(true);
    try {
      const result = await AlertDialog.show({ title: t('sessions.sidebar.dialogs.deleteSession.title'), description: t('sessions.sidebar.dialogs.deleteSession.single', { sessionTitle: row.title }), actions: [
        { id: 'delete', label: t('sessions.sidebar.dialogs.deleteSession.titleAction'), role: 'destructive' },
        { id: 'cancel', label: t('sessions.sidebar.dialogs.cancel'), role: 'cancel' },
      ] });
      if (can() && revision === interactionRevision && result.action === 'delete') await controller.mutate(row, 'delete');
    } finally { if (revision === interactionRevision) confirming.set(false); }
  }
  async function deleteArchived(project: Project, folder?: SessionFolder) {
    if (!admitted() || confirming()) return;
    const revision = ++interactionRevision;
    const current = () => admitted() && revision === interactionRevision;
    confirming.set(true); archivedDeleteFailed.set(false);
    try {
      const rows = await desktopSidebarReadAllArchived({ directories: [project.path, ...controller.orderedWorktrees(project).map(tree => tree.path)], current, snapshot: sidebar.snapshot, load: sidebar.loadArchived });
      if (!current()) return;
      if (!rows) { archivedDeleteFailed.set(true); return; }
      if (folder) {
        await sidebar.loadFolders();
        if (!current()) return;
        if (sidebarState().errors.folders || !sidebarState().folders) { archivedDeleteFailed.set(true); return; }
      }
      const membership = folder ? sidebarState().folders?.foldersMap[archivedScope(project)]?.find(value => value.id === folder.id) : undefined;
      if (folder && !membership) { archivedDeleteFailed.set(true); return; }
      const ids = membership ? new Set(membership.sessionIds) : null;
      const candidates = rows.filter(row => !controller.hiddenSessionIDs().has(row.id) && (!ids || ids.has(row.id)));
      if (!candidates.length) return;
      const result = await AlertDialog.show({ title: t('sessions.sidebar.dialogs.deleteSessions.title'), description: t(candidates.length === 1 ? 'sessions.sidebar.dialogs.deleteSessions.singleDescription' : 'sessions.sidebar.dialogs.deleteSessions.pluralDescription', { count: candidates.length }), actions: [{ id: 'delete', label: t('sessions.sidebar.dialogs.deleteSession.titleAction'), role: 'destructive' }, { id: 'cancel', label: t('sessions.sidebar.dialogs.cancel'), role: 'cancel' }] });
      if (!current() || result.action !== 'delete') return;
      if (membership && sidebarState().folders?.foldersMap[archivedScope(project)]?.find(value => value.id === membership.id) !== membership) { archivedDeleteFailed.set(true); return; }
      // The controller owns subtree enumeration, lossless Undo and per-entity failed commits.
      for (const row of candidates) {
        if (!current()) return;
        await controller.mutate(row, 'delete');
        if (current() && !controller.hiddenSessionIDs().has(row.id)) archivedDeleteFailed.set(true);
      }
    } catch { if (current()) archivedDeleteFailed.set(true); }
    finally { if (revision === interactionRevision) confirming.set(false); }
  }
  function DragRow(item: { target: DesktopSidebarDragTarget | null; label: string; children?: JSX.Element; indent?: boolean; selected?: boolean }) {
    return <DesktopSidebarDragRow {...item} enabled={admitted() && !sortState().pending} state={dragState()} drag={drag} geometry={geometry} />;
  }
  async function saveTitle() {
    const row = rename();
    if (!admitted() || !row) return;
    const saved = await controller.mutate(row, 'rename', title());
    if (authority() && saved && rename() === row) rename.set(null);
  }
  function SessionItems(item: { row: Row; scope?: string }) {
    const disabled = () => !can() || controller.pending().includes(item.row.id);
    const scope = () => item.scope?.startsWith('__archived__:') ? item.scope : item.row.directory;
    return <View>
      <MenuItem class={menuItemClass} disabled={disabled()} onSelect={() => invoke(() => { renameContext.set(item.scope ?? item.row.directory); rename.set(item.row); title.set(item.row.title); })}><Icon name="edit" size={14} /><Text class="text-sm text-foreground">{t('sessions.sidebar.session.menu.rename')}</Text></MenuItem>
      <MenuItem class={menuItemClass} disabled={disabled()} onSelect={() => invoke(() => { void controller.mutate(item.row, 'pin'); })}><Icon name={pins().has(item.row.id) ? 'unpin' : 'pushpin'} size={14} /><Text class="text-sm text-foreground">{t(pins().has(item.row.id) ? 'sessions.sidebar.session.menu.unpin' : 'sessions.sidebar.session.menu.pin')}</Text></MenuItem>
      <MenuItem class={menuItemClass} disabled={disabled()} onSelect={() => { void exportRow(item.row); }}><Icon name="download" size={14} /><Text class="text-sm text-foreground">{t('sessions.sidebar.session.menu.exportMarkdown')}</Text></MenuItem>
      <MenuItem class={menuItemClass} disabled={disabled()} onSelect={() => invoke(() => { void controller.syncMessages(item.row); })}><Icon name="refresh" size={14} /><Text class="text-sm text-foreground">{t('sessions.sidebar.session.menu.refreshTranscript')}</Text></MenuItem>
      <If when={!item.row.parentID}>
        <MenuSeparator class="h-px my-1 bg-border" />
        <Submenu disabled={disabled()} trigger={<View class={menuItemClass}><Icon name="folder" size={14} /><Text class="flex-1 text-sm text-foreground">{t('sessions.sidebar.folders.moveToFolder')}</Text><Icon name="arrow-right-s" size={12} /></View>}>
          <Each of={sidebarState().folders?.foldersMap[scope()] ?? []}>{folder => <MenuItem class={menuItemClass} disabled={disabled() || sidebarState().pending.includes('folders-write')} onSelect={() => invoke(() => { void sidebar.folders(scope(), { kind: 'member', sessionId: item.row.id, folderId: folder().sessionIds.includes(item.row.id) ? null : folder().id, directory: item.row.directory }); })}><Text class="flex-1 text-sm text-foreground">{folder().name}</Text><If when={folder().sessionIds.includes(item.row.id)}><Icon name="check" size={14} /></If></MenuItem>}</Each>
          <MenuSeparator class="h-px my-1 bg-border" />
          <MenuItem class={menuItemClass} disabled={disabled()} onSelect={() => editFolder(scope(), undefined, undefined, item.row)}><Icon name="add" size={14} /><Text class="text-sm text-foreground">{t('sessions.sidebar.folders.newFolderEllipsis')}</Text></MenuItem>
          <If when={(sidebarState().folders?.foldersMap[scope()] ?? []).some(folder => folder.sessionIds.includes(item.row.id))}><MenuItem class={menuItemClass} disabled={disabled() || !sidebarState().folders} onSelect={() => invoke(() => { void sidebar.folders(scope(), { kind: 'member', sessionId: item.row.id, folderId: null, directory: item.row.directory }); })}><Text class="text-sm text-destructive">{t('sessions.sidebar.folders.removeFromFolder')}</Text></MenuItem></If>
        </Submenu>
      </If>
      <MenuSeparator class="h-px my-1 bg-border" />
      <If when={!item.row.archived} else={<MenuItem class={menuItemClass} disabled={disabled()} onSelect={() => invoke(() => { void sidebar.restore(item.row); })}><Text class="text-sm text-foreground">{t('settings.yuri.archivedSessions.actions.restore')}</Text></MenuItem>}>
        <MenuItem class={menuItemClass} disabled={disabled()} onSelect={() => { void confirmArchive(item.row); }}><Icon name="archive" size={14} /><Text class="text-sm text-foreground">{t('sessions.sidebar.bulkActions.archive')}</Text></MenuItem>
      </If>
      <MenuItem class={menuItemClass} disabled={disabled()} onSelect={() => { void confirmDelete(item.row); }}><Text class="text-sm text-destructive">{t('sessions.sidebar.dialogs.deleteSession.titleAction')}</Text></MenuItem>
    </View>;
  }
  function SessionRow(item: { row: Row; context: string; tree?: boolean; folderId?: string | null; depth?: number }) {
    const shift = signal(false);
    const key = () => `${item.context}:${item.row.directory}:${item.row.id}`;
    const selected = () => {
      if (!desktopSidebarSelected(item.row, props.selectedTarget)) return false;
      return selectedRepresentation()?.context === item.context;
    };
    const blocking = () => readProjectsBlocking(controller.attention().blockingByDirectory, item.row.directory, item.row.id);
    const indicator = () => resolveMobileSessionIndicator({ ...blocking(), hasPendingPermission: false, running: running().has(item.row.id), unread: !item.row.parentID && (unread()[item.row.id] ?? 0) > 0 });
    const expanded = () => props.view.expandedSessions().includes(sidebarSessionKey(item.row));
    const hasChildren = () => !!item.tree && (sessionState(item.row)?.hasChildren === true || (sidebarState().children[sidebarSessionKey(item.row)]?.rows.length ?? 0) > 0);
    const target = (): DesktopSidebarDragTarget | null => item.context === 'running' || item.row.parentID ? null : { kind: 'session', scope: item.context === 'pinned' ? '__pinned__' : item.context, id: item.row.id, folderId: item.folderId };
    const relativeTime = () => { const value = desktopSidebarRelativeTime(item.row.activity ?? item.row.updated, Date.now()); return value ? t(value.key, { count: value.count }) : ''; };
    const tooltip = <Tooltip placement="right" delay={0} class="rounded-lg bg-card border border-border px-3 py-2 shadow-lg"><Text class="text-sm text-foreground">{item.row.title}</Text><Text class="text-xs text-muted-foreground">{relativeTime()}</Text><Text class="text-xs text-muted-foreground">{secondary().get(normalizeDirectoryKey(item.row.directory))?.project}</Text><Text class="text-xs text-muted-foreground">{secondary().get(normalizeDirectoryKey(item.row.directory))?.branch}</Text></Tooltip>;
    return <If when={renameContext() === item.context && rename()?.id === item.row.id && rename()?.directory === item.row.directory} else={<DragRow target={target()} label={item.row.title} selected={selected()}>
      <ContextMenu class="flex-1 min-w-0" style={{ height: 33 }} open={can() && menu() === `context:${key()}`} onOpenChange={event => menu.set(event.open && can() ? `context:${key()}` : '')} popupClass={menuClass} trigger={
        <View role="button" {...desktopSidebarDragBindings(target(), drag)} testID={`desktop-session-${item.context}-${item.row.id}`} accessibilityState={{ selected: selected() }} tooltip={tooltip} class="w-full min-w-0 flex-row items-center gap-1 rounded-lg pr-2 group-hover:pr-14 group-focus-within:pr-14 focus-visible:ring-2 focus-visible:ring-ring" style={{ height: 33, paddingLeft: desktopSidebarPadding(item.depth ?? 0) }} onPress={() => invoke(() => { navigationOwner.open(item.context, item.row); })}>
          <Text class="flex-1 min-w-0 text-sm text-foreground" style={{ numberOfLines: 1, lineHeight: 21 }}>{item.row.title || t('sessions.sidebar.session.untitled')}</Text>
          <If when={!!item.row.changes}><Text class="text-xs text-muted-foreground" style={{ flexShrink: 0 }}>{item.row.changes}</Text></If>
          <If when={blocking().hasPendingPermission}><View testID={`desktop-permission-${item.row.id}`} class="flex-row items-center gap-1 rounded bg-destructive/10 px-1" accessibilityLabel={t('sessions.sidebar.session.status.permissionRequired')}><Icon name="shield" size={12} color={String(token('destructive'))} /><Text class="text-xs text-destructive">{permissionCounts().get(sidebarSessionKey(item.row))}</Text></View></If>
          <If when={indicator() !== 'idle'}><View class="group-hover:hidden group-focus-within:hidden"><DesktopSidebarIndicator indicator={indicator()} sessionID={item.row.id} /></View></If>
        </View>
      }><SessionItems row={item.row} scope={item.context} /></ContextMenu>
      <If when={hasChildren()}><View role="button" testID={`desktop-children-${item.row.id}`} class={`${compactButton} ${reveal}`} style={{ position: 'absolute', left: desktopSidebarPadding(Math.max(0, (item.depth ?? 1) - 1)), width: 14, height: 24 }} accessibilityState={{ expanded: expanded(), busy: sidebarState().pending.includes(`children:${sidebarSessionKey(item.row)}`) }} accessibilityLabel={t(expanded() ? 'sessions.sidebar.session.subsessions.collapse' : 'sessions.sidebar.session.subsessions.expand')} onPress={() => invoke(() => {
        const wasExpanded = expanded(); toggle(props.view.expandedSessions, sidebarSessionKey(item.row));
        if (!wasExpanded) void sidebar.loadChildren(item.row);
      })}><Icon name={sidebarState().pending.includes(`children:${sidebarSessionKey(item.row)}`) ? 'loader' : expanded() ? 'arrow-down-s' : 'arrow-right-s'} size={12} /></View></If>
      <View class={`flex-row items-center gap-1 ${reveal}`} style={{ position: 'absolute', right: 4, height: 24 }}>
        <Button testID={`desktop-session-pin-${item.context}-${item.row.id}`} class={quickButton} style={{ width: 20, height: 24 }} disabled={!can() || controller.pending().includes(item.row.id)} accessibilityLabel={t(pins().has(item.row.id) ? 'sessions.sidebar.session.menu.unpin' : 'sessions.sidebar.session.menu.pin')} onPress={() => invoke(() => { void controller.mutate(item.row, 'pin'); })}><Icon name={pins().has(item.row.id) ? 'pushpin-2-fill' : 'pushpin-2'} size={14} /></Button>
        <View role="button" testID={`desktop-session-archive-${item.context}-${item.row.id}`} class={quickButton} style={{ width: 20, height: 24 }} disabled={!can() || controller.pending().includes(item.row.id)} accessibilityLabel={t(item.row.archived || shift() ? 'sessions.sidebar.dialogs.deleteSession.titleAction' : 'sessions.sidebar.bulkActions.archive')} onMouseEnter={event => shift.set(event.modifiers.shift)} onMouseMove={event => shift.set(event.modifiers.shift)} onMouseLeave={() => shift.set(false)} onPress={event => { if (admitted()) { if (item.row.archived || event.modifiers.shift) void confirmDelete(item.row); else void confirmArchive(item.row); } }}><Icon name={item.row.archived || shift() ? 'delete-bin' : 'archive'} size={14} /></View>
      </View>
    </DragRow>}><InlineRename depth={item.depth ?? 0} /></If>;
  }
  function InlineRename(item: { depth: number }) {
    const focused = signal(false);
    effect(() => {
      if (focused() && admitted()) return keymap.bind('escape', () => { if (admitted() && !controller.pending().includes(rename()?.id ?? '')) rename.set(null); }, { when: 'always' });
    });
    return <View class="flex-row items-center gap-1 pr-2" style={{ height: 35, paddingLeft: desktopSidebarPadding(item.depth) }}>
      <Input testID="desktop-session-rename" class="flex-1 min-w-0 rounded-md bg-secondary px-1 text-sm text-foreground" autoFocus value={title()} disabled={!can() || controller.pending().includes(rename()?.id ?? '')} accessibilityLabel={t('sessions.sidebar.session.menu.rename')} onFocus={() => focused.set(true)} onBlur={() => focused.set(false)} onChange={event => invoke(() => title.set(event.value))} onSubmit={() => { void saveTitle(); }} />
      <Button class={quickButton} style={{ width: 20, height: 24 }} accessibilityLabel={t('sessions.sidebar.session.rename.save')} disabled={!can() || !title().trim() || controller.pending().includes(rename()?.id ?? '')} onPress={() => { void saveTitle(); }}><Icon name="check" size={14} /></Button>
      <Button class={quickButton} style={{ width: 20, height: 24 }} accessibilityLabel={t('sessions.sidebar.session.rename.cancel')} disabled={!can() || controller.pending().includes(rename()?.id ?? '')} onPress={() => invoke(() => rename.set(null))}><Icon name="close" size={14} /></Button>
    </View>;
  }
  function ProjectItems(item: { project: Project }) {
    const action = (label: string, run: () => void) => <MenuItem class={menuItemClass} disabled={!can()} onSelect={() => invoke(run)}><Text class="text-sm text-foreground">{label}</Text></MenuItem>;
    return <View>
      {action(t('sessions.sidebar.project.actions.newSession'), () => props.onNewSession(item.project))}
      {action(t('sessions.sidebar.project.actions.syncSessions'), () => { void controller.syncProject(item.project); })}
      {action(t('sessions.sidebar.project.actions.edit'), () => props.navigation.onEditProject(item.project))}
      {action(t('sessions.sidebar.project.actions.closeProject'), () => { void controller.updateProjectCatalog('close', item.project.id); })}
    </View>;
  }
  function GroupIcon(item: { icon: IconName; open: boolean; busy?: boolean }) {
    return <View class="items-center justify-center" style={{ width: 16, height: 16, flexShrink: 0 }}>
      <If when={item.busy} else={<View><View class="group-hover:hidden group-focus-within:hidden"><Icon name={item.icon} size={16} /></View><View class="hidden group-hover:flex group-focus-within:flex"><Icon name={item.open ? 'arrow-down-s' : 'arrow-right-s'} size={14} /></View></View>}><View class="animate-spin"><Icon name="loader" size={16} /></View></If>
    </View>;
  }
  function ProjectRow(item: { project: Project }) {
    const open = () => !props.view.collapsed().includes(item.project.id);
    const target = { kind: 'project', scope: '__projects__', id: item.project.id } as const;
    const loading = () => [item.project.path, ...controller.orderedWorktrees(item.project).map(tree => tree.path)].some(directory => controller.pending().includes(directory)) || controller.loading() && !controller.buckets()[item.project.path];
    return <DragRow target={target} label={item.project.name}>
      <ContextMenu class="flex-1 min-w-0" style={{ height: 33 }} open={can() && menu() === `project-context:${item.project.id}`} onOpenChange={event => menu.set(event.open && can() ? `project-context:${item.project.id}` : '')} popupClass={menuClass} trigger={<View role="button" {...desktopSidebarDragBindings(target, drag)} testID={`desktop-project-${item.project.id}`} class="w-full min-w-0 flex-row items-center gap-1.5 px-2 group-hover:pr-20 group-focus-within:pr-20 rounded-lg focus-visible:ring-2 focus-visible:ring-ring" style={{ height: 33 }} accessibilityState={{ expanded: open(), busy: !!loading() }} accessibilityLabel={t(open() ? 'sessions.sidebar.group.collapseAria' : 'sessions.sidebar.group.expandAria', { label: item.project.name })} onPress={() => invoke(() => toggle(props.view.collapsed, item.project.id))}><GroupIcon icon="folder-open" open={open()} busy={!!loading()} /><Text class="flex-1 min-w-0 text-sm text-foreground" style={{ numberOfLines: 1, lineHeight: 21 }}>{item.project.name}</Text></View>}><ProjectItems project={item.project} /></ContextMenu>
      <View class={`flex-row items-center gap-1 ${reveal}`} style={{ position: 'absolute', right: 2 }}>
        <If when={!!props.navigation.onNewWorktree}><Button class={quickButton} style={{ width: 24, height: 24 }} accessibilityLabel={t('sessions.sidebar.project.actions.newWorktree')} onPress={() => invoke(() => props.navigation.onNewWorktree?.(item.project))}><Icon name="node-tree" size={16} /></Button></If>
        <Menu open={can() && menu() === `project:${item.project.id}`} onOpenChange={event => menu.set(event.open && can() ? `project:${item.project.id}` : '')} popupClass={menuClass} align="end" trigger={<Button class={quickButton} style={{ width: 24, height: 24 }} accessibilityLabel={t('sessions.sidebar.project.actions.projectMenu')}><Icon name="more-2" size={14} /></Button>}><ProjectItems project={item.project} /></Menu>
        <Button class={quickButton} style={{ width: 24, height: 24 }} accessibilityLabel={t('sessions.sidebar.project.actions.newSession')} onPress={() => invoke(() => props.onNewSession(item.project))}><Icon name="add" size={16} /></Button>
      </View>
    </DragRow>;
  }
  async function removeWorktree(project: Project, tree: NonNullable<DesktopSidebarGroup<Row>['tree']>) {
    if (!admitted() || confirming()) return;
    const revision = ++interactionRevision; confirming.set(true);
    try {
      const result = await AlertDialog.show({ title: t('sessions.sidebar.group.actions.deleteWorktree'), description: tree.branch || tree.name, actions: [{ id: 'cancel', label: t('sessions.sidebar.dialogs.cancel'), role: 'cancel' }, { id: 'delete', label: t('sessions.sidebar.dialogs.deleteSession.titleAction'), role: 'destructive' }] });
      if (admitted() && revision === interactionRevision && result.action === 'delete') await controller.removeWorktree(project, tree, false);
    } finally { if (revision === interactionRevision) confirming.set(false); }
  }
  function WorktreeRow(item: { group: DesktopSidebarGroup<Row>; project: Project }) {
    const open = () => props.view.expandedTrees().includes(item.group.directory);
    const target = { kind: 'worktree', scope: item.project.path, id: item.group.directory } as const;
    return <DragRow target={target} label={item.group.label}>
      <View role="button" {...desktopSidebarDragBindings(target, drag)} class="flex-1 min-w-0 flex-row items-center gap-1.5 pr-2 group-hover:pr-14 group-focus-within:pr-14 rounded-lg focus-visible:ring-2 focus-visible:ring-ring" style={{ height: 33, paddingLeft: desktopSidebarPadding(1) }} accessibilityState={{ expanded: open() }} accessibilityLabel={t(open() ? 'sessions.sidebar.group.collapseAria' : 'sessions.sidebar.group.expandAria', { label: item.group.label })} onPress={() => invoke(() => toggle(props.view.expandedTrees, item.group.directory))}><GroupIcon icon="git-branch" open={open()} /><Text class="flex-1 min-w-0 text-sm text-foreground" style={{ numberOfLines: 1, lineHeight: 21 }}>{item.group.label}</Text></View>
      <View class={`flex-row items-center gap-1 ${reveal}`} style={{ position: 'absolute', right: 2 }}>
        <Button testID={`desktop-worktree-delete-${item.group.directory}`} class={quickButton} style={{ width: 24, height: 24 }} disabled={controller.pending().includes(item.group.directory)} accessibilityLabel={t('sessions.sidebar.group.actions.deleteGroupAria', { label: item.group.label })} onPress={() => { if (item.group.tree) void removeWorktree(item.project, item.group.tree); }}><Icon name="delete-bin" size={16} /></Button>
        <Button class={quickButton} style={{ width: 24, height: 24 }} accessibilityLabel={t('sessions.sidebar.project.actions.newSession')} onPress={() => invoke(() => props.onNewSession({ ...item.project, path: item.group.directory }))}><Icon name="add" size={16} /></Button>
      </View>
    </DragRow>;
  }
  function DirectoryRows(item: { group: DesktopSidebarGroup<Row> }) {
    const count = () => props.view.counts()[item.group.directory] ?? DESKTOP_SIDEBAR_INITIAL_COUNT;
    const window = computed(() => outlines().get(item.group.directory));
    const bucket = () => controller.buckets()[item.group.directory];
    const pending = () => controller.pending().includes(item.group.directory);
    return <View class="gap-0">
      <OutlineRows scope={item.group.directory} />
      <If when={!window()?.rows.length && bucket()?.loaded && !pending() && !controller.error()}><Text class="px-2 py-1 text-xs text-muted-foreground">{t('sessions.sidebar.group.empty.noSessionsInWorkspace')}</Text></If>
      <If when={(window()?.hidden ?? 0) > 0 || bucket()?.hasMore || !bucket()?.loaded}>
        <Button testID={`desktop-more-${item.group.directory}`} class={`${rowClass} py-1`} disabled={!can() || pending()} onPress={() => invoke(() => {
          const next = count() + DESKTOP_SIDEBAR_PAGE_INCREMENT;
          props.view.counts.set({ ...props.view.counts(), [item.group.directory]: next });
          if (item.group.rows.length < next) void controller.loadDirectory(item.group.directory);
        })}><Text class="text-xs text-muted-foreground">{pending() ? t('common.loading') : t('sessions.sidebar.group.showMore')}</Text></Button>
      </If>
      <If when={count() > DESKTOP_SIDEBAR_INITIAL_COUNT}><Button class={`${rowClass} py-1`} onPress={() => invoke(() => props.view.counts.set({ ...props.view.counts(), [item.group.directory]: DESKTOP_SIDEBAR_INITIAL_COUNT }))}><Text class="text-xs text-muted-foreground">{t('sessions.sidebar.group.showFewer')}</Text></Button></If>
    </View>;
  }
  function FolderRow(item: { folder: SessionFolder; scope: string; depth: number }) {
    const closed = () => sidebarState().folders?.collapsedFolderIds.includes(item.folder.id) ?? false;
    const archived = () => item.scope.startsWith('__archived__:');
    const project = () => sections().find(section => section.groups.some(group => group.directory === item.scope))?.project;
    const target = { kind: 'folder', scope: item.scope, id: item.folder.id, parentId: item.folder.parentId } as const;
    return <If when={folderEditor()?.scope === item.scope && folderEditor()?.folder?.id === item.folder.id} else={<DragRow target={target} label={item.folder.name}>
      <View role="button" {...desktopSidebarDragBindings(target, drag)} testID={`desktop-folder-${item.folder.id}`} class="flex-1 min-w-0 flex-row items-center gap-1.5 pr-2 group-hover:pr-24 group-focus-within:pr-24 rounded-lg focus-visible:ring-2 focus-visible:ring-ring" style={{ height: 33, paddingLeft: desktopSidebarPadding(item.depth) }} accessibilityState={{ expanded: !closed() }} accessibilityLabel={t(closed() ? 'sessions.sidebar.folderItem.expandAria' : 'sessions.sidebar.folderItem.collapseAria', { folderName: item.folder.name })} onPress={() => invoke(() => { void sidebar.folders(item.scope, { kind: 'collapse', id: item.folder.id }); })}><Icon name="folder-open" size={16} /><Text class="min-w-0 text-sm font-semibold text-muted-foreground" style={{ numberOfLines: 1 }}>{item.folder.name}</Text><Text class="text-xs text-muted-foreground">{`• ${item.folder.sessionIds.length}`}</Text><Icon name={closed() ? 'arrow-right-s' : 'arrow-down-s'} size={14} /></View>
      <View class={`flex-row items-center gap-0.5 ${reveal}`} style={{ position: 'absolute', right: 2 }}>
        <If when={!archived()}>
          <If when={!!props.onNewSessionInFolder && !!project()}><Button class={quickButton} style={{ width: 24, height: 24 }} accessibilityLabel={t('sessions.sidebar.folderItem.newSessionAria', { folderName: item.folder.name })} onPress={() => invoke(() => { const owner = project(); if (owner) props.onNewSessionInFolder?.({ ...owner, path: item.scope }, { scope: item.scope, id: item.folder.id }); })}><Icon name="add" size={14} /></Button></If>
          <If when={!item.folder.parentId}><Button class={quickButton} style={{ width: 24, height: 24 }} accessibilityLabel={t('sessions.sidebar.folderItem.newSubfolderAria', { folderName: item.folder.name })} onPress={() => editFolder(item.scope, undefined, item.folder.id)}><Icon name="folder-add" size={14} /></Button></If>
          <Button class={quickButton} style={{ width: 24, height: 24 }} accessibilityLabel={t('sessions.sidebar.folderItem.renameAria', { folderName: item.folder.name })} onPress={() => editFolder(item.scope, item.folder)}><Icon name="pencil-ai" size={14} /></Button>
          <Button class={quickButton} style={{ width: 24, height: 24 }} accessibilityLabel={t('sessions.sidebar.folderItem.deleteFolderAria', { folderName: item.folder.name })} onPress={() => { void deleteFolder(item.scope, item.folder); }}><Icon name="delete-bin" size={14} /></Button>
        </If>
        <If when={archived()}><Button class={quickButton} style={{ width: 24, height: 24 }} accessibilityLabel={t('sessions.sidebar.folderItem.deleteArchivedInFolderAria', { folderName: item.folder.name })} disabled={confirming()} onPress={() => { const owner = app.projects().find(project => archivedScope(project) === item.scope); if (owner) void deleteArchived(owner, item.folder); }}><Icon name="delete-bin" size={14} /></Button></If>
      </View>
    </DragRow>}><FolderNameEditor depth={item.depth} /></If>;
  }
  function FolderNameEditor(item: { depth: number }) {
    const focused = signal(false);
    effect(() => { if (focused() && admitted()) return keymap.bind('escape', () => { if (admitted() && !sidebarState().pending.includes('folders-write')) folderEditor.set(null); }, { when: 'always' }); });
    return <View class="flex-row items-center gap-1 pr-2" style={{ height: 35, paddingLeft: desktopSidebarPadding(item.depth) }}>
      <Icon name="folder-open" size={16} />
      <Input testID="desktop-folder-name" class="flex-1 min-w-0 bg-transparent text-sm text-foreground" autoFocus disabled={!can() || sidebarState().pending.includes('folders-write')} value={folderName()} accessibilityLabel={t('sessions.sidebar.folderItem.namePlaceholder')} onFocus={() => focused.set(true)} onBlur={() => focused.set(false)} onChange={event => invoke(() => folderName.set(event.value))} onSubmit={() => { void saveFolder(); }} />
      <Button testID="desktop-folder-save" class={quickButton} style={{ width: 20, height: 24 }} accessibilityLabel={t('sessions.sidebar.session.rename.save')} disabled={!can() || !folderName().trim() || sidebarState().pending.includes('folders-write')} onPress={() => { void saveFolder(); }}><Icon name="check" size={14} /></Button>
      <Button class={quickButton} style={{ width: 20, height: 24 }} accessibilityLabel={t('sessions.sidebar.dialogs.cancel')} disabled={!can() || sidebarState().pending.includes('folders-write')} onPress={() => invoke(() => folderEditor.set(null))}><Icon name="close" size={14} /></Button>
    </View>;
  }
  function OutlineRows(item: { scope: string }) {
    return <Each of={outlines().get(item.scope)?.rows ?? []} key={row => row.kind === 'folder' ? `folder:${row.folder.id}` : `session:${sidebarSessionKey(row.session)}`}>{entry => <View>
      <If when={entry().kind === 'folder'} else={<SessionRow row={(entry() as Extract<DesktopSidebarOutlineRow, { kind: 'session' }>).session} folderId={(entry() as Extract<DesktopSidebarOutlineRow, { kind: 'session' }>).folderId} context={item.scope} depth={entry().depth + 1} tree />}>
        <FolderRow folder={(entry() as Extract<DesktopSidebarOutlineRow, { kind: 'folder' }>).folder} scope={item.scope} depth={entry().depth + 1} />
      </If>
    </View>}</Each>;
  }
  function ArchivedRows(item: { project: Project }) {
    const open = () => props.view.archivedOpen().includes(item.project.id), scope = () => archivedScope(item.project);
    const directories = () => [...new Set([item.project.path, ...controller.orderedWorktrees(item.project).map(tree => tree.path)])];
    return <View>
      <View class="group flex-row items-center min-w-0 rounded-lg hover:bg-foreground/3.5 dark:hover:bg-foreground/8" style={{ minHeight: 33 }}><Button testID={`desktop-archived-${item.project.id}`} class="flex-1 min-w-0 flex-row items-center gap-1.5 pr-2 rounded-lg focus-visible:ring-2 focus-visible:ring-ring" style={{ height: 33, paddingLeft: desktopSidebarPadding(1) }} accessibilityLabel={t(open() ? 'sessions.sidebar.group.collapseAria' : 'sessions.sidebar.group.expandAria', { label: t('sessions.sidebar.grouping.archived') })} onPress={() => invoke(() => {
        const wasOpen = open(); toggle(props.view.archivedOpen, item.project.id);
        if (!wasOpen) void (async () => { const paths = directories(); for (let i = 0; i < paths.length && admitted(); i += 2) await Promise.all(paths.slice(i, i + 2).map(path => sidebar.loadArchived(path))); })();
      })}><GroupIcon icon="archive" open={open()} busy={directories().some(path => sidebarState().pending.includes(`archived:${path}`))} /><Text class="text-sm text-foreground" style={{ numberOfLines: 1 }}>{t('sessions.sidebar.grouping.archived')}</Text></Button><If when={scopeRows(scope()).length > 0}><Button testID={`desktop-archived-delete-${item.project.id}`} class={`${quickButton} ${reveal}`} style={{ width: 24, height: 24 }} disabled={confirming()} accessibilityLabel={t('sessions.sidebar.group.actions.deleteArchivedInGroupAria', { label: t('sessions.sidebar.grouping.archived') })} onPress={() => { void deleteArchived(item.project); }}><Icon name="delete-bin" size={16} /></Button></If></View>
      <If when={open()}><OutlineRows scope={scope()} />
        <Each of={directories().filter(path => sidebarState().archived[path]?.cursor)}>{directory => <Button class={rowClass} testID={`desktop-archived-more-${directory()}`} onPress={() => invoke(() => { void sidebar.loadArchived(directory(), true); })}><Text class="text-xs text-foreground">{t('sessions.sidebar.group.showMore')}</Text></Button>}</Each>
        <If when={(outlines().get(scope())?.hidden ?? 0) > 0}><Button class={rowClass} onPress={() => invoke(() => props.view.counts.set({ ...props.view.counts(), [scope()]: (props.view.counts()[scope()] ?? DESKTOP_SIDEBAR_INITIAL_COUNT) + DESKTOP_SIDEBAR_PAGE_INCREMENT }))}><Text class="text-xs text-foreground">{t('sessions.sidebar.group.showMore')}</Text></Button></If>
      </If>
    </View>;
  }
  function NavigationButton(item: { label: string; icon: IconName; onPress: () => void; selected?: boolean; testID?: string; assistant?: boolean; running?: boolean }) {
    const info = () => desktopSidebarTheme().colors.status.info;
    const infoForeground = () => desktopSidebarTheme().colors.status.infoForeground;
    return <Button testID={item.testID} class={`${rowClass} focus:bg-accent ${item.selected ? 'bg-accent' : ''}`} style={{ height: 32, flexShrink: 0 }} accessibilityLabel={item.label} selected={item.selected} onPress={() => invoke(item.onPress)}>
      <View class="items-center justify-center" style={{ width: 16, height: 16 }}><If when={item.assistant && !!navigationStatus()?.avatar} else={<Icon name={item.icon} size={16} color={item.selected ? String(token('accent-foreground')) : undefined} />}><AssistantAvatar bot={navigationStatus()?.avatar ?? {}} size={20} active={rendering()} testID="desktop-assistant-avatar" /></If></View>
      <Text class={`flex-1 text-sm ${item.selected ? 'text-accent-foreground' : 'text-foreground'}`} style={{ numberOfLines: 1 }}>{item.label}</Text>
      <If when={item.assistant && (navigationStatus()?.assistantUnread ?? 0) > 0}><View testID="desktop-assistant-unread" class="rounded-full px-1.5 items-center justify-center" style={{ minWidth: 18, height: 18, backgroundColor: info() }} accessibilityLabel={t('assistants.unread.label', { count: navigationStatus()?.assistantUnread ?? 0 })}><Text class="text-xs" style={{ color: infoForeground() }}>{(navigationStatus()?.assistantUnread ?? 0) > 99 ? '99+' : navigationStatus()?.assistantUnread}</Text></View></If>
      <If when={item.running}><ProjectsSessionIndicator indicator="running" sessionID={item.assistant ? 'sidebar-assistants' : 'sidebar-schedules'} /></If>
    </Button>;
  }
  function FooterButton(item: { label: string; icon: IconName; onPress?: () => void; selected?: boolean; testID: string; size?: number }) {
    return <Button testID={item.testID} accessibilityLabel={item.label} disabled={!item.onPress} selected={item.selected}
      tooltip={<Tooltip placement="top" offset={4} class="rounded-md bg-card border border-border px-2 py-1 shadow-lg"><Text class="text-xs text-foreground">{item.label}</Text></Tooltip>}
      class={`${compactButton} focus:bg-accent disabled:opacity-50 ${item.selected ? 'bg-accent' : ''}`} style={{ width: 28, height: 28, flexShrink: 0 }}
      onPress={() => invoke(() => item.onPress?.())}>
      <View class="opacity-55 hover:opacity-100"><Icon name={item.icon} size={item.size ?? 16} /></View>
    </Button>;
  }
  const topLabel = () => t(inProgress().length ? 'directoryTree.section.pinnedInProgress' : 'directoryTree.section.pinned');
  return <If when={props.visible !== false}><DesktopSidebarMouseSurface drag={drag}>
    <If when={folderEditor() !== null && !folderEditor()?.folder}><FolderNameEditor depth={0} /></If>
    <If when={exported() !== null}><View class="bg-card rounded-md p-2 gap-1">
      <Text class="text-xs text-foreground">{exported()?.filename}</Text>
      <Scroll style={{ height: 160 }}><TextView markdown={exported()?.content ?? ''} selectable class="text-xs text-foreground" /></Scroll>
      <Button testID="desktop-export-copy" class={rowClass} onPress={() => { const value = exported(); if (admitted() && value) void Clipboard.writeText(value.content).then(() => { if (authority() && exported() === value) copyStatus.set(t('contextSidebar.actions.copied')); }).catch(() => { if (authority() && exported() === value) copyStatus.set(t('mobile.files.toast.copyFailed')); }); }}><Text class="text-xs text-foreground">{t('contextSidebar.actions.copy')}</Text></Button>
      <If when={copyStatus()}><Text class="text-xs text-muted-foreground">{copyStatus()}</Text></If>
      <Button testID="desktop-export-save" class="bg-secondary rounded-md px-2 py-1 hover:bg-accent" disabled={!admitted() || documentState().phase === 'saving' || documentState().phase === 'saved'} onPress={() => { void saveDocument(); }}><Text class="text-xs text-foreground">{t(documentState().phase === 'unknown' || documentState().phase === 'pending' ? 'layout.browserProvider.retry' : 'sessions.sidebar.session.rename.save')}</Text></Button>
      <If when={documentState().phase !== 'idle'}><Text testID="desktop-export-save-status" class="text-xs text-muted-foreground">{t(documentState().phase === 'saved' ? 'sessions.sidebar.session.export.success' : documentState().phase === 'cancelled' ? 'chat.todo.cancelled' : documentState().phase === 'saving' || documentState().phase === 'pending' ? 'filesView.editor.saving' : documentState().phase === 'unknown' ? 'desktopHostSwitcher.status.unknown' : 'filesView.toast.saveFailed')}</Text></If>
      <Button class={rowClass} onPress={() => invoke(() => exported.set(null))}><Text class="text-xs text-muted-foreground">{t('sessions.sidebar.dialogs.cancel')}</Text></Button>
    </View></If>
    <Scroll testID="desktop-sidebar-scroll" class="flex-1 min-h-0" style={{ marginTop: -8 }} contentClass="gap-1 px-1 pb-1" onScroll={() => drag.cancel()}>
      <View testID="desktop-sidebar-navigation" class="gap-0.5 py-1">
        <NavigationButton label={t('sessions.sidebar.header.actions.newSession')} icon="chat-new" onPress={() => props.onNewSession()} testID="desktop-new-session" />
        <NavigationButton label={t('sessions.sidebar.header.actions.scheduledTasks')} icon="time" selected={props.selectedSection === 'schedules'} running={navigationStatus()?.scheduleRunning} onPress={props.onSchedules} testID="desktop-schedules" />
        <NavigationButton label={t('assistants.title')} icon="ai-agent" selected={props.selectedSection === 'assistants'} assistant running={navigationStatus()?.assistantRunning} onPress={props.onAssistants} testID="desktop-assistants" />
      </View>
      <If when={controller.error()}><View class="px-2 py-1 gap-1"><Text class="text-xs text-destructive">{controller.error()}</Text><Button testID="desktop-sidebar-retry" class={rowClass} disabled={!can() || controller.loading()} onPress={() => { void retryReads(); }}><Text class="text-xs text-foreground">{t('layout.browserProvider.retry')}</Text></Button></View></If>
      <If when={archivedDeleteFailed()}><Text class="px-2 py-1 text-xs text-destructive">{t('chat.chatInput.toast.reloadFailed')}</Text></If>
      <If when={controller.loading()}><Text class="px-2 py-1 text-xs text-muted-foreground">{t('sessions.sidebar.projectsSyncing')}</Text></If>
      <If when={controller.notice()}><Text class="px-2 text-xs text-muted-foreground">{controller.notice()}</Text></If>
      <Each of={Object.entries(sidebarState().errors).filter(([, message]) => !!message)} key={entry => entry[0]}>{entry => <View class="px-2 gap-1"><Text class="text-xs text-destructive">{entry()[1]}</Text>
        <If when={sidebarState().unknown.includes(entry()[0]) || ['folders', 'folders-write', 'projects-read', 'projects-write'].includes(entry()[0]) || entry()[0].startsWith('children:') || entry()[0].startsWith('archived:')}><Button testID={`desktop-sidebar-operation-retry-${entry()[0]}`} class={rowClass} disabled={!can() || sidebarState().pending.includes(entry()[0])} onPress={() => retrySidebar(entry()[0])}><Text class="text-xs text-foreground">{t('layout.browserProvider.retry')}</Text></Button></If>
      </View>}</Each>
      <Each of={sidebarState().unknown.filter(key => !sidebarState().errors[key])}>{key => <Button class={rowClass} onPress={() => invoke(() => { void sidebar.retry(key()); })}><Text class="text-xs text-foreground">{t('layout.browserProvider.retry')}</Text><Text class="text-xs text-muted-foreground">{key()}</Text></Button>}</Each>
      <If when={sortState().failure}><View class="px-2 gap-1"><Text class="text-xs text-destructive">{sortState().failure?.error}</Text><Button testID="desktop-order-retry" class={rowClass} disabled={!can() || sortState().pending} onPress={() => invoke(() => { void sorting.retry(); })}><Text class="text-xs text-foreground">{t('layout.browserProvider.retry')}</Text></Button></View></If>
      <Each of={controller.deleteBatches()} key={batch => batch.id}>{batch => <View class="px-2 gap-1">
        <Text class="text-xs text-muted-foreground">{t('sessions.sidebar.dialogs.deleteSession.titleAction')}</Text>
        <If when={batch().error}><Text class="text-xs text-destructive">{batch().error}</Text></If>
        <Button testID={`desktop-delete-undo-${batch().id}`} class={rowClass} disabled={!can() || batch().phase === 'committing'} onPress={() => invoke(() => { controller.undoDelete(batch().id); })}><Text class="text-xs text-foreground">{t('sessions.sidebar.undo')}</Text></Button>
        <If when={batch().phase === 'failed'}><Button testID={`desktop-delete-retry-${batch().id}`} class={rowClass} disabled={!can()} onPress={() => invoke(() => { void controller.retryDelete(batch().id); })}><Text class="text-xs text-foreground">{t('layout.browserProvider.retry')}</Text></Button></If>
      </View>}</Each>
      <If when={controller.undoRows().length > 0}><Button class={rowClass} disabled={!can() || controller.pending().includes('undo-archive')} onPress={() => invoke(() => { void controller.undoArchive(); })}><Text class="text-xs text-foreground">{t('sessions.sidebar.undo')}</Text></Button></If>
      <Each of={controller.archiveFailures()} key={row => row.id}>{row => <Button class={rowClass} disabled={!can() || controller.pending().includes(row().id)} onPress={() => invoke(() => { void controller.mutate(row(), 'archive'); })}><Text class="text-xs text-destructive">{t('layout.browserProvider.retry')}</Text><Text class="flex-1 text-xs text-foreground" style={{ numberOfLines: 1 }}>{row().title}</Text></Button>}</Each>
      <If when={pinned().length + inProgress().length > 0}><View class="pb-1">
        <Button testID="desktop-sidebar-top-section" class={`${rowClass} pt-4 pb-1 focus:bg-accent`} accessibilityLabel={t(props.view.pinnedClosed() ? 'sessions.sidebar.group.expandAria' : 'sessions.sidebar.group.collapseAria', { label: topLabel() })} onPress={() => invoke(() => {
          const closed = !props.view.pinnedClosed(); props.view.pinnedClosed.set(closed); props.view.progressClosed.set(closed);
        })}><Text class="text-xs text-muted-foreground">{topLabel()}</Text></Button>
        <If when={!props.view.pinnedClosed()}><Each of={pinned()} key={row => row.id}>{row => <SessionRow row={row()} context="pinned" />}</Each></If>
        <If when={!props.view.progressClosed()}><Each of={inProgress()} key={row => row.id}>{row => <SessionRow row={row()} context="running" />}</Each></If>
      </View></If>
      <View class="flex-row items-center px-2 pb-1" style={{ paddingTop: pinned().length + inProgress().length > 0 ? 16 : 4 }}><Text class="flex-1 text-xs text-muted-foreground">{t('sessions.sidebar.projectsTitle')}</Text>
        <Menu open={can() && menu() === 'projects-header'} onOpenChange={event => menu.set(event.open && can() ? 'projects-header' : '')} popupClass={menuClass} align="end" trigger={<Button testID="desktop-sidebar-projects-menu" class={compactButton} style={{ width: 24, height: 24 }} accessibilityLabel={t('sessions.sidebar.header.actions.sessionDisplayMode')}><Icon name="more-2" size={14} /></Button>}>
          <MenuItem class={menuItemClass} onSelect={() => invoke(() => props.view.collapsed.set(app.projects().map(project => project.id)))}><Icon name="contract-up-down" size={14} /><Text class="text-sm text-foreground">{t('sessions.sidebar.header.displayMode.collapseAll')}</Text></MenuItem>
          <MenuItem class={menuItemClass} onSelect={() => invoke(() => props.view.collapsed.set([]))}><Icon name="expand-up-down" size={14} /><Text class="text-sm text-foreground">{t('sessions.sidebar.header.displayMode.expandAll')}</Text></MenuItem>
        </Menu>
        <Button class={compactButton} style={{ width: 24, height: 24 }} accessibilityLabel={t('sessions.sidebar.header.actions.addProject')} onPress={() => invoke(props.navigation.onAddProject)}><Icon name="add" size={14} /></Button></View>
      <Each of={sections()} key={section => section.project.id}>{section => <View class="gap-0">
        <ProjectRow project={section().project} />
        <If when={!props.view.collapsed().includes(section().project.id)}><Each of={section().groups} key={group => group.directory}>{group => <View>
          <If when={!!group().tree} else={<DirectoryRows group={group()} />}>
            <WorktreeRow group={group()} project={section().project} />
            <If when={props.view.expandedTrees().includes(group().directory)}><DirectoryRows group={group()} /></If>
          </If>
        </View>}</Each><ArchivedRows project={section().project} /></If>
      </View>}</Each>
      <If when={!app.projects().length && !controller.loading() && !controller.error()}><Text class="px-2 py-2 text-xs text-muted-foreground">{t('mobile.sessions.empty.noProjectsTitle')}</Text></If>
    </Scroll>
    <View testID="desktop-sidebar-footer" class="flex-row items-center gap-1 py-2" style={{ paddingLeft: 2, paddingRight: 2, marginBottom: -8, flexShrink: 0 }}>
      <FooterButton label={t('sessions.sidebar.footer.actions.settings')} icon="settings-3" selected={props.selectedSection === 'settings'} onPress={props.onSettings} testID="desktop-settings" />
      <FooterButton label={t('settings.remoteInstances.quick.title')} icon="devices-connected" size={18} selected={props.selectedSection === 'connections'} onPress={props.onConnections} testID="desktop-connections" />
      <FooterButton label={t('sessions.sidebar.footer.actions.shortcuts')} icon="question" onPress={props.onShortcuts} testID="desktop-shortcuts" />
    </View>
  </DesktopSidebarMouseSurface></If>;
}
