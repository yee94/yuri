import { expect, test } from 'vitest';
import { highlightAutocompleteQuery } from '../ui/src/components/chat/autocompleteQueryHighlight';
import { computeMobileAutocompleteMaxHeight } from '../ui/src/components/chat/useMobileAutocompleteMaxHeight';
import { getDefaultTheme, getThemeById } from '../ui/src/lib/theme/themes';
import { record, text } from './model';
import { referenceDescriptionStyle, referenceHighlightColor, referencePanelMetrics, referenceQuerySpans, referenceQuerySpanStyle, referenceRowDensity, referenceTitleStyle } from './composer-references-presentation';

function webSpans(value: string, query: string) {
  const result = highlightAutocompleteQuery(value, query);
  return (Array.isArray(result) ? result : [result]).map(node => {
    if (typeof node === 'string') return { text: node, matched: false };
    expect(record(node).type).toBe('mark');
    return { text: text(record(record(node).props).children), matched: true };
  });
}

test('case-insensitive title and description fragments match the real Web highlight helper exactly', () => {
  for (const [value, query] of [
    ['packages/ui/src/lib/native-video.ts', 'NaTiVe'],
    ['Use NATIVE APIs with native views; Native only', ' native '],
    ['@desktop-shell', 'native'],
    ['[Native] native', '[native]'],
    ['aaaa', 'aa'],
    ['原生 Native 输入', 'NATIVE'],
    ['native😀native', '😀'],
    ['Native native', ''],
    ['Native native', '   '],
  ]) {
    const spans = referenceQuerySpans(value, query);
    expect(spans).toEqual(webSpans(value, query));
    expect(spans.map(span => span.text).join('')).toBe(value);
  }
  expect(referenceQuerySpans('Use NATIVE APIs with native views', 'NaTiVe')).toEqual([
    { text: 'Use ', matched: false }, { text: 'NATIVE', matched: true },
    { text: ' APIs with ', matched: false }, { text: 'native', matched: true }, { text: ' views', matched: false },
  ]);
});

test('only matched spans receive semantic color; neither weight nor a row/background fill is introduced', () => {
  const color = getThemeById('cursor-dark')!.colors.primary.base;
  expect(referenceQuerySpanStyle(false, color)).toBeUndefined();
  expect(referenceQuerySpanStyle(true, color)).toEqual({ color });
  expect(Object.keys(referenceQuerySpanStyle(true, color)!)).toEqual(['color']);
  expect(referenceTitleStyle).toEqual({ fontSize: 14, lineHeight: 21, fontWeight: '600' });
  expect(referenceDescriptionStyle).toEqual({ fontSize: 13, lineHeight: 19.5, fontWeight: '400' });
});

test('highlight follows the canonical Web theme accent, never the neutral native action primary', () => {
  const theme = getThemeById('cursor-dark')!;
  expect(referenceHighlightColor({ primary: theme.colors.surface.foreground }, theme.metadata.id, true)).toBe(theme.colors.primary.base);
  expect(referenceHighlightColor({ primary: 'neutral-action', 'primary-base': 'custom-semantic-accent' }, theme.metadata.id, true)).toBe('custom-semantic-accent');
  expect(referenceHighlightColor(undefined, undefined, false)).toBe(getDefaultTheme(false).colors.primary.base);
});

test('row inset and icon well match Web mx-1.5 / px-3 / gap-2 / size-5 geometry', () => {
  expect(referenceRowDensity).toMatchObject({ marginHorizontal: 6, paddingHorizontal: 12, paddingVertical: 6, gap: 8, iconWell: 20, icon: 14, minHeight: 44 });
  const labelInset = referenceRowDensity.panelBorder + referenceRowDensity.marginHorizontal + referenceRowDensity.paddingHorizontal + referenceRowDensity.iconWell + referenceRowDensity.gap;
  expect(labelInset).toBe(47);
});

test('402x778 viewport has the Web 311pt cap, partial seventh row, and only the native list scroll budget', () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ presentation: { subtitle: i === 0 ? 'Skill description' : undefined } }));
  const metrics = referencePanelMetrics(rows, 778);
  expect(metrics).toEqual({ panelHeight: 311, listHeight: 301 });
  const firstRow = 2 * referenceRowDensity.paddingVertical + referenceTitleStyle.lineHeight + referenceDescriptionStyle.lineHeight;
  expect(firstRow + 5 * referenceRowDensity.minHeight).toBeLessThan(metrics.listHeight);
  expect(firstRow + 6 * referenceRowDensity.minHeight).toBeGreaterThan(metrics.listHeight);
  expect(referencePanelMetrics(rows, 1200).panelHeight).toBe(320);
});

test('height honors the same Web soft floor and a smaller owner/keyboard budget, never a fixed six-row count', () => {
  const rows = Array.from({ length: 20 }, () => ({ presentation: {} }));
  for (const [viewportHeight, availableHeight] of [[778, 320], [200, 320], [500, 90], [500, 40]]) {
    const expected = computeMobileAutocompleteMaxHeight({ popupBottom: availableHeight + 8, boundaryTop: 0, viewportHeight });
    expect(referencePanelMetrics(rows, viewportHeight, availableHeight).panelHeight).toBe(expected);
  }
  expect(referencePanelMetrics(rows.slice(0, 1), 778)).toEqual({ panelHeight: 54, listHeight: 44 });
  expect(referencePanelMetrics([], 778)).toEqual({ panelHeight: 0, listHeight: 0 });
});
