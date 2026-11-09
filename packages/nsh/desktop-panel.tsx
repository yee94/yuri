import { cleanup, Clipboard, computed, effect, lifecycle, Scroll, signal, Text, untracked, View, type JSX } from 'nsh';
import { Button, ResizablePanel, ResizablePanelGroup } from 'nsh/base';
import { t } from './i18n';
import { Icon } from './Icon';
import { app } from './state';
import { sameRuntimeScope } from './runtime-scope';
import { NativeDesktopFileEditor } from './desktop-files-editor';
import { createNativeDesktopEditors } from './desktop-files-editor-owner';
import { NativeDesktopFilesTree } from './desktop-files';
import { NativeDesktopChanges } from './desktop-panel-changes';
import { NativeDesktopGit } from './desktop-git';
import type { DesktopGitCallbacks } from './desktop-git-extra';
import { NativeDesktopBrowserPane } from './desktop-browser';
import { DesktopPanelTabs } from './desktop-panel-tabs';
import { DesktopPanelChat, type DesktopPanelChatHandle, type DesktopPanelChatProps } from './desktop-panel-chat';
import type { ChangesSource } from './chat-changes-model';
import type { ChatTarget } from './model';
import type { DesktopBrowserRequest } from './desktop-browser-core';
import type { DesktopJournalStorage } from './desktop-files-journal';
import type { DesktopDiffPreferencesPort } from './desktop-diff-preferences-core';
import { createDesktopFileOperations, desktopFileOperationKey } from './desktop-files-operations';
import { createDesktopFileOperationJournal } from './desktop-files-operation-journal';
import { resourcePath, resourceWithin } from './resources-model';
import { createDesktopPanelTabs, createSourceFileIntent, desktopPanelFileScope, desktopPanelFilePath, desktopPanelRailWidth, desktopPanelScopeKey, desktopPanelVisibility, type DesktopPanelFileSource, type DesktopPanelIntent, type DesktopPanelScope, type DesktopPanelTab } from './desktop-panel-model';

/** Construct once under the window/root owner. Its snapshot is reactive; every
 * callback requires an explicit captured Host/session/directory scope. */
export function createNativeDesktopPanelTabs(options: { storage?: DesktopJournalStorage | false } = {}) {
  const revision = signal(0), editorRevision = signal(0), error = signal(''), modalCount = signal(0);
  const paneModals = new Set<object>();
  let editorDialogs = 0;
  const editors = createNativeDesktopEditors(() => untracked(() => editorRevision.set(editorRevision() + 1)), { ...options, onModalChange: delta => { editorDialogs = Math.max(0, editorDialogs + delta); modalCount.set(editorDialogs + paneModals.size); } });
  const operationJournal = editors.journal ? createDesktopFileOperationJournal(editors.journal.storage, () => untracked(() => editorRevision.set(editorRevision() + 1))) : undefined;
  const filesReady = signal(!operationJournal), filesError = signal('');
  const tabs = createDesktopPanelTabs(() => untracked(() => revision.set(revision() + 1)), {
    scopeProtected: editors.model.scopeProtected,
    scopeRestoreProtected: editors.model.scopeRestoreProtected,
    tabProtected: (scope, tab) => tab.kind === 'file' && editors.model.scopeProtected(desktopPanelScopeKey(desktopPanelFileScope(scope, tab))),
    canClose: (scope, tab) => tab.kind !== 'file' || (() => { const doc = editors.model.peek(desktopPanelFileScope(scope, tab), tab.path); return !doc || !editors.model.protected(doc); })(),
  });
  const closing = new Map<string, Promise<boolean>>();
  const fileOperations = new Map<string, ReturnType<typeof createDesktopFileOperations>>();
  const browsers = new Map<string, { request: (intent: DesktopBrowserRequest) => boolean }>();
  const browserKey = (scope: DesktopPanelScope, id: string) => JSON.stringify([desktopPanelScopeKey(scope), scope.host.lease, id]);
  let alive = true;
  function requestClose(scope: DesktopPanelScope, id: string): Promise<boolean> {
    if (!alive) return Promise.resolve(false);
    const key = JSON.stringify([desktopPanelScopeKey(scope), id]), existing = closing.get(key);
    if (existing) return existing;
    const tab = tabs.snapshot(scope).tabs.find(tab => tab.id === id);
    const document = tab?.kind === 'file' ? editors.model.peek(desktopPanelFileScope(scope, tab), tab.path) : undefined;
    const flight = (async () => {
      if (document && !await editors.guard(document)) return false;
      return alive && tabs.close(scope, id);
    })().catch(() => false).finally(() => { if (closing.get(key) === flight) closing.delete(key); });
    closing.set(key, flight); return flight;
  }
  const canWindowClose = () => alive && filesReady() && ![...fileOperations.values()].some(owner => owner.protected()) && editors.journalState().hydrated && !editors.journalState().error && !editors.journalState().pending && editors.model.documents().every(document => !editors.model.protected(document) && document.state().error !== 'unknown');
  // Startup navigation retains this entire window owner. Recovered protected
  // buffers/receipts must remain reachable, not be mistaken for closing them.
  const canRestoreNavigation = () => alive && filesReady() && !filesError() && editors.journalState().hydrated && !editors.journalState().error && !editors.journalState().pending;
  const dispose = () => {
    if (!canWindowClose() || !editors.model.dispose() || !tabs.dispose()) return false;
    alive = false;
    browsers.clear(); paneModals.clear(); modalCount.set(0);
    editors.journal?.stop();
    return true;
  };
  // Dirty owners are deliberately not cleared by cleanup. The shell must await
  // requestWindowClose() before native approval; actual cleanup releases owners.
  // requestDispose() is reserved for real destruction; scope switches merely
  // detach views and keep bounded, pinned documents in this window owner.
  cleanup(() => { dispose(); alive = false; editors.journal?.stop(); });
  function operations(scope: DesktopPanelScope) {
    const key = desktopFileOperationKey(scope), existing = fileOperations.get(key);
    if (existing) { fileOperations.delete(key); fileOperations.set(key, existing); return existing; }
    if (fileOperations.size >= 20) {
      const oldest = [...fileOperations].find(([, value]) => !value.protected());
      if (!oldest) throw new Error('desktop_file_operations_capacity');
      fileOperations.delete(oldest[0]);
    }
    const related = (path: string) => editors.model.documents().filter(doc => doc.hostID === scope.host.hostID && doc.authorityKey === scope.authorityKey && resourceWithin(doc.path, path));
    const owner = createDesktopFileOperations(scope, {
      notify: () => untracked(() => editorRevision.set(editorRevision() + 1)),
      begin: path => editors.model.beginMutation(scope, path),
      restoreLock: path => editors.model.beginMutation(scope, path, true),
      persistence: operationJournal?.bind(scope),
      async guard(path) {
        if (editors.journal && !await editors.journal.flush()) return null;
        const checked = new Map<string, number>();
        for (const doc of related(path)) { if (!await editors.guard(doc)) return null; checked.set(doc.key, editors.model.revision(doc)); }
        const current = () => alive && related(path).every(doc => checked.has(doc.key) && !editors.model.protected(doc) && checked.get(doc.key) === editors.model.revision(doc));
        return current() ? current : null;
      },
      confirmed(path) {
        for (const doc of related(path)) {
          for (const row of tabs.metadata()) {
            if (row.scope.host.hostID !== scope.host.hostID || row.scope.authorityKey !== scope.authorityKey) continue;
            const captured = { ...row.scope, host: scope.host };
            for (const tab of tabs.snapshot(captured).tabs) if (tab.kind === 'file' && resourceWithin(tab.path, path)) tabs.close(captured, tab.id);
          }
          editors.model.invalidate(doc);
        }
      },
    });
    fileOperations.set(key, owner); return owner;
  }
  async function restoreOperations() {
    if (!operationJournal || filesReady()) return true;
    await editors.journal?.ready; await operationJournal.ready;
    if (!await operationJournal.restore()) { filesError.set(operationJournal.state().error); return false; }
    for (const record of operationJournal.records()) {
      const scope = { ...record.scope, host: { ...record.scope.host, lease: 'unavailable-until-captured-authority' } };
      const owner = operations(scope);
      if (owner.state().phase === 'idle' && !owner.restore(record.command, record.phase)) { filesError.set('desktop_file_operation_restore_lock_failed'); return false; }
    }
    filesReady.set(true); filesError.set(''); return true;
  }
  const ready = restoreOperations();
  return { ...tabs, editors, error, close: requestClose, requestClose,
    open(scope: DesktopPanelScope, intent: DesktopPanelIntent) {
      if (!alive) return '';
      try { const id = tabs.open(scope, intent); error.set(''); return id; }
      catch (cause) { error.set(cause instanceof Error ? cause.message : String(cause)); return ''; }
    },
    openFileReference(scope: DesktopPanelScope, source: DesktopPanelFileSource, path: string, targetLine?: number) {
      if (!alive) return '';
      try { const id = tabs.open(scope, createSourceFileIntent(scope, source, path, targetLine)); error.set(''); return id; }
      catch (cause) { error.set(cause instanceof Error ? cause.message : String(cause)); return ''; }
    },
    dispose,
    /** Recheck synchronously after other owners' async guards, immediately before native approval. */
    canWindowClose,
    canRestoreNavigation,
    journalState() { editorRevision(); return editors.journalState(); },
    fileOperations: operations,
    ready, filesReady, filesError, restoreOperations,
    fileOperationState(scope: DesktopPanelScope) { editorRevision(); return operations(scope).state(); },
    fileState(scope: DesktopPanelScope, path: string) { revision(); editorRevision(); const doc = editors.model.peek(scope, path); return { open: tabs.snapshot(scope).tabs.some(tab => (tab.kind === 'file' || tab.kind === 'preview') && tab.path === path), dirty: !!doc && editors.model.protected(doc) }; },
    modalOpen: () => modalCount() > 0,
    setModal(owner: object, open: boolean) { if (open) paneModals.add(owner); else paneModals.delete(owner); modalCount.set(editorDialogs + paneModals.size); },
    bindBrowser(scope: DesktopPanelScope, id: string, request: (intent: DesktopBrowserRequest) => boolean) {
      const tab = tabs.snapshot(scope).tabs.find(tab => tab.id === id);
      if (!alive || !tab || tab.kind !== 'browser' && tab.kind !== 'preview') return () => {};
      const key = browserKey(scope, id), binding = { request }; browsers.set(key, binding);
      return () => { if (browsers.get(key) === binding) browsers.delete(key); };
    },
    requestBrowser(scope: DesktopPanelScope, id: string, intent: DesktopBrowserRequest) {
      if (!alive || modalCount() > 0 || tabs.snapshot(scope).selectedID !== id) return false;
      return browsers.get(browserKey(scope, id))?.request(intent) ?? false;
    },
    recoverable() { editorRevision(); return editors.model.documents().filter(document => editors.model.protected(document)); },
    /** Confirmation only. Cancellation or failed native approval leaves this owner usable. */
    async requestWindowClose() { return alive && await editors.guardAll() && canWindowClose(); },
    async requestDispose() { return alive && await editors.guardAll() && dispose(); },
    isDirty(scope: DesktopPanelScope, path: string, source?: DesktopPanelFileSource) { editorRevision(); const doc = editors.model.peek(desktopPanelFileScope(scope, { source }), path); return !!doc && editors.model.protected(doc); },
    snapshot(scope: DesktopPanelScope) { revision(); return tabs.snapshot(scope); },
  };
}
export type NativeDesktopPanelTabsOwner = ReturnType<typeof createNativeDesktopPanelTabs>;
export type NativeDesktopPanelChatContext = Readonly<{ scope: DesktopPanelScope; tabID: string; current: () => boolean }>;
export type NativeDesktopPanelChatPort = {
  /** Explicit feature admission, never inferred from a JSX renderer's existence. */
  enabled: boolean;
  renderCard: DesktopPanelChatProps['renderCard'];
  /** Omit until the native Host really supports independent panel-chat keys. */
  stream?: DesktopPanelChatProps['stream'];
  onOpenFile: (input: NativeDesktopPanelChatContext & { path: string; target: ChatTarget; targetLine?: number }) => void;
  onOpenLink?: (input: NativeDesktopPanelChatContext & { href: string; target: ChatTarget }) => void | Promise<void>;
  onOpenDiff: (input: NativeDesktopPanelChatContext & { source: Extract<ChangesSource, { kind: 'turn' }> }) => void;
  onOwner?: (context: NativeDesktopPanelChatContext, owner: DesktopPanelChatHandle | null) => void;
};
export type NativeDesktopPanelProps = DesktopGitCallbacks & {
  scope: DesktopPanelScope;
  /** True only for the shell's captured route/Host authority. */
  current: () => boolean;
  active: boolean;
  /** Shell-owned Settings/Search/Help/palette/closing occlusion, excluding
   * tabs.modalOpen(). Chat keeps reading; other surface actions are fenced.
   * Internal file confirmations must not invalidate their own operation. */
  modalOpen?: boolean;
  tabs: NativeDesktopPanelTabsOwner;
  menuOwnedKeystrokes?: readonly string[];
  /** Existing context owner supplies real content and receives its exact demand. */
  context?: (scope: DesktopPanelScope, active: () => boolean, interactive: () => boolean) => JSX.Element;
  btw?: (context: { scope: DesktopPanelScope; tabID: string; current: () => boolean; active: () => boolean; interactive: () => boolean; visible: () => boolean }) => JSX.Element;
  panelChat?: NativeDesktopPanelChatPort;
  diffPreferences?: DesktopDiffPreferencesPort;
  railWidth?: number;
  expanded?: boolean;
  onToggleExpanded?: () => void;
  /** Hide only; the shell retains this window's tabs/editor owner. */
  onClose?: () => void;
};

function tabLabel(tab: DesktopPanelTab) {
  if (tab.kind === 'file' || tab.kind === 'preview') return tab.path.split('/').pop() || tab.path;
  if (tab.kind === 'browser') return tab.url;
  if (tab.kind === 'context') return t('contextPanel.mode.context');
  if (tab.kind === 'chat') return tab.target.title || tab.target.sessionID;
  if (tab.kind === 'btw') return t('chat.btw.title');
  const source = tab.source;
  return source.path ? source.path.split('/').pop() || source.path : t(source.kind === 'turn' ? 'diffView.scope.lastTurn' : 'contextPanel.mode.diff');
}

/** Native workbench, not a navigation route and not a Sheet. The shell supplies
 * width/visibility and opens tabs via tabs.open(scope, intent). UI snapshots are
 * Host+session+effective-directory scoped; native leases fence mounted readers. */
export function NativeDesktopPanel(props: NativeDesktopPanelProps) {
  const identity = () => JSON.stringify([desktopPanelScopeKey(props.scope), props.scope.host.lease]);
  return <Each of={[props.scope]} key={identity}>{scope => <DesktopPanelSurface {...props} scope={scope()} />}</Each>;
}

function DesktopPanelSurface(props: NativeDesktopPanelProps) {
  const scope = props.scope;
  const current = computed(() => props.current() && desktopPanelScopeKey(props.scope) === desktopPanelScopeKey(scope) && sameRuntimeScope(scope.host, app.runtimeScope()));
  const active = computed(() => current() && props.active && props.tabs.filesReady() && lifecycle() === 'active');
  // External occlusion revokes bound editor/core operations. An internal guard
  // retains that authority through its own dialog; only its underlying UI stops.
  const businessCurrent = computed(() => active() && !props.modalOpen);
  const interactive = computed(() => businessCurrent() && !props.tabs.modalOpen());
  const snapshot = computed(() => props.tabs.snapshot(scope));
  const selected = computed(() => snapshot().tabs.find(tab => tab.id === snapshot().selectedID));
  const bodyWidth = signal(0), railWidth = signal(desktopPanelRailWidth(props.railWidth));
  const recovery = signal(false), recoveryError = signal('');
  const visible = computed(() => desktopPanelVisibility(snapshot(), bodyWidth()));
  function open(intent: DesktopPanelIntent) { if (interactive()) props.tabs.open(scope, intent); }
  function toggleRail(rail: 'git' | 'files') { if (interactive()) props.tabs.setRail(scope, snapshot().rail === rail && (!visible().compact || snapshot().activeView === 'rail') ? null : rail); }
  const openFile = (path: string, targetLine?: number) => open({ kind: 'file', path: desktopPanelFilePath(scope.directory, path), targetLine });
  return <View testID="native-desktop-panel" class="flex-1 bg-background border-l border-border/30">
    <If when={!!props.tabs.error()}><Text role="alert" class="px-3 text-xs text-destructive">{t('common.unavailable')} · {props.tabs.error()}</Text></If>
    <If when={!!props.tabs.filesError()}><View class="p-2 gap-1"><Text role="alert" class="text-xs text-destructive">{t('common.unavailable')} · {props.tabs.filesError()}</Text><Button testID="desktop-files-recovery-retry" class="min-h-8 px-2 rounded-md bg-secondary" onPress={() => { void props.tabs.restoreOperations(); }}><Text>{t('diffView.actions.retry')}</Text></Button></View></If>
    <DesktopPanelTabs tabs={props.tabs} scope={scope} current={current} active={interactive()} label={tabLabel}
      menuOwnedKeystrokes={props.menuOwnedKeystrokes} expanded={props.expanded} onToggleExpanded={props.onToggleExpanded} onClose={props.onClose}
      railActions={<>
      <If when={!!props.context}><Button testID="desktop-panel-context" class="h-8 w-8 items-center justify-center rounded-md hover:bg-accent" disabled={!interactive()} accessibilityLabel={t('contextPanel.mode.context')} onPress={() => open({ kind: 'context' })}><Icon name="pie-chart" size={16} /></Button></If>
      <If when={props.tabs.recoverable().length > 0}><Button testID="desktop-panel-recovery" class="h-8 w-8 items-center justify-center rounded-md hover:bg-accent" disabled={!interactive()} accessibilityLabel={t('filesView.unsaved.title')} onPress={() => { if (interactive()) recovery.set(!recovery()); }}><Icon name="history" size={16} /></Button></If>
      <Button testID="desktop-panel-rail-git" class="h-8 w-8 items-center justify-center rounded-md hover:bg-accent selected:bg-accent" selected={snapshot().rail === 'git'} disabled={!interactive()} accessibilityLabel={t('layout.rightSidebar.git')} onPress={() => toggleRail('git')}><Icon name="git-branch" size={16} /></Button>
      <Button testID="desktop-panel-rail-files" class="h-8 w-8 items-center justify-center rounded-md hover:bg-accent selected:bg-accent" selected={snapshot().rail === 'files'} disabled={!interactive()} accessibilityLabel={t('contextPanel.actions.toggleFileTree')} onPress={() => toggleRail('files')}><Icon name="list-unordered" size={16} /></Button>
      </>} />
    <If when={!!props.tabs.journalState().error}><View class="p-2 gap-1"><Text role="alert" class="text-xs text-destructive">{t('chat.newSessionDraft.operationFailed')} · {props.tabs.journalState().error}</Text><Button testID="desktop-panel-journal-retry" class="min-h-8 px-2 rounded-md bg-secondary" onPress={() => { void props.tabs.editors.journal?.retry(); }}><Text>{t('diffView.actions.retry')}</Text></Button></View></If>
    <If when={recovery()}><Scroll style={{ maxHeight: 180 }}><Each of={props.tabs.recoverable()} key={document => document.key}>{document => <View class="px-2 py-1 flex-row items-center gap-2">
      <Button class="flex-1 min-h-8 hover:bg-accent" disabled={document().hostID !== scope.host.hostID || document().authorityKey !== scope.authorityKey || document().storedScope.sessionID === null && document().scopeKey !== desktopPanelScopeKey(scope)} onPress={() => {
        const doc = document();
        if (doc.hostID !== scope.host.hostID || doc.authorityKey !== scope.authorityKey) return;
        if (doc.scopeKey === desktopPanelScopeKey(scope)) open({ kind: 'file', path: doc.path });
        else if (doc.storedScope.sessionID !== null) open(createSourceFileIntent(scope, { directory: doc.directory, sessionID: doc.storedScope.sessionID }, doc.path));
      }}><Text class="text-xs text-foreground">{document().hostID} · {document().path}</Text><If when={document().hostID !== scope.host.hostID || document().authorityKey !== scope.authorityKey}><Text class="text-xs text-muted-foreground">{t('common.unavailable')}</Text></If></Button>
      <Button testID={'desktop-panel-recovery-copy-' + document().key} class="min-h-8 px-2 rounded-md bg-secondary" accessibilityLabel={t('filesView.editor.copyFileContents')} onPress={() => { void Clipboard.writeText(document().state().text).catch(() => recoveryError.set(t('filesView.toast.saveFailed'))); }}><Icon name="file-copy" size={14} /></Button>
    </View>}</Each><If when={!!recoveryError()}><Text role="alert">{recoveryError()}</Text></If></Scroll></If>
    <View testID="desktop-panel-body" class="flex-1" onLayout={event => { const width = event.bounds.size.width; if (width > 0 && width !== bodyWidth()) bodyWidth.set(width); }}>
      <ResizablePanelGroup axis="horizontal" handleClass="bg-border/30" class="flex-1">
      <ResizablePanel testID="desktop-panel-preview" minSize={100} visible={visible().preview}>
        <Each of={snapshot().tabs} key={tab => tab.id}>{tab => <View class="flex-1" style={{ display: snapshot().selectedID === tab().id ? 'flex' : 'none' }}>
          <DesktopPanelTabContent tabs={props.tabs} scope={scope} tab={tab()} current={current} businessCurrent={businessCurrent} active={active() && visible().preview && snapshot().selectedID === tab().id} browserOccluded={props.modalOpen} context={props.context} btw={props.btw} panelChat={props.panelChat} diffPreferences={props.diffPreferences} open={open} openFile={openFile} />
        </View>}</Each>
      </ResizablePanel>
      <ResizablePanel testID="desktop-panel-rail" minSize={visible().preview ? 240 : 0} maxSize={visible().preview ? 860 : undefined} size={visible().preview ? railWidth() : undefined} visible={visible().rail} onResize={event => { if (visible().preview) railWidth.set(desktopPanelRailWidth(event.size)); }}>
        <View class="flex-1" style={{ display: snapshot().rail === 'git' ? 'flex' : 'none' }}><NativeDesktopGit scope={scope} current={businessCurrent} active={interactive() && visible().rail && snapshot().rail === 'git'} onOpenDiff={source => open({ kind: 'diff', source })} onOpenFile={openFile} onResolveWithAgent={props.onResolveWithAgent} worktreeAttachment={props.worktreeAttachment} /></View>
        <View class="flex-1" style={{ display: snapshot().rail === 'files' ? 'flex' : 'none' }}><NativeDesktopFilesTree scope={scope} current={businessCurrent} active={businessCurrent() && visible().rail && snapshot().rail === 'files'} tabs={props.tabs} selectedPath={selected()?.kind === 'file' ? (() => { const value = selected(); return value?.kind === 'file' && resourceWithin(value.path, scope.directory) ? value.path : undefined; })() : undefined} onOpen={openFile} /></View>
      </ResizablePanel>
      </ResizablePanelGroup>
    </View>
  </View>;
}

function DesktopPanelTabContent(props: { tabs: NativeDesktopPanelTabsOwner; scope: DesktopPanelScope; tab: DesktopPanelTab; current: () => boolean; businessCurrent: () => boolean; active: boolean; browserOccluded?: boolean; context: NativeDesktopPanelProps['context']; btw?: NativeDesktopPanelProps['btw']; panelChat?: NativeDesktopPanelChatPort; diffPreferences?: DesktopDiffPreferencesPort; open: (intent: DesktopPanelIntent) => void; openFile: (path: string, line?: number) => void }) {
  const tab = props.tab;
  if (tab.kind === 'btw') return <View testID="desktop-panel-btw-content" class="flex-1">{props.btw ? props.btw({ scope: props.scope, tabID: tab.id, current: props.current,
    active: () => props.current() && lifecycle() === 'active', interactive: () => props.businessCurrent() && !props.tabs.modalOpen(), visible: () => props.active }) : <Text class="p-3 text-muted-foreground">{t('common.unavailable')}</Text>}</View>;
  if (tab.kind === 'chat') return <If when={props.panelChat?.enabled === true} else={<Text testID="desktop-panel-chat-unavailable" class="p-3 text-muted-foreground">{t('common.unavailable')}</Text>}><DesktopPanelChatTab {...props} tab={props.tab.kind === 'chat' ? props.tab : tab} /></If>;
  if (tab.kind === 'browser' || tab.kind === 'preview') return <DesktopPanelBrowserTab tabs={props.tabs} scope={props.scope} tab={props.tab.kind === 'browser' || props.tab.kind === 'preview' ? props.tab : tab} current={props.current} active={props.active && !props.browserOccluded && !props.tabs.modalOpen()} />;
  if (tab.kind === 'file') {
    const scope = desktopPanelFileScope(props.scope, tab);
    return <NativeDesktopFileEditor owner={props.tabs.editors} scope={scope} path={tab.path} targetLine={props.tab.kind === 'file' ? props.tab.targetLine : undefined} current={props.businessCurrent} active={props.active && props.businessCurrent() && !props.tabs.modalOpen()} onOpen={(path, line) => {
      if (tab.source) props.open(createSourceFileIntent(props.scope, tab.source, path, line));
      else props.openFile(path, line);
    }} />;
  }
  if (tab.kind === 'file-diff') {
    const source = tab.source, scope = { ...props.scope, host: { ...props.scope.host } }, tabID = tab.id;
    const current = () => props.businessCurrent() && props.active && !props.tabs.modalOpen() && props.tabs.snapshot(scope).selectedID === tabID && props.tabs.snapshot(scope).tabs.some(tab => tab.id === tabID);
    return <NativeDesktopChanges scope={scope} source={source} current={current} active={props.active && props.businessCurrent() && !props.tabs.modalOpen()}
      singleFileView showFileSidebar={false} preferences={props.diffPreferences?.preferences(source.path)} filePreferences={path => props.diffPreferences?.preferences(path)}
      onLayoutChange={props.diffPreferences?.available() ? (paths, mode) => { if (current()) props.diffPreferences?.setFileLayout(paths, mode); } : undefined}
      onWrapLinesChange={props.diffPreferences?.available() ? wrap => { if (current()) void props.diffPreferences?.setWrapLines(wrap); } : undefined}
      onOpenDiff={source => { if (current() && source.kind === 'turn' && source.path) props.open({ kind: 'file-diff', source: { ...source, path: source.path } }); }}
      onOpenFile={(path, targetLine) => { if (current() && props.panelChat?.enabled === true) props.panelChat.onOpenFile({ scope, tabID, current, path, targetLine, target: { kind: 'session', id: source.sessionID, directory: source.directory, title: source.sessionID } }); }} />;
  }
  if (tab.kind === 'diff') return <NativeDesktopChanges scope={props.scope} source={tab.source} current={props.businessCurrent} active={props.active && props.businessCurrent() && !props.tabs.modalOpen()}
    singleFileView={false} showFileSidebar={false} preferences={props.diffPreferences?.preferences()} filePreferences={path => props.diffPreferences?.preferences(path)}
    onLayoutChange={props.diffPreferences?.available() ? (paths, mode) => { if (props.active && props.businessCurrent() && !props.tabs.modalOpen()) props.diffPreferences?.setFileLayout(paths, mode); } : undefined}
    onWrapLinesChange={props.diffPreferences?.available() ? wrap => { if (props.active && props.businessCurrent() && !props.tabs.modalOpen()) void props.diffPreferences?.setWrapLines(wrap); } : undefined}
    onOpenEditor={tab.source.kind === 'workspace' ? props.openFile : undefined}
    onOpenDiff={source => props.open({ kind: 'diff', source })} onOpenFile={props.openFile} />;
  return <View testID="desktop-panel-context-content" class="flex-1">{props.context ? props.context(props.scope, () => props.active && props.current(), () => props.active && props.businessCurrent() && !props.tabs.modalOpen()) : <Text class="p-3 text-muted-foreground">{t('common.unavailable')}</Text>}</View>;
}

function DesktopPanelChatTab(props: { tabs: NativeDesktopPanelTabsOwner; scope: DesktopPanelScope; tab: Extract<DesktopPanelTab, { kind: 'chat' }>; current: () => boolean; active: boolean; browserOccluded?: boolean; panelChat?: NativeDesktopPanelChatPort }) {
  const scope = { ...props.scope, host: { ...props.scope.host } }, tabID = props.tab.id;
  const owner = signal<DesktopPanelChatHandle | null>(null);
  let alive = true, locatorRevision = 0, appliedMessageID = props.tab.target.messageID;
  const current = () => alive && props.current() && props.active && props.panelChat?.enabled === true && !props.browserOccluded && !props.tabs.modalOpen()
    && props.tabs.snapshot(scope).selectedID === tabID && props.tabs.snapshot(scope).tabs.some(tab => tab.id === tabID);
  const context: NativeDesktopPanelChatContext = { scope, tabID, current };
  cleanup(() => { alive = false; locatorRevision++; });
  effect(() => {
    const target = props.tab.target, next = target.messageID, handle = owner(), admitted = current();
    if (!admitted || !handle || next === appliedMessageID) return;
    appliedMessageID = next;
    if (!next) return;
    const revision = ++locatorRevision, captured = { ...target };
    // Explicit locator updates remain within the same native surface/tab. A
    // verified private page owns the new initial jump, including cold history.
    untracked(() => { void Promise.resolve().then(() => current() && revision === locatorRevision ? handle.navigate(captured) : false); });
  });
  return <DesktopPanelChat surfaceID={JSON.stringify([desktopPanelScopeKey(scope), tabID])} target={props.tab.target}
    authority={{ hostID: scope.host.hostID, authorityKey: scope.authorityKey }} active={props.active && props.current()}
    interactive={!props.browserOccluded && !props.tabs.modalOpen()} stream={props.panelChat?.stream}
    renderCard={(card, surface) => props.panelChat!.renderCard(card, surface)}
    onOwner={value => { owner.set(value); props.panelChat?.onOwner?.(context, value); }}
    onOpenLink={(href, target, readerCurrent) => {
      if (!current() || !readerCurrent()) return;
      if (!props.panelChat?.onOpenLink) throw new Error('content_link_unavailable');
      return props.panelChat.onOpenLink({ ...context, href, target, current: () => current() && readerCurrent() });
    }}
    onOpenFile={(path, target) => { if (current() && target.kind === 'session') props.panelChat?.onOpenFile({ ...context, path, target: { ...target } }); }}
    onOpenDiff={(file, target, messageID, files) => {
      if (!current() || target.kind !== 'session') return;
      const source: Extract<ChangesSource, { kind: 'turn' }> = { kind: 'turn', directory: target.directory, sessionID: target.id, messageID, path: file.path, files: files.map(file => ({ ...file })) };
      props.panelChat?.onOpenDiff({ ...context, source });
    }} />;
}

function DesktopPanelBrowserTab(props: { tabs: NativeDesktopPanelTabsOwner; scope: DesktopPanelScope; tab: Extract<DesktopPanelTab, { kind: 'browser' | 'preview' }>; current: () => boolean; active: boolean }) {
  const id = props.tab.id;
  let unbind: (() => void) | undefined;
  cleanup(() => { unbind?.(); });
  const current = () => props.current() && props.tabs.snapshot(props.scope).tabs.some(tab => tab.id === id);
  const scope = props.tab.kind === 'preview' ? desktopPanelFileScope(props.scope, props.tab) : props.scope;
  return <NativeDesktopBrowserPane scope={scope} current={current} active={props.active} intent={props.tab}
    onNavigate={props.tab.kind === 'browser' ? url => { if (current()) props.tabs.setBrowserURL(props.scope, id, url); } : undefined}
    request={request => { unbind?.(); unbind = request ? props.tabs.bindBrowser(props.scope, id, request) : undefined; }} />;
}
