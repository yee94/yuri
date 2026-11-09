import { cleanup, computed, Text, View, windowSize, List } from 'nsh';
import { AlertDialog, Button, Input } from 'nsh/base';
import { buildChangesTree, flattenChangesTree, type ChangesTreeDirectoryNode, type FlattenedTreeRow } from './chat-changes-tree.js';
import { t } from './i18n';
import { Icon } from './Icon';
import { changeGroups } from './chat-changes-model';
import type { ChangesGenerationContext } from './chat-changes-generation';
import type { NativeChangesOwner } from './chat-changes';

type Owner = NativeChangesOwner;
type PanelRow = { key: string; staged: boolean; kind: 'header'; count: number; paths: string[] } | { key: string; staged: boolean; kind: 'entry'; row: FlattenedTreeRow };
const iconAction = 'min-h-9 min-w-9 items-center justify-center rounded-lg active:bg-accent disabled:opacity-40';
const action = 'min-h-11 px-3 rounded-xl bg-secondary active:bg-accent disabled:opacity-40 items-center justify-center';

export function NativeWorkspaceChanges(props: { owner: Owner; active?: boolean; generationContext?: ChangesGenerationContext }) {
  const { reader, state } = props.owner;
  const { tree, collapsed, collapsedGroups, message, inputHeight, uncertain, deferredLoaded, remotes, remoteError, generated, generation, refreshRemotes } = props.owner.workspace;
  let alive = true, resize: { y: number; height: number } | undefined;
  const current = () => alive && props.active !== false && reader.current();
  cleanup(() => { alive = false; });
  const actions = props.owner.actions, status = actions.state;
  const snapshot = computed(() => state().snapshot);
  const deferred = () => snapshot()?.oversized === true && !deferredLoaded();
  const deferredCounts = computed(() => {
    let staged = 0, working = 0;
    if (deferred()) for (const file of snapshot()?.files ?? []) { if (file.index.trim() && file.index.trim() !== '?') staged++; if (file.working_dir.trim() || file.index.trim() === '?') working++; }
    return { staged, working };
  });
  const groups = computed(() => deferred() ? [] : changeGroups(snapshot()));
  const paths = computed(() => [...new Set(groups().flatMap(group => group.files.map(file => file.path)))]);
  const stagedCount = computed(() => groups().find(group => group.staged)?.files.length ?? 0);
  const disabled = () => !props.owner.ready() || uncertain() || status().pending || status().unknown || status().needsRefresh || generated().pending || state().loading || !!state().error || !state().snapshot;
  const trees = computed(() => groups().map(group => ({ ...group, tree: buildChangesTree(group.files) })));
  const directoryKeys = computed(() => new Map(trees().map(group => {
    const keys: string[] = [], prefix = group.staged ? 'staged:' : 'working:';
    const visit = (node: ChangesTreeDirectoryNode) => { for (const directory of node.children.values()) { keys.push(prefix + directory.path); visit(directory); } };
    visit(group.tree); return [group.staged, keys] as const;
  })));
  const allDirectoriesExpanded = (staged: boolean) => (directoryKeys().get(staged) ?? []).every(key => !collapsed().has(key));
  function toggleDirectories(staged: boolean) {
    const next = new Set(collapsed()), collapse = allDirectoriesExpanded(staged);
    for (const key of directoryKeys().get(staged) ?? []) { if (collapse) next.add(key); else next.delete(key); }
    collapsed.set(next);
  }
  const rows = computed(() => {
    const result: PanelRow[] = [];
    for (const group of trees()) {
      const groupKey = group.staged ? 'staged' : 'working';
      result.push({ key: groupKey, staged: group.staged, kind: 'header', count: group.files.length, paths: group.files.map(file => file.path) });
      if (collapsedGroups().has(group.staged)) continue;
      const expanded = new Set<string>();
      const visit = (node: ChangesTreeDirectoryNode) => { for (const directory of node.children.values()) { if (!collapsed().has(groupKey + ':' + directory.path)) expanded.add(directory.path); visit(directory); } };
      visit(group.tree);
      const entries: FlattenedTreeRow[] = tree() ? flattenChangesTree(group.tree, expanded) : group.files.map(file => ({ key: file.path, kind: 'file', depth: 0, file }));
      for (const row of entries) result.push({ key: groupKey + ':' + row.key, staged: group.staged, kind: 'entry', row });
    }
    return result;
  });
  function toggleGroup(staged: boolean) { const next = new Set(collapsedGroups()); if (next.has(staged)) next.delete(staged); else next.add(staged); collapsedGroups.set(next); }
  function toggleDirectory(staged: boolean, path: string) { const key = (staged ? 'staged' : 'working') + ':' + path, next = new Set(collapsed()); if (next.has(key)) next.delete(key); else next.add(key); collapsed.set(next); }
  async function revert(selected: string[], directory?: string) {
    if (disabled() || !current()) return;
    const lane = props.owner.operation();
    const count = selected.length;
    const result = await AlertDialog.show({ title: t(directory ? 'gitView.changes.revertDirectoryDialogTitle' : 'gitView.changes.revertAllDialogTitle'), description: directory ? t(count === 1 ? 'gitView.changes.revertDirectoryDescriptionSingle' : 'gitView.changes.revertDirectoryDescriptionPlural', { count, path: directory }) : t(count === 1 ? 'gitView.changes.revertAllDescriptionSingle' : 'gitView.changes.revertAllDescriptionPlural', { count }), actions: [
      { id: 'revert', label: t('gitView.changes.revertAll'), role: 'destructive' },
      { id: 'cancel', label: t('gitView.common.cancel'), role: 'cancel' },
    ] });
    if (current() && props.owner.operation() === lane && result.action === 'revert') await actions.revert(selected, true);
  }
  async function commit(pushAfter: boolean) {
    await actions.commit(message(), pushAfter);
  }
  const actionError = () => status().error === 'mobile.changes.noRemote' ? t('mobile.changes.noRemote') : status().error === 'gitView.toast.commitOrStashBeforeSync' ? t('gitView.toast.commitOrStashBeforeSync') : status().error;
  const dirtyBehind = () => (snapshot()?.behind ?? 0) > 0 && (snapshot()?.files.length ?? 0) > 0;
  const syncLabel = () => dirtyBehind() ? t('gitView.sync.commitOrStashTooltip') : !remotes()?.length ? t('gitView.sync.noRemoteTooltip') : (snapshot()?.ahead ?? 0) > 0 || (snapshot()?.behind ?? 0) > 0 ? t('gitView.sync.syncChangesTooltip', { ahead: snapshot()?.ahead ?? 0, behind: snapshot()?.behind ?? 0 }) : t('gitView.sync.syncChanges');
  return <View class="flex-1">
    <View class="px-4 py-2 gap-2">
      <View class="flex-row items-center gap-2"><Text class="flex-1 text-xs text-muted-foreground" style={{ numberOfLines: 1 }}>{state().snapshot?.current || reader.source.directory}</Text><Button testID="changes-sync" class={iconAction} disabled={disabled() || dirtyBehind() || !remotes()?.length || !!remoteError()} accessibilityLabel={syncLabel()} onPress={() => { void actions.sync(); }}><Icon name={status().pending ? 'loader-4' : 'refresh'} size={16} /></Button><Button testID="changes-refresh" class={iconAction} disabled={state().loading || status().pending} accessibilityLabel={t('mobile.files.refreshAria')} onPress={() => { void reader.refresh(); void refreshRemotes(); }}><Icon name="refresh" size={18} /></Button></View>
      <If when={state().loading || status().pending}><Text class="text-sm text-muted-foreground">{t('common.loading')}</Text></If>
      <If when={!!state().error}><Text role="alert" class="text-sm text-destructive">{state().error}</Text></If>
      <If when={!!remoteError()}><Text role="alert" class="text-sm text-destructive">{remoteError()}</Text></If>
      <If when={!!status().error}><Text role="alert" class="text-sm text-destructive">{actionError()}</Text></If>
      <If when={uncertain() || status().unknown}><Text testID="changes-write-unknown" role="alert" class="text-sm text-destructive">{t(status().unknown ? 'chat.questionDelegate.uncertain' : 'settings.yuri.sessionRetention.result.uncertain')}</Text></If>
      <If when={!!generated().error}><Text testID="changes-generation-error" role="alert" class="text-sm text-destructive">{generated().error === 'gitView.toast.generateCommitMessageFailed' ? t('gitView.toast.generateCommitMessageFailed') : generated().error}</Text></If>
      <If when={status().failedPaths.length > 0}><Button testID="changes-retry-failed" class={action} disabled={disabled()} onPress={() => { void revert(status().failedPaths); }}><Text>{t('diffView.actions.retry')}</Text></Button></If>
    </View>
    <If when={deferred()}><View testID="changes-deferred" class="flex-1 px-6 gap-3 items-center justify-center"><Text class="text-sm text-muted-foreground">{t('gitView.changes.deferredStagedCount', { count: deferredCounts().staged })} · {t('gitView.changes.deferredUnstagedCount', { count: deferredCounts().working })}</Text><Text class="text-sm text-muted-foreground">{t('gitView.changes.deferredHint')}</Text><Button testID="changes-load-deferred" class={action} onPress={() => deferredLoaded.set(true)}><Text class="text-sm text-foreground">{t('gitView.changes.deferredLoadAction')}</Text></Button></View></If>
    <If when={state().gitRepository === false}><View testID="changes-not-repository" class="flex-1 px-6 gap-2 items-center justify-center"><Icon name="git-branch" size={24} /><Text class="text-sm font-semibold text-foreground">{t('gitView.empty.notGitRepository')}</Text><Text class="text-sm text-muted-foreground">{t('gitView.empty.notGitRepositoryDescription')}</Text></View></If>
    <List testID="changes-workspace-list" class="flex-1" style={{ display: deferred() || state().gitRepository === false ? 'none' : 'flex' }} each={rows()} keyExtractor={row => row.key}>{item => <View>
      {item().kind === 'header' ? (() => {
        const group = item(); if (group.kind !== 'header') return null;
        return <View class="min-h-11 px-3 flex-row items-center gap-1">
          <Button testID={`changes-group-${group.staged ? 'staged' : 'working'}`} class="flex-1 min-h-11 flex-row items-center gap-1" onPress={() => toggleGroup(group.staged)}><Text class="text-sm font-semibold text-foreground">{t(group.staged ? 'gitView.changes.stagedTitle' : 'gitView.changes.title')}</Text><Text class="text-xs text-muted-foreground">{group.count}</Text><Icon name={collapsedGroups().has(group.staged) ? 'arrow-right-s' : 'arrow-down-s'} size={14} /></Button>
          <If when={tree()}><Button testID={`changes-collapse-directories-${group.staged}`} class={iconAction} accessibilityLabel={t(allDirectoriesExpanded(group.staged) ? 'diffView.actions.collapseAll' : 'diffView.actions.expandAll')} onPress={() => toggleDirectories(group.staged)}><Icon name={allDirectoriesExpanded(group.staged) ? 'contract-up-down' : 'expand-up-down'} size={16} /></Button></If>
          <Button testID="changes-view-mode" class={iconAction} accessibilityLabel={t(tree() ? 'settings.yuri.git.option.flatList' : 'settings.yuri.git.option.treeView')} onPress={() => tree.set(!tree())}><Icon name={tree() ? 'node-tree' : 'list-unordered'} size={16} /></Button>
          <If when={groups()[0]?.staged === group.staged}><Button testID="changes-revert-all" class={iconAction} disabled={disabled()} accessibilityLabel={t('gitView.changes.revertAll')} onPress={() => { void revert(paths()); }}><Icon name="arrow-go-back" size={16} /></Button></If>
          <Button testID={`changes-${group.staged ? 'unstage' : 'stage'}-all`} class={iconAction} disabled={disabled()} accessibilityLabel={t(group.staged ? 'gitView.changes.unstageAllAria' : 'gitView.changes.stageAllAria')} onPress={() => { void actions.move(group.paths, group.staged); }}><Text class="text-muted-foreground">{group.staged ? '−' : '+'}</Text></Button>
        </View>;
      })() : (() => {
        const value = item(); if (value.kind !== 'entry') return null;
        const row = value.row;
        if (row.kind === 'directory') return <View class="min-h-11 pr-3 flex-row items-center gap-1" style={{ paddingLeft: 12 + row.depth * 14 }}>
          <Button testID={`changes-directory-${value.staged}-${row.directory.path}`} class="flex-1 min-h-11 flex-row items-center gap-2" accessibilityLabel={t(collapsed().has((value.staged ? 'staged' : 'working') + ':' + row.directory.path) ? 'gitView.changes.expandDirectoryAria' : 'gitView.changes.collapseDirectoryAria', { path: row.directory.path })} onPress={() => toggleDirectory(value.staged, row.directory.path)}><Icon name={collapsed().has((value.staged ? 'staged' : 'working') + ':' + row.directory.path) ? 'folder-3-fill' : 'folder-open-fill'} size={16} /><Text class="flex-1 text-sm text-muted-foreground" style={{ numberOfLines: 1 }}>{row.directory.name}</Text><Text class="text-xs text-muted-foreground">{row.directory.files.length}</Text></Button>
          <If when={!value.staged}><Button class={iconAction} disabled={disabled()} accessibilityLabel={t('gitView.changes.revertDirectoryAria', { path: row.directory.path })} onPress={() => { void revert(row.directory.files.map(file => file.path), row.directory.path); }}><Icon name="arrow-go-back" size={16} /></Button></If>
          <Button class={iconAction} disabled={disabled()} accessibilityLabel={t(value.staged ? 'gitView.changes.unstageDirectoryAria' : 'gitView.changes.stageDirectoryAria', { path: row.directory.path })} onPress={() => { void actions.move(row.directory.files.map(file => file.path), value.staged); }}><Text class="text-muted-foreground">{value.staged ? '−' : '+'}</Text></Button>
        </View>;
        const file = row.file, stats = state().snapshot?.diffStats?.[file.path];
        return <View class="min-h-11 pr-3 flex-row items-center gap-1" style={{ paddingLeft: 12 + row.depth * 14 }}>
          <Button testID={`changes-${value.staged ? 'staged' : 'working'}-${file.path}`} class="flex-1 min-h-11 flex-row items-center gap-2 active:bg-accent disabled:opacity-40" disabled={status().pending} onPress={() => { void reader.select(file.path, value.staged); }}><Text class="text-xs text-muted-foreground">{value.staged ? file.index : file.working_dir || file.index}</Text><Icon name="file-edit" size={14} /><Text class="flex-1 text-sm text-foreground" style={{ numberOfLines: 1 }}>{tree() ? file.path.split('/').pop() : file.path}</Text><If when={!!stats}><Text class="text-xs text-success">+{stats?.insertions}</Text><Text class="text-xs text-destructive">−{stats?.deletions}</Text></If></Button>
          <If when={!value.staged}><Button testID={`changes-revert-${file.path}`} class={iconAction} disabled={disabled()} accessibilityLabel={t('gitView.changes.revertFileAria', { path: file.path })} onPress={() => { void revert([file.path]); }}><Icon name="arrow-go-back" size={16} /></Button></If>
          <Button testID={`changes-${value.staged ? 'unstage' : 'stage'}-${file.path}`} class={iconAction} disabled={disabled()} accessibilityLabel={t(value.staged ? 'gitView.changes.unstageFileAria' : 'gitView.changes.stageFileAria', { path: file.path })} onPress={() => { void actions.move([file.path], value.staged); }}><Text class="text-muted-foreground">{value.staged ? '−' : '+'}</Text></Button>
        </View>;
      })()}
    </View>}</List>
    <If when={!deferred() && !state().loading && !state().error && state().snapshot !== null && groups().length === 0}><Text class="px-4 text-muted-foreground">{t('diffView.state.cleanWorkingTree')}</Text></If>
    <If when={groups().length > 0}><View class="px-4 pt-2 pb-3 gap-2 border-t border-border/30">
      <View class="flex-row items-center gap-2"><Text class="text-sm font-semibold text-foreground">{t('gitView.commit.title')}</Text><If when={stagedCount() === 0}><Text class="flex-1 text-xs text-muted-foreground">{t('gitView.commit.stageFilesHint')}</Text></If></View>
      <If when={generated().highlights.length > 0}><View testID="changes-highlights" class="rounded-xl border border-border/30 px-3 py-2 gap-2"><View class="flex-row items-center gap-2"><Text class="flex-1 text-xs text-muted-foreground">{t('gitView.commit.aiHighlights.title')}</Text><Button testID="changes-insert-highlights" class={iconAction} disabled={generated().pending || status().pending} accessibilityLabel={t('gitView.commit.aiHighlights.insertAria')} onPress={generation.insertHighlights}><Icon name="arrow-down" size={16} /></Button></View><Each of={generated().highlights}>{highlight => <Text class="text-sm text-foreground">{highlight()}</Text>}</Each></View></If>
      <Input testID="changes-commit-message" multiline value={message()} placeholder={t('gitView.commit.messagePlaceholder')} accessibilityLabel={t('gitView.commit.messagePlaceholder')} disabled={status().pending} class="bg-card rounded-xl p-2 text-sm text-foreground" style={{ height: inputHeight() }} onChange={event => generation.edit(event.value)} />
      <View testID="changes-commit-resize" accessibilityLabel={t('textarea.resizeHandleAria')} class="items-center justify-center" style={{ height: 20 }} onTouchStart={event => { resize = { y: event.pageY, height: inputHeight() }; }} onTouchMove={event => { if (resize) inputHeight.set(Math.max(60, Math.min(windowSize().height * .35, resize.height + event.pageY - resize.y))); }} onTouchEnd={() => { resize = undefined; }} onTouchCancel={() => { resize = undefined; }}><View class="rounded-full bg-muted-foreground/40" style={{ width: 40, height: 4 }} /></View>
      <View class="flex-row items-center gap-2"><Button testID="changes-generate" class={action} disabled={disabled() || stagedCount() === 0} accessibilityLabel={t('gitView.commit.generateAria')} onPress={() => { void generation.generate(); }}><Icon name={generated().pending ? 'loader-4' : 'ai-generate-2'} size={16} /><Text class="text-xs text-foreground">{t('gitView.commit.generate')}</Text></Button><View class="flex-1" /><Button testID="changes-commit" class={action} disabled={disabled() || stagedCount() === 0 || !message().trim()} onPress={() => { void commit(false); }}><Icon name="git-commit" size={16} /><Text class="text-sm text-foreground">{t('gitView.commit.commit')}</Text></Button><Button testID="changes-commit-sync" class={action} disabled={disabled() || stagedCount() === 0 || !message().trim()} accessibilityLabel={t('gitView.commit.pushAria')} onPress={() => { void commit(true); }}><Icon name="arrow-up" size={16} /></Button></View>
    </View></If>
  </View>;
}
