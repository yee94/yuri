import { colorScheme, computed, effect, lifecycle, Overlay, reduceMotion, signal, Text, token, View, type JSX, type TextStyle, type ViewRef } from 'nsh';
import { Button, TextView } from 'nsh/base';
import { AssistantAvatar } from './assistants-avatar-live';
import { nativeAppearance, nativeChatTextStyle } from './appearance';
import { nativeTranscriptMarkdownStyles } from './transcript-body-markdown';
import { text, type Message, type Row } from './model';
import { t } from './i18n';
import { Icon } from './Icon';
import { NativeDesktopChatColumn } from './desktop-chat-layout';

/** Apply to the caller's single Input after its appearance typography. */
export const desktopAssistantEditorStyle: TextStyle = {
  minHeight: 48, maxHeight: 160, paddingHorizontal: 12, paddingVertical: 12,
  fontSize: 14, lineHeight: 24, backgroundColor: 'transparent', borderWidth: 0,
};

export type NativeDesktopAssistantComposerProps = {
  editor: JSX.Element;
  attach: JSX.Element;
  send: JSX.Element;
  attachments?: JSX.Element;
  feedback?: JSX.Element;
  overlays?: JSX.Element;
  anchorRef?: (view: ViewRef) => void;
  onWidth?: (width: number) => void;
  onHeight?: (height: number) => void;
  focused?: boolean;
};

function alpha(color: string, opacity: number) {
  const match = /^#([\da-f]{6})([\da-f]{2})?$/i.exec(color);
  if (!match) return color;
  return `#${match[1]}${Math.round((match[2] ? parseInt(match[2], 16) : 255) * opacity).toString(16).padStart(2, '0')}`;
}

function contactTextStyle(role: 'user' | 'assistant'): TextStyle {
  const primary = nativeAppearance.current()?.webTheme?.[colorScheme()].colors.primary;
  return { ...nativeChatTextStyle(role), color: role === 'user' ? primary?.foreground || token('primary-foreground') : token('foreground'), lineHeight: 24 };
}

// NSH primary intentionally means a neutral action; the Web contact bubble is
// non-action primary.base and must keep the canonical theme's actual accent.
function userBubbleColor() { return nativeAppearance.current()?.webTheme?.[colorScheme()].colors.primary.base || token('primary'); }

/** Contact-only inline composer. No Input, actions, draft or transport owner.
 * Footer 4 + form 6/16 + 50pt bordered surface = 76pt at its minimum. */
export function NativeDesktopAssistantComposer(props: NativeDesktopAssistantComposerProps) {
  const hovered = signal(false), height = signal(50);
  let lastWidth = 0, lastHeight = 0;
  const dark = () => colorScheme() === 'dark';
  return <View testID="desktop-assistant-composer" class="w-full shrink-0 relative bg-background" style={{ paddingTop: 4 }}
    onLayout={event => { const next = event.bounds.size.height; if (next > 0 && next !== lastHeight) { lastHeight = next; props.onHeight?.(next); } }}>
    <NativeDesktopChatColumn>{props.feedback}</NativeDesktopChatColumn>
    <View testID="desktop-assistant-composer-form" class="w-full min-w-0" style={{ paddingTop: 6, paddingBottom: 16 }}>
      <NativeDesktopChatColumn testID="desktop-assistant-composer-column">
        <View testID="desktop-assistant-composer-surface" ref={props.anchorRef} class="relative min-w-0 bg-background"
          onMouseEnter={() => hovered.set(true)} onMouseLeave={() => hovered.set(false)}
          onLayout={event => { const size = event.bounds.size; if (size.width > 0 && size.width !== lastWidth) { lastWidth = size.width; props.onWidth?.(size.width); } if (size.height > 0 && size.height !== height()) height.set(size.height); }}
          style={{ borderRadius: 24, borderWidth: 1, borderColor: dark() ? 'transparent' : alpha(token('border'), .5),
            boxShadow: dark() ? 'none' : `0 2px 6px -3px ${alpha(token('foreground'), .04)}, inset 0 1px 0 ${alpha(token('background'), .8)}` }}>
          <If when={dark()}><View testID="desktop-assistant-composer-fill" accessible={false} style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, borderRadius: 23, pointerEvents: 'none', backgroundColor: token('foreground'), opacity: hovered() || props.focused ? .11 : .08 }} /></If>
          <View testID="desktop-assistant-composer-inline" class="relative flex-row min-w-0" style={{ minHeight: 48, alignItems: height() > 50 ? 'flex-end' : 'center' }}>
            <View testID="desktop-assistant-composer-attach" class="shrink-0 items-center justify-center" style={{ height: 48, paddingLeft: 6 }}>{props.attach}</View>
            <View class="flex-1 min-w-0">{props.attachments}{props.editor}</View>
            <View testID="desktop-assistant-composer-send" class="shrink-0 items-center justify-center" style={{ height: 48, paddingRight: 6 }}>{props.send}</View>
          </View>
          {props.overlays}
        </View>
      </NativeDesktopChatColumn>
    </View>
  </View>;
}

export type NativeDesktopAssistantMessageProps = {
  message: Message;
  /** Actual sender row, including a peer's resolved row when available. */
  bot: Row;
  kind: 'user' | 'assistant' | 'peer';
  showAvatar: boolean;
  timeSeparator?: string;
  peerLabel?: string;
  current: () => boolean;
  onOpenLink?: (href: string) => void | Promise<void>;
  renderCard: (card: Row) => JSX.Element;
  renderFile?: (file: Row) => JSX.Element;
  /** Authoritative source supplied by the existing conversation owner. */
  status?: 'sending' | 'streaming' | 'error' | 'failed' | 'complete' | 'admitted';
  feedback?: JSX.Element;
  first?: boolean;
  /** 0 after separator/first row, 24 new turn, 6 same run, 12 otherwise. */
  spacing?: number;
};

/** One original message, not a Session turn/activity projection. Raw part order
 * is retained; legacy records without content alone use their old fields. */
export function NativeDesktopAssistantMessage(props: NativeDesktopAssistantMessageProps) {
  const width = signal(0), linkFailed = signal(false);
  const parts = computed(() => props.message.content ?? [
    ...(props.message.text ? [{ type: 'text', text: props.message.text }] : []),
    ...props.message.cards, ...props.message.files,
  ]);
  const user = () => props.kind === 'user';
  const peer = () => props.kind === 'peer';
  const failed = () => props.status === 'error' || !user() && (props.status === 'failed' || !!props.message.error);
  const bodyWidth = () => width() > 0 ? Math.min(width() * (user() ? .82 : .84), user() ? 480 : 544) : undefined;
  async function openLink(href: string) {
    if (!props.current()) return;
    const source = props.message;
    try {
      if (!props.onOpenLink) throw new Error('content_link_unavailable');
      await props.onOpenLink(href);
      if (props.current() && props.message === source) linkFailed.set(false);
    } catch { if (props.current() && props.message === source) linkFailed.set(true); }
  }
  function Part(item: { part: Row; index: number }) {
    const value = () => text(item.part.text);
    const imageOnly = () => !user() && /^!\[(?:\\.|[^\]\\\n])*\]\(\s*(?:<[^>\n]+>|[^\s()]+)(?:\s+"[^"\n]*")?\s*\)$/.test(value().trim());
    return <If when={item.part.type === 'card'} else={
      <If when={item.part.type === 'file'} else={
        <If when={item.part.type === 'text' && !/^(?:yuri|oc)\.settle\./.test(value().trim()) && (!!value().trim() || props.status === 'streaming')}>
          <View testID={`desktop-assistant-text-${props.message.id}-${item.index}`} accessibilityLabel={peer() ? t('assistants.contact.peer.aria', { name: props.peerLabel || text(props.bot.name) }) : undefined}
            class="min-w-0" style={{ maxWidth: '100%', paddingHorizontal: imageOnly() ? 0 : 16, paddingVertical: imageOnly() ? 0 : 10, borderRadius: user() ? 18.4 : peer() ? 20 : 21.6, borderBottomRightRadius: user() ? 8 : undefined,
              backgroundColor: imageOnly() ? 'transparent' : user() ? alpha(userBubbleColor(), .9) : peer() ? alpha(token('muted'), .7) : token('muted'),
              borderWidth: peer() && !imageOnly() ? 1 : 0, borderStyle: peer() ? 'dashed' : 'solid', borderColor: alpha(token('border'), .5) }}>
            <If when={user()} else={<TextView testID={`desktop-assistant-markdown-${props.message.id}-${item.index}`} markdown={value()} selectable links="report" onLinkPress={event => { void openLink(event.url); }}
              options={{ streaming: props.status === 'streaming' }} class="text-foreground min-w-0" style={contactTextStyle('assistant')}
              styles={{ ...nativeTranscriptMarkdownStyles('assistant'), root: contactTextStyle('assistant'), paragraph: { marginTop: 0, marginBottom: 0 } }} codeBlockActions={props.current() ? [{ id: 'copy' }] : []} />}>
              <TextView testID={`desktop-assistant-literal-${props.message.id}-${item.index}`} document={{ blocks: [{ type: 'paragraph', content: [{ type: 'text', text: value() }] }] }} selectable
                class="text-primary-foreground min-w-0" style={contactTextStyle('user')}
                styles={{ root: contactTextStyle('user'), paragraph: { marginTop: 0, marginBottom: 0 } }} />
            </If>
          </View>
        </If>
      }><View testID={`desktop-assistant-file-${props.message.id}-${item.index}`} class="min-w-0" style={{ maxWidth: '100%' }}>
        <If when={!!props.renderFile} else={<View class="bg-muted min-w-0" style={{ borderRadius: 20, paddingHorizontal: 14, paddingVertical: 10, gap: 4 }}>
          <View class="flex-row items-center gap-2.5"><Icon name="file-text" size={16} /><Text class="text-foreground" style={{ ...nativeChatTextStyle('uiLabel'), numberOfLines: 1 }}>{text(item.part.filename) || t('assistants.contact.attachment.file')}</Text></View>
          <Text class="text-muted-foreground" style={nativeChatTextStyle('micro')}>{t('common.unavailable')}</Text>
        </View>}>{props.renderFile?.(item.part)}</If>
      </View></If>
    }><View testID={`desktop-assistant-card-${props.message.id}-${item.index}`} class="min-w-0" style={{ maxWidth: '100%' }}>{props.renderCard(item.part)}</View></If>;
  }
  return <View testID={`desktop-assistant-message-${props.message.id}`} class="w-full self-center min-w-0" style={{ maxWidth: 672 }} onLayout={event => { const next = event.bounds.size.width; if (next > 0 && next !== width()) width.set(next); }}>
    <If when={!!props.timeSeparator}><View testID={`desktop-assistant-time-${props.message.id}`} class="items-center" style={{ paddingTop: props.first ? 4 : 28, paddingBottom: 16, paddingHorizontal: 16 }}><Text class="text-muted-foreground" style={{ fontSize: 11, lineHeight: 16, opacity: .7 }}>{props.timeSeparator}</Text></View></If>
    <If when={failed()} else={<View class={`w-full flex-row min-w-0 ${user() ? 'justify-end' : 'justify-start'}`} style={{ marginTop: props.timeSeparator ? 0 : props.spacing ?? 12 }}>
      <If when={!user()}><View testID={`desktop-assistant-avatar-slot-${props.message.id}`} class="shrink-0 items-center" style={{ width: 36, marginRight: 10, paddingTop: 2 }}>
        <If when={props.showAvatar}><AssistantAvatar bot={props.bot} size={32} active={props.current()} testID={`desktop-assistant-avatar-${props.message.id}`} /></If>
      </View></If>
      <View testID={`desktop-assistant-parts-${props.message.id}`} class={`relative min-w-0 ${user() ? 'items-end' : 'items-start'}`} style={{ maxWidth: bodyWidth(), gap: 6, flexShrink: 1 }}>
        <If when={peer()}><Text class="text-muted-foreground" style={{ ...nativeChatTextStyle('micro'), marginBottom: 2, paddingHorizontal: 4, opacity: .75 }}>{t('assistants.contact.peer.from', { name: props.peerLabel || text(props.bot.name) || t('assistants.contact.peer.unknown') })}</Text></If>
        <Each of={parts()} key={(_, index) => index}>{(part, index) => <Part part={part()} index={index()} />}</Each>
        <If when={props.status === 'sending'}><Text testID={`desktop-assistant-sending-${props.message.id}`} class="text-muted-foreground" style={{ ...nativeChatTextStyle('micro'), position: 'absolute', right: 4, bottom: -20, opacity: .75 }}>{t('assistants.contact.sending')}</Text></If>
        {props.feedback}
        <If when={linkFailed()}><Text role="alert" class="text-muted-foreground" style={nativeChatTextStyle('micro')}>{t('common.unavailable')}</Text></If>
      </View>
    </View>}><View testID={`desktop-assistant-error-${props.message.id}`} class="items-center px-1" style={{ marginTop: props.timeSeparator ? 0 : props.spacing ?? 12 }}><Text role="alert" class="text-muted-foreground text-center" style={{ fontSize: 11, lineHeight: 16 }}>{props.message.error || props.message.text || t('assistants.contact.sendFailed')}</Text>{props.feedback}</View></If>
  </View>;
}

export function NativeDesktopAssistantEmpty(props: { bot: Row; current: () => boolean }) {
  return <View testID="desktop-assistant-empty" class="flex-1 min-w-0 items-center justify-center self-center" style={{ minHeight: 224, maxWidth: 384, paddingBottom: 64 }}>
    <View style={{ opacity: .9 }}><AssistantAvatar bot={props.bot} size={48} active={props.current()} /></View>
    <Text class="text-foreground text-center font-medium" style={{ ...nativeChatTextStyle('uiHeader'), marginTop: 20 }}>{t('assistants.conversation.emptyTitle', { name: text(props.bot.name) })}</Text>
    <Text class="text-muted-foreground text-center" style={{ ...nativeChatTextStyle('uiLabel'), lineHeight: 24, marginTop: 8, maxWidth: 320, opacity: .8 }}>{t('assistants.contact.empty')}</Text>
  </View>;
}

/** Caller mounts only for real busy/local preview authority, never history. */
export function NativeDesktopAssistantTyping(props: { bot: Row; current: () => boolean }) {
  return <View testID="desktop-assistant-typing" accessibilityLabel={t('assistants.contact.processing')} class="flex-row items-start" style={{ height: 40 }}>
    <View class="items-center shrink-0" style={{ width: 36, marginRight: 10, paddingTop: 2 }}><AssistantAvatar bot={props.bot} size={32} active={props.current()} /></View>
    <View class="bg-muted flex-row items-center" style={{ height: 36, borderRadius: 21.6, gap: 4, paddingHorizontal: 16 }}>
      <Each of={[-450, -220, 0]}>{delay => <View accessible={false} style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: alpha(token('muted-foreground'), .7), animationName: props.current() && lifecycle() === 'active' && !reduceMotion() ? 'pulse' : 'none', animationDuration: 1400, animationDelay: delay(), animationIterationCount: 'infinite' }} />}</Each>
    </View>
  </View>;
}

/** Message-scoped error affordance; retry still belongs to the original writer. */
export function NativeDesktopAssistantSendError(props: { messageID: string; error: string; active: boolean; retryDisabled: boolean; onRetry: () => void }) {
  const open = signal(false), anchor = signal<ViewRef | null>(null);
  effect(() => { if (!props.active) open.set(false); });
  return <View ref={value => anchor.set(value)} style={{ position: 'absolute', left: -42, top: 0 }}>
    <Button testID={`desktop-assistant-send-error-${props.messageID}`} class="size-9 rounded-md items-center justify-center active:bg-accent" disabled={!props.active}
      accessibilityLabel={t('assistants.contact.sendError.viewDetails')} onPress={() => { if (props.active) open.set(!open()); }}><Icon name="error-warning" size={18} color={token('destructive')} /></Button>
    <If when={open() && !!anchor()}><Overlay testID="desktop-assistant-send-error-popup" anchor={anchor()} placement="left" align="center" offset={6} margin={12}
      class="bg-card border border-border rounded-xl p-4 gap-2" style={{ width: 288 }} onPressOutside={() => open.set(false)} onCancel={() => open.set(false)}>
      <Text class="text-foreground font-medium" style={nativeChatTextStyle('uiLabel')}>{t('assistants.contact.sendError.title')}</Text>
      <Text role="alert" class="text-muted-foreground" style={nativeChatTextStyle('meta')}>{props.error || t('assistants.contact.sendFailed')}</Text>
      <Button testID="desktop-assistant-message-retry" class="self-end min-h-8 px-3 rounded-md bg-primary active:bg-primary/90 disabled:opacity-40" disabled={!props.active || props.retryDisabled}
        onPress={() => { if (!props.active || props.retryDisabled) return; open.set(false); props.onRetry(); }}><Text class="text-primary-foreground">{t('chat.history.retry')}</Text></Button>
    </Overlay></If>
  </View>;
}
