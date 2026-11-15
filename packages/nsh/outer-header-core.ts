/** Scroll distance (pt) over which a top-level page header goes from large to compact. */
export const OUTER_HEADER_RANGE = 44;
export const OUTER_HEADER_EXPANDED = 56;
const EXPANDED_HEIGHT = OUTER_HEADER_EXPANDED, COMPACT_HEIGHT = 44, COMPACT_TITLE = 0.74, COMPACT_ACTIONS = 0.8;
/** Web `--yuri-mobile-header-fade`: the page background at 85%, never opaque; hangs 1.75rem below the header. */
export const HEADER_FADE_LENGTH = 28;
const FADE_ALPHA = 'd9';

/** Web `linear-gradient(fade 0%, fade calc(safe-area-top + 35%), transparent 100%)` as an alpha mask over the page background. */
export function headerFadeMask(total: number, safeTop = 0) {
  const hold = total > 0 ? Math.min(100, Math.max(0, (safeTop + total * 0.35) / total * 100)) : 0;
  return `linear-gradient(to bottom, #000000${FADE_ALPHA} 0%, #000000${FADE_ALPHA} ${hold.toFixed(2)}%, #00000000 100%)`;
}

/** Same fade as explicit RGBA stops for backends without `maskImage` (Android draws gradients as `backgroundImage`). */
export function headerFadeGradient(color: string, total: number, safeTop = 0) {
  const rgb = color.slice(0, 7), hold = total > 0 ? Math.min(100, Math.max(0, (safeTop + total * 0.35) / total * 100)) : 0;
  return `linear-gradient(to bottom, ${rgb}${FADE_ALPHA} 0%, ${rgb}${FADE_ALPHA} ${hold.toFixed(2)}%, ${rgb}00 100%)`;
}

/** Web fades the outer header in only as its title collapses; at rest nothing covers the content. */
export const outerHeaderFadeOpacity = (progress: number) => Math.min(1, Math.max(0, Number.isFinite(progress) ? progress : 0));

const lerp = (from: number, to: number, progress: number) => from + (to - from) * progress;

/** Pure mapping from scroll offset to collapse progress in [0, 1]. */
export function outerHeaderProgress(offset: number) {
  return Math.min(1, Math.max(0, (Number.isFinite(offset) ? offset : 0) / OUTER_HEADER_RANGE));
}

/** Pure sizing contract shared by every top-level page header. */
export function outerHeaderMetrics(progress: number) {
  return {
    height: lerp(EXPANDED_HEIGHT, COMPACT_HEIGHT, progress),
    titleScale: lerp(1, COMPACT_TITLE, progress),
    actionsScale: lerp(1, COMPACT_ACTIONS, progress),
  };
}
