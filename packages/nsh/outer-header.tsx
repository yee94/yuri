import { platform, signal, Text, token, View, type JSX, type ScrollEvent, type ViewStyle } from 'nsh';

import { HEADER_FADE_LENGTH, headerFadeGradient, headerFadeMask, OUTER_HEADER_EXPANDED, outerHeaderFadeOpacity, outerHeaderMetrics, outerHeaderProgress } from './outer-header-core';

/** One writer per page; feed `onScroll` from the page's scroll container. */
export function createOuterHeaderCollapse() {
  const progress = signal(0);
  return {
    progress,
    onScroll(event: ScrollEvent) {
      const next = outerHeaderProgress(event.offset.y);
      // Skip sub-pixel churn, but always land exactly on the ends.
      if (next === progress() || (next !== 0 && next !== 1 && Math.abs(next - progress()) < 0.01)) return;
      progress.set(next);
    },
  };
}

export type OuterHeaderCollapse = ReturnType<typeof createOuterHeaderCollapse>;

/** Page-background fade: `maskImage` on iOS/web; Android ignores it, so the same stops are painted as a gradient. */
export function headerFadeStyle(total: number, safeTop = 0): ViewStyle {
  const color = String(token('background'));
  return platform.os === 'android' ? { backgroundImage: headerFadeGradient(color, total, safeTop) } : { backgroundColor: color, maskImage: headerFadeMask(total, safeTop) };
}

/**
 * Fixed (non-scrolling) page header with no background or border. Render it as a sibling above the page's
 * scroll container, never inside it. The title and the action cluster shrink as the page scrolls.
 * By default it floats over the scroll container (which takes `outerHeaderOverlap` and pads its content by
 * `OUTER_HEADER_EXPANDED`): content scrolls under it through Web's translucent fade. `overlay={false}` keeps
 * it in flow, with no fade, for pages with fixed controls below it.
 */
export function OuterHeader(props: { title: string; collapse: OuterHeaderCollapse; paddingHorizontal?: number; titleSize?: number; maxWidth?: number; overlay?: boolean; children?: JSX.Element }) {
  const metrics = () => outerHeaderMetrics(props.collapse.progress());
  const overlay = () => props.overlay !== false;
  return <View testID="outer-header" style={overlay() ? { height: OUTER_HEADER_EXPANDED, zIndex: 2, pointerEvents: 'box-none' } : undefined}>
    <If when={overlay()}><View testID="outer-header-fade" accessible={false} accessibilityElementsHidden style={{
      position: 'absolute', top: 0, left: 0, right: 0, height: metrics().height + HEADER_FADE_LENGTH, pointerEvents: 'none',
      opacity: outerHeaderFadeOpacity(props.collapse.progress()),
      ...headerFadeStyle(metrics().height + HEADER_FADE_LENGTH),
    }} /></If>
    <View class="flex-row items-center" style={{ height: metrics().height, width: '100%', alignSelf: 'center', paddingHorizontal: props.paddingHorizontal ?? 20, gap: 8, ...(props.maxWidth ? { maxWidth: props.maxWidth } : {}) }}>
      <View class="flex-1" style={{ transform: [{ scale: metrics().titleScale }], transformOrigin: 'left center' }}>
        <Text role="header" class="font-bold text-foreground" style={{ numberOfLines: 1, fontSize: props.titleSize ?? 30 }}>{props.title}</Text>
      </View>
      <View class="flex-row items-center" style={{ gap: 8, transform: [{ scale: metrics().actionsScale }], transformOrigin: 'right center' }}>{props.children}</View>
    </View>
  </View>;
}

/** Scroll containers under an overlaying OuterHeader: start at the page top, keep first content below the header. */
export const outerHeaderOverlap = { marginTop: -OUTER_HEADER_EXPANDED };
