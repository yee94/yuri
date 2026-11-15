import { referenceKinds, type NativeReference, type ReferenceKind } from './composer-references';
import { getDefaultTheme } from '../ui/src/lib/theme/themes';
import type { Theme } from '../ui/src/types/theme';

/** The Web composer's inline reference icons, drawn inside the trigger run. */
export type InlineChipIcon = 'file' | 'folder' | 'ai-agent' | 'book-open' | 'chat-thread';
export type InlineChipColors = { primary: string; skill: string };
export type NativeInlineChip = {
  /** UTF-16 offset of the reference trigger (`@`). The native bridge replaces it with the icon. */
  start: number;
  /** UTF-16 end of the reference display. The label starts at `start + 1`. */
  end: number;
  kind: ReferenceKind;
  icon: InlineChipIcon;
  /** Opaque `#rrggbb`; the bridge never parses theme rules itself. */
  color: string;
};
export type NativeInlineChipConfig = {
  ownerID: string;
  inputID: string;
  textLength: number;
  chips: NativeInlineChip[];
};

const HEX = /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i;
const RGB = /^rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})(?:\s*[,/]\s*[\d.]+%?)?\s*\)$/i;

const channel = (value: number) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0');

/** The native bridges take platform-neutral `#rrggbb`; CSS-only color functions fall back. */
export function inlineChipColor(value: unknown, fallback: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (HEX.test(text)) {
    const digits = text.slice(1);
    if (digits.length === 3 || digits.length === 4) return `#${digits.slice(0, 3).split('').map(char => char + char).join('')}`.toLowerCase();
    return `#${digits.slice(0, 6)}`.toLowerCase();
  }
  const match = RGB.exec(text);
  return match ? `#${channel(Number(match[1]))}${channel(Number(match[2]))}${channel(Number(match[3]))}` : inlineChipColor(fallback, '#000000');
}

function lighten(color: string, percent: number): string {
  const base = inlineChipColor(color, '#000000').slice(1);
  const step = Math.round(2.55 * percent);
  return `#${[0, 2, 4].map(index => channel(parseInt(base.slice(index, index + 2), 16) + step)).join('')}`;
}

type ThemeShape = { metadata?: { variant?: string }; colors?: { chat?: { composerSkill?: string }; status?: { warning?: string } } };

/** Web `cssGenerator`'s Composer Skill color: the theme's value, else its warning (lit in dark). */
export function composerSkillColor(theme: ThemeShape | undefined, dark: boolean, fallback: string): string {
  const configured = theme?.colors?.chat?.composerSkill;
  if (typeof configured === 'string' && configured.trim()) return inlineChipColor(configured, fallback);
  const warning = theme?.colors?.status?.warning;
  return warning ? inlineChipColor(dark ? lighten(warning, 25) : warning, fallback) : inlineChipColor(fallback, '#000000');
}

/** Reference highlights use the Web palette; NSH primary is the neutral action-button color. */
export function referenceChipColors(theme: Theme | undefined, dark: boolean): InlineChipColors {
  const palette = theme ?? getDefaultTheme(dark);
  const primary = palette.colors.primary.base;
  return { primary, skill: composerSkillColor(palette, dark, primary) };
}

export function inlineChipIcon(kind: ReferenceKind): InlineChipIcon {
  switch (kind) {
    case 'skill': return 'book-open';
    case 'session': return 'chat-thread';
    case 'agent': return 'ai-agent';
    case 'directory': return 'folder';
    default: return 'file';
  }
}

/**
 * Projects durable sidecars into the only thing the native Input bridge needs:
 * the trigger and display ranges already stored in the logical draft. It never
 * changes text, selection, or reference ranges, so no visual placeholder can
 * leak into sends, drafts, or the reference keyboard.
 */
export function buildInlineChips(input: {
  references: readonly NativeReference[];
  textLength: number;
  colors: InlineChipColors;
}): NativeInlineChip[] {
  const length = input.textLength;
  if (!Number.isInteger(length) || length < 0) return [];
  const primary = inlineChipColor(input.colors.primary, '#000000');
  const skill = inlineChipColor(input.colors.skill, primary);
  const chips: NativeInlineChip[] = [];
  for (const reference of [...input.references].sort((left, right) => left.start - right.start)) {
    if (chips.length === 64) break;
    if (!referenceKinds.includes(reference.kind)
      || !Number.isInteger(reference.start) || !Number.isInteger(reference.end)
      || reference.start < 0 || reference.end <= reference.start || reference.end > length
      || reference.display.length !== reference.end - reference.start
      || !reference.display.startsWith('@')
      || (chips.length && reference.start < chips[chips.length - 1]!.end)) continue;
    chips.push({
      start: reference.start,
      end: reference.end,
      kind: reference.kind,
      icon: inlineChipIcon(reference.kind),
      color: reference.kind === 'skill' ? skill : primary,
    });
  }
  return chips;
}

export function buildInlineChipConfig(input: {
  ownerID: string;
  inputID: string;
  textLength: number;
  references: readonly NativeReference[];
  colors: InlineChipColors;
}): NativeInlineChipConfig {
  return {
    ownerID: input.ownerID,
    inputID: input.inputID,
    textLength: Number.isInteger(input.textLength) ? input.textLength : 0,
    chips: buildInlineChips(input),
  };
}
