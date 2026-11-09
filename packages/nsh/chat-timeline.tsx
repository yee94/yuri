import { cleanup, computed, effect, keymap, List, locale, signal, Text, untracked, View, type ListRef } from 'nsh';
import { AlertDialog, Button } from 'nsh/base';
import { NativeSheet } from './native-sheet';
import { NativeSheetSearch } from './sheet-search';
import { Icon } from './Icon';
import { language, t } from './i18n';
import { nativeDensity, nativeChatTextStyle as nativeTextStyle } from './appearance';
import type { Message } from './model';
import type { NativeHistoryFocusState } from './history-focus';
import { createTranscriptActions, type TranscriptActionOptions } from './transcript-actions-core';
import { createNativeTimelineOwner, type NativeTimelineState, type TimelineAuthority, type TimelineAction } from './chat-timeline-owner';
import { nativeTimelineEntries, nativeTimelineDate, nativeTimelineTime } from './chat-timeline-model';

export type NativeChatTimelineProps = {
  open: boolean;
  /** Existing Chat page operation; never create a second Host or page owner here. */
  operation: TimelineAuthority | null;
  onOpenChange: (open: boolean) => void;
  messages: () => readonly Message[];
  focusedMessageID: () => string | null;
  messagesResolved: () => boolean;
  more: () => boolean;
  olderLoading: () => boolean;
  historyError: () => string;
  loadOlder: () => Promise<void>;
  focusMessage: (id: string) => Promise<NativeHistoryFocusState>;
  resumeLatest: () => void | Promise<void>;
  /** Pass the original history.props function, retaining its operation/async-write fences. */
  messageOptions: (message: () => Message) => TranscriptActionOptions;
};

type TimelinePresentation = {
  interactive: () => boolean;
  close: () => void;
  dismiss: () => void;
};

export function NativeChatTimeline(props: NativeChatTimelineProps) {
  const state = signal<NativeTimelineState>({ generation: 0, phase: 'closed', pending: null, messageID: null, error: null });
  const owner = createNativeTimelineOwner(value => state.set(value));
  effect(() => { const operation = props.operation; untracked(() => owner.replaceAuthority(operation)); });
  effect(() => { const requested = props.open, operation = props.operation; untracked(() => owner.request(requested && operation?.current() === true)); });
  cleanup(owner.dispose);
  return <Each of={state().phase === 'closed' ? [] : [state().generation]}>{generation => {
    const id = generation(), operation = props.operation;
    // Capture at presentation construction, before any UI callback can be retained.
    const current = () => state().generation === id && props.operation === operation && operation?.current() === true;
    const interactive = () => current() && owner.interactive();
    const dismiss = () => { if (current()) props.onOpenChange(false); };
    const close = () => { if (current() && owner.close()) dismiss(); };
    const presentation: TimelinePresentation = { interactive, close, dismiss };
    return <NativeSheet testID="chat-timeline-sheet" open={state().generation === id && state().phase !== 'closing'} detents={[.72, .98]} initialDetent={1}
      closeOnSwipe={!state().pending} closeOnBackdropPress={!state().pending} closeOnEscape={!state().pending}
      onOpen={() => { if (current()) owner.opened(id); }} onOpenChange={event => { if (!event.open) close(); }} onClose={() => owner.closed(id)} popupClass="bg-background">
      <If when={state().phase === 'open' || state().phase === 'closing'}><NativeTimelineContent props={props} state={state} owner={owner} presentation={presentation} /></If>
    </NativeSheet>;
  }}</Each>;
}

function NativeTimelineContent(input: { props: NativeChatTimelineProps; state: () => NativeTimelineState; owner: ReturnType<typeof createNativeTimelineOwner>; presentation: TimelinePresentation }) {
  const { props, owner, state, presentation } = input;
  // Refuse an old cell/sheet callback before run() may capture the current authority.
  const run = (...args: Parameters<typeof owner.run>) => presentation.interactive() ? owner.run(...args) : Promise.resolve(false);
  const search = signal(''), selected = signal<string | null>(null), composing = signal(false);
  const list = signal<ListRef | null>(null);
  const intlLocale = () => language() === 'system' ? locale() : language();
  const entries = computed(() => nativeTimelineEntries(props.messages(), search()));
  const byID = computed(() => new Map(entries().map(entry => [entry.id, entry])));
  const ids = computed(() => entries().map(entry => entry.id));
  const disabled = () => !presentation.interactive() || !!state().pending;
  let initialized = false;
  effect(() => {
    const rows = ids(), focused = props.focusedMessageID(), query = search(), ref = list();
    untracked(() => {
      if (!initialized || !rows.includes(selected() ?? '')) selected.set(rows.includes(focused ?? '') ? focused : query.trim() ? rows[0] ?? null : rows.at(-1) ?? null);
      if (!initialized && ref && rows.length) { initialized = true; ref.scrollToIndex({ index: Math.max(0, rows.indexOf(selected()!)), animated: false, viewPosition: .5 }); }
    });
  });
  const goto = (id: string) => run('goto', id, async valid => {
    if (!valid()) return false;
    const result = await props.focusMessage(id);
    if (valid() && result.status !== 'revealed') throw new Error(t('miniChat.actions.failed'));
  }, presentation.dismiss);
  const older = () => run('older', null, async valid => {
    if (!valid() || props.olderLoading() || (!props.more() && !props.historyError())) return false;
    await props.loadOlder();
    if (valid() && props.historyError()) throw new Error(props.historyError());
  }, presentation.dismiss);
  async function action(type: TimelineAction, id: string) {
    await run(type, id, async valid => {
      const message = byID().get(id)?.message;
      if (!message || !valid()) return false;
      const options = props.messageOptions(() => props.messages().find(item => item.id === id) ?? message);
      const scopeCurrent = options.scope.current;
      const current = () => valid() && scopeCurrent() && props.messages().some(item => item.id === id);
      if (type === 'revert') {
        const result = await AlertDialog.show({ title: t('chat.messageBody.actions.revert'), description: t('chat.revertPopover.files'), actions: [
          { id: 'revert', label: t('chat.revertPopover.revert'), role: 'destructive' },
          { id: 'cancel', label: t('settings.common.actions.cancel'), role: 'cancel' },
        ] });
        if (result.action !== 'revert' || !current()) return false;
      }
      let navigation: (() => void) | undefined;
      const actions = createTranscriptActions({ ...options, scope: { ...options.scope, current }, onOpenChat: target => {
        if (current()) navigation = () => { if (scopeCurrent()) options.onOpenChat?.(target); };
      } });
      if (!actions.current() || actions.pending()) return false;
      if (type === 'revert') await actions.revert(true); else await actions.fork();
      return navigation;
    }, presentation.dismiss);
  }
  function move(offset: number) {
    if (disabled() || !ids().length) return;
    const rows = ids(), index = (Math.max(0, rows.indexOf(selected()!)) + offset + rows.length) % rows.length;
    selected.set(rows[index]); list()?.scrollToIndex({ index, animated: false, viewPosition: .5 });
  }
  effect(() => {
    state();
    if (!presentation.interactive() || composing()) return;
    cleanup(keymap.bind({ up: () => move(-1), down: () => move(1), enter: () => { if (!disabled() && selected()) void goto(selected()!); }, escape: presentation.close }, { when: 'always', repeat: true }));
  });
  return <View class="flex-1 p-4 gap-3" style={nativeDensity().select.content}>
    <View class="flex-row items-center gap-2" style={nativeDensity().select.header}>
      <Text class="flex-1 text-foreground font-semibold" style={nativeTextStyle('uiLabel')}>{t('chat.timeline.title')}</Text>
      <Button testID="chat-timeline-close" disabled={disabled()} class="min-h-11 min-w-11 items-center justify-center" accessibilityLabel={t('mobile.surface.closeAria')} onPress={presentation.close}><Icon name="close" size={20} /></Button>
    </View>
    <NativeSheetSearch testID="chat-timeline-search" value={search()} disabled={disabled()} accessibilityLabel={t('chat.timeline.searchPlaceholder')} placeholder={t('chat.timeline.searchPlaceholder')}
      onChange={event => { if (!disabled()) { search.set(event.value); selected.set(null); } }} onClear={() => { if (!disabled()) { search.set(''); selected.set(null); } }} onCompositionChange={event => { if (presentation.interactive()) composing.set(event.composing); }} />
    <If when={props.more() || !!props.historyError()}><Button testID="chat-timeline-older" disabled={disabled() || props.olderLoading()} class="min-h-11 items-center justify-center bg-secondary rounded-xl" style={nativeDensity().forms.quiet} onPress={() => { void older(); }}><Text class="text-foreground">{t(props.olderLoading() ? 'common.loading' : props.historyError() ? 'chat.questionDelegate.retry' : 'chat.history.loadOlder')}</Text></Button></If>
    <If when={!!props.historyError()}><Text role="alert" class="text-destructive" style={nativeTextStyle('micro')}>{props.historyError()}</Text></If>
    <If when={!!state().error}><Text testID="chat-timeline-error" role="alert" class="text-destructive" style={nativeTextStyle('micro')}>{state().error instanceof Error ? (state().error as Error).message : t('miniChat.actions.failed')}</Text></If>
    <If when={!props.messagesResolved()}><Text class="text-muted-foreground">{t('common.loading')}</Text></If>
    <List testID="chat-timeline-list" class="flex-1" each={ids()} keyExtractor={id => id} ref={node => list.set(node)} keyboardDismissMode="interactive" maintainVisibleContentPosition={{}}>
      {id => <If when={byID().has(id())}>{() => {
        const entry = () => byID().get(id())!;
        const previous = () => entries()[ids().indexOf(id()) - 1];
        const date = (created: number | undefined) => created === undefined ? '' : nativeTimelineDate(created, intlLocale());
        return <View>
          <If when={!!date(entry().created) && date(previous()?.created) !== date(entry().created)}><Text class="text-muted-foreground px-3 py-2" style={nativeTextStyle('micro')}>{date(entry().created)}</Text></If>
          <View class="flex-row items-center gap-2">
             <Button testID={`chat-timeline-goto-${id()}`} selected={selected() === id()} disabled={disabled()} class="flex-1 rounded-xl selected:bg-accent items-start" style={nativeDensity().forms.session} accessibilityLabel={entry().text || t('chat.timeline.noTextContent')} onPress={() => { if (!disabled()) { selected.set(id()); void goto(id()); } }}>
              <Text class="text-muted-foreground" style={nativeTextStyle('micro')}>{entry().created === undefined ? '' : nativeTimelineTime(entry().created!, intlLocale())}</Text>
              <Text class="text-foreground" style={nativeTextStyle('markdown')}>{entry().text || t('chat.timeline.noTextContent')}</Text>
            </Button>
            <Button testID={`chat-timeline-revert-${id()}`} class="min-h-11 min-w-11 items-center justify-center disabled:opacity-40" disabled={disabled()} accessibilityLabel={t('chat.timeline.actions.revertFromHere')} onPress={() => { void action('revert', id()); }}><Icon name={state().pending === 'revert' && state().messageID === id() ? 'loader-4' : 'arrow-go-back'} size={18} /></Button>
            <Button testID={`chat-timeline-fork-${id()}`} class="min-h-11 min-w-11 items-center justify-center disabled:opacity-40" disabled={disabled()} accessibilityLabel={t('chat.timeline.actions.forkFromHere')} onPress={() => { void action('fork', id()); }}><Icon name={state().pending === 'fork' && state().messageID === id() ? 'loader-4' : 'git-branch'} size={18} /></Button>
          </View>
        </View>;
      }}</If>}
    </List>
    <If when={props.messagesResolved() && !ids().length && !props.historyError()}><Text class="text-muted-foreground" style={nativeTextStyle('markdown')}>{t(search().trim() ? 'chat.timeline.empty.search' : 'chat.timeline.empty.session')}</Text></If>
    <Button testID="chat-timeline-latest" disabled={disabled()} class="min-h-11 bg-secondary rounded-xl items-center justify-center" style={nativeDensity().forms.action} onPress={() => { void run('latest', null, async valid => { if (!valid()) return false; await props.resumeLatest(); }, presentation.dismiss); }}><Text class="text-foreground">{t('chat.timeline.actions.latest')}</Text></Button>
  </View>;
}
