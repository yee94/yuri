import { platform, signal, View, type JSX } from 'nsh';
import type { ChatChromeState } from './chat-chrome';
import { nativeComposerSurface } from './composer-surface';
import { nativeDensity } from './appearance';

/** Keep the expanded footprint: chrome motion must not resize the inverted List. */
export function NativeComposerChrome(props: { state: ChatChromeState; bottom: number; children: JSX.Element; compact: JSX.Element; onHeight?: (height: number) => void }) {
  if (platform.desktop) return <View testID="chat-composer-desktop" class="w-full self-center" style={{ maxWidth: 800 }}
    onLayout={event => { if (event.bounds.size.height > 0) props.onHeight?.(event.bounds.size.height); }}>{props.children}</View>;
  const height = signal(120);
  const expanded = () => Math.min(1, props.state.swap.progress * 2);
  const compact = () => Math.max(0, props.state.swap.progress * 2 - 1);
  const duration = () => props.state.swap.phase === 'snapping' ? 240 : 0;
  return <View testID="chat-composer-chrome" style={{ position: 'absolute', left: 0, right: 0, bottom: 0, pointerEvents: 'box-none' }}>
    <View testID="chat-composer-expanded" accessibilityElementsHidden={props.state.swap.progress >= .5}
      onLayout={event => { if (event.bounds.size.height > 0) { height.set(event.bounds.size.height); props.onHeight?.(event.bounds.size.height); } }}
      style={{ opacity: 1 - expanded(), transform: [{ translateY: expanded() * height() * 1.1 }], pointerEvents: props.state.swap.progress >= .5 ? 'none' : 'box-none', transitionProperty: 'all', transitionDuration: duration() }}>
      {props.children}
    </View>
    <View testID="chat-composer-compact" accessibilityElementsHidden={props.state.swap.progress < 1}
      class="flex-row items-center gap-1 px-2" style={{ ...nativeComposerSurface, ...nativeDensity().chat.compact, position: 'absolute', left: '10%', width: '80%', height: 44, bottom: props.bottom, opacity: compact(), transform: [{ translateY: (1 - compact()) * 62 }], pointerEvents: props.state.swap.progress >= 1 ? 'auto' : 'none', transitionProperty: 'all', transitionDuration: duration() }}>
      {props.compact}
    </View>
  </View>;
}
