import { cleanup, computed, effect, lifecycle, List, signal, Text, untracked, View, windowSize, type ListRef } from 'nsh';
import { Button } from 'nsh/base';
import { NativeSelect } from './native-select';
import { Icon } from './Icon';
import { t } from './i18n';
import type { ChangesReader, ChangesSnapshot, ChangesSource } from './chat-changes-model';
import { DesktopDiffDocument, type DesktopDiffRetainedView } from './desktop-diff-document';
import { desktopDiffLayout, type DesktopDiffFocus, type DesktopDiffLayout, type DesktopDiffPreferences } from './desktop-diff-model';
import { createDesktopDiffList, desktopDiffListFiles, type DesktopDiffListFile, type DesktopDiffScope } from './desktop-diff-list-core';

const action = 'min-h-7 min-w-7 px-1.5 rounded-md hover:bg-accent active:bg-accent disabled:opacity-40 flex-row items-center gap-1.5';
export type NativeDesktopDiffListProps = {
  source: ChangesSource;
  /** The original exact-source reader, never a factory or one reader per file. */
  reader: ChangesReader;
  scope: DesktopDiffScope;
  snapshot?: ChangesSnapshot | null;
  /** Authoritative patch invalidation from the existing inventory/event owner. */
  refreshRevision?: string | number;
  files?: readonly DesktopDiffListFile[];
  current: () => boolean;
  active: boolean;
  targetPath?: string;
  targetLine?: number;
  singleFileView?: boolean;
  stackedDefaultCollapsedAll?: boolean;
  turnIsToolSnapshot?: boolean;
  showFileSidebar?: boolean;
  scopeChoices?: readonly { scope: DesktopDiffScope; count?: number; available: boolean }[];
  /** Controlled admission: caller commits an exact source/reader, not a guessed turn. */
  onScopeChange?: (scope: DesktopDiffScope) => void;
  preferences?: DesktopDiffPreferences;
  filePreferences?: (path: string) => DesktopDiffPreferences | undefined;
  onFocusStatus?: (focus: DesktopDiffFocus) => void;
  /** Read-only projection of the actual native viewport, never a demand or scroll override. */
  onVisibleFilesChange?: (keys: readonly string[]) => void;
  onLayoutChange?: (paths: readonly string[], layout: DesktopDiffLayout) => void;
  onWrapLinesChange?: (wrap: boolean) => void;
  onOpenFile: (path: string, line?: number) => void;
  onOpenEditor?: (path: string, line: number) => void;
};

/** The owning adapter swaps the captured reader only when source authority changes.
 * Working/staged retain that reader and body cache; scope replaces only List views. */
export function NativeDesktopDiffList(props: NativeDesktopDiffListProps) {
  return <Each of={[props.reader]} key={reader => reader}>{reader => <DesktopDiffListSurface {...props} reader={reader()} />}</Each>;
}
function DesktopDiffListSurface(props: NativeDesktopDiffListProps) {
  const reader = props.reader, source = reader.source;
  const revision = signal(0), height = signal(480), full = signal(false);
  let list: ListRef | undefined, previousSnapshot: ChangesSnapshot | null | undefined, previousScope: DesktopDiffScope | undefined;
  let previousFiles: readonly DesktopDiffListFile[] = [];
  const retained = new Map<string, DesktopDiffRetainedView>();
  const positionedTargets = new Set<string>();
  const targetRevision = signal(0);
  const current = () => props.current() && props.reader === reader && props.source === source;
  const active = computed(() => current() && props.active && lifecycle() === 'active');
  const owner = createDesktopDiffList({ reader, current, notify: () => untracked(() => revision.set(revision() + 1)) });
  const files = computed(() => {
    if (props.files) return props.files.filter(file => file.staged === (props.scope === 'staged'));
    const snapshot = props.snapshot, scope = props.scope;
    if (snapshot === previousSnapshot && scope === previousScope) return previousFiles;
    previousSnapshot = snapshot; previousScope = scope;
    return previousFiles = desktopDiffListFiles(source, snapshot ?? null, scope);
  });
  const rows = computed(() => { revision(); return owner.rows(); });
  let priorCatalog: readonly { key: string; file: DesktopDiffListFile }[] = [];
  const catalog = computed(() => {
    const previous = new Map(priorCatalog.map(row => [row.key, row]));
    const next = files().map(file => { const key = JSON.stringify([props.scope, file.path]); return previous.get(key) ?? { key, file }; });
    if (next.length === priorCatalog.length && next.every((row, index) => row === priorCatalog[index])) return priorCatalog;
    return priorCatalog = next;
  });
  const stack = computed(() => props.singleFileView ? catalog().filter(row => row.file.path === (props.targetPath ?? source.path)) : catalog());
  const visible = signal<readonly string[]>([]);
  let demandFrame: number | undefined;
  // Native List can report an estimated range before recycled cells finish
  // layout. Coalesce demand at the next frame, without guessing row offsets.
  function demandAfterLayout() {
    if (demandFrame !== undefined) return;
    demandFrame = requestAnimationFrame(() => { demandFrame = undefined; if (active()) owner.visible(visible()); });
  }
  function changeGeometry(change: () => void) { owner.visible([], true); change(); demandAfterLayout(); }
  const live = (key: string) => active() && visible().includes(key) && owner.entry(key)?.expanded === true;
  const toolbarLayout = computed(() => { const file = files().find(file => file.path === (props.targetPath ?? source.path)) ?? files()[0]; return desktopDiffLayout(windowSize().width, file ? props.filePreferences?.(file.path) ?? props.preferences : props.preferences, file?.isNew ?? false); });
  effect(() => {
    const values = files(), scope = props.scope, collapsedAll = props.stackedDefaultCollapsedAll, toolSnapshot = props.turnIsToolSnapshot;
    untracked(() => owner.configure(values, scope, { collapsedAll, toolSnapshot, targetPath: props.targetPath ?? source.path }));
  });
  effect(() => { const value = active(); untracked(() => {
    if (!value && owner.rows().some(row => row.fullContextLoading)) full.set(false);
    owner.active(value);
    if (value) owner.full(full());
  }); });
  let refreshRevision = props.refreshRevision;
  effect(() => {
    const value = props.refreshRevision;
    if (value === refreshRevision || !current()) return;
    refreshRevision = value; untracked(() => owner.refresh());
  });
  function focus(path: string) { if (!active()) return; changeGeometry(() => { const index = owner.focus(path); if (index >= 0) list?.scrollToIndex({ index: props.singleFileView ? 0 : index, animated: false, viewPosition: 0 }); }); }
  let target = '';
  effect(() => {
    const path = props.targetPath ?? source.path, line = props.targetLine ?? source.targetLine, available = rows().some(row => row.file.path === path), enabled = active();
    const key = JSON.stringify([props.scope, path, line]);
    if (enabled && path && available && key !== target) { target = key; untracked(() => { positionedTargets.clear(); targetRevision.set(targetRevision() + 1); focus(path); }); }
  });
  cleanup(() => { if (demandFrame !== undefined) cancelAnimationFrame(demandFrame); owner.dispose(); });
  const scopes = computed(() => (['working', 'staged', 'turn'] as const).map(scope => {
    const choice = props.scopeChoices?.find(choice => choice.scope === scope);
    const available = choice?.available ?? (source.kind === 'turn' ? scope === 'turn' : scope !== 'turn');
    const count = choice?.count;
    return { value: scope, disabled: !available, title: t(scope === 'working' ? 'diffView.scope.changed' : scope === 'staged' ? 'diffView.scope.staged' : 'diffView.scope.lastTurn') + (count === undefined ? '' : ': ' + count) };
  }));
  return <View testID="native-desktop-diff-list" class="flex-1 bg-background">
    <If when={!props.singleFileView}><View class="min-h-9 px-2 flex-row items-center gap-1.5 border-b border-border/30">
      <NativeSelect testID="desktop-diff-scope" value={props.scope} disabled={!active() || !props.onScopeChange} items={scopes()} accessibilityLabel={t('diffView.scope.selectorAria')}
        trigger={<View testID="desktop-diff-scope" class="min-h-7 px-1.5 flex-row items-center gap-1"><Text class="text-xs text-foreground">{scopes().find(item => item.value === props.scope)?.title}</Text><Icon name="arrow-down-s" size={12} /></View>}
        onChange={event => { if (active() && scopes().some(item => item.value === event.value && !item.disabled)) props.onScopeChange?.(event.value as DesktopDiffScope); }} />
      <If when={rows().length > 0 && (props.scope !== 'turn' || props.turnIsToolSnapshot)}><Button testID="desktop-diff-toggle-all" class={action} disabled={!active()} onPress={() => { if (active()) changeGeometry(() => owner.toggleAll()); }} accessibilityLabel={t(rows().some(row => row.expanded) ? 'diffView.actions.collapseAll' : 'diffView.actions.expandAll')}><Icon name="expand-up-down" size={14} /><Text class="text-xs text-foreground">{t(rows().some(row => row.expanded) ? 'diffView.actions.collapseAll' : 'diffView.actions.expandAll')}</Text></Button></If>
      <If when={props.scope !== 'turn'}><Button testID="desktop-diff-list-full-context" class={action} disabled={!active()} accessibilityLabel={t(full() ? 'diffView.actions.disableFullFiles' : 'diffView.actions.loadFullFiles')} onPress={() => { if (active()) { const next = !full(); full.set(next); owner.full(next); } }}><Icon name="file-download" size={14} /></Button></If>
      <If when={!!props.onWrapLinesChange}><Button testID="desktop-diff-list-wrap" class={action} disabled={!active()} onPress={() => { if (active()) props.onWrapLinesChange?.(!props.preferences?.wrapLines); }} accessibilityLabel={t(props.preferences?.wrapLines ? 'diffView.actions.disableLineWrap' : 'diffView.actions.enableLineWrap')}><Icon name="text-wrap" size={14} /></Button></If>
      <If when={!!props.onLayoutChange}><Button testID="desktop-diff-list-layout" class={action} disabled={!active()} onPress={() => { if (active()) props.onLayoutChange?.(files().map(file => file.path), toolbarLayout() === 'split' ? 'inline' : 'side-by-side'); }} accessibilityLabel={t('layout.mainTab.diff')}><Icon name="layout-column" size={14} /></Button></If>
    </View></If>
    <Each of={[props.scope]} key={scope => scope}>{capturedScope => {
      untracked(() => owner.configure(files(), capturedScope(), { collapsedAll: props.stackedDefaultCollapsedAll, toolSnapshot: props.turnIsToolSnapshot, targetPath: props.targetPath ?? source.path }));
      return <View class="flex-1 flex-row">
      <If when={props.showFileSidebar && windowSize().width >= 1024}><View class="w-72 border-r border-border/30"><Text class="px-3 py-2 text-xs text-muted-foreground">{t('diffView.section.files')}</Text><List testID="desktop-diff-list-files" class="flex-1" each={catalog()} keyExtractor={row => row.key}>{row => <Button testID={'desktop-diff-list-file-' + row().file.path} class={action} disabled={!active()} onPress={() => focus(row().file.path)}><Text class="text-xs text-foreground">{row().file.path}</Text></Button>}</List></View></If>
      <List testID="desktop-diff-stack" class="flex-1" ref={value => { list = value; }} estimatedItemSize={48} each={stack()} keyExtractor={row => row.key}
        empty={<Text class="p-3 text-xs text-muted-foreground">{t(source.kind === 'turn' ? 'diffView.state.noLastTurnChanges' : props.files !== undefined || props.snapshot ? 'diffView.state.cleanWorkingTree' : 'common.unavailable')}</Text>}
        onLayout={event => { if (event.bounds.size.height > 0) height.set(event.bounds.size.height); }}
        onViewableItemsChange={event => { if (props.scope !== capturedScope()) return; const keys = event.viewableItems.filter(item => item.isViewable).map(item => item.key); visible.set(keys); owner.visible(keys, true); props.onVisibleFilesChange?.(keys); demandAfterLayout(); }}>
        {item => <Each of={[item()]} key={row => row.key}>{captured => {
          const key = captured().key;
          const row = computed(() => { revision(); return owner.entry(key) ?? { ...captured(), expanded: false, loading: false, error: '', diff: null, fullContext: null, fullContextLoading: false, fullContextError: '' }; });
          const header = <Button testID={'desktop-diff-fold-' + key} class="flex-1 min-h-8 px-2 flex-row items-center gap-1.5 hover:bg-accent" disabled={!active()} accessibilityLabel={row().file.path} onPress={() => changeGeometry(() => owner.expand(key, !row().expanded))}><Icon name={row().expanded ? 'arrow-down-s' : 'arrow-right-s'} size={12} /><Text class="flex-1 text-xs text-foreground" style={{ numberOfLines: 1 }}>{row().file.path}</Text><Text class="text-xs text-muted-foreground">{row().file.status}</Text></Button>;
          const navigationKey = () => JSON.stringify([key, props.targetLine ?? source.targetLine, targetRevision()]);
          return <View testID={'desktop-diff-entry-' + key}>
            <If when={!row().expanded || !row().diff}>{header}</If>
            <If when={row().expanded && !row().diff && !row().error}><Text class="min-h-8 px-3 py-2 text-xs text-muted-foreground">{t('diffView.state.loadingDiff')}</Text></If>
            <If when={row().expanded && !!row().error}><View class="px-3 flex-row items-center gap-2"><Text role="alert" class="text-xs text-destructive">{row().error}</Text><Button testID={'desktop-diff-retry-' + key} class={action} disabled={!active() || row().loading} onPress={() => owner.retry(key)}><Text class="text-xs text-foreground">{t('diffView.actions.retry')}</Text></Button></View></If>
            <If when={row().expanded && !!row().diff}><View style={{ height: props.singleFileView ? height() : undefined }}><DesktopDiffDocument diff={row().diff!} current={() => live(key)} historical={source.kind === 'turn'}
              viewport={props.singleFileView ? undefined : 'parent'} navigation={{ pending: () => !positionedTargets.has(navigationKey()), complete: () => { positionedTargets.add(navigationKey()); } }}
              headerLeading={header} retainedView={retained.get(key)} onRetainView={value => retained.set(key, value)}
              fullContextExpanded={full()} fullContext={source.kind === 'workspace' ? { snapshot: row().fullContext, loading: row().fullContextLoading, error: row().fullContextError, load: async () => { owner.retryFull(key); }, cancel: () => { full.set(false); owner.full(false); } } : undefined}
               targetLine={row().file.path === (props.targetPath ?? source.path) ? props.targetLine ?? source.targetLine : undefined} isNew={row().file.isNew} singleFileView preferences={props.filePreferences?.(row().file.path) ?? props.preferences}
               onFocusStatus={row().file.path === (props.targetPath ?? source.path) ? props.onFocusStatus : undefined}
              onOpenFile={line => { if (live(key)) props.onOpenFile(row().file.path, line); }} onOpenEditor={source.kind === 'workspace' && props.onOpenEditor ? line => { if (live(key)) props.onOpenEditor?.(row().file.path, line); } : undefined} /></View></If>
          </View>;
        }}</Each>}
      </List>
    </View>;
    }}</Each>
  </View>;
}
