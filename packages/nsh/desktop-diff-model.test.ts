import { describe, expect, it } from 'vitest';
import { desktopDiffBody, desktopDiffCopy, desktopDiffFirstChangedLine, desktopDiffFocus, desktopDiffHasFullText, desktopDiffLayout, desktopDiffSelection } from './desktop-diff-model';

describe('desktop diff uses current Web preference precedence', () => {
  it('uses screen width 1100, new files inline, then explicit preference and per-file override', () => {
    const dynamic = { layoutPreference: 'dynamic', wrapLines: false } as const;
    expect(desktopDiffLayout(1099, dynamic)).toBe('unified'); expect(desktopDiffLayout(1100, dynamic)).toBe('split');
    expect(desktopDiffLayout(1500, dynamic, true)).toBe('unified'); expect(desktopDiffLayout(NaN, dynamic)).toBe('unified');
    expect(desktopDiffLayout(1500)).toBe('unified');
    expect(desktopDiffLayout(400, { layoutPreference: 'side-by-side', wrapLines: false }, true)).toBe('split');
    expect(desktopDiffLayout(1500, { layoutPreference: 'inline', wrapLines: true })).toBe('unified');
    expect(desktopDiffLayout(400, { layoutPreference: 'inline', fileLayout: 'side-by-side', wrapLines: false })).toBe('split');
  });
  it('does not lose complete text or mistake explicit empty text for missing body', () => {
    const diff = { path: 'C:\\repo\\file.ts', patch: '', before: 'BEFORE\r\n', after: 'AFTER\r\n' };
    expect(desktopDiffCopy(diff)).toBe('BEFORE\r\n\n\nAFTER\r\n');
    expect(desktopDiffBody(diff)).toEqual({ oldValue: 'BEFORE\r\n', newValue: 'AFTER\r\n' });
    expect(desktopDiffHasFullText({ path: '/file', before: '', after: '' })).toBe(true);
    expect(desktopDiffHasFullText({ path: '/file', patch: '@@ excerpt' })).toBe(false);
    expect(desktopDiffBody({ ...diff, patch: 'PATCH' })).toEqual({ patch: 'PATCH' });
    expect(desktopDiffBody({ ...diff, patch: 'PATCH' }, true)).toEqual({ oldValue: diff.before, newValue: diff.after });
  });
  it('never clips large historical source on display or copy', () => {
    const before = 'old\n'.repeat(60_000) + 'OLD_TAIL', after = 'new\n'.repeat(60_000) + 'NEW_TAIL';
    const diff = { path: '/history.txt', patch: '', before, after };
    expect(desktopDiffBody(diff).newValue).toBe(after); expect(desktopDiffBody(diff).oldValue).toBe(before);
    expect(desktopDiffCopy(diff)).toBe(before + '\n\n' + after);
  });
});

describe('NSH 0.4 documented selection is distinct from viewport positioning', () => {
  const patch = '@@ -100,3 +100,3 @@\n context\n-old\n+new\n tail\n';
  const hunks = [{ index: 0, oldStart: 100, oldLines: 1, newStart: 100, newLines: 1 }];
  it('preserves old/new selection through actual source coordinates when switching excerpts and full files', () => {
    const excerpt = { path: '/file', patch }, full = { path: '/file', before: 'prefix\n'.repeat(99) + 'context\nold\ntail', after: 'prefix\n'.repeat(99) + 'context\nnew\ntail' };
    expect(desktopDiffSelection({ side: 'new', start: 1, end: 2 }, excerpt, full)).toEqual({ side: 'new', start: 100, end: 101 });
    expect(desktopDiffSelection({ side: 'old', start: 100, end: 101 }, full, excerpt)).toEqual({ side: 'old', start: 1, end: 2 });
    expect(desktopDiffSelection({ side: 'new', start: 0, end: 0 }, full, excerpt)).toBeNull();
  });
  it('maps source line into reconstructed patch text for exact native selection, not scroll offsets', () => {
    expect(desktopDiffFocus({ path: '/file', patch }, hunks, 101)).toEqual({ requestedLine: 101, viewport: 'hunk-only', hunkIndex: 0, selection: { side: 'new', start: 1, end: 1 } });
    expect(desktopDiffFocus({ path: '/file', patch }, hunks, 1000)).toEqual({ requestedLine: 1000, viewport: 'hunk-only', hunkIndex: 0 });
  });
  it('reports the long-hunk gap instead of claiming an exact viewport line', () => {
    const diff = { path: '/file', before: 'old\n'.repeat(5000), after: 'new\n'.repeat(5000) };
    const result = desktopDiffFocus(diff, [{ index: 0, oldStart: 0, oldLines: 5000, newStart: 0, newLines: 5000 }], 4999);
    expect(result.selection).toEqual({ side: 'new', start: 4998, end: 4998 }); expect(result.viewport).toBe('hunk-only');
    expect(desktopDiffFocus(diff, [], 5002)).toEqual({ requestedLine: 5002, viewport: 'unavailable' });
  });
  it('opens editor at the true first change after context, matching Web deletion/addition semantics', () => {
    expect(desktopDiffFirstChangedLine({ path: '/file', patch })).toBe(101);
    expect(desktopDiffFirstChangedLine({ path: '/file', patch: '@@ -9,3 +9,2 @@\n context\n-deleted\n tail\n' })).toBe(10);
    expect(desktopDiffFirstChangedLine({ path: '/file', before: 'same\nbefore\n', after: 'same\nafter\n' })).toBe(2);
  });
});
