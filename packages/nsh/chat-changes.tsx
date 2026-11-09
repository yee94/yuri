import { cleanup, computed, effect, host, Image, Keyboard, keyboardFrame, lifecycle, List, Overlay, platform, safeArea, Scroll, signal, Storage, Text, untracked, View, windowSize, type ViewRef } from 'nsh';
import { Button, DiffView, type DiffViewRef, type DiffHunk } from 'nsh/base';
import { NativeSheet as Sheet } from './native-sheet';
import { extractGitChangedFiles, summarizeGitChangedFiles } from '../ui/src/components/chat/changedFiles';
import { t } from './i18n';
import { Icon } from './Icon';
import { epoch } from './state';
import { createPageOperations } from './page-operations';
import { runtimeEventFrom } from './model';
import { nativeChatTextStyle } from './appearance';
import { nativeChangeLocation, nativeSourceHunks, type ChangesSource, type HistoricalChange } from './chat-changes-model';
import { createChangesOwner } from './chat-changes-owner';
import { NativeWorkspaceChanges } from './chat-changes-workspace';
import type { ChangesGenerationContext } from './chat-changes-generation';
import { isImageFile } from '../ui/src/lib/toolHelpers';
import { nativeDiffIsNew, nativeDiffLayout, type NativeDiffLayoutPreference } from './chat-changes-layout';

type Owner = ReturnType<typeof createChangesOwner>;
type ChangesSheetProps = { source: ChangesSource; open: boolean; active: boolean; onClose: () => void; onOpenPreview?: (path: string, line?: number) => void; owner?: Owner; generationContext?: ChangesGenerationContext; diffLayoutPreference?: NativeDiffLayoutPreference | null };
const action = 'min-h-11 px-3 flex-row items-center justify-center gap-2 rounded-xl bg-secondary active:bg-accent disabled:opacity-40';
/** Web single-file diff actions are icon-only ghost buttons, not labeled chips. */
const diffAction = 'min-h-11 min-w-11 items-center justify-center rounded-lg active:bg-accent disabled:opacity-40';
let wrapPreferenceSave = Promise.resolve();
/** Session override of the canonical preference, matching Web diffFileLayout. Not persisted, and not part of the diff identity. */
let diffLayoutOverride: 'unified' | 'split' | null = null;

/** Same authoritative workspace status and pure summary rules as PendingChangesBar. */
export function NativeComposerChanges(props: {
  directory: string; active: boolean;
  expanded?: boolean;
  onExpandedChange?: (open: boolean) => void;
  /** Legacy navigation callback is intentionally not used for diff opening. */
  onOpenFile?: (path: string, staged: boolean) => void;
  onOpenPreview?: (path: string, line?: number) => void;
  generationContext?: ChangesGenerationContext;
  diffLayoutPreference?: NativeDiffLayoutPreference | null;
}) {
  const operations = createPageOperations(() => props.active), directory = props.directory;
  const localExpanded = signal(false), opened = signal(false);
  const expanded = () => props.expanded ?? localExpanded();
  function setExpanded(open: boolean) {
    if (props.expanded === undefined) localExpanded.set(open);
    props.onExpandedChange?.(open);
  }
  const anchor = signal<ViewRef | null>(null);
  let alive = true, timer: ReturnType<typeof setTimeout> | undefined;
  const current = () => alive && operations.current() && lifecycle() === 'active' && props.directory === directory;
  const owner = createChangesOwner({ kind: 'workspace', directory }, current);
  effect(() => {
    const visible = current();
    untracked(() => {
      if (!visible) { owner.reader.cancel(); setExpanded(false); opened.set(false); }
    });
  });
  const unsubscribe = host.on('runtime.event', payload => {
    const event = runtimeEventFrom(payload);
    if (!current() || !event || event.key !== 'global' || timer || event.directory && event.directory !== directory) return;
    if (event.type !== 'reconnected' && !/^(vcs\.|yuri:git-|yuri:workspace-)/.test(event.type)) return;
    timer = setTimeout(() => { timer = undefined; void owner.reader.refresh(); }, 120);
  });
  cleanup(() => { alive = false; owner.reader.cancel(); unsubscribe(); if (timer) clearTimeout(timer); });
  const summary = computed(() => {
    const value = owner.snapshot();
    return value && !value.isClean ? summarizeGitChangedFiles(value.files, value.diffStats) : { count: 0, insertions: 0, deletions: 0 };
  });
  effect(() => { if (summary().count === 0) setExpanded(false); });
  const files = computed(() => {
    if (!expanded()) return [];
    const value = owner.snapshot();
    return value && !value.isClean ? extractGitChangedFiles(value.files, value.diffStats, directory) : [];
  });
  function open(path: string, staged: boolean) {
    if (!current()) return;
    Keyboard.dismiss(); setExpanded(false); opened.set(true); void owner.reader.select(path, staged);
  }
  return <View class="gap-1">
    <If when={expanded() && !!anchor()}><Overlay anchor={anchor()} placement="top" align="start" offset={8} margin={12} style={{ width: windowSize().width - 24 }} onPressOutside={() => setExpanded(false)} onCancel={() => setExpanded(false)} testID="composer-changed-files" class="bg-card rounded-2xl border border-border/30 p-2 gap-2">
      <List class="max-h-64" style={{ height: Math.min(256, files().length * 44) }} each={files()} keyExtractor={file => file.relativePath}>{file => <Button testID={`composer-change-${file().relativePath}`} class="min-h-11 px-2 flex-row items-center gap-2 active:bg-accent rounded-xl" onPress={() => open(file().relativePath, file().hasStagedChanges && !file().hasWorkingChanges)}><Icon name="file-edit" size={14} /><Text class="flex-1 text-sm text-foreground" style={{ numberOfLines: 1 }}>{file().relativePath}</Text><If when={file().insertions > 0}><Text class="text-xs text-success">+{file().insertions}</Text></If><If when={file().deletions > 0}><Text class="text-xs text-destructive">−{file().deletions}</Text></If></Button>}</List>
      <If when={!!owner.state().error}><Text role="alert" class="text-xs text-destructive">{owner.state().error}</Text><Button testID="composer-changes-expanded-retry" class={action} disabled={owner.state().loading} onPress={() => { void owner.reader.refresh(); }}><Text class="text-foreground">{t('diffView.actions.retry')}</Text></Button></If>
    </Overlay></If>
    <If when={summary().count > 0}>
      <View ref={view => anchor.set(view)}>
      <Button testID="composer-changes" class="min-h-7 min-w-0 flex-row items-center gap-1" hitSlop={4} accessibilityLabel={t('chat.pendingChanges.changedInWorkspace')} onPress={() => {
        if (!current()) return;
        const next = !expanded(); setExpanded(next); if (next) void owner.reader.refresh();
      }}><Icon name="file-edit" size={12} /><Text class="text-xs text-foreground" style={{ flexShrink: 0 }}>{t(summary().count === 1 ? 'chat.pendingChanges.fileCountSingle' : 'chat.pendingChanges.fileCountPlural', { count: summary().count })}</Text><If when={summary().insertions > 0}><Text class="text-xs text-success" style={{ numberOfLines: 1 }}>+{summary().insertions}</Text></If><If when={summary().deletions > 0}><Text class="text-xs text-destructive" style={{ numberOfLines: 1 }}>-{summary().deletions}</Text></If><Icon name={expanded() ? 'arrow-up-s' : 'arrow-down-s'} size={12} /></Button>
      </View>
    </If>
    <If when={!!owner.state().error && !owner.state().snapshot && !expanded()}><Button testID="composer-changes-retry" class="min-h-6 px-3 flex-row items-center gap-1" disabled={owner.state().loading} onPress={() => { void owner.reader.refresh(); }}><Text class="text-xs text-muted-foreground">{t('mobile.menu.changes')} · {t('common.unavailable')} · {t('chat.questionDelegate.retry')}</Text></Button></If>
    <NativeChangesSheet source={owner.reader.source} owner={owner} open={opened()} active={props.active} onClose={() => { opened.set(false); owner.reader.cancel(); }} onOpenPreview={props.onOpenPreview} generationContext={props.generationContext} diffLayoutPreference={props.diffLayoutPreference} />
  </View>;
}

/** Workspace, staged, historical turn and Host identities own separate lifetimes. */
export function NativeChangesSheet(props: ChangesSheetProps) {
  const identity = (source: ChangesSource) => JSON.stringify([epoch(), source.kind, source.directory, source.path, source.targetLine, source.kind === 'workspace' ? source.staged : [source.sessionID, source.messageID, source.revision]]);
  return <Each of={[props.source]} key={identity}>{source => <NativeChangesSheetPage source={source()} open={props.open} active={props.active} onClose={props.onClose} onOpenPreview={props.onOpenPreview} owner={props.owner} generationContext={props.generationContext} diffLayoutPreference={props.diffLayoutPreference} />}</Each>;
}

function NativeChangesSheetPage(props: ChangesSheetProps) {
  const generation = epoch(); let alive = true, wasOpen = false;
  const closing = signal(false);
  let pendingPreview: { path: string; line?: number } | undefined;
  const height = signal<number | null>(null);
  const available = () => Math.max(0, windowSize().height - safeArea().top - 8 - keyboardFrame().height);
  let resizeStart = 0;
  const current = () => alive && epoch() === generation && props.open && props.active && lifecycle() === 'active';
  const owner = props.owner ?? createChangesOwner(props.source, current);
  function close(preview?: { path: string; line?: number }) {
    if (closing()) return;
    pendingPreview = preview;
    owner.reader.cancel(); closing.set(true);
  }
  function dismissed() {
    const preview = pendingPreview, callback = props.onOpenPreview;
    const valid = alive && epoch() === generation && props.active && lifecycle() === 'active';
    pendingPreview = undefined; wasOpen = false;
    // Parent navigation may unmount this page. It must run only after the system's completion.
    props.onClose();
    if (valid && preview) callback?.(preview.path, preview.line);
  }
  effect(() => {
    const visible = props.open && props.active && lifecycle() === 'active';
    if (!visible) { untracked(() => { if (wasOpen) close(); else if (props.open) props.onClose(); }); return; }
    wasOpen = true;
    untracked(() => {
      closing.set(false); height.set(null);
      Keyboard.dismiss();
    });
  });
  cleanup(() => { alive = false; pendingPreview = undefined; owner.reader.cancel(); });
  function resize(dy: number, ended = false) {
    const next = Math.max(available() * .42, Math.min(available(), resizeStart - dy));
    height.set(ended ? [.42, .72, 1].map(ratio => ratio * available()).sort((a, b) => Math.abs(a - next) - Math.abs(b - next))[0] : next);
  }
  return <Sheet detents={[.42, .72, 1]} initialDetent={2} open={props.open && props.active && !closing()} closeOnSwipe onOpenChange={event => { if (!event.open) close(); }} onClose={dismissed} popupClass="bg-background rounded-t-3xl" popupStyle={{ height: Math.min(height() ?? available(), available()), marginBottom: keyboardFrame().height }} backdropClass="bg-background/50">
    <If when={props.open && props.active}><View testID="native-changes-sheet" class="flex-1 bg-background" style={{ paddingBottom: keyboardFrame().height > 0 ? 0 : safeArea().bottom, paddingLeft: safeArea().left, paddingRight: safeArea().right, pointerEvents: closing() ? 'none' : 'auto' }}><Each of={[owner.reader]} key={reader => reader}>{() => <NativeChangesContent owner={owner} active={!closing()} generationContext={props.generationContext} diffLayoutPreference={props.diffLayoutPreference} onClose={() => close()} onOpenPreview={props.onOpenPreview ? (path, line) => close({ path, line }) : undefined} onResizeStart={() => { resizeStart = height() ?? available(); }} onResize={resize} />}</Each></View></If>
  </Sheet>;
}

function NativeChangesContent(props: { owner: Owner; active: boolean; onClose: () => void; onOpenPreview?: (path: string, line?: number) => void; onResizeStart: () => void; onResize: (dy: number, ended?: boolean) => void; generationContext?: ChangesGenerationContext; diffLayoutPreference?: NativeDiffLayoutPreference | null }) {
  const { reader, state } = props.owner;
  let resizeY = 0;
  const history = computed(() => reader.source.kind === 'turn' ? [...reader.source.files].sort((a, b) => a.path.localeCompare(b.path)) : []);
  return <View class="flex-1">
    <If when={platform.os !== 'ios'}><View testID="changes-sheet-resize" accessibilityLabel={t('mobile.changes.sheet.resizeAria')} class="items-center justify-center" style={{ height: 24 }} onStartShouldSetResponder={() => true} onResponderGrant={event => { resizeY = event.pageY; props.onResizeStart(); return true; }} onResponderMove={event => props.onResize(event.pageY - resizeY)} onResponderRelease={event => props.onResize(event.pageY - resizeY, true)} onResponderTerminate={event => props.onResize(event.pageY - resizeY, true)} onResponderTerminationRequest={() => false}><View class="bg-muted-foreground/40 rounded-full" style={{ width: 46, height: 5 }} /></View></If>
    <View class="min-h-14 px-3 flex-row items-center gap-2 border-b border-border/30">
      <If when={!!state().path}><Button testID="changes-back" class="min-h-11 min-w-11 items-center justify-center" accessibilityLabel={t('header.actions.backAria')} onPress={reader.back}><Icon name="arrow-left" size={20} /></Button></If>
      <View class="flex-1 gap-1"><Text class="text-sm font-semibold text-foreground" style={{ numberOfLines: 1 }}>{state().path || t('mobile.nav.changes')}</Text><Text class="text-xs text-muted-foreground" style={{ numberOfLines: 1 }}>{reader.source.kind === 'turn' ? t('diffView.scope.lastTurn') : state().path && state().staged ? t('diffView.scope.staged') : t('chat.pendingChanges.changedInWorkspace')}</Text></View>
      <Button testID="changes-close" class="min-h-11 min-w-11 items-center justify-center" accessibilityLabel={t('mobile.surface.closeAria')} onPress={props.onClose}><Icon name="close" size={20} /></Button>
    </View>
    <If when={reader.source.kind === 'workspace'}><View class="flex-1" style={{ display: state().path ? 'none' : 'flex' }}><NativeWorkspaceChanges owner={props.owner} active={props.active} generationContext={props.generationContext} /></View></If>
    <If when={!state().path}>
      <If when={reader.source.kind === 'turn'}><List class="flex-1" each={history()} keyExtractor={file => file.path}>{file => <Button class="min-h-11 px-4 flex-row items-center gap-2 active:bg-accent" onPress={() => { void reader.select(file().path); }}><Icon name="file-edit" size={16} /><Text class="text-sm text-foreground">{file().path}</Text></Button>}</List><If when={history().length === 0}><Text class="p-4 text-muted-foreground">{t('diffView.state.noLastTurnChanges')}</Text></If></If>
    </If>
    <If when={!!state().path}><NativeChangeDiff owner={props.owner} onOpenPreview={props.onOpenPreview} diffLayoutPreference={props.diffLayoutPreference} /></If>
  </View>;
}

function NativeChangeDiff(props: { owner: Owner; onOpenPreview?: (path: string, line?: number) => void; diffLayoutPreference?: NativeDiffLayoutPreference | null }) {
  const { reader, state } = props.owner;
  const viewError = signal(''), ready = signal(false), hunks = signal<DiffHunk[]>([]);
  const wrap = signal(reader.source.kind === 'workspace'), wrapError = signal('');
  let wrapAlive = true, wrapEdits = 0;
  cleanup(() => { wrapAlive = false; });
  if (reader.source.kind === 'turn') {
    void wrapPreferenceSave.then(() => Storage.getItem('changes-diff-wrap-v1')).then(value => { if (wrapAlive && wrapEdits === 0) wrap.set(value === 'true'); }).catch(cause => { if (wrapAlive) wrapError.set(String(cause)); });
  }
  function toggleWrap() {
    if (!reader.current()) return;
    const next = !wrap(); wrapEdits++; wrap.set(next); wrapError.set('');
    wrapPreferenceSave = wrapPreferenceSave.catch(() => {}).then(() => Storage.setItem('changes-diff-wrap-v1', String(next)));
    void wrapPreferenceSave.catch(cause => { if (wrapAlive) wrapError.set(String(cause)); });
  }
  const image = () => isImageFile(state().path);
  const textDiff = () => !!state().diff && !state().diff?.isBinary && !image();
  const isNew = computed(() => nativeDiffIsNew(reader.source, state().snapshot, state().path, state().diff));
  const layoutChoice = signal(diffLayoutOverride);
  const layout = computed(() => layoutChoice() ?? nativeDiffLayout(props.diffLayoutPreference, windowSize().width, isNew()));
  let diffView: DiffViewRef | undefined;
  const first = computed(() => nativeChangeLocation(hunks()));
  effect(() => { state().diff; untracked(() => { viewError.set(''); ready.set(false); hunks.set([]); diffView = undefined; }); });
  function toggleLayout() {
    if (!reader.current() || !textDiff()) return;
    diffLayoutOverride = layout() === 'split' ? 'unified' : 'split';
    layoutChoice.set(diffLayoutOverride);
  }
  return <View class="flex-1 gap-2">
    <View testID="changes-diff-actions" class="px-3 pt-2 flex-row items-center gap-1">
      <If when={!!props.onOpenPreview}><Button testID="changes-open-preview" class={diffAction} accessibilityLabel={t('diffView.actions.openFilePreview')} onPress={() => props.onOpenPreview?.(state().path)}><Icon name="eye" size={18} /></Button></If>
      <If when={textDiff()}><Button testID="changes-wrap" class={diffAction} accessibilityLabel={t(wrap() ? 'diffView.actions.disableLineWrap' : 'diffView.actions.enableLineWrap')} onPress={toggleWrap}><Icon name="text-wrap" size={18} /></Button></If>
      <If when={textDiff()}><Button testID="changes-layout" class={diffAction} accessibilityLabel={t(layout() === 'split' ? 'settings.yuri.visual.option.diffLayout.inline.label' : 'settings.yuri.visual.option.diffLayout.sideBySide.label')} onPress={toggleLayout}><Icon name={layout() === 'split' ? 'align-justify' : 'layout-column'} size={18} /></Button></If>
    </View>
    <If when={state().diffLoading}><Text class="px-4 text-sm text-muted-foreground">{t('diffView.state.loadingDiff')}</Text></If>
    <If when={!!state().diffError || !!viewError() || !!wrapError()}><Text role="alert" class="px-4 text-sm text-destructive">{state().diffError || viewError() || wrapError()}</Text><Button testID="changes-diff-refresh" class={action} disabled={state().diffLoading} onPress={() => { void reader.retryDiff(); }}><Text class="text-foreground">{t('diffView.actions.retry')}</Text></Button></If>
    <If when={state().diff?.isBinary}><Text class="p-4 text-muted-foreground">{t('diffView.binary.unavailable')}</Text></If>
    <If when={!!state().diff && !state().diff?.isBinary && image()}>
      <If when={reader.source.kind === 'turn' && [state().diff?.before, state().diff?.after].some(value => typeof value === 'string' && /^data:image\/[a-z0-9.+-]+;base64,/i.test(value))} else={<Text testID="changes-image-unavailable" class="p-4 text-muted-foreground">{t('mobile.changes.diffDetail.imageUnavailable')}</Text>}>
        <Scroll testID="changes-history-images" class="flex-1"><Each of={[{ side: 'before', value: state().diff?.before }, { side: 'after', value: state().diff?.after }].filter(item => typeof item.value === 'string' && /^data:image\/[a-z0-9.+-]+;base64,/i.test(item.value))}>{item => <View class="p-4 gap-2"><Text class="text-xs text-muted-foreground">{t(item().side === 'before' ? 'diffView.image.original' : state().diff?.before ? 'diffView.image.modified' : 'diffView.image.new')}</Text><Image src={item().value!} accessibilityLabel={t(item().side === 'before' ? 'diffView.image.originalAlt' : 'diffView.image.modifiedAlt', { path: state().path })} style={{ width: windowSize().width - 32, height: windowSize().height * .45, objectFit: 'contain' }} onError={() => viewError.set(t('diffView.state.failedToLoadDiff'))} /></View>}</Each></Scroll>
      </If>
    </If>
    <If when={!!state().diff && !state().diff?.isBinary && !image()}>
      <Each of={state().diff ? [state().diff!] : []} key={diff => diff}>{diff => <NativeDiffDocument diff={diff()} wrap={wrap()} layout={layout()} current={() => reader.current() && state().diff === diff()} targetLine={reader.source.targetLine} onReady={(ref, value) => { diffView = ref; hunks.set(value); ready.set(true); viewError.set(''); }} onError={() => viewError.set(t('diffView.state.failedToLoadDiff'))} />}</Each>
      <If when={ready() && !first()}><Text class="p-4 text-muted-foreground">{t('diffView.state.cleanWorkingTree')}</Text></If>
    </If>
  </View>;
}

/** DiffView owns diffing, virtual rows, horizontal scrolling and collapsed context. */
function NativeDiffDocument(props: { diff: HistoricalChange; wrap: boolean; layout: 'unified' | 'split'; current: () => boolean; targetLine?: number; onReady: (ref: DiffViewRef, hunks: DiffHunk[]) => void; onError: () => void }) {
  let ref: DiffViewRef | undefined, alive = true, laidOut = false, initialized = false;
  let hunks: DiffHunk[] | undefined;
  cleanup(() => { alive = false; });
  function ready() {
    if (!alive || !props.current() || !ref || !hunks) return;
    props.onReady(ref, hunks);
    if (!laidOut || initialized) return;
    const location = nativeChangeLocation(hunks, props.targetLine);
    if (location) { initialized = true; ref.goToHunk(location.index); }
  }
  async function readHunks() {
    const view = ref;
    if (!view) return;
    try { const value = await view.hunks(); if (alive && props.current() && ref === view) { hunks = nativeSourceHunks(value, props.diff.patch); ready(); } }
    catch { if (alive && props.current()) props.onError(); }
  }
  return <DiffView testID="changes-native-diff" class="flex-1" ref={value => { ref = value; void readHunks(); }}
    patch={props.diff.patch || undefined} oldValue={props.diff.patch ? undefined : props.diff.before ?? ''} newValue={props.diff.patch ? undefined : props.diff.after ?? ''}
    language={props.diff.path} layout={props.layout} inline="word" indicators="classic" contextLines={3} softWrap={props.wrap} lineNumbers background
    fontFamily={nativeChatTextStyle('code').fontFamily} fontSize={nativeChatTextStyle('code').fontSize} lineHeight={20 * (nativeChatTextStyle('code').fontSize ?? 13) / 13}
    classes={{ side: 'bg-background text-foreground', content: 'select-text', gutter: 'bg-background', lineNumber: 'text-muted-foreground', lineAdded: 'bg-success/10', lineDeleted: 'bg-destructive/10', wordAdded: 'bg-success/20', wordDeleted: 'bg-destructive/20', indicatorAdded: 'text-success', indicatorDeleted: 'text-destructive', separator: 'bg-secondary text-muted-foreground' }}
    onStatsChange={() => { void readHunks(); }} onScroll={() => { if (!laidOut) { laidOut = true; ready(); } }} />;
}
