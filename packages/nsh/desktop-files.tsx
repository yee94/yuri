import { cleanup, Clipboard, computed, effect, lifecycle, List, locale, signal, Text, untracked, View, type ListRef, type Point } from 'nsh';
import { AlertDialog, Button, Dialog, Input, Progress } from 'nsh/base';
import { Menu } from 'nsh/desktop';
import { Icon } from './Icon';
import { language, t } from './i18n';
import { historyImportProgressTokens } from './history-import';
import { bindRequest, native } from './runtime';
import { createDesktopFileDownload } from './desktop-files-download';
import type { DesktopPanelScope } from './desktop-panel-model';
import { createDesktopFilesTree } from './desktop-files-model';
import type { DesktopFileCommand } from './desktop-files-operations';
import type { NativeDesktopPanelTabsOwner } from './desktop-panel';
import { resourceParent, resourceResolve, type ResourceEntry } from './resources-model';
import { changesSnapshot } from './chat-changes-model';

type NameCommand = Extract<DesktopFileCommand, { name: string }>;
const action = 'min-h-8 px-2 rounded-md bg-secondary hover:bg-accent disabled:opacity-40 items-center justify-center';
const quiet = 'min-h-8 px-2 rounded-md hover:bg-accent selected:bg-accent disabled:opacity-40 items-center justify-center';
export function NativeDesktopFilesTree(props: { scope: DesktopPanelScope; current: () => boolean; active: boolean; tabs: NativeDesktopPanelTabsOwner; selectedPath?: string; onOpen: (path: string) => void }) {
  const revision = signal(0), downloadRevision = signal(0), search = signal('');
  const dialog = signal<NameCommand | null>(null), name = signal(''), error = signal('');
  const formModal = {}, alertModal = {}, downloadModal = {};
  const git = signal<ReadonlyMap<string, string>>(new Map()), gitError = signal('');
  let alive = true, list: ListRef | undefined, gitSerial = 0;
  const active = computed(() => alive && props.current() && props.active && lifecycle() === 'active');
  const download = createDesktopFileDownload(props.scope, native, active, () => untracked(() => downloadRevision.set(downloadRevision() + 1)));
  const downloading = () => { downloadRevision(); return download.state(); };
  const choosingDownload = computed(() => downloading().phase === 'choosing');
  async function saveDownload(path: string) { await download.save(path); }
  const downloadMB = (value: number) => new Intl.NumberFormat(language() === 'system' ? locale() : language(), { maximumFractionDigits: 2 }).format(value / 1_000_000);
  const request = bindRequest(props.scope.host);
  const tree = createDesktopFilesTree(props.scope.directory, request, active, () => untracked(() => revision.set(revision() + 1)));
  const operations = props.tabs.fileOperations(props.scope);
  const mutation = () => props.tabs.fileOperationState(props.scope);
  const busy = () => mutation().phase === 'working' || mutation().phase === 'unknown';
  const operation = () => ({ scope: props.scope, current: active, request });
  const root = () => { revision(); return tree.query() ? tree.search() : tree.state(); };
  const rows = computed(() => { revision(); return tree.rows(); });
  const filters = () => { revision(); return tree.filters(); };
  async function gitStatus() {
    if (!active()) return;
    const serial = ++gitSerial;
    try {
      const snapshot = changesSnapshot(await request('/api/git/status?directory=' + encodeURIComponent(tree.root)));
      const next = new Map(snapshot.files.map(file => [resourceResolve(file.path, tree.root), file.index + file.working_dir]));
      if (active() && serial === gitSerial) { git.set(next); gitError.set(''); }
    } catch (cause) { if (active() && serial === gitSerial) gitError.set(String(cause)); }
  }
  async function refresh() { await Promise.all([tree.refresh(), gitStatus()]); }
  function closeForm() { dialog.set(null); props.tabs.setModal(formModal, false); }
  async function submit(command: DesktopFileCommand) {
    if (!active()) return false;
    const result = await operations.run(command, operation());
    if (result && active()) { closeForm(); await refresh(); }
    return result;
  }
  function edit(command: NameCommand) { if (active() && !busy()) { error.set(''); name.set(command.name); props.tabs.setModal(formModal, true); dialog.set(command); } }
  async function remove(entry: ResourceEntry) {
    if (!active() || busy()) return;
    props.tabs.setModal(alertModal, true);
    let result: Awaited<ReturnType<typeof AlertDialog.show>>;
    try { result = await AlertDialog.show({ title: t('sidebarFilesTree.dialog.delete.title'), description: t('sidebarFilesTree.dialog.delete.description', { name: entry.name }), actions: [{ id: 'delete', label: t('sidebarFilesTree.menu.delete'), role: 'destructive' }, { id: 'cancel', label: t('gitView.common.cancel'), role: 'cancel' }] }); }
    finally { props.tabs.setModal(alertModal, false); }
    if (active() && result.action === 'delete') await submit({ kind: 'delete', path: entry.path });
  }
  function menu(entry?: ResourceEntry, at?: Point) {
    if (!active()) return;
    const parent = entry?.isDirectory ? entry.path : entry ? resourceParent(entry.path, tree.root)! : tree.root;
    void Menu.popup([
      { label: t('sidebarFilesTree.menu.newFile'), disabled: busy(), onSelect: () => edit({ kind: 'file', parent, name: '' }) },
      { label: t('sidebarFilesTree.menu.newFolder'), disabled: busy(), onSelect: () => edit({ kind: 'directory', parent, name: '' }) },
      entry && { label: t('sidebarFilesTree.menu.rename'), disabled: busy(), onSelect: () => edit({ kind: 'rename', path: entry.path, name: entry.name }) },
      entry && { label: t('sidebarFilesTree.menu.delete'), disabled: busy(), onSelect: () => { void remove(entry); } },
      { type: 'separator' },
      { label: t('sidebarFilesTree.menu.copyPath'), onSelect: () => { if (active()) void Clipboard.writeText(entry?.path ?? tree.root).catch(() => error.set(t('sidebarFilesTree.toast.copyFailed'))); } },
      { label: t('common.revealPath.fileManager'), disabled: busy(), onSelect: () => { void submit({ kind: 'reveal', path: entry?.path ?? tree.root }); } },
       // Only the dedicated native system-save owner can grant a destination;
       // resources.read alone is not local save authority or a download fallback.
        entry && !entry.isDirectory && { label: t('mobileUpdate.toast.actions.download') + (downloading().available ? '' : ' · ' + t('common.unavailable')), disabled: busy() || !downloading().available || !['idle', 'saved'].includes(downloading().phase), onSelect: () => { if (active()) void saveDownload(entry.path); } },
    ], at).catch(cause => error.set(String(cause)));
  }
  async function locate() {
    if (!active() || !props.selectedPath) return;
    search.set(''); await tree.find('');
    if (await tree.reveal(props.selectedPath)) {
      const index = tree.rows().findIndex(row => row.entry.path === props.selectedPath);
      if (active() && index >= 0) list?.scrollToIndex({ index, viewPosition: 0.5 });
    }
  }
  effect(() => { if (active()) { untracked(() => { void gitStatus(); }); cleanup(() => { gitSerial++; }); } });
  effect(() => { if (active()) untracked(() => { void download.probe(); }); });
  effect(() => { const choosing = choosingDownload(); untracked(() => props.tabs.setModal(downloadModal, choosing)); });
  effect(() => { const path = props.selectedPath, visible = active(); if (visible && path) untracked(() => { void tree.reveal(path); }); });
  effect(() => {
    const term = search(), visible = active();
    // Revoke the old search immediately; the debounce must not adopt an old result.
    untracked(() => tree.cancel());
    if (!visible) return;
    const timer = setTimeout(() => {
      if (!active()) return;
      if (term.trim()) {
        if (tree.query() !== term.trim() || !tree.search().resolved && !tree.search().error) void tree.find(term);
      } else {
        void tree.find('');
        if (!tree.state().resolved && !tree.state().error) void tree.load();
      }
    }, term.trim() ? 250 : 0);
    cleanup(() => { clearTimeout(timer); tree.cancel(); });
  });
  cleanup(() => { alive = false; tree.dispose(); download.dispose(); props.tabs.setModal(formModal, false); props.tabs.setModal(alertModal, false); props.tabs.setModal(downloadModal, false); });
  const title = () => t(dialog()?.kind === 'file' ? 'sidebarFilesTree.dialog.createFile.title' : dialog()?.kind === 'directory' ? 'sidebarFilesTree.dialog.createFolder.title' : 'sidebarFilesTree.dialog.rename.title');
  const fileState = (path: string) => props.tabs.fileState(props.scope, path);
  const statusClass = (path: string) => fileState(path).dirty ? 'text-foreground' : /D/.test(git().get(path) ?? '') ? 'text-destructive' : /[A?]/.test(git().get(path) ?? '') ? 'text-success' : git().has(path) ? 'text-foreground' : 'text-muted-foreground';
  return <View testID="desktop-files-tree" class="flex-1 bg-background" onContextMenu={event => menu(undefined, event.pagePosition)}>
    <View class="p-2 gap-2 border-b border-border/30">
      <View class="flex-row items-center gap-2"><Text class="flex-1 text-xs text-muted-foreground" style={{ numberOfLines: 1 }}>{tree.root}</Text><Button testID="desktop-files-refresh" class={quiet} disabled={!active() || root().loading} accessibilityLabel={t(root().error ? 'diffView.actions.retry' : 'mobile.files.refreshAria')} onPress={() => { void refresh(); }}><Icon name="refresh" size={16} /></Button><Button testID="desktop-files-menu" class={quiet} accessibilityLabel={t('sidebarFilesTree.actions.fileMenuTitle')} onPress={() => menu()}><Icon name="more" size={16} /></Button></View>
      <Input testID="desktop-files-search" class="h-8 px-2 rounded-md bg-secondary text-sm text-foreground" value={search()} placeholder={t('mobile.files.search.placeholder')} onChange={event => search.set(event.value)} />
      <View class="flex-row flex-wrap gap-1">
        <Button testID="desktop-files-hidden" class={quiet} selected={filters().showHidden} disabled={!active()} onPress={() => { void tree.filtersChanged({ showHidden: !filters().showHidden }); }}><Text class="text-xs">{t('directoryExplorerDialog.toggle.showHidden')}</Text></Button>
        <Button testID="desktop-files-ignored" class={quiet} selected={!filters().showIgnored} disabled={!active()} accessibilityLabel=".gitignore" onPress={() => { void tree.filtersChanged({ showIgnored: !filters().showIgnored }); }}><Text class="text-xs">.gitignore</Text></Button>
        <Button testID="desktop-files-expand-all" class={quiet} disabled={!active()} onPress={() => { void tree.expandAll(); }}><Text class="text-xs">{t('sidebarFilesTree.actions.expandAllTitle')}{tree.expansionRemaining() ? ' +' : ''}</Text></Button>
        <Button testID="desktop-files-collapse-all" class={quiet} disabled={!active()} onPress={() => tree.collapseAll()}><Text class="text-xs">{t('sidebarFilesTree.actions.collapseAllTitle')}</Text></Button>
        <Button testID="desktop-files-locate" class={quiet} disabled={!active() || !props.selectedPath} accessibilityLabel={t('contextPanel.actions.toggleFileTree')} onPress={() => { void locate(); }}><Icon name="search" size={14} /></Button>
      </View>
      <View class="flex-row gap-1"><Each of={['all', 'file', 'directory'] as const}>{kind => <Button testID={'desktop-files-search-' + kind()} class={quiet} selected={filters().searchType === kind()} disabled={!active()} onPress={() => { void tree.filtersChanged({ searchType: kind() }); }}><Text class="text-xs">{t(kind() === 'all' ? 'contextPanel.preview.console.filter.all' : kind() === 'file' ? 'layout.rightSidebar.files' : 'directoryExplorerDialog.browse.directories')}</Text></Button>}</Each></View>
      <If when={root().loading}><Text class="text-xs text-muted-foreground">{t('common.loading')}</Text></If>
      <If when={!!root().error}><Text role="alert" class="text-xs text-destructive">{root().error}</Text></If>
      <If when={!!error() || !!gitError() || !!mutation().detail}><Text testID="desktop-files-operation-error" role="alert" class="text-xs text-destructive">{error() || mutation().detail || gitError()}</Text></If>
       <If when={mutation().phase === 'unknown'}><Button testID="desktop-files-operation-inspect" class={action} onPress={() => { void (async () => { if (await operations.inspect(operation()) && active()) await refresh(); })(); }}><Text>{t('diffView.actions.retry')}</Text></Button></If>
        <If when={downloading().phase === 'choosing'}><Text class="text-xs text-muted-foreground">{t('common.loading')}</Text></If>
        <If when={['saving', 'checking', 'error', 'unknown', 'saved'].includes(downloading().phase)}><View testID="desktop-files-download-progress" class="gap-2">
          <Text class="text-xs text-muted-foreground" style={{ numberOfLines: 1 }}>{downloading().path}</Text>
          <Progress testID="desktop-files-download-bar" value={downloading().total !== null && downloading().total! > 0 ? Math.min(downloading().phase === 'saved' ? 100 : 99, downloading().received / downloading().total! * 100) : undefined} indeterminate={downloading().total === null && downloading().phase === 'saving'} accessibilityLabel={t('backgroundTasks.download')} trackClass="h-1 overflow-hidden rounded-full" trackStyle={{ backgroundColor: historyImportProgressTokens().track }} indicatorClass={'h-full rounded-full' + (downloading().total === null ? ' w-1/3' : '')} indicatorStyle={{ backgroundColor: ['error', 'unknown'].includes(downloading().phase) ? historyImportProgressTokens().error : historyImportProgressTokens().fill }} />
          <Text class="text-xs text-muted-foreground">{t(downloading().total === null ? 'backgroundTasks.downloadedUnknownTotal' : 'backgroundTasks.downloaded', { completed: downloadMB(downloading().received), total: downloadMB(downloading().total ?? 0) })}</Text>
        </View></If>
        <If when={!!downloading().detail}><Text role="alert" class="text-xs text-destructive">{t('filesView.toast.saveFailed')} · {downloading().detail}</Text></If>
        <If when={downloading().phase === 'checking'}><Text testID="desktop-files-download-checking" class="text-xs text-muted-foreground">{t('common.loading')}</Text></If>
        <If when={downloading().phase === 'unknown'}><View class="flex-row gap-2"><Button testID="desktop-files-download-inspect" class={action} onPress={() => { void download.inspect(); }}><Text>{t('diffView.actions.retry')}</Text></Button><Button testID="desktop-files-download-cancel" class={quiet} onPress={() => { void download.cancel(); }}><Text>{t('gitView.common.cancel')}</Text></Button></View></If>
        <If when={downloading().phase === 'error'}><View class="flex-row gap-2"><Button testID="desktop-files-download-resume" class={action} disabled={!active() || !downloading().resumable} onPress={() => { void download.resume(); }}><Text>{t('backgroundTasks.resume')}{downloading().resumable ? '' : ' · ' + t('common.unavailable')}</Text></Button><Button testID="desktop-files-download-error-cancel" class={quiet} disabled={!active()} onPress={() => { void download.cancel(); }}><Text>{t('gitView.common.cancel')}</Text></Button></View></If>
        <If when={downloading().phase === 'saving' || downloading().phase === 'checking'}><Button testID="desktop-files-download-running-cancel" class={quiet} disabled={!active()} onPress={() => { void download.cancel(); }}><Text>{t('gitView.common.cancel')}</Text></Button></If>
    </View>
    <List ref={value => { list = value; }} class="flex-1" each={rows()} keyExtractor={row => row.entry.path}>{item => <View onContextMenu={event => menu(item().entry, event.pagePosition)}>
      <Button testID={`desktop-file-${item().entry.path}`} selected={props.selectedPath === item().entry.path} class="min-h-8 flex-row items-center gap-1.5 pr-2 hover:bg-accent selected:bg-accent" style={{ paddingLeft: 8 + item().depth * 14 }} onPress={() => { if (!active()) return; if (item().entry.isDirectory) void tree.toggle(item().entry.path); else props.onOpen(item().entry.path); }}>
        <Icon name={item().entry.isDirectory ? item().expanded ? 'arrow-down-s' : 'arrow-right-s' : 'file-code'} size={14} />
        <Text class="flex-1 text-sm text-foreground" style={{ numberOfLines: 1 }}>{item().entry.name}</Text>
        <If when={fileState(item().entry.path).open || git().has(item().entry.path)}><Text testID={'desktop-file-status-' + item().entry.path} class={'text-xs ' + statusClass(item().entry.path)} accessibilityLabel={fileState(item().entry.path).dirty ? t('filesView.unsaved.title') : git().get(item().entry.path) || t('contextPanel.mode.files')}>●</Text></If>
      </Button>
      <If when={item().expanded && item().state?.loading}><Text class="px-4 text-xs text-muted-foreground">{t('common.loading')}</Text></If>
      <If when={item().expanded && !!item().state?.error}><View class="px-3 gap-1"><Text role="alert" class="text-xs text-destructive">{item().state?.error}</Text><Button testID={`desktop-directory-retry-${item().entry.path}`} class={action} onPress={() => { void tree.load(item().entry.path); }}><Text class="text-xs text-foreground">{t('diffView.actions.retry')}</Text></Button></View></If>
    </View>}</List>
    <If when={tree.query() && root().more}><Button testID="desktop-files-search-more" class={action} disabled={root().loading || !active()} onPress={() => { void tree.continueSearch(); }}><Text>{t('gitView.history.loadMore')}</Text></Button></If>
    <If when={root().resolved && !root().loading && !root().error && !root().more && rows().length === 0}><Text class="p-3 text-sm text-muted-foreground">{t(tree.query() ? 'mobile.files.search.empty' : 'mobile.files.empty.directory')}</Text></If>
    <Dialog testID="desktop-files-name-dialog" open={!!dialog()} animation="none" class="p-4 gap-3 bg-background rounded-xl border border-border/30" style={{ width: 340, maxWidth: '92%' }} backdropClass="bg-background/60" closeOnEscape={!busy()} closeOnBackdropPress={!busy()} onClose={() => { if (!dialog()) props.tabs.setModal(formModal, false); }} onOpenChange={event => { if (!event.open && !busy()) closeForm(); }}>
      <Text class="text-base text-foreground">{title()}</Text>
      <Input testID="desktop-files-name" class="min-h-9 px-2 rounded-md bg-secondary text-foreground" value={name()} placeholder={t('sidebarFilesTree.dialog.namePlaceholder')} readonly={busy()} onChange={event => name.set(event.value)} />
      <If when={!!mutation().detail}><Text role="alert" class="text-xs text-destructive">{t('sidebarFilesTree.toast.operationFailed')} · {mutation().detail}</Text></If>
      <View class="flex-row gap-2"><Button testID="desktop-files-name-cancel" class={quiet} disabled={busy()} onPress={closeForm}><Text>{t('gitView.common.cancel')}</Text></Button><Button testID="desktop-files-name-submit" class={action} disabled={busy() || !active() || !name().trim()} onPress={() => { const command = dialog(); if (command) void submit({ ...command, name: name() }); }}><Text>{t('sidebarFilesTree.menu.save')}</Text></Button></View>
    </Dialog>
  </View>;
}
