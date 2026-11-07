import type { TextStyle } from 'nsh';
import { getDefaultTheme, getThemeById } from '../ui/src/lib/theme/themes';

// FileMentionAutocomplete: mx-1.5, px-3, gap-2, size-5 icon well, size-3.5 glyph,
// py-1.5 and mobile min-h-11. iOS mobile.css fixes labels at 14px and micro at 13px.
export const referenceRowDensity = {
  marginHorizontal: 6, paddingHorizontal: 12, paddingVertical: 6,
  gap: 8, iconWell: 20, icon: 14, minHeight: 44,
  panelPadding: 4, panelBorder: 1, maxPanelHeight: 320,
  viewportRatio: 0.4, softMinHeight: 120,
} as const;
export const referenceTitleStyle = { fontSize: 14, lineHeight: 21, fontWeight: '600' } as const;
export const referenceDescriptionStyle = { fontSize: 13, lineHeight: 19.5, fontWeight: '400' } as const;

export type ReferenceQuerySpan = { text: string; matched: boolean };

/** Literal, case-insensitive, non-overlapping matches, matching autocompleteQueryHighlight.tsx. */
export function referenceQuerySpans(value: string, query: string): ReferenceQuerySpan[] {
  const needle = query.trim().toLowerCase(), normalized = value.toLowerCase();
  if (!needle || !normalized.includes(needle)) return [{ text: value, matched: false }];
  const spans: ReferenceQuerySpan[] = [];
  let cursor = 0, match = normalized.indexOf(needle);
  while (match !== -1) {
    if (match > cursor) spans.push({ text: value.slice(cursor, match), matched: false });
    spans.push({ text: value.slice(match, match + needle.length), matched: true });
    cursor = match + needle.length;
    match = normalized.indexOf(needle, cursor);
  }
  if (cursor < value.length) spans.push({ text: value.slice(cursor), matched: false });
  return spans;
}

/** Highlight is color only; title/description weight and paragraph metrics remain inherited. */
export function referenceQuerySpanStyle(matched: boolean, color: string): TextStyle | undefined {
  return matched ? { color } : undefined;
}

/** The canonical Web palette, not NSH's deliberately neutral primary button token. */
export function referenceHighlightColor(variables: Readonly<Record<string, string>> | undefined, themeID: string | undefined, dark: boolean): string {
  return variables?.['primary-base'] || (themeID ? getThemeById(themeID)?.colors.primary.base : undefined) || getDefaultTheme(dark).colors.primary.base;
}

export function referencePanelMetrics(rows: readonly { presentation: { subtitle?: string } }[], viewportHeight: number, availableHeight: number = referenceRowDensity.maxPanelHeight) {
  if (!rows.length) return { panelHeight: 0, listHeight: 0 };
  const viewport = Number.isFinite(viewportHeight) ? Math.max(0, viewportHeight) : 0;
  const available = Number.isFinite(availableHeight) ? Math.max(0, Math.min(referenceRowDensity.maxPanelHeight, availableHeight)) : 0;
  const viewportCap = Math.floor(viewport * referenceRowDensity.viewportRatio);
  // Same soft floor as computeMobileAutocompleteMaxHeight: never exceed the owner budget.
  const cap = available >= referenceRowDensity.softMinHeight ? Math.min(available, Math.max(referenceRowDensity.softMinHeight, viewportCap)) : Math.min(available, viewportCap);
  const chrome = 2 * (referenceRowDensity.panelPadding + referenceRowDensity.panelBorder);
  const content = rows.reduce((height, row) => height + Math.max(referenceRowDensity.minHeight,
    2 * referenceRowDensity.paddingVertical + referenceTitleStyle.lineHeight + (row.presentation.subtitle ? referenceDescriptionStyle.lineHeight : 0)), 0);
  const panelHeight = Math.min(cap, content + chrome);
  return { panelHeight, listHeight: Math.max(0, panelHeight - chrome) };
}
