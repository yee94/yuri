/**
 * Pure decisions for the native text motions that mirror Web's CSS/motion
 * animations (yuri-summary-flip-*, animate-text-shimmer, generate-effect).
 * The components in text-motion.tsx only run motions these functions allow.
 */

/** Web FlipUpText / yuri-summary-flip-in/out: 280ms ease-out. */
export const FLIP_DURATION = 280;
/** Web animate-text-shimmer: 1.7s linear infinite. */
export const SHIMMER_DURATION = 1700;
/** Web generate-effect: 140ms per character. */
export const CHARACTER_FADE_DURATION = 140;
/** Web generate-effect caps the stagger at 140ms for every later character. */
export const CHARACTER_FADE_MAX_DELAY = 140;
/** Per-character stagger, exactly Web's `min(index * 4.5, 140)` milliseconds. */
export function characterFadeDelay(index: number): number {
  return Math.min(Math.max(0, index) * 4.5, CHARACTER_FADE_MAX_DELAY);
}
/** When the last character of a `length`-character text has finished fading. */
export function characterFadeTotal(length: number): number {
  return (length > 0 ? characterFadeDelay(length - 1) : 0) + CHARACTER_FADE_DURATION;
}

/**
 * A long title or a long tail text never splits per character: it would add
 * one animated node per glyph to every transcript row.
 */
const CHARACTER_FADE_LIMIT = 24;

/**
 * Characters to fade in, or null to render the text as it is.
 *
 * Web mounts one `motion.span` per character, so only characters that are new
 * fade in. Native rows are recycled by the transcript list, so "new" is read as
 * "this text appeared where nothing was shown before": a row that binds another
 * tool keeps its previous text and does not replay the entrance. `text === previous`
 * is not a new appearance either.
 */
export function characterFadePlan(previous: string, next: string, limit = CHARACTER_FADE_LIMIT): string[] | null {
  if (!next || next === previous || previous.length > 0) return null;
  const characters = Array.from(next);
  return characters.length > Math.max(0, limit) ? null : characters;
}

/**
 * What FlipUpText does when its text changes: `hold` (nothing changed),
 * `replace` (no flip: inactive group or nothing to flip away from), `defer`
 * (a flip is already running, so only the newest text is kept and the running
 * flip finishes on it) and `flip` (start the old-out/new-in pair).
 */
type FlipPlan = 'hold' | 'replace' | 'flip' | 'defer';
export function flipPlan(previous: string, next: string, active: boolean, playing: boolean): FlipPlan {
  if (previous === next) return 'hold';
  if (!active || previous.length === 0) return 'replace';
  return playing ? 'defer' : 'flip';
}
