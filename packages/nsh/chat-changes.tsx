import { cleanup, Clipboard, computed, effect, host, Keyboard, keyboardFrame, lifecycle, List, Overlay, platform, safeArea, signal, Text, untracked, View, windowSize, type ViewRef } from 'nsh';
import { Button, DiffView, type DiffViewRef, type DiffHunk } from 'nsh/base';
import { NativeSheet as Sheet } from './native-sheet';
import { extractGitChangedFiles, summarizeGitChangedFiles } from '../ui/src/components/chat/changedFiles';
import { t } from './i18n';
import { Icon } from './Icon';
import { app } from './state';
import { createPageOperations, type PageOperation } from './page-operations';
import { runtimeEventFrom } from './model';
import { nativeChatTextStyle } from './appearance';
import { createChangesReader, nativeChangeLocation, nativeSourceHunks, type ChangesSource, type HistoricalChange } from './chat-changes-model';
import { NativeWorkspaceChanges } from './chat-changes-workspace';
import { createChangesActions } from './chat-changes-actions';

function createOwner(source: ChangesSource, current: () => boolean) {
  const operations = createPageOperations(current);
  const revision = signal(0), actionRevision = signal(0), lane = signal<PageOperation | null>(null), statusLane = signal<PageOperation | null>(null);
  const workspace = { tree: signal(true), collapsed: signal(new Set<string>()), collapsedGroups: signal(new Set<boolean>()), message: signal(''), inputHeight: signal(88), uncertain: signal(false) };
  let alive = true, assigned: PageOperation | null = null, actionLane: PageOperation | null = null, writePending = false;
  let mutation: object | null = null;
  let committing: { message: string; lane: PageOperation } | undefined;
  const valid = () => alive && assigned?.current() === true && current();
  const raw = createChangesReader(source, async path => {
    const captured = assigned;
    if (!captured || !valid()) throw new Error('page_operation_stale');
    const value = await captured.request(path, 'GET');
    if (assigned !== captured || !valid()) throw new Error('page_operation_stale');
    return value;
  }, valid, () => revision.set(revision() + 1));
  const reader = { ...raw, async refresh() {
    const captured = assigned;
    if (!captured || !valid()) return;
    await raw.refresh();
    if (captured === assigned && valid() && !raw.state().loading && !raw.state().error && raw.state().snapshot) statusLane.set(captured);
  } };
  const actions = createChangesActions(reader, async (path, method = 'GET', body) => {
    const captured = actionLane;
    if (!captured || captured !== assigned || !valid()) throw new Error('page_operation_stale');
    const write = method !== 'GET';
    if (write) writePending = true;
    try {
      const value = await captured.request(path, method, body);
      if (captured !== assigned || !valid()) throw new Error('page_operation_stale');
      if (write) writePending = false;
      return value;
    } catch (cause) {
      if (write) {
        const status = cause && typeof cause === 'object' && 'status' in cause ? Number(cause.status) : NaN;
        if (!Number.isInteger(status)) workspace.uncertain.set(true);
        writePending = false;
      }
      throw cause;
    }
  }, () => actionLane !== null && actionLane === assigned && valid(), () => {
    actionRevision.set(actionRevision() + 1);
    // Clear only the exact draft whose commit was acknowledged on this lane,
    // before any follow-up sync/status await can suspend the presentation.
    if (committing && committing.lane === assigned && valid() && actions.state().committed && workspace.message() === committing.message) workspace.message.set('');
  });
  function cancel() {
    if (writePending) workspace.uncertain.set(true);
    mutation = null; actionLane = null; committing = undefined; actions.cancel(); raw.cancel(); statusLane.set(null);
  }
  async function perform(work: () => Promise<boolean>, message?: string) {
    const captured = assigned;
    if (!captured || !valid() || workspace.uncertain() || actions.state().pending || statusLane() !== captured) return false;
    const ticket = {}; mutation = ticket;
    actionLane = captured;
    committing = message === undefined ? undefined : { message, lane: captured };
    try { return await work(); }
    finally { if (mutation === ticket) { mutation = null; committing = undefined; actionLane = null; } }
  }
  effect(() => {
    const next = operations.operation();
    untracked(() => {
      if (assigned === next) return;
      cancel(); assigned = next; lane.set(next);
    });
  });
  cleanup(operations.onRetire(cancel));
  cleanup(() => { alive = false; cancel(); });
  const state = () => { revision(); return reader.state(); };
  const snapshot = computed(() => state().snapshot);
  return { reader, operation: lane, state, snapshot, workspace, cancel,
    canLeave: () => !workspace.message() && !workspace.uncertain() && !writePending && !actions.state().pending,
    ready: () => lane() !== null && statusLane() === lane() && valid(),
    actions: { state: () => { actionRevision(); return actions.state(); },
      move: (paths: string[], staged: boolean) => perform(() => actions.move(paths, staged)),
      revert: (paths: string[], confirmed: boolean) => perform(() => actions.revert(paths, confirmed)),
      commit: (message: string, pushAfter: boolean) => perform(() => actions.commit(message, pushAfter), message),
      sync: () => perform(actions.sync),
    },
  };
}
export type NativeChangesOwner = ReturnType<typeof createOwner>;
type Owner = NativeChangesOwner;
type ChangesSheetProps = { source: ChangesSource; open: boolean; active: boolean; onClose: () => void; onOpenPreview?: (path: string, line?: number) => void; owner?: Owner };
export type NativeChangesPresentationHandle = { canLeave: () => boolean; source: () => ChangesSource | null };
type ChangesPresentationProps = {
  source: ChangesSource | null; open: boolean; active: boolean; current: () => boolean;
  onClose: () => void;
  onOpenPreview?: (path: string, line: number | undefined, source: ChangesSource) => void;
  onHandle?: (handle: NativeChangesPresentationHandle | null) => void;
  onBlocked?: (source: ChangesSource) => void;
};
function sourceIdentity(source: ChangesSource) {
  return JSON.stringify(source.kind === 'workspace' ? ['workspace', source.directory] : ['turn', source.directory, source.sessionID, source.messageID, source.revision]);
}
function hostIdentity() { const value = app.connection(); return JSON.stringify([value?.id, value?.url, value?.authorizationID]); }

/** Mount once outside source presence: the sole business owner outlives its Sheet. */
export function NativeChangesPresentation(props: ChangesPresentationProps) {
  type Entry = { source: ChangesSource; host: string; identity: string; owner?: Owner };
  const entry = signal<Entry | null>(null);
  let alive = true;
  const handle: NativeChangesPresentationHandle = { canLeave: () => entry()?.owner?.canLeave() ?? true, source: () => entry()?.source ?? null };
  props.onHandle?.(handle);
  cleanup(() => { alive = false; props.onHandle?.(null); });
  effect(() => {
    const source = props.source, authority = hostIdentity();
    untracked(() => {
      if (!source || !alive) return;
      const previous = entry(), identity = sourceIdentity(source);
      if (previous?.host === authority && previous.identity === identity) return;
      if (previous?.owner && !previous.owner.canLeave()) {
        previous.owner.cancel(); props.onBlocked?.(previous.source); props.onClose(); return;
      }
      entry.set({ source, host: authority, identity });
    });
  });
  return <Each of={entry() ? [entry()!] : []} key={value => value}>{value => {
    const retained = value();
    const matches = computed(() => !!props.source && retained.host === hostIdentity() && retained.identity === sourceIdentity(props.source));
    const current = computed(() => alive && entry() === retained && matches() && props.open && props.active && props.current() && lifecycle() === 'active');
    const initial = retained.source;
    // The invocation captures exactly one accepted historical loader. A later
    // source/Host cannot lend its authority to the old closure's completion.
    const source: ChangesSource = initial.kind === 'turn' && initial.loadFile ? { ...initial, loadFile: async path => {
      if (!current()) throw new Error('page_operation_stale');
      const accepted = props.source;
      if (accepted?.kind !== 'turn' || !accepted.loadFile) throw new Error('Historical diff body unavailable');
      const result = await accepted.loadFile(path);
      if (!current()) throw new Error('page_operation_stale');
      return result;
    } } : initial;
    const owner = createOwner(source, current); retained.owner = owner;
    cleanup(() => { retained.owner = undefined; });
    return <NativeChangesSheetPage source={matches() ? props.source! : retained.source} owner={owner} managed open={current()} active={props.active} onClose={props.onClose}
      onOpenPreview={props.onOpenPreview ? (path, line) => { if (alive && entry() === retained && retained.host === hostIdentity() && props.current()) props.onOpenPreview?.(path, line, retained.source); } : undefined} />;
  }}</Each>;
}
const action = 'min-h-11 px-3 flex-row items-center justify-center gap-2 rounded-xl bg-secondary active:bg-accent disabled:opacity-40';

/** Same authoritative workspace status and pure summary rules as PendingChangesBar. */
export function NativeComposerChanges(props: {
  directory: string; active: boolean;
  expanded?: boolean;
  onExpandedChange?: (open: boolean) => void;
  /** Legacy navigation callback is intentionally not used for diff opening. */
  onOpenFile?: (path: string, staged: boolean) => void;
  onOpenPreview?: (path: string, line?: number) => void;
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
  const owner = createOwner({ kind: 'workspace', directory }, current);
  effect(() => {
    const lane = owner.operation(), visible = current() && lane?.current() === true;
    untracked(() => {
      if (visible) void owner.reader.refresh();
      else { owner.cancel(); setExpanded(false); opened.set(false); }
    });
  });
  const unsubscribe = host.on('runtime.event', payload => {
    const event = runtimeEventFrom(payload);
    if (!current() || !event || event.key !== 'global' || timer || event.directory && event.directory !== directory) return;
    if (event.type !== 'reconnected' && !/^(vcs\.|yuri:git-|yuri:workspace-)/.test(event.type)) return;
    timer = setTimeout(() => { timer = undefined; void owner.reader.refresh(); }, 120);
  });
  cleanup(() => { alive = false; owner.cancel(); unsubscribe(); if (timer) clearTimeout(timer); });
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
      <Button testID="composer-changes" class="min-h-6 px-3 flex-row items-center gap-1" accessibilityLabel={t('chat.pendingChanges.changedInWorkspace')} onPress={() => {
        if (!current()) return;
        const next = !expanded(); setExpanded(next); if (next) void owner.reader.refresh();
      }}><Icon name="file-edit" size={12} /><Text class="text-xs text-foreground">{t(summary().count === 1 ? 'chat.pendingChanges.fileCountSingle' : 'chat.pendingChanges.fileCountPlural', { count: summary().count })}</Text><If when={summary().insertions > 0}><Text class="text-xs text-success">+{summary().insertions}</Text></If><If when={summary().deletions > 0}><Text class="text-xs text-destructive">−{summary().deletions}</Text></If><Icon name={expanded() ? 'arrow-up-s' : 'arrow-down-s'} size={12} /></Button>
      </View>
    </If>
    <If when={!!owner.state().error && !owner.state().snapshot && !expanded()}><Button testID="composer-changes-retry" class="min-h-6 px-3 flex-row items-center gap-1" disabled={owner.state().loading} onPress={() => { void owner.reader.refresh(); }}><Text class="text-xs text-muted-foreground">{t('mobile.menu.changes')} · {t('common.unavailable')} · {t('chat.questionDelegate.retry')}</Text></Button></If>
    <NativeChangesSheet source={owner.reader.source} owner={owner} open={opened()} active={props.active} onClose={() => { opened.set(false); owner.cancel(); }} onOpenPreview={props.onOpenPreview} />
  </View>;
}

/** Workspace, staged, historical turn and Host identities own separate lifetimes. */
export function NativeChangesSheet(props: ChangesSheetProps) {
  const identity = (source: ChangesSource) => { const host = app.connection(); return JSON.stringify([host?.id, host?.url, host?.authorizationID, source.kind, source.directory, source.path, source.targetLine, source.kind === 'workspace' ? source.staged : [source.sessionID, source.messageID, source.revision]]); };
  return <Each of={[props.source]} key={identity}>{source => <NativeChangesSheetPage source={source()} open={props.open} active={props.active} onClose={props.onClose} onOpenPreview={props.onOpenPreview} owner={props.owner} />}</Each>;
}

function NativeChangesSheetPage(props: ChangesSheetProps & { managed?: boolean }) {
  let alive = true, wasOpen = false;
  const height = signal<number | null>(null);
  const available = () => Math.max(0, windowSize().height - safeArea().top - 8 - keyboardFrame().height);
  let resizeStart = 0;
  const current = () => alive && props.open && props.active && lifecycle() === 'active';
  const owner = props.owner ?? createOwner(props.source, current);
  const visible = computed(() => props.open && props.active && lifecycle() === 'active');
  const selection = computed(() => JSON.stringify([props.source.path, props.source.kind === 'workspace' && props.source.staged === true]));
  effect(() => {
    const displayed = visible(), lane = owner.operation(), opening = !wasOpen;
    const [path, staged] = JSON.parse(selection()) as [string | undefined, boolean];
    if (!displayed) { untracked(() => { if (wasOpen) owner.cancel(); wasOpen = false; if (props.open) props.onClose(); }); return; }
    wasOpen = true;
    untracked(() => {
      if (opening) { height.set(null); Keyboard.dismiss(); }
      if (!props.owner || props.managed) {
        if (opening) owner.reader.back();
        if (!lane?.current()) return;
        void owner.reader.refresh();
        const selected = owner.reader.state();
        const target = path || selected.path;
        if (target) void owner.reader.select(target, props.source.kind === 'workspace' && (path ? staged : selected.staged));
      }
    });
  });
  cleanup(() => { alive = false; owner.cancel(); });
  function resize(dy: number, ended = false) {
    const next = Math.max(available() * .42, Math.min(available(), resizeStart - dy));
    height.set(ended ? [.42, .72, 1].map(ratio => ratio * available()).sort((a, b) => Math.abs(a - next) - Math.abs(b - next))[0] : next);
  }
  return <Sheet detents={[.42, .72, 1]} initialDetent={2} open={props.open && props.active} closeOnSwipe onOpenChange={event => { if (!event.open) { owner.cancel(); props.onClose(); } }} popupClass="bg-background rounded-t-3xl" popupStyle={{ height: Math.min(height() ?? available(), available()), marginBottom: keyboardFrame().height }} backdropClass="bg-background/50">
    <If when={props.open && props.active}><View testID="native-changes-sheet" class="flex-1 bg-background" style={{ paddingBottom: keyboardFrame().height > 0 ? 0 : safeArea().bottom, paddingLeft: safeArea().left, paddingRight: safeArea().right }}><NativeChangesContent owner={owner} targetLine={props.source.targetLine} onClose={props.onClose} onOpenPreview={props.onOpenPreview ? (path, line) => { if (!owner.reader.current()) return; props.onClose(); props.onOpenPreview?.(path, line); } : undefined} onResizeStart={() => { resizeStart = height() ?? available(); }} onResize={resize} /></View></If>
  </Sheet>;
}

function NativeChangesContent(props: { owner: Owner; targetLine?: number; onClose: () => void; onOpenPreview?: (path: string, line?: number) => void; onResizeStart: () => void; onResize: (dy: number, ended?: boolean) => void }) {
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
    <If when={reader.source.kind === 'workspace'}><View class="flex-1" style={{ display: state().path ? 'none' : 'flex' }}><NativeWorkspaceChanges owner={props.owner} /></View></If>
    <If when={!state().path}>
      <If when={reader.source.kind === 'turn'}><List class="flex-1" each={history()} keyExtractor={file => file.path}>{file => <Button class="min-h-11 px-4 flex-row items-center gap-2 active:bg-accent" onPress={() => { void reader.select(file().path); }}><Icon name="file-edit" size={16} /><Text class="text-sm text-foreground">{file().path}</Text></Button>}</List><If when={history().length === 0}><Text class="p-4 text-muted-foreground">{t('diffView.state.noLastTurnChanges')}</Text></If></If>
    </If>
    <If when={!!state().path}><NativeChangeDiff owner={props.owner} targetLine={props.targetLine} onOpenPreview={props.onOpenPreview} /></If>
  </View>;
}

function NativeChangeDiff(props: { owner: Owner; targetLine?: number; onOpenPreview?: (path: string, line?: number) => void }) {
  const { reader, state } = props.owner;
  const copyError = signal(''), viewError = signal(''), ready = signal(false), hunks = signal<DiffHunk[]>([]);
  let diffView: DiffViewRef | undefined;
  const first = computed(() => nativeChangeLocation(hunks()));
  effect(() => { state().diff; untracked(() => { copyError.set(''); viewError.set(''); ready.set(false); hunks.set([]); diffView = undefined; }); });
  function jump() { if (first()) diffView?.goToHunk(first()!.index); }
  return <View class="flex-1 gap-2">
    <View class="px-3 pt-2 flex-row flex-wrap gap-2">
      <Button testID="changes-diff-refresh" class={action} disabled={state().diffLoading} onPress={() => { void reader.retryDiff(); }}><Text class="text-foreground">{t(state().diffError ? 'diffView.actions.retry' : 'mobile.files.refreshAria')}</Text></Button>
      <If when={!!props.onOpenPreview}><Button testID="changes-open-preview" class={action} onPress={() => props.onOpenPreview?.(state().path, first()?.line)}><Icon name="eye" size={18} /><Text class="text-foreground">{t('diffView.actions.openFilePreview')}</Text></Button></If>
      <Button testID="changes-first-change" class={action} disabled={!first()} accessibilityLabel={t('diffView.actions.openFileAtFirstChangedLine')} onPress={jump}><Icon name="arrow-down-s" size={18} /><Text class="text-foreground">{t(first() ? 'diffView.actions.openFileAtFirstChangedLine' : 'common.unavailable')}</Text></Button>
      <Button testID="changes-copy-diff" class={action} disabled={!state().diff} accessibilityLabel={t('mobile.files.copyContent')} onPress={() => { const diff = state().diff; if (!diff) return; void Clipboard.writeText(diff.patch ?? [diff.before ?? '', diff.after ?? ''].join('\n\n')).catch(cause => copyError.set(String(cause))); }}><Icon name="file-copy" size={18} /></Button>
    </View>
    <If when={state().diffLoading}><Text class="px-4 text-sm text-muted-foreground">{t('diffView.state.loadingDiff')}</Text></If>
    <If when={!!state().diffError || !!copyError() || !!viewError()}><Text role="alert" class="px-4 text-sm text-destructive">{state().diffError || copyError() || viewError()}</Text></If>
    <If when={state().diff?.isBinary}><Text class="p-4 text-muted-foreground">{t('diffView.binary.unavailable')}</Text></If>
    <If when={!!state().diff && !state().diff?.isBinary}>
      <Each of={state().diff ? [state().diff!] : []} key={diff => diff}>{diff => <NativeDiffDocument diff={diff()} current={() => reader.current() && state().diff === diff()} targetLine={props.targetLine} onReady={(ref, value) => { diffView = ref; hunks.set(value); ready.set(true); viewError.set(''); }} onError={() => viewError.set(t('diffView.state.failedToLoadDiff'))} />}</Each>
      <If when={ready() && !first()}><Text class="p-4 text-muted-foreground">{t('diffView.state.cleanWorkingTree')}</Text></If>
    </If>
  </View>;
}

/** DiffView owns diffing, virtual rows, horizontal scrolling and collapsed context. */
function NativeDiffDocument(props: { diff: HistoricalChange; current: () => boolean; targetLine?: number; onReady: (ref: DiffViewRef, hunks: DiffHunk[]) => void; onError: () => void }) {
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
  effect(() => { props.targetLine; untracked(() => { initialized = false; ready(); }); });
  async function readHunks() {
    const view = ref;
    if (!view) return;
    try { const value = await view.hunks(); if (alive && props.current() && ref === view) { hunks = nativeSourceHunks(value, props.diff.patch); ready(); } }
    catch { if (alive && props.current()) props.onError(); }
  }
  return <DiffView testID="changes-native-diff" class="flex-1" ref={value => { ref = value; void readHunks(); }}
    patch={props.diff.patch || undefined} oldValue={props.diff.patch ? undefined : props.diff.before ?? ''} newValue={props.diff.patch ? undefined : props.diff.after ?? ''}
    language={props.diff.path} layout="unified" inline="word" indicators="classic" contextLines={3} lineNumbers background
    fontFamily={nativeChatTextStyle('code').fontFamily} fontSize={nativeChatTextStyle('code').fontSize} lineHeight={20}
    classes={{ side: 'bg-background text-foreground', gutter: 'bg-background', lineNumber: 'text-muted-foreground', lineAdded: 'bg-success/10', lineDeleted: 'bg-destructive/10', wordAdded: 'bg-success/20', wordDeleted: 'bg-destructive/20', indicatorAdded: 'text-success', indicatorDeleted: 'text-destructive', separator: 'bg-secondary text-muted-foreground' }}
    onStatsChange={() => { void readHunks(); }} onScroll={() => { if (!laidOut) { laidOut = true; ready(); } }} />;
}
