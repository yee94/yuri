import { cleanup, Clipboard, computed, effect, signal, Text, untracked, View, windowSize, type JSX } from 'nsh';
import { Button, DiffView, type DiffHunk, type DiffLineRange, type DiffViewRef, type DiffViewport } from 'nsh/base';
import { Icon } from './Icon';
import { t } from './i18n';
import { nativeChatTextStyle } from './appearance';
import { nativeChangeLocation, nativeSourceHunks, type HistoricalChange } from './chat-changes-model';
import { desktopDiffBody, desktopDiffCopy, desktopDiffFirstChangedLine, desktopDiffFocus, desktopDiffHasFullText, desktopDiffLayout, desktopDiffSelection, type DesktopDiffFocus, type DesktopDiffLayout, type DesktopDiffPreferences } from './desktop-diff-model';

const action = 'min-h-7 min-w-7 px-1.5 rounded-md hover:bg-accent active:bg-accent disabled:opacity-40 flex-row items-center justify-center gap-1.5';
export type DesktopDiffRetainedView = Readonly<{ body: HistoricalChange; requestedLine?: number; selection: DiffLineRange | null; hunk: number | null }>;
export type DesktopDiffDocumentProps = {
  diff: HistoricalChange;
  current: () => boolean;
  historical: boolean;
  targetLine?: number;
  isNew?: boolean;
  singleFileView?: boolean;
  /** Fixed at mount, matching the generated native DiffView contract. */
  viewport?: DiffViewport;
  /** The List owns explicit target admission across recycled document mounts. */
  navigation?: { pending: () => boolean; complete: () => void };
  preferences?: DesktopDiffPreferences;
  onLayoutChange?: (layout: DesktopDiffLayout) => void;
  onWrapLinesChange?: (wrap: boolean) => void;
  onOpenFile: (line?: number) => void;
  onOpenEditor?: (line: number) => void;
  /** Diagnostic projection only: never treat hunk-only positioning as exact. */
  onFocusStatus?: (focus: DesktopDiffFocus) => void;
  headerLeading?: JSX.Element;
  retainedView?: DesktopDiffRetainedView;
  onRetainView?: (view: DesktopDiffRetainedView) => void;
  fullContextExpanded?: boolean;
  /** The same captured reader's explicit workspace operation, not another loader. */
  fullContext?: { snapshot: HistoricalChange | null; loading: boolean; error: string; load: () => Promise<void>; cancel: () => void };
};

/** Native owns diffing, visible rows and syntax; parent mode delegates vertical scrolling to the List. */
export function DesktopDiffDocument(props: DesktopDiffDocumentProps) {
  const parentViewport = props.viewport === 'parent';
  let ref: DiffViewRef | undefined, alive = true, positioned = false, laidOut = false, reading = false, transition = 0;
  let restoring: { body: HistoricalChange; range: DiffLineRange | null; anchorLine?: number; ready: boolean } | undefined;
  let retaining = false, requestedLine = props.targetLine;
  const hunks = signal<DiffHunk[]>([]), viewError = signal(false), copyError = signal(false), loaded = signal(false), expanded = signal(false);
  const adoptionRetry = signal(0);
  const initial = props.fullContextExpanded && props.fullContext?.snapshot ? props.fullContext.snapshot : props.diff;
  const displayed = signal(initial), full = signal(!!props.fullContextExpanded && desktopDiffHasFullText(initial));
  const body = computed(() => desktopDiffBody(displayed(), full()));
  const layout = computed(() => desktopDiffLayout(windowSize().width, props.preferences, props.isNew ?? /^---\s+\/dev\/null(?:\s|$)/m.test(props.diff.patch ?? '')));
  const firstLine = computed(() => desktopDiffFirstChangedLine(props.diff));
  const focus = computed(() => desktopDiffFocus(displayed(), hunks(), props.targetLine, full()));
  cleanup(() => { alive = false; transition++; });
  function reportSelection(view: DiffViewRef) {
    if (!props.onFocusStatus) return;
    const capturedBody = body();
    void view.selectedLines().then(selection => {
      if (!alive || !props.current() || view !== ref || capturedBody !== body()) return;
      props.onFocusStatus?.({ ...focus(), selection: selection?.side === 'new' ? { side: 'new', start: selection.start, end: selection.end } : undefined });
    }).catch(() => { if (alive && props.current() && view === ref) viewError.set(true); });
  }
  function restoreSelection() {
    if (!restoring?.ready || !ref || !alive || !props.current() || restoring.body !== displayed()) return;
    const value = restoring; restoring = undefined;
    ref.setSelectedLines(value.range);
    if (value.anchorLine !== undefined) { const location = nativeChangeLocation(hunks(), value.anchorLine); if (location) ref.goToHunk(location.index); }
    reportSelection(ref);
  }
  effect(() => {
    adoptionRetry();
    const current = props.current(), snapshot = props.fullContext?.snapshot, wanted = props.fullContextExpanded ?? expanded();
    const target = wanted && snapshot ? snapshot : props.diff;
    const complete = wanted && desktopDiffHasFullText(target);
    untracked(() => {
      const serial = ++transition;
      if (!current || target === displayed() && complete === full()) return;
      const view = ref, previous = displayed(), previousFull = full();
      void (async () => {
        const [range, currentHunk] = view ? await Promise.all([view.selectedLines(), view.currentHunk()]) : [null, null];
        if (!alive || !props.current() || transition !== serial || view !== ref) return;
        const anchor = hunks().find(hunk => hunk.index === currentHunk);
        const anchorLine = anchor ? (anchor.newLines ? anchor.newStart : anchor.oldStart) + 1 : undefined;
        const from = previousFull ? { ...previous, patch: undefined } : previous;
        const to = complete ? { ...target, patch: undefined } : target;
        restoring = { body: target, range: desktopDiffSelection(range, from, to), anchorLine: !parentViewport || previousFull !== complete ? anchorLine : undefined, ready: false };
        displayed.set(target); full.set(complete);
        // Native text changes clear selection. The public native read completes
        // after prop adoption; its event also restores when counts stay equal.
        if (view) {
          await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
          const value = await view.hunks();
          if (!alive || !props.current() || serial !== transition || view !== ref) return;
          const next = nativeSourceHunks(value, body().patch);
          if (restoring?.body === target) restoring.ready = true;
          hunks.set(next); restoreSelection();
          reportSelection(view); void readHunks();
        }
      })().catch(() => { if (alive && props.current() && serial === transition) viewError.set(true); });
    });
  });
  function position() {
    if (!alive || !props.current() || !laidOut || !loaded() || positioned || !ref) return;
    positioned = true;
    const retained = props.retainedView;
    if (retained?.body === displayed() && retained.requestedLine === props.targetLine) {
      if (!parentViewport && retained.hunk !== null) ref.goToHunk(retained.hunk);
      ref.setSelectedLines(retained.selection);
      if (!parentViewport || !props.navigation?.pending()) { reportSelection(ref); return; }
    }
    const target = focus();
    const navigate = !parentViewport || props.targetLine !== undefined && (props.navigation?.pending() ?? true);
    if (navigate) {
      props.navigation?.complete();
      if (target.hunkIndex !== undefined) ref.goToHunk(target.hunkIndex);
      if (target.selection) ref.setSelectedLines(target.selection);
    }
    reportSelection(ref);
  }
  function retainView() {
    const view = ref, capturedBody = displayed();
    if (!view || !props.onRetainView || retaining || !alive || !props.current()) return;
    retaining = true;
    void Promise.all([view.selectedLines(), view.currentHunk()]).then(([selection, hunk]) => {
      if (alive && props.current() && ref === view && displayed() === capturedBody) props.onRetainView?.({ body: capturedBody, requestedLine: props.targetLine, selection, hunk });
    }).catch(() => {}).finally(() => { retaining = false; });
  }
  async function readHunks() {
    const view = ref;
    if (!view || reading || !alive || !props.current()) return;
    reading = true;
    const capturedBody = body();
    try {
      if (restoring && !restoring.ready) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      const value = await view.hunks();
      if (!alive || !props.current() || ref !== view || capturedBody !== body()) return;
      if (restoring?.body === displayed()) restoring.ready = true;
      hunks.set(nativeSourceHunks(value, capturedBody.patch)); viewError.set(false); loaded.set(true);
      restoreSelection(); position();
    } catch { if (alive && props.current() && ref === view) viewError.set(true); }
    finally { reading = false; if (alive && props.current() && capturedBody !== body()) void readHunks(); }
  }
  effect(() => { const current = props.current(); untracked(() => { if (current) { if (!loaded() || restoring) void readHunks(); else position(); } }); });
  effect(() => { const line = props.targetLine; if (line !== requestedLine) { requestedLine = line; positioned = false; untracked(position); } });
  async function copy() {
    if (!alive || !props.current() || props.diff.isBinary && !props.diff.patch) return;
    try { await Clipboard.writeText(desktopDiffCopy(displayed())); if (alive && props.current()) copyError.set(false); }
    catch { if (alive && props.current()) copyError.set(true); }
  }
  function toggleFullContext() {
    if (!props.current() || props.historical || props.diff.isBinary || props.fullContext?.loading && !expanded()) return;
    if (!props.fullContext && !desktopDiffHasFullText(props.diff)) return;
    const next = !expanded(); expanded.set(next);
    if (!next) props.fullContext?.cancel();
    else if (!props.fullContext?.snapshot && props.fullContext) void props.fullContext.load();
  }
  return <View class={parentViewport ? 'flex-none' : 'flex-1'}>
    <View class="min-h-8 px-2 py-1 flex-row flex-wrap items-center gap-1.5 border-b border-border/30">
      {props.headerLeading ?? <Text class="flex-1 text-xs text-foreground" style={{ numberOfLines: 1 }}>{props.diff.path}</Text>}
      <If when={!props.historical && !!props.onOpenEditor}><Button testID="desktop-diff-open-editor" class={action} disabled={!props.current()} accessibilityLabel={t('diffView.actions.openFileInEditorAtChange')} onPress={() => { if (props.current()) props.onOpenEditor?.(firstLine()); }}><Icon name="edit" size={14} /></Button></If>
      <Button testID="desktop-diff-open-file" class={action} disabled={!props.current()} accessibilityLabel={t('diffView.actions.openFilePreview')} onPress={() => { if (props.current()) props.onOpenFile(props.targetLine ?? firstLine()); }}><Icon name="eye" size={14} /></Button>
      <Button testID="desktop-diff-copy" class={action} disabled={!props.current() || props.diff.isBinary && !props.diff.patch} accessibilityLabel={t('mobile.files.copyContent')} onPress={() => { void copy(); }}><Icon name="file-copy" size={14} /></Button>
      <If when={!props.singleFileView}>
        <If when={!props.historical}><Button testID="desktop-diff-full-context" class={action} disabled={!props.current() || !!props.diff.isBinary || !!props.fullContext?.loading && !expanded() || !props.fullContext && !desktopDiffHasFullText(props.diff)} accessibilityLabel={t(expanded() ? 'diffView.actions.disableFullFiles' : 'diffView.actions.loadFullFiles')} onPress={toggleFullContext}><Icon name="file-download" size={14} /></Button></If>
        <If when={!!props.onWrapLinesChange}><Button testID="desktop-diff-wrap" class={action} disabled={!props.current()} accessibilityLabel={t(props.preferences?.wrapLines ? 'diffView.actions.disableLineWrap' : 'diffView.actions.enableLineWrap')} onPress={() => { if (props.current()) props.onWrapLinesChange?.(!props.preferences?.wrapLines); }}><Icon name="text-wrap" size={14} /></Button></If>
        <If when={!!props.onLayoutChange}><Button testID="desktop-diff-layout" class={action} disabled={!props.current()} accessibilityLabel={t('layout.mainTab.diff')} onPress={() => { if (props.current()) props.onLayoutChange?.(layout() === 'split' ? 'inline' : 'side-by-side'); }}><Icon name={layout() === 'split' ? 'align-justify' : 'layout-column'} size={14} /></Button></If>
      </If>
    </View>
    <If when={props.fullContext?.loading}><Text testID="desktop-diff-full-context-loading" class="px-3 py-2 text-xs text-muted-foreground">{t('diffView.state.loadingDiff')}</Text></If>
    <If when={!!props.fullContext?.error}><View class="px-3 py-2 flex-row items-center gap-2"><Text role="alert" testID="desktop-diff-full-context-error" class="flex-1 text-xs text-destructive">{t('diffView.state.failedToLoadDiff')} · {t('common.unavailable')}</Text><Button testID="desktop-diff-full-context-retry" class={action} disabled={!props.current() || !!props.fullContext?.loading} onPress={() => { if (props.current() && !props.historical) { expanded.set(true); void props.fullContext?.load(); } }}><Text class="text-xs text-foreground">{t('diffView.actions.retry')}</Text></Button></View></If>
    <If when={viewError() || copyError()}><View class="px-3 py-2 flex-row gap-2 items-center"><Text role="alert" class="flex-1 text-xs text-destructive">{t(copyError() ? 'mobile.files.toast.copyFailed' : 'diffView.state.failedToLoadDiff')}</Text><Button testID="desktop-diff-native-retry" class={action} disabled={!props.current()} onPress={() => { if (!props.current()) return; if (copyError()) void copy(); else { adoptionRetry.set(adoptionRetry() + 1); void readHunks(); } }}><Text class="text-xs text-foreground">{t('diffView.actions.retry')}</Text></Button></View></If>
    <If when={props.diff.isBinary}><Text class="p-3 text-sm text-muted-foreground">{t('diffView.binary.unavailable')}</Text></If>
    <If when={!props.diff.isBinary}>
    <If when={loaded() && !hunks().length}><Text class="px-3 text-sm text-muted-foreground">{t(props.historical ? 'diffView.state.noLastTurnChanges' : 'diffView.state.cleanWorkingTree')}</Text></If>
    <DiffView testID="desktop-native-diff" class={parentViewport ? 'flex-none' : 'flex-1'} viewport={props.viewport} ref={value => { ref = value; void readHunks(); }}
      patch={body().patch} oldValue={body().oldValue} newValue={body().newValue}
      language={props.diff.path} layout={layout()} softWrap={props.preferences?.wrapLines ?? false} inline="word" indicators="classic" contextLines={3} expandAll={full()} lineNumbers background
      fontFamily={nativeChatTextStyle('code').fontFamily} fontSize={nativeChatTextStyle('code').fontSize} lineHeight={nativeChatTextStyle('code').lineHeight}
      classes={{ side: 'bg-background text-foreground', gutter: 'bg-background', lineNumber: 'text-muted-foreground', lineAdded: 'bg-success/10', lineDeleted: 'bg-destructive/10', wordAdded: 'bg-success/20', wordDeleted: 'bg-destructive/20', indicatorAdded: 'text-success', indicatorDeleted: 'text-destructive', separator: 'bg-secondary text-muted-foreground' }}
      onStatsChange={() => { restoreSelection(); void readHunks(); }} onLineSelectionChange={() => { restoreSelection(); retainView(); }} onScroll={() => { if (!laidOut) { laidOut = true; position(); } retainView(); }} />
    </If>
  </View>;
}
