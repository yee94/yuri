import { batch, cleanup, Clipboard, computed, effect, lifecycle, List, signal, Text, untracked, View, type JSX, type ListRef } from 'nsh';
import { Button, createNavStack, Input, NavStack } from 'nsh/base';
import { app, createChat } from './state';
import { desktopGitDraftAuthority } from './desktop-git-dispatch';
import { createPageOperations } from './page-operations';
import { createNativeHistoryRows } from './history-rows';
import { createNativeHistoryFocus, type NativeHistoryFocusState } from './history-focus';
import { NativeTranscriptBody } from './transcript-body';
import { NativeTurnError, NativeTurnHeader, NativeTurnMetrics } from './transcript-tools-turn';
import { nativeTurnHeaderMessage, nativeTurnPresentation, nativeTurnModelName } from './transcript-tools-turn-model';
import { nativeAppearance } from './appearance';
import { record, text, type ChatTarget, type Message, type Row } from './model';
import { query } from './runtime';
import type { NativeToolFile } from './transcript-tools-model';
import { Icon } from './Icon';
import { t } from './i18n';
import type { DesktopPanelChatStream } from './desktop-panel-chat-source';
import { nativeMessageEntry } from './transcript-body-model';
import { resolveContextPanelSessionExecution } from '../ui/src/components/layout/contextPanelSessionExecution';
import { NativeAgentAvatar, NativeModelLogo } from './chat-identity';

export type DesktopPanelChatTarget = Readonly<{ sessionID: string; directory: string; title?: string; messageID?: string }>;
export type DesktopPanelChatAuthority = Readonly<{ hostID: string; authorityKey: string }>;
export type DesktopPanelChatHandle = {
  navigate: (target: DesktopPanelChatTarget) => Promise<boolean>; back: () => boolean;
  focus: (messageID: string) => Promise<NativeHistoryFocusState | false>; search: (query: string) => Promise<readonly string[]>;
  retry: () => Promise<void>; loadOlder: () => Promise<void>; latest: () => boolean;
  copy: (messageID: string) => Promise<boolean>;
};
export type DesktopPanelChatProps = {
  surfaceID: string; target: DesktopPanelChatTarget; authority: DesktopPanelChatAuthority;
  /** Actual selected tab/foreground demand. False stops all reads, retaining the pages. */
  active?: boolean;
  /** Temporary modal cover: reads stay live, but every surface action is fenced. */
  interactive?: boolean;
  stream?: DesktopPanelChatStream;
  renderCard: (card: Row, surface: { current: () => boolean; navigate: DesktopPanelChatHandle['navigate']; target: ChatTarget }) => JSX.Element;
  onOpenFile?: (path: string, target: ChatTarget) => void;
  onOpenLink?: (href: string, target: ChatTarget, current: () => boolean) => void | Promise<void>;
  onOpenDiff?: (file: NativeToolFile, target: ChatTarget, messageID: string, files: NativeToolFile[]) => void;
  onOwner?: (owner: DesktopPanelChatHandle | null) => void;
};
const quiet = 'min-h-9 min-w-9 px-2 py-1 rounded-lg items-center justify-center active:bg-accent disabled:opacity-40';
const action = `${quiet} bg-secondary`;
function validTarget(target: DesktopPanelChatTarget) {
  return typeof target.sessionID === 'string' && !!target.sessionID.trim() && typeof target.directory === 'string' && !!target.directory.trim();
}

/** Each keyed native page owns its List, reading anchor, search, expansion and focus.
 * No product/global NavStack, composer, mutation transport or PTY enters this tree. */
export function DesktopPanelChat(props: DesktopPanelChatProps) {
  return <Each of={[JSON.stringify([props.surfaceID, props.authority.hostID, props.authority.authorityKey, props.target.sessionID, props.target.directory])]} key={key => key}>{() => <PanelSurface {...props} />}</Each>;
}
function PanelSurface(props: DesktopPanelChatProps) {
  const authority = { ...props.authority }, root = { ...props.target };
  const nav = createNavStack<DesktopPanelChatTarget>([root]);
  let alive = true, retired = false, navigationRevision = 0;
  const operations = createPageOperations();
  const error = signal('');
  const authorityCurrent = () => {
    const connection = app.connection();
    if (!connection || connection.id !== authority.hostID || desktopGitDraftAuthority(connection) !== authority.authorityKey) retired = true;
    return alive && !retired && operations.displayCurrent();
  };
  const interactive = () => validTarget(root) && authorityCurrent() && props.active !== false && props.interactive !== false && lifecycle() === 'active' && operations.current();
  const pageOwner = signal<DesktopPanelChatHandle | null>(null);
  async function navigate(target: DesktopPanelChatTarget) {
    if (!interactive() || !validTarget(target)) return false;
    const operation = operations.operation(), revision = ++navigationRevision;
    if (!operation?.current()) return false;
    try {
      const response = record(await operation.request(`/api/session/${encodeURIComponent(target.sessionID)}?${query(target.directory)}`)), row = record(response.data ?? response);
      if (!interactive() || revision !== navigationRevision || !operation.current()) return false;
      if (row.id !== target.sessionID || (record(row.location).directory ?? row.directory) !== target.directory) throw new Error('chat_directory_mismatch');
      nav.push({ ...target, title: text(row.title) || target.title }); error.set(''); return true;
    } catch { if (interactive() && revision === navigationRevision) error.set(t('chat.emptyState.opencodeUnreachable')); return false; }
  }
  const owner: DesktopPanelChatHandle = {
    navigate,
    back: () => { if (!interactive() || nav.routes().length < 2) return false; navigationRevision++; nav.pop(); return true; },
    focus: id => interactive() ? pageOwner()?.focus(id) ?? Promise.resolve(false) : Promise.resolve(false),
    search: value => interactive() ? pageOwner()?.search(value) ?? Promise.resolve([]) : Promise.resolve([]),
    retry: () => interactive() ? pageOwner()?.retry() ?? Promise.resolve() : Promise.resolve(),
    loadOlder: () => interactive() ? pageOwner()?.loadOlder() ?? Promise.resolve() : Promise.resolve(),
    latest: () => interactive() && pageOwner()?.latest() === true,
    copy: id => interactive() ? pageOwner()?.copy(id) ?? Promise.resolve(false) : Promise.resolve(false),
  };
  untracked(() => props.onOwner?.(owner));
  cleanup(() => { alive = false; navigationRevision++; props.onOwner?.(null); });
  return <View testID={`panel-chat:${props.surfaceID}`} class="flex-1 bg-background">
    <If when={!!error()}><Text class="text-sm text-destructive px-3 py-2">{error()}</Text></If>
    <NavStack state={nav} testID={`panel-chat-nav:${props.surfaceID}`} class="flex-1">{route => <PanelPage
      {...props} route={route} displayed={() => props.active !== false && nav.routes().at(-1) === route && authorityCurrent()}
      current={() => interactive() && nav.routes().at(-1) === route} authorityCurrent={authorityCurrent}
      canBack={() => nav.routes().length > 1} onBack={owner.back} onNavigate={navigate}
      publish={value => { if (nav.routes().at(-1) === route) pageOwner.set(value); }}
    />}</NavStack>
  </View>;
}
function PanelPage(props: DesktopPanelChatProps & {
  route: DesktopPanelChatTarget; displayed: () => boolean; current: () => boolean; authorityCurrent: () => boolean;
  canBack: () => boolean; onBack: () => boolean; onNavigate: (target: DesktopPanelChatTarget) => Promise<boolean>;
  publish: (value: DesktopPanelChatHandle | null) => void;
}) {
  const route = { ...props.route }, target: ChatTarget = { kind: 'session', id: route.sessionID, directory: route.directory, title: route.title || route.sessionID };
  const chat = createChat(target, { readOnly: true, displayConsumer: { surfaceID: props.surfaceID, current: () => validTarget(route) && props.authorityCurrent(), get stream() { return props.stream; } } });
  const project = createNativeHistoryRows(), rows = computed(() => project(chat.visibleMessages()));
  const turns = computed(() => nativeTurnPresentation(chat.visibleMessages(), chat.busy(), rows().slice().reverse()));
  const list = signal<ListRef | null>(null), choices = signal<Record<string, boolean>>({});
  const contentWidth = signal<number | undefined>(undefined);
  const searchText = signal(''), searchIDs = signal<readonly string[]>([]), searching = signal(false), searchComplete = signal(false), searchError = signal(''), copied = signal('');
  const reading = signal(false);
  const confirmedChild = signal(false);
  effect(() => { if (chat.sessionIdentity()?.parentID) untracked(() => confirmedChild.set(true)); });
  const execution = computed(() => confirmedChild() ? resolveContextPanelSessionExecution(chat.visibleMessages().map(nativeMessageEntry)) : {});
  let searchRevision = 0;
  const focusRevision = signal(0);
  const focus = createNativeHistoryFocus({
    current: () => props.current() && chat.messagesResolved(), scope: () => JSON.stringify([chat.messageScope, chat.historyGeneration()]),
    hasMessage: id => rows().some(row => row.messages.some(message => message.id === id)),
    isHidden: id => { const boundary = chat.revert()?.messageID, messages = chat.messages(), cut = boundary ? messages.findIndex(message => message.id === boundary) : -1; return cut >= 0 && messages.findIndex(message => message.id === id) >= cut; },
    more: chat.more, olderLoading: chat.olderLoading, historyError: chat.historyError, loadOlder: chat.loadOlder,
    reveal: id => { const index = rows().findIndex(row => row.messages.some(message => message.id === id)); if (!props.current() || !list() || index < 0) return false; list()!.scrollToIndex({ index, animated: false, viewPosition: .5 }); reading.set(true); return true; },
    changed: () => focusRevision.set(focusRevision() + 1),
  });
  async function search(value: string): Promise<readonly string[]> {
    if (!props.current()) return [];
    const revision = ++searchRevision, needle = value.trim().toLocaleLowerCase(), generation = chat.historyGeneration();
    if (value !== searchText()) searchIDs.set([]);
    searchText.set(value); searchError.set(''); searchComplete.set(false);
    if (!needle) { searching.set(false); return []; }
    searching.set(true);
    const valid = () => props.current() && revision === searchRevision && generation === chat.historyGeneration();
    try {
      if (!chat.messagesResolved()) await chat.load(false, ['messages']);
      // Explicit user search walks the existing opaque history lane, never a second
      // parser/index/transport. Cancellation fences the result, not another owner's GET.
      while (valid() && chat.more() && !chat.historyError()) await chat.loadOlder();
      if (!valid()) return [];
      if (chat.historyError() || chat.messageReadError()) throw new Error('history_read_failed');
      const ids = chat.visibleMessages().filter(message => `${message.text}\n${message.reasoning}`.toLocaleLowerCase().includes(needle)).map(message => message.id);
      searchIDs.set(ids); searchComplete.set(true); return ids;
    } catch { if (valid()) searchError.set(t('commandPalette.error.messages')); return []; }
    finally { if (revision === searchRevision) searching.set(false); }
  }
  async function copy(messageID: string) {
    if (!props.current()) return false;
    const message = chat.visibleMessages().find(message => message.id === messageID);
    if (!message) return false;
    try { await Clipboard.writeText(message.text || message.error); if (!props.current()) return false; copied.set(messageID); return true; }
    catch { if (props.current()) searchError.set(t('miniChat.actions.failed')); return false; }
  }
  const owner: DesktopPanelChatHandle = {
    navigate: props.onNavigate, back: props.onBack, focus: id => props.current() ? focus.focus(id) : Promise.resolve(false), search, copy,
    retry: async () => { if (props.current()) { chat.retryDisplayStream(); await chat.load(false, ['messages', 'status']); } },
    loadOlder: async () => { if (props.current()) await chat.loadOlder(); },
    latest: () => { if (!props.current() || !list()) return false; list()!.scrollToIndex({ index: 0, animated: true, viewPosition: 1 }); reading.set(false); return true; },
  };
  effect(() => {
    const displayed = props.displayed(), interactive = props.current();
    untracked(() => batch(() => { if (displayed) chat.rebuildOperationLane(); chat.active.set(displayed && interactive); chat.syncActive.set(displayed && !interactive); if (displayed) props.publish(owner); }));
    if (!interactive) { searchRevision++; searching.set(false); focus.cancel(); }
  });
  let initialFocus = false;
  effect(() => {
    if (!route.messageID || initialFocus || !props.current() || !chat.messagesResolved() || !list()) return;
    initialFocus = true; untracked(() => { void focus.focus(route.messageID!); });
  });
  cleanup(() => { searchRevision++; focus.cancel(); props.publish(null); });
  const focusStatus = () => { focusRevision(); return focus.state().status; };
  const header = (message: Message) => nativeTurnHeaderMessage(rows().find(row => row.head.id === message.id)!);
  return <View class="flex-1 bg-background" testID={`panel-chat-page:${route.sessionID}`} style={{ pointerEvents: props.current() ? 'auto' : 'none' }}>
    <If when={!validTarget(route) || !props.authorityCurrent()}><Text testID="panel-chat-authority-unavailable" class="text-destructive px-3 py-2">{t('chat.emptyState.opencodeUnreachable')}</Text></If>
    <View class="flex-row items-center gap-2 px-3 py-2">
      <If when={props.canBack()}><Button testID="panel-chat-back" class={quiet} disabled={!props.current()} onPress={props.onBack} accessibilityLabel={t('chat.container.returnToParent.aria')}><Icon name="arrow-left" size={16} /></Button></If>
      <Input testID="panel-chat-search" class="flex-1 text-foreground" value={searchText()} onChange={event => { if (props.current()) { searchRevision++; searching.set(false); searchComplete.set(false); searchText.set(event.value); searchIDs.set([]); } }} placeholder={t('chat.timeline.searchPlaceholder')} disabled={!props.current()} onSubmit={() => { void search(searchText()); }} />
      <Button testID="panel-chat-find" class={quiet} disabled={!props.current() || searching()} onPress={() => { void search(searchText()); }} accessibilityLabel={t('chat.timeline.searchPlaceholder')}><Icon name="search" size={16} /></Button>
    </View>
    <If when={searching()}><Button testID="panel-chat-search-cancel" class={quiet} disabled={!props.current()} onPress={() => { if (props.current()) { searchRevision++; searching.set(false); } }}><Text>{t('settings.common.actions.cancel')}</Text></Button></If>
    <If when={searchIDs().length > 0}><List each={searchIDs()} keyExtractor={id => id} style={{ height: Math.min(160, searchIDs().length * 40), flexShrink: 0 }} testID="panel-chat-search-results">{id => <Button testID={`panel-chat-result:${id()}`} class={quiet} disabled={!props.current()} onPress={() => { void owner.focus(id()); }}><Text class="text-muted-foreground" style={{ numberOfLines: 1 }}>{chat.visibleMessages().find(message => message.id === id())?.text}</Text></Button>}</List></If>
    <If when={searchComplete() && !searchIDs().length}><Text testID="panel-chat-search-empty" class="text-muted-foreground px-3 py-2">{t('chat.timeline.empty.search')}</Text></If>
    <If when={!!searchError()}><Text class="text-destructive px-3 py-2">{searchError()}</Text></If>
    <If when={!!chat.error()}><View class="flex-row items-center px-3 py-2 gap-2"><Text testID="panel-chat-error" class="text-destructive flex-1">{t('chat.emptyState.opencodeUnreachable')}</Text><Button testID="panel-chat-retry" class={action} disabled={!props.current() || chat.loading()} onPress={() => { void owner.retry(); }}><Text>{t('chat.history.retry')}</Text></Button></View></If>
    <If when={!!chat.displayStreamError()}><Text testID="panel-chat-stream-unavailable" class="text-destructive px-3 py-2">{t('mobile.chat.syncingMessages')} · {t('common.unavailable')}</Text></If>
    <If when={!chat.messagesResolved() && !chat.error()}><Text class="text-muted-foreground px-3 py-2">{t('common.loading')}</Text></If>
    <If when={chat.messagesResolved() && !chat.visibleMessages().length}><Text testID="panel-chat-empty" class="text-muted-foreground px-3 py-2">{t('chat.timeline.empty.session')}</Text></If>
    <List testID={`panel-chat-transcript:${route.sessionID}`} ref={ref => list.set(ref)} class="flex-1" inverted each={rows()} keyExtractor={row => row.key}
      onLayout={event => { const width = event.bounds.size.width; if (width > 0) { const next = Math.min(780, Math.max(0, width - 24)); if (contentWidth() !== next) contentWidth.set(next); } }}
      contentStyle={{ paddingHorizontal: 12, paddingTop: 26, gap: 20 }}
      header={() => <View style={{ height: 16 }} />}
      onScrollDragStart={() => { if (props.current()) reading.set(true); }}
      onLoadMoreAtStart={() => { if (props.current()) reading.set(false); }}
      footer={() => <View class="gap-2">
        <If when={chat.more()}><Button testID="panel-chat-load-older" class={quiet} disabled={!props.current() || chat.loading() || chat.olderLoading()} onPress={() => { void owner.loadOlder(); }}><Text class="text-muted-foreground">{t(chat.olderLoading() ? 'common.loading' : chat.historyError() ? 'chat.history.retry' : 'chat.history.loadOlder')}</Text></Button></If>
        <If when={!!chat.historyError()}><Text testID="panel-chat-page-error" class="text-destructive">{t('chat.history.loadOlderFailed')}</Text></If>
        <If when={chat.hasGap() || chat.historyBoundaryMissing() || chat.historyRepairPending()}><Button class={quiet} disabled={!props.current()} onPress={() => { void owner.retry(); }}><Text>{t('mobile.chat.syncingMessages')} · {t('chat.history.retry')}</Text></Button></If>
      </View>}
    >{row => <View class="w-full self-center gap-2" style={{ maxWidth: 780 }}>
      <If when={!!turns().get(row().head.id)?.header}><NativeTurnHeader message={header(row().head)} modelName={nativeTurnModelName(header(row().head), [])} identityKey={row().turn?.turnId} /></If>
      <Each of={[chat.messageScope.generation]} key={generation => generation}>{() => <NativeTranscriptBody row={row()} target={target} current={props.current} live={chat.busy()} streaming={chat.streamingMessageIDs().has(row().tail.id)}
        activityMaterialization={chat.activityMaterialization} collapsibleUserMessages={nativeAppearance.current()?.collapsibleUserMessages} contentWidth={contentWidth()}
        activityChoice={choices()[row().turn?.turnId ?? row().key]} onToggleActivity={(key, expanded) => {
          if (!props.current()) return;
          const present = new Set(rows().map(row => row.turn?.turnId ?? row.key));
          choices.set({ ...Object.fromEntries(Object.entries(choices()).filter(([key]) => present.has(key))), [key]: expanded });
        }}
        renderCard={card => props.renderCard(card, { current: props.current, navigate: props.onNavigate, target })} onOpenChat={target => { if (target.kind === 'session') void props.onNavigate({ sessionID: target.id, directory: target.directory, title: target.title }); }}
        onOpenLink={async href => {
          if (!props.current()) return;
          try {
            if (!props.onOpenLink) throw new Error('content_link_unavailable');
            await props.onOpenLink(href, target, props.current);
          } catch { if (props.current()) searchError.set(t('common.unavailable')); }
        }}
        onOpenFile={(path, target) => { if (props.current()) props.onOpenFile?.(path, target); }} onOpenDiff={(...args) => { if (props.current()) props.onOpenDiff?.(...args); }} />}</Each>
      <NativeTurnError row={row()} />
      <View class="flex-row items-center gap-2">
        <Button testID={`panel-chat-copy:${row().tail.id}`} class={quiet} disabled={!props.current()} onPress={() => { void copy(row().tail.id); }} accessibilityLabel={t('chat.messageBody.actions.copyMessage')}><Icon name={copied() === row().tail.id ? 'check' : 'file-copy'} size={16} /></Button>
        <NativeTurnMetrics tps={turns().get(row().tail.id)?.tps} duration={turns().get(row().tail.id)?.duration} />
      </View>
    </View>}</List>
    <If when={reading()}><Button testID="panel-chat-latest" class={quiet} disabled={!props.current()} onPress={owner.latest} accessibilityLabel={t('chat.scrollToBottom.aria')}><Icon name="arrow-down-s" size={16} /></Button></If>
    <If when={['error', 'hidden', 'not-found', 'loading'].includes(focusStatus())}><View class="px-3 py-2 gap-2"><Text testID="panel-chat-focus-state" class="text-muted-foreground">{t(focusStatus() === 'hidden' ? 'chat.history.focusHidden' : focusStatus() === 'not-found' ? 'chat.history.focusMissing' : focusStatus() === 'loading' ? 'mobile.chat.syncingMessages' : 'commandPalette.error.messages')}</Text>
      <If when={focusStatus() === 'error'}><Button testID="panel-chat-focus-retry" class={quiet} disabled={!props.current()} onPress={() => { if (props.current()) void focus.retry(); }}><Text>{t('chat.history.retry')}</Text></Button></If>
    </View></If>
    <If when={confirmedChild()}><View testID="panel-chat-read-only-banner" class="border-t border-border p-3 gap-2">
      <Text class="text-muted-foreground text-sm">{t('chat.container.readOnlySubagentPromptBanner')}</Text>
      <View class="flex-row items-center gap-2"><NativeAgentAvatar name={execution().agentName} size={14} /><Text class="text-foreground text-sm flex-1">{execution().agentName || t('common.unavailable')}</Text>
        <NativeModelLogo modelID={execution().modelId} providerID={execution().providerId} size={14} /><Text class="text-foreground text-sm">{execution().modelId || t('common.unavailable')}</Text></View>
    </View></If>
  </View>;
}
