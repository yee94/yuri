import { nativeComponent } from 'nsh';

export const NativeChatHeaderCollapse = nativeComponent<{ progress: number; duration: number; active: boolean }, Record<string, never>>(
  'yuri.chat.headerCollapse', { props: ['progress', 'duration', 'active'] },
);

/** Replaces the system glass under the transparent chat header with the page background fading down. */
export const NativeChatHeaderEdge = nativeComponent<{ color: string; fade?: boolean }, Record<string, never>>('yuri.chat.headerEdge', { props: ['color', 'fade'] });

/** The header buttons' presses, read natively: UIKit's bar platter cancels the touch before NSH's `onPress`. */
export const NativeChatHeaderPress = nativeComponent<Record<never, never>, { press: { id: string } }>('yuri.chat.headerPress', { props: [], events: ['press'] });
