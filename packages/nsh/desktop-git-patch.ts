/** Import-free native snapshot of ui/src/lib/diff/patchFileDiff.ts's two pure
 * hunk helpers. That file imports @pierre/diffs (not a native runtime module).
 * The focused parity test checks these exports byte-for-byte against Web. */
export const splitPatchIntoHunks = (patch: string): string[] => {
  if (!patch) return [];

  const lines = patch.split(/\r?\n/);
  const hunkHeaderRegex = /^@@\s/;
  const headerLines: string[] = [];
  let firstHunk = 0;
  while (firstHunk < lines.length && !hunkHeaderRegex.test(lines[firstHunk] ?? '')) {
    headerLines.push(lines[firstHunk]);
    firstHunk += 1;
  }

  if (firstHunk >= lines.length) {
    return [];
  }

  const hunks: string[][] = [];
  for (let index = firstHunk; index < lines.length; index += 1) {
    const line = lines[index];
    if (hunkHeaderRegex.test(line ?? '')) {
      hunks.push([...headerLines, line]);
    } else if (hunks.length > 0) {
      hunks[hunks.length - 1].push(line ?? '');
    }
  }

  return hunks.map((hunkLines) => hunkLines.join('\n'))
    .filter((hunk) => hunk.trim().length > 0)
    .map((hunk) => (hunk.endsWith('\n') ? hunk : `${hunk}\n`));
};

/**
 * Extract a standalone patch for a single hunk by zero-based index.
 *
 * Returns `null` when the index is out of range or the patch has no hunks.
 */
export const extractHunkPatch = (patch: string, hunkIndex: number): string | null => {
  if (!Number.isInteger(hunkIndex) || hunkIndex < 0) return null;
  const hunks = splitPatchIntoHunks(patch);
  return hunks[hunkIndex] ?? null;
};
