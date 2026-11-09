import { colorScheme, Image, signal, Text, token, View, windowSize, type Bounds, type JSX, type ListContentStyle, type ViewRef, type TextStyle } from 'nsh';
import { desktopChatGeometry, desktopChatReserveRight, desktopChatRowSpacing, type DesktopChatRowSpacing } from './desktop-chat-layout-core';
import { t } from './i18n';
import markBlack from './assets/brand/yuri-b-mark-black.svg';
import markWhite from './assets/brand/yuri-b-mark-white.svg';

export type DesktopChatColumnProps = { wide?: boolean; paddingScale?: number; reserveRight?: number };

/** Native layout events only; no measure command, effects or List ref owner. */
function reservedColumn(props: DesktopChatColumnProps) {
  const width = signal(0);
  return {
    onLayout: (event: { bounds: Bounds }) => {
      const next = event.bounds.size.width;
      if (Number.isFinite(next) && next > 0 && next !== width()) width.set(next);
    },
    right: () => desktopChatReserveRight(props.reserveRight, width(), desktopChatGeometry(windowSize().width, props.wide, props.paddingScale).columnInset * 2 + 1),
  };
}

/** Geometry only. This component never observes Chat, drafts, history or a transport. */
export function NativeDesktopChatColumn(props: DesktopChatColumnProps & { children?: JSX.Element; testID?: string }) {
  const geometry = () => desktopChatGeometry(windowSize().width, props.wide, props.paddingScale);
  return <View testID={props.testID} class="w-full self-center min-w-0" style={{ maxWidth: geometry().columnMax, paddingHorizontal: geometry().columnInset }}>{props.children}</View>;
}

export type NativeDesktopChatLayoutProps = {
  /** Existing warning / send-retry / speech-error controls; no new recovery owner. */
  feedback?: JSX.Element;
  /** The original inverted List OR its authoritative loading/empty/error branch. */
  transcript: JSX.Element;
  historyFeedback?: JSX.Element;
  blocking?: JSX.Element;
  composer: JSX.Element;
  overlays?: JSX.Element;
  /** Independent sibling in the transcript/composer relative body. */
  statusPanel?: JSX.Element;
  /** measure().pagePosition, not onLayout.bounds, supplies root coordinates. */
  bodyRef?: (view: ViewRef) => void;
  onBodyLayout?: () => void;
  /** Web omits the edge fade for the existing-session empty branch. */
  edgeFade?: boolean;
};

/** Desktop in-flow foot: not the iOS absolute/keyboard/safe-area composer. The
 * existing shell owns the 48pt titlebar; the supplied List owns all scrolling. */
export function NativeDesktopChatLayout(props: NativeDesktopChatLayoutProps) {
  let lastBounds: Bounds | undefined;
  function bodyLayout(event: { bounds: Bounds }) {
    const { origin, size } = event.bounds;
    if (lastBounds && origin.x === lastBounds.origin.x && origin.y === lastBounds.origin.y && size.width === lastBounds.size.width && size.height === lastBounds.size.height) return;
    lastBounds = { origin: { ...origin }, size: { ...size } };
    props.onBodyLayout?.();
  }
  return <View testID="desktop-chat-layout" class="flex-1 min-h-0 min-w-0 bg-background">
    {props.feedback}
    <View testID="desktop-chat-body" ref={view => props.bodyRef?.(view)} onLayout={bodyLayout} class="relative flex-1 min-h-0 min-w-0">
      <View testID="desktop-chat-viewport" class="flex-1 min-h-0 min-w-0">{props.transcript}</View>
      {props.historyFeedback}
      {props.blocking}
      <View testID="desktop-chat-foot" class="relative shrink-0 min-w-0 bg-background">
        <If when={props.edgeFade !== false}><View testID="desktop-chat-edge-fade" accessible={false} style={{ position: 'absolute', top: -44, left: 0, right: 0, height: 44, pointerEvents: 'none', backgroundImage: `linear-gradient(to top, ${token('background')}, transparent)` }} /></If>
        {props.composer}
      </View>
      {props.statusPanel}
    </View>
    {props.overlays}
  </View>;
}

/** Pass to the original desktop List, not an additional Scroll or virtualizer.
 * Row insets own horizontal padding, so narrow panels use their actual width. */
export const desktopChatListContentStyle: ListContentStyle = { paddingHorizontal: 0, paddingTop: 0, gap: 0 };

export function NativeDesktopChatRow(props: DesktopChatColumnProps & DesktopChatRowSpacing & { children?: JSX.Element }) {
  const reserve = reservedColumn(props);
  return <View testID="desktop-chat-row" class="w-full" onLayout={reserve.onLayout} style={{ ...desktopChatRowSpacing(props), paddingRight: reserve.right() }}>
    <NativeDesktopChatColumn wide={props.wide} paddingScale={props.paddingScale}>{props.children}</NativeDesktopChatColumn>
  </View>;
}

/** Apply after nativeChatTextStyle('composer') on the existing Input. NSH
 * AppKit removes NSTextView's default insets/line padding; these are the sole
 * text insets. Never add the former mobile card's px-3 around this Input. */
export const desktopChatEditorStyle: TextStyle = {
  minHeight: 52, maxHeight: 160, paddingHorizontal: 12, paddingTop: 16, paddingBottom: 8,
  backgroundColor: 'transparent', borderWidth: 0,
};

export type NativeDesktopChatComposerProps = DesktopChatColumnProps & {
  queue?: JSX.Element;
  goal?: JSX.Element;
  status?: JSX.Element;
  feedback?: JSX.Element;
  /** Existing attachment chips above the solid input surface, as on Web. */
  attachments?: JSX.Element;
  inputHeader?: JSX.Element;
  editor: JSX.Element;
  recovery?: JSX.Element;
  /** Attach / permission / Goal / dictation / shell-exit, using actual controls. */
  leadingActions?: JSX.Element;
  /** Actual Agent / model / variant / send-stop controls, in that order. */
  trailingActions?: JSX.Element;
  overlays?: JSX.Element;
  anchorRef?: (view: ViewRef) => void;
  onWidth?: (width: number) => void;
  focused?: boolean;
};

/** nsh token() resolves to #rrggbbaa. Retain its alpha rather than replacing it. */
function alpha(color: string, opacity: number) {
  const match = /^#([\da-f]{6})([\da-f]{2})?$/i.exec(color);
  if (!match) return color;
  return `#${match[1]}${Math.round((match[2] ? parseInt(match[2], 16) : 255) * opacity).toString(16).padStart(2, '0')}`;
}

/** Slots retain their mount owners during resize, focus, typing and modal
 * admission. Only local material hover changes; no business state is copied. */
export function NativeDesktopChatComposer(props: NativeDesktopChatComposerProps) {
  const hovered = signal(false), dark = () => colorScheme() === 'dark';
  const reserve = reservedColumn(props);
  return <View testID="desktop-chat-composer" class="w-full shrink-0" onLayout={reserve.onLayout} style={{ paddingBottom: 16, paddingRight: reserve.right() }}>
    <NativeDesktopChatColumn wide={props.wide} paddingScale={props.paddingScale} testID="desktop-chat-composer-column">
      {props.attachments}
      {props.feedback}
      {props.queue}
      {props.goal}
      {props.status}
      <View testID="composer-glass" ref={props.anchorRef} class="relative min-w-0 bg-background"
        onLayout={event => { if (event.bounds.size.width > 0) props.onWidth?.(event.bounds.size.width); }}
        onMouseEnter={() => hovered.set(true)} onMouseLeave={() => hovered.set(false)}
        style={{ borderRadius: 24, borderWidth: 1, borderColor: dark() ? 'transparent' : alpha(token('border'), .5),
          boxShadow: dark() ? 'none' : `0 2px 6px -3px ${alpha(token('foreground'), .04)}, inset 0 1px 0 ${alpha(token('background'), .8)}` }}>
        <If when={dark()}><View testID="desktop-chat-composer-fill" accessible={false} style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, borderRadius: 23, pointerEvents: 'none', backgroundColor: token('foreground'), opacity: hovered() || props.focused ? .11 : .08 }} /></If>
        <View class="relative min-w-0">
          {props.inputHeader}
          <View style={{ paddingTop: 4 }}>{props.editor}</View>
          {props.recovery}
          <View testID="desktop-chat-composer-actions" class="flex-row items-center min-w-0" style={{ paddingHorizontal: 10, paddingVertical: 6, gap: 6, minHeight: 36 }}>
            <View testID="desktop-chat-composer-leading" class="flex-row items-center shrink-0" style={{ gap: 6 }}>{props.leadingActions}</View>
            <View testID="desktop-chat-composer-trailing" class="flex-1 min-w-0 flex-row items-center justify-end" style={{ gap: 6 }}>{props.trailingActions}</View>
          </View>
        </View>
      </View>
      {props.overlays}
    </NativeDesktopChatColumn>
  </View>;
}

/** Existing-session empty state (not the new-draft welcome). No message avatar
 * or author label is introduced. Error details/retry remain the caller's slot. */
export function NativeDesktopChatEmptyState(props: { feedback?: JSX.Element }) {
  return <View testID="chat-empty" class="flex-1 min-h-0 min-w-0 items-center justify-center gap-6 px-4">
    <Image src={colorScheme() === 'dark' ? markWhite : markBlack} accessible={false} style={{ width: 140, height: 140, objectFit: 'contain', opacity: .2 }} />
    <If when={!!props.feedback} else={<Text class="text-muted-foreground text-center" style={{ fontSize: 14 }}>{t('chat.emptyState.startNewChat')}</Text>}>{props.feedback}</If>
  </View>;
}
