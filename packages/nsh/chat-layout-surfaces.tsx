import { keyboardFrame, platform, safeArea, View, type JSX } from 'nsh';
import { NativeComposerChrome } from './chat-chrome-surfaces';
import type { ChatChromeState } from './chat-chrome';
import { NativeDesktopChatComposer, NativeDesktopChatLayout, NativeDesktopChatRow, type DesktopChatColumnProps, type NativeDesktopChatComposerProps, type NativeDesktopChatLayoutProps } from './desktop-chat-layout';
import type { DesktopChatRowSpacing } from './desktop-chat-layout-core';
import { nativeComposerSurface } from './composer-surface';
import { NativeDesktopAssistantComposer } from './desktop-assistant-conversation';

export function NativeChatBodyLayout(props: NativeDesktopChatLayoutProps) {
  if (platform.desktop) return <NativeDesktopChatLayout {...props} />;
  return <>{props.feedback}{props.transcript}{props.historyFeedback}{props.blocking}{props.composer}{props.overlays}</>;
}

export function NativeChatRow(props: DesktopChatColumnProps & DesktopChatRowSpacing & { children?: JSX.Element }) {
  if (platform.desktop) return <NativeDesktopChatRow {...props} />;
  return <View class={props.role === 'user' ? 'pt-2' : 'gap-2'}>{props.children}</View>;
}

export function NativeChatComposerLayout(props: NativeDesktopChatComposerProps & { state: ChatChromeState; compact: JSX.Element; onHeight: (height: number) => void; contact?: { attach: JSX.Element; send: JSX.Element } }) {
  if (platform.desktop && props.contact) return <NativeDesktopAssistantComposer editor={props.editor} attach={props.contact.attach} send={props.contact.send}
    attachments={props.attachments} feedback={<>{props.feedback}{props.recovery}</>} overlays={props.overlays}
    anchorRef={props.anchorRef} onWidth={props.onWidth} onHeight={props.onHeight} focused={props.focused} />;
  if (platform.desktop) return <NativeDesktopChatComposer {...props} />;
  return <NativeComposerChrome state={props.state} bottom={safeArea().bottom + 16} onHeight={props.onHeight} compact={props.compact}>
    <View>
      <View accessibilityElementsHidden={props.state.dock >= 1} style={{ opacity: 1 - props.state.dock, pointerEvents: props.state.dock >= 1 ? 'none' : 'auto' }}>{props.queue}</View>
      <View class="px-3 pt-2" style={{ paddingBottom: keyboardFrame().height > 0 ? keyboardFrame().height : safeArea().bottom + 16, transitionProperty: 'all', transitionDuration: keyboardFrame().duration }}>
        <View accessibilityElementsHidden={props.state.dock >= 1} style={{ opacity: 1 - props.state.dock, pointerEvents: props.state.dock >= 1 ? 'none' : 'auto' }}>{props.goal}{props.status}</View>
        <View testID="composer-glass" ref={props.anchorRef} onLayout={event => props.onWidth?.(event.bounds.size.width)} style={nativeComposerSurface} class="px-3 pt-1 pb-1">
          {props.feedback}{props.attachments}{props.inputHeader}{props.editor}{props.recovery}
          <View class="min-h-10 flex-row gap-2 items-center">{props.leadingActions}<View class="flex-1" />{props.trailingActions}</View>
        </View>
        {props.overlays}
      </View>
    </View>
  </NativeComposerChrome>;
}
