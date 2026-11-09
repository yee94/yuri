import { cleanup, Clipboard, computed, effect, lifecycle, List, signal, Text, token, untracked, View, type JSX } from 'nsh';
import { Button, Input, TextView } from 'nsh/base';
import { nativeChatTextStyle } from './appearance';
import { nativeTranscriptMarkdownStyles } from './transcript-body-markdown';
import { NativeProviderLogo } from './provider-logo';
import { Icon } from './Icon';
import { t } from './i18n';
import { formatTurnDuration } from '../ui/src/components/chat/message/turnDurationFormat';
import { normalizeDirectoryKey } from '../ui/src/lib/pathNormalization';
import type { NativeBtwScope, NativeBtwSelection, NativeBtwStore, NativeBtwTurn } from './desktop-btw';
import { createNativeDesktopBtwHandle, type NativeDesktopBtwHandle } from './desktop-btw-panel-core';

export type NativeBtwSelectionSlot = {
  selection: () => NativeBtwSelection | null;
  pending: () => boolean;
  current: () => boolean;
  setSelection: (value: NativeBtwSelection) => boolean;
};
export type NativeBtwSpeech = {
  /** Delegate to the existing Chat speech owner; the panel never creates audio/ASR. */
  state: (messageID: string) => 'idle' | 'loading' | 'playing' | 'error';
  speak: (messageID: string, text: string) => void | Promise<unknown>;
  stop: (messageID: string) => void | Promise<unknown>;
};
export type NativeDesktopBtwPanelProps = {
  store: NativeBtwStore;
  scope: NativeBtwScope;
  /** Actual Host/page operation identity; never a sidebar-selected session. */
  authority: string;
  current: () => boolean;
  active: boolean;
  interactive: boolean;
  visible: boolean;
  foot?: 'panel' | 'page';
  onClose: (scope: NativeBtwScope) => void;
  /** Return exact-handle cleanup; old keyed owners must not unpublish a newer handle. */
  onHandle?: (handle: NativeDesktopBtwHandle) => void | (() => void);
  renderSelection?: (slot: NativeBtwSelectionSlot) => JSX.Element;
  modelLabel?: (selection: NativeBtwSelection) => string;
  onChooseModel?: (slot: NativeBtwSelectionSlot) => void;
  onChooseAgent?: (slot: NativeBtwSelectionSlot) => void;
  speech?: NativeBtwSpeech;
  /** Return false on clipboard failure; default is the native Clipboard. */
  copy?: (text: string) => Promise<boolean>;
  onOpenLink?: (url: string) => void | Promise<void>;
};

function timestamp(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '';
  const date = new Date(value), pad = (part: number) => String(part).padStart(2, '0');
  if (!Number.isFinite(date.getTime())) return '';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Product side conversation, mounted in a workbench tab or page. No WebView or main-history reader. */
export function NativeDesktopBtwPanel(props: NativeDesktopBtwPanelProps) {
  const identity = () => `${props.authority}\u0000${props.scope.runtime?.transport ?? ''}\u0000${props.scope.runtime?.generation ?? ''}\u0000${normalizeDirectoryKey(props.scope.directory)}\u0000${props.scope.sessionId}`;
  function Owner() {
    const store = props.store, authority = props.authority, ownerIdentity = identity();
    const draft = signal(''), composing = signal(false), copyError = signal(false);
    let alive = true;
    let playback: { speech: NativeBtwSpeech; id: string } | undefined;
    const stopSpeech = () => {
      const owned = playback; playback = undefined;
      if (!owned) return;
      try {
        if (['loading', 'playing'].includes(owned.speech.state(owned.id))) void Promise.resolve(owned.speech.stop(owned.id)).catch(() => {});
      } catch { /* The injected audio owner retains its own failure state. */ }
    };
    const actual = () => alive && props.store === store && props.authority === authority && identity() === ownerIdentity && props.current();
    const handle = createNativeDesktopBtwHandle({ store, scope: props.scope, current: actual,
      active: () => props.active && lifecycle() === 'active', interactive: () => props.interactive,
      visible: () => props.visible, onReset: stopSpeech, onClose: () => { draft.set(''); props.onClose(handle.scope); } });
    const entry = signal(store.entry(handle.scope)), selectionRevision = signal(0);
    cleanup(store.observe(handle.scope, () => { entry.set(store.entry(handle.scope)); selectionRevision.set(selectionRevision() + 1); }));
    const selection = computed(() => { selectionRevision(); return store.selection(handle.scope); });
    const pending = computed(() => entry().turns.some(turn => turn.pending));
    const admitted = () => handle.current() && props.interactive && props.visible;
    const slot: NativeBtwSelectionSlot = { selection, pending, current: admitted, setSelection: handle.setSelection };
    const unpublish = props.onHandle?.(handle);
    cleanup(() => { alive = false; handle.dispose(); unpublish?.(); });
    effect(() => {
      const current = actual() && store.current(handle.scope), active = props.active && lifecycle() === 'active';
      if (!current || !active) untracked(() => store.cancel(handle.scope));
    });
    effect(() => { if (!props.visible || !props.active || !actual() || lifecycle() !== 'active') untracked(stopSpeech); });
    cleanup(stopSpeech);
    function send() {
      if (composing()) return;
      if (handle.ask(draft())) draft.set('');
    }
    async function copy(text: string) {
      if (!admitted()) return;
      let ok = false;
      try { if (props.copy) ok = await props.copy(text); else { await Clipboard.writeText(text); ok = true; } } catch { /* Report below without changing a turn. */ }
      if (admitted()) copyError.set(!ok);
    }
    function Turn(propsTurn: { turn: NativeBtwTurn }) {
      const hovered = signal(false), linkError = signal(false);
      const turn = () => propsTurn.turn;
      const isLast = () => entry().turns[entry().turns.length - 1]?.id === turn().id;
      const messageID = () => `btw:${handle.scope.sessionId}:${turn().id}`;
      const error = () => turn().error === 'empty response' || turn().error === 'session.btw failed' ? t('chat.btw.failed') : turn().error;
      const cancelled = () => !turn().pending && !turn().error && !turn().answer;
      const speechState = () => props.speech?.state(messageID()) ?? 'idle';
      async function openLink(href: string) {
        if (!admitted()) return;
        try {
          if (!props.onOpenLink) throw new Error('content_link_unavailable');
          await props.onOpenLink(href);
          if (admitted()) linkError.set(false);
        } catch { if (admitted()) linkError.set(true); }
      }
      async function speak() {
        if (!admitted() || !props.speech) return;
        const speech = props.speech, id = messageID();
        try {
          if (speechState() === 'loading' || speechState() === 'playing') { await speech.stop(id); playback = undefined; }
          else { stopSpeech(); playback = { speech, id }; await speech.speak(id, turn().answer); }
        } catch { /* Existing speech owner owns playback error state. */ }
      }
      return <View testID={`btw-turn-${turn().id}`} class="gap-2 py-2.5">
        <View class="self-end ml-8 rounded-xl bg-card px-3 py-2 gap-1.5" style={{ maxWidth: '100%' }}>
          <Each of={turn().quotes}>{quote => <Text class="border-l-2 border-border pl-1.5 text-muted-foreground" style={nativeChatTextStyle('meta')}>{quote()}</Text>}</Each>
          <TextView testID={`btw-question-${turn().id}`} document={{ blocks: [{ type: 'paragraph', content: [{ type: 'text', text: turn().question }] }] }} selectable class="text-foreground" style={nativeChatTextStyle('user')} styles={nativeTranscriptMarkdownStyles('user', true)} />
        </View>
        <If when={turn().pending}><View testID="btw-pending" class="flex-row items-center gap-1.5"><Icon name="loader-4" size={14} /><Text class="text-muted-foreground" style={nativeChatTextStyle('meta')}>{t('chat.btw.pending')}</Text></View></If>
        <If when={!!error()}><View testID="btw-turn-error" role="alert" class="flex-row items-center gap-1.5"><Icon name="error-warning" size={14} color={token('destructive')} /><Text class="text-muted-foreground" style={nativeChatTextStyle('meta')}>{error()}</Text></View></If>
        <If when={cancelled()}><Text testID="btw-cancelled" class="text-muted-foreground" style={nativeChatTextStyle('meta')}>{t('chat.btw.cancelled')}</Text></If>
        <View onMouseEnter={() => hovered.set(true)} onMouseLeave={() => hovered.set(false)}>
        <If when={!!turn().answer}><TextView testID={`btw-answer-${turn().id}`} markdown={turn().answer} selectable links="report" options={{ streaming: false }}
          class="text-foreground" style={nativeChatTextStyle('assistant')} styles={nativeTranscriptMarkdownStyles('assistant')}
          codeBlockActions={admitted() ? [{ id: 'copy', label: t('markdownRenderer.code.actions.copyTitle') }] : []} onLinkPress={event => { void openLink(event.url); }} /></If>
        <If when={linkError()}><Text testID={`btw-link-error-${turn().id}`} role="alert" class="text-sm text-destructive">{t('common.unavailable')}</Text></If>
        <If when={!turn().pending && (!!turn().answer || isLast() && (!!error() || cancelled()))}>
          <View testID={`btw-footer-${turn().id}`} class="flex-row flex-wrap items-center gap-3 mt-1.5 mb-0.5">
            <View class="flex-row items-center gap-2">
              <If when={!!turn().answer}>
                <Button testID={`btw-copy-${turn().id}`} class="h-6 w-6 bg-transparent text-muted-foreground" disabled={!admitted()} tooltip={t('chat.messageBody.actions.copyMessage')} accessibilityLabel={t('chat.messageBody.actions.copyMessageAria')} onPress={() => { void copy(turn().answer); }}><Icon name="file-copy" size={14} color={token('muted-foreground')} /></Button>
                <If when={!!props.speech}><Button testID={`btw-speech-${turn().id}`} class="h-6 w-6 bg-transparent text-muted-foreground" disabled={!admitted()}
                  accessibilityLabel={t(speechState() === 'playing' || speechState() === 'loading' ? 'chat.messageBody.tts.stopSpeaking' : 'chat.messageBody.tts.readAloud')} onPress={() => { void speak(); }}>
                  <Icon name={speechState() === 'loading' ? 'loader-4' : speechState() === 'playing' ? 'volume-up-fill' : 'volume-up'} size={14} /></Button></If>
              </If>
              <If when={isLast()}><Button testID="btw-retry" class="h-6 w-6 bg-transparent text-muted-foreground" disabled={!admitted() || !store.available() || pending()} tooltip={t('contextPanel.preview.actions.retry')} accessibilityLabel={t('contextPanel.preview.actions.retry')} onPress={() => { handle.retry(); }}><Icon name="refresh" size={14} color={token('muted-foreground')} /></Button></If>
            </View>
            <If when={!!turn().answer}><View class="flex-row gap-2 items-center">
              <If when={typeof turn().durationMs === 'number' && Number.isFinite(turn().durationMs) && turn().durationMs! >= 0}><Icon name="hourglass" size={14} /><Text class="text-muted-foreground" style={nativeChatTextStyle('micro')}>{formatTurnDuration(turn().durationMs!)}</Text></If>
              <If when={hovered()}><Text class="text-muted-foreground" style={nativeChatTextStyle('micro')}>{timestamp(turn().completedAt ?? 0)}</Text></If>
            </View></If>
          </View>
          <If when={speechState() === 'error'}><Text role="alert" class="text-destructive" style={nativeChatTextStyle('meta')}>{t('chat.messageBody.tts.failed')}</Text></If>
        </If>
        </View>
      </View>;
    }
    function Selection() {
      const label = computed(() => { const value = selection(); return value ? props.modelLabel?.(value) ?? value.modelID : ''; });
      return <If when={!!props.renderSelection} else={<View class="flex-1 flex-row items-center gap-1.5">
        <If when={!!selection()}><View class="flex-row items-center gap-1.5 px-2.5 py-1" style={{ minWidth: 0, flexShrink: 1 }}>
          <NativeProviderLogo providerID={selection()!.providerID} size={16} />
          <If when={!!props.onChooseModel} else={<Text class="text-foreground" style={{ ...nativeChatTextStyle('meta'), numberOfLines: 1 }}>{label()}</Text>}>
            <Button testID="btw-model" class="bg-transparent" style={{ minWidth: 0, flexShrink: 1 }} disabled={!admitted()} accessibilityLabel={label()} onPress={() => { if (admitted()) props.onChooseModel?.(slot); }}><Text class="text-foreground" style={{ ...nativeChatTextStyle('meta'), numberOfLines: 1 }}>{label()}</Text></Button>
          </If>
        </View></If>
        <If when={!selection() && !!props.onChooseModel}><Button testID="btw-model" class="bg-transparent" disabled={!admitted()} accessibilityLabel={t('chat.modelControls.selectModel')} onPress={() => { if (admitted()) props.onChooseModel?.(slot); }}><Text class="text-foreground" style={nativeChatTextStyle('meta')}>{t('chat.modelControls.selectModel')}</Text></Button></If>
        <If when={!!props.onChooseAgent} else={<If when={!!selection()?.agent}><Text class="text-muted-foreground" style={nativeChatTextStyle('meta')}>{selection()?.agent}</Text></If>}>
          <Button testID="btw-agent" class="bg-transparent" disabled={!admitted()} accessibilityLabel={t('chat.modelControls.selectAgent')} onPress={() => { if (admitted()) props.onChooseAgent?.(slot); }}><Text class="text-muted-foreground" style={nativeChatTextStyle('meta')}>{selection()?.agent ?? t('chat.modelControls.selectAgent')}</Text></Button>
        </If>
      </View>}>{props.renderSelection?.(slot)}</If>;
    }
    return <View testID={`desktop-btw-${props.foot ?? 'panel'}`} class="flex-1 min-h-0 min-w-0 text-foreground" style={{ display: props.visible ? 'flex' : 'none' }} accessibilityLabel={t('chat.btw.title')}>
      <List testID="btw-transcript" class="flex-1 min-h-0 px-4 py-3" each={entry().turns} keyExtractor={turn => turn.id}
        maintainVisibleContentPosition={{ autoscrollToBottomThreshold: 48 }} initialScrollIndex={Math.max(0, entry().turns.length - 1)}
        empty={<Text testID="btw-empty" class="text-muted-foreground" style={nativeChatTextStyle('meta')}>{t('chat.btw.description')}</Text>}>{turn => <Turn turn={turn()} />}</List>
      <If when={copyError()}><Text testID="btw-copy-error" role="alert" class="px-3 text-destructive" style={nativeChatTextStyle('meta')}>{t('filesView.toast.copyFailed')}</Text></If>
      <If when={!store.available()}><Text testID="btw-unavailable" role="alert" class="px-3 text-muted-foreground" style={nativeChatTextStyle('meta')}>{t('common.unavailable')}</Text></If>
      <View testID="btw-composer" class="mx-3 mt-1 mb-3 rounded-3xl bg-card">
        <Each of={entry().quotes}>{(quote, index) => <View testID={`btw-quote-${index()}`} class="mx-3 mt-1 flex-row items-center gap-1 rounded-md bg-secondary py-0.5 pl-2 pr-0.5">
          <Text class="flex-1 border-l-2 border-border pl-2 text-muted-foreground" style={{ ...nativeChatTextStyle('meta'), numberOfLines: 1 }}>{quote().replace(/\s+/g, ' ')}</Text>
          <Button testID={`btw-remove-quote-${index()}`} class="h-6 w-6 bg-transparent" disabled={!admitted()} accessibilityLabel={t('chat.btw.removeQuoteAria')} onPress={() => { if (admitted()) store.removeQuote(handle.scope, index()); }}><Icon name="close" size={14} /></Button>
        </View>}</Each>
        <Input testID="btw-editor" multiline submitBehavior="submit" value={draft()} readonly={!admitted()} placeholder={t('chat.btw.placeholder')} accessibilityLabel={t('chat.btw.placeholder')}
          class="px-3 pt-4 pb-2 bg-transparent text-foreground" style={{ ...nativeChatTextStyle('user'), minHeight: 54, maxHeight: 240 }}
          onChange={event => { if (admitted()) draft.set(event.value); }} onCompositionChange={event => composing.set(event.composing)} onSubmit={send} />
        <View class="flex-row items-center justify-between gap-2 px-2.5 py-1.5"><Selection />
          <If when={pending()} else={<Button testID="btw-send" class="h-8 w-8 rounded-full bg-primary active:bg-accent" disabled={!admitted() || !store.available() || !draft().trim() || composing()} accessibilityLabel={t('chat.chatInput.actions.sendMessageAria')} onPress={send}><Icon name="arrow-up" size={16} tone="background" /></Button>}>
            <Button testID="btw-stop" class="h-8 w-8 rounded-full bg-primary active:bg-accent" disabled={!admitted()} accessibilityLabel={t('chat.statusRow.actions.stopGeneratingAria')} onPress={() => { handle.cancel(); }}><Icon name="stop" size={16} tone="background" /></Button>
          </If>
        </View>
      </View>
    </View>;
  }
  return <Each of={[identity()]} key={key => key}>{() => <Owner />}</Each>;
}
