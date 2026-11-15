/**
 * Pure decisions for the native text motions that mirror Web's CSS/motion
 * animations (yuri-summary-flip-*, animate-text-shimmer, generate-effect).
 * The components in text-motion.tsx only run motions these functions allow.
 */

/** Web FlipUpText / yuri-summary-flip-in/out: 280ms ease-out. */
export const FLIP_DURATION = 280;
/** Web animate-text-shimmer: 1.7s linear infinite. */
export const SHIMMER_DURATION = 1700;
/** Web's 220% background, moving from 100% to -100%. */
export const SHIMMER_SOURCE = `
struct Uniforms { base: vec4f, highlight: vec4f }
fn shade(uv: vec2f) -> vec4f {
  let content = sample_content(uv);
  let position = (uv.x + 1.2 - 2.4 * nsh.progress) / 2.2;
  let glow = clamp(1.0 - abs(position - 0.5) / 0.12, 0.0, 1.0);
  let color = mix(uniforms.base, uniforms.highlight, glow);
  return vec4f(color.rgb, content.a * color.a);
}`;

/** Within each unit, integer places count from the right and fractions from the left. */
export function numberCells(text: string): Array<{ key: string; text: string; digit: boolean }> {
  const cells: Array<{ key: string; text: string; digit: boolean }> = [];
  const parts = [...text.matchAll(/([0-9]+)(?:([.,])([0-9]+))?([^0-9]*)/gu)];
  const prefix = text.slice(0, parts[0]?.index ?? text.length);
  if (prefix) cells.push({ key: 'prefix', text: prefix, digit: false });
  const seen = new Map<string, number>();
  for (const part of parts) {
    const unit = part[4].trim();
    const occurrence = seen.get(unit) ?? 0;
    seen.set(unit, occurrence + 1);
    const key = `${unit}:${occurrence}`;
    for (const [index, digit] of Array.from(part[1]).entries()) cells.push({ key: `${key}:integer:${part[1].length - index - 1}`, text: digit, digit: true });
    if (part[2]) cells.push({ key: `${key}:point`, text: part[2], digit: false });
    for (const [index, digit] of Array.from(part[3] ?? '').entries()) cells.push({ key: `${key}:fraction:${index}`, text: digit, digit: true });
    if (part[4]) cells.push({ key: `${key}:unit`, text: part[4], digit: false });
  }
  return cells;
}
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
 * (a flip is already running, so only the newest pending text is kept until
 * it finishes) and `flip` (start the old-out/new-in pair).
 */
type FlipPlan = 'hold' | 'replace' | 'flip' | 'defer';
export function flipPlan(previous: string, next: string, active: boolean, playing: boolean): FlipPlan {
  if (!active && playing) return 'replace';
  if (previous === next) return 'hold';
  if (!active || previous.length === 0) return 'replace';
  return playing ? 'defer' : 'flip';
}
