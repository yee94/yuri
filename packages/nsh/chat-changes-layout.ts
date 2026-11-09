import type { DiffLayout } from 'nsh/base';
import type { ChangesSnapshot, ChangesSource, HistoricalChange } from './chat-changes-model';

export type NativeDiffLayoutPreference = 'dynamic' | 'inline' | 'side-by-side';

/** Validation only. Unknown/invalid settings are not a confirmed default. */
export function nativeDiffLayoutPreference(value: unknown): NativeDiffLayoutPreference | null {
  return value === 'dynamic' || value === 'inline' || value === 'side-by-side' ? value : null;
}

/** Web DiffView getLayoutForFile uses the viewport (not panel width), with a 1100pt threshold. */
export function nativeDiffLayout(preference: unknown, viewportWidth: number, isNew: boolean): DiffLayout {
  const value = nativeDiffLayoutPreference(preference);
  if (value === 'side-by-side') return 'split';
  if (value !== 'dynamic' || isNew || !Number.isFinite(viewportWidth) || viewportWidth < 1100) return 'unified';
  return 'split';
}

/** Selected file metadata only; historical layout never consults current Git. */
export function nativeDiffIsNew(source: ChangesSource, snapshot: ChangesSnapshot | null, path: string, diff: HistoricalChange | null) {
  if (source.kind === 'workspace') {
    const file = snapshot?.files.find(file => file.path === path);
    return !!file && (file.index === 'A' || file.working_dir === 'A' || file.index === '?' || file.working_dir === '?');
  }
  const file = source.files.find(file => file.path === path);
  const status = file?.status ?? diff?.status;
  if (status !== undefined) return status === 'added';
  // Same added-file marker as Web createToolPatchTurnDiffs. Empty old text alone is not status authority.
  return /^---\s+\/dev\/null(?:\s|$)/m.test(diff?.patch ?? file?.patch ?? '');
}
