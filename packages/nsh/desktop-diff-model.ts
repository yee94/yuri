import { nativeChangeLocation, patchLines, type HistoricalChange } from './chat-changes-model';
import { getFirstChangedModifiedLineFromPatch } from '../ui/src/components/views/diffPatchUtils';

export type DesktopDiffLayout = 'inline' | 'side-by-side';
/** Read-only projection of the existing Web preferences; never a second store. */
export type DesktopDiffPreferences = Readonly<{
  layoutPreference: 'dynamic' | DesktopDiffLayout;
  fileLayout?: DesktopDiffLayout;
  wrapLines: boolean;
}>;
export function desktopDiffLayout(width: number, preferences?: DesktopDiffPreferences, isNew = false): 'unified' | 'split' {
  const layout = preferences?.fileLayout ?? preferences?.layoutPreference ?? 'inline';
  if (layout !== 'dynamic') return layout === 'side-by-side' ? 'split' : 'unified';
  return !isNew && Number.isFinite(width) && width >= 1100 ? 'split' : 'unified';
}

export function desktopDiffHasFullText(diff: HistoricalChange): boolean {
  return typeof diff.before === 'string' && typeof diff.after === 'string';
}

/** Empty patches must not hide real retained before/after (including empty files). */
export function desktopDiffBody(diff: HistoricalChange, full = false) {
  if (diff.patch && !(full && desktopDiffHasFullText(diff))) return { patch: diff.patch };
  return { oldValue: diff.before ?? '', newValue: diff.after ?? '' };
}
export function desktopDiffCopy(diff: HistoricalChange): string {
  return diff.patch || [diff.before ?? '', diff.after ?? ''].join('\n\n');
}

type Hunk = { index: number; oldStart: number; oldLines: number; newStart: number; newLines: number };
type DesktopDiffSelection = { side: 'old' | 'new'; start: number; end: number };
/** Map public native selection through source lines, never through row heights. */
export function desktopDiffSelection(range: DesktopDiffSelection | null, from: HistoricalChange, to: HistoricalChange): DesktopDiffSelection | null {
  if (!range) return null;
  const sideLines = (diff: HistoricalChange) => diff.patch ? patchLines(diff.patch).flatMap(line => {
    const number = range.side === 'new' ? line.newLine : line.oldLine;
    return number === null ? [] : [number];
  }) : undefined;
  const before = sideLines(from), after = sideLines(to);
  const source = (index: number) => before ? before[index] : index + 1;
  const target = (line: number | undefined) => line === undefined ? -1 : after ? after.indexOf(line) : line - 1;
  const start = target(source(range.start)), end = target(source(range.end));
  const text = (range.side === 'new' ? to.after : to.before) ?? '';
  if (start < 0 || end < 0 || !after && Math.max(start, end) >= text.split('\n').length) return null;
  return { side: range.side, start, end };
}
export type DesktopDiffFocus = Readonly<{
  requestedLine?: number;
  /** NSH 0.4 has no public scroll-to-line API. Selection is exact, viewport is not. */
  viewport: 'hunk-only' | 'unavailable';
  hunkIndex?: number;
  selection?: { side: 'new'; start: number; end: number };
}>;
export function desktopDiffFocus(diff: HistoricalChange, hunks: readonly Hunk[], targetLine?: number, full = false): DesktopDiffFocus {
  const location = nativeChangeLocation(hunks, targetLine);
  const valid = targetLine !== undefined && Number.isSafeInteger(targetLine) && targetLine > 0;
  let selected = -1;
  if (valid) {
    const body = desktopDiffBody(diff, full);
    if (body.patch) selected = patchLines(body.patch).filter(line => line.newLine !== null).findIndex(line => line.newLine === targetLine);
    else if (targetLine <= (body.newValue ?? '').split('\n').length) selected = targetLine - 1;
  }
  return { ...(valid ? { requestedLine: targetLine } : {}), viewport: location ? 'hunk-only' : 'unavailable',
    ...(location ? { hunkIndex: location.index } : {}), ...(selected >= 0 ? { selection: { side: 'new', start: selected, end: selected } } : {}) };
}

/** Open-in-editor is a source line, not a hunk boundary or a guessed scroll offset. */
export function desktopDiffFirstChangedLine(diff: HistoricalChange): number {
  if (diff.patch) {
    const line = getFirstChangedModifiedLineFromPatch(diff.patch);
    if (line !== null) return line;
  }
  const before = (diff.before ?? '').split('\n'), after = (diff.after ?? '').split('\n');
  let index = 0;
  while (index < before.length && index < after.length && before[index] === after[index]) index++;
  return Math.min(index + 1, Math.max(1, after.length));
}
