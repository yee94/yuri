import { platform, Scroll, View, windowSize, type JSX } from 'nsh';
import { NativeDesktopChatColumn } from './desktop-chat-layout';

export function NativeNewSessionLayout(props: { children?: JSX.Element }) {
  // Web `.chat-input-column` uses the window breakpoint, then its own inline padding.
  // The measured shell is that column minus both insets: 752pt at this viewport.
  return platform?.desktop
    ? <Scroll testID="desktop-new-session-layout" class="flex-1" contentClass="grow items-center justify-center" contentStyle={{ paddingBottom: windowSize().height * .06 }}><NativeDesktopChatColumn testID="desktop-new-session-column">{props.children}</NativeDesktopChatColumn></Scroll>
    : <View class="flex-1">{props.children}</View>;
}
