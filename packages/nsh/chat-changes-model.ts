export type ChangesSnapshot = {
  isClean: boolean;
  current?: string;
  tracking?: string | null;
  ahead?: number;
  behind?: number;
  files: Array<{ path: string; index: string; working_dir: string }>;
  diffStats?: Record<string, { insertions: number; deletions: number }>;
};
export type HistoricalChange = { path: string; patch?: string; before?: string; after?: string; isBinary?: boolean };
export type ChangesSource =
  | { kind: 'workspace'; directory: string; path?: string; staged?: boolean; targetLine?: number }
  | { kind: 'turn'; directory: string; sessionID: string; messageID: string; files: HistoricalChange[]; path?: string; targetLine?: number; revision?: string | number; loadFile?: (path: string) => Promise<HistoricalChange> };
export type ChangesRead = (path: string) => Promise<unknown>;
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};

async function historicalFile(source: Extract<ChangesSource, { kind: 'turn' }>, path: string, read: ChangesRead, current: () => boolean): Promise<HistoricalChange> {
  const query = `directory=${encodeURIComponent(source.directory)}&messageID=${encodeURIComponent(source.messageID)}`;
  let body: Record<string, unknown> = {};
  try { body = object(await read(`/api/yuri/sessions/${encodeURIComponent(source.sessionID)}/changes?${query}&file=${encodeURIComponent(path)}`)); }
  catch (cause) { if (![404, 405, 501].includes(Number(object(cause).status))) throw cause; }
  let diff = object(body.diff);
  if (!current()) throw new Error('Historical read superseded');
  // Same narrow legacy Host fallback as sessionTurnChangesQueries, never Git.
  if (!body.diff || typeof body.diff !== 'object') {
    const legacy = object(await read(`/api/session/${encodeURIComponent(source.sessionID)}/diff?${query}`));
    diff = object(Array.isArray(legacy.data) ? legacy.data.find(value => object(value).file === path) : undefined);
  }
  if (diff.file !== path) throw new Error('Historical diff body unavailable');
  return { path, ...(typeof diff.patch === 'string' ? { patch: diff.patch } : {}), ...(typeof diff.before === 'string' ? { before: diff.before } : {}), ...(typeof diff.after === 'string' ? { after: diff.after } : {}), ...(typeof diff.isBinary === 'boolean' ? { isBinary: diff.isBinary } : {}) };
}

export function changesSnapshot(value: unknown): ChangesSnapshot {
  const body = object(value);
  if (typeof body.isClean !== 'boolean' || !Array.isArray(body.files)) throw new Error('Invalid Git status');
  const files = body.files.map(value => {
    const file = object(value);
    if (typeof file.path !== 'string' || typeof file.index !== 'string' || typeof file.working_dir !== 'string') throw new Error('Invalid Git file');
    return { path: file.path, index: file.index, working_dir: file.working_dir };
  });
  let diffStats: ChangesSnapshot['diffStats'];
  if (body.diffStats !== undefined) {
    diffStats = {};
    for (const [path, value] of Object.entries(object(body.diffStats))) {
      const stats = object(value);
      if (typeof stats.insertions !== 'number' || typeof stats.deletions !== 'number' || !Number.isFinite(stats.insertions) || !Number.isFinite(stats.deletions)) throw new Error('Invalid Git statistics');
      diffStats[path] = { insertions: stats.insertions, deletions: stats.deletions };
    }
  }
  return { isClean: body.isClean, files, diffStats, ...(typeof body.current === 'string' ? { current: body.current } : {}), ...(typeof body.tracking === 'string' || body.tracking === null ? { tracking: body.tracking } : {}), ...(typeof body.ahead === 'number' ? { ahead: body.ahead } : {}), ...(typeof body.behind === 'number' ? { behind: body.behind } : {}) };
}

export function changeGroups(snapshot: ChangesSnapshot | null) {
  if (!snapshot || snapshot.isClean) return [];
  const unique = new Map(snapshot.files.map(file => [file.path, file]));
  const files = [...unique.values()].sort((a, b) => a.path.localeCompare(b.path));
  return [true, false].map(staged => ({ staged, files: files.filter(file => {
    const index = file.index.trim(), working = file.working_dir.trim();
    return staged ? !!index && index !== '?' && index !== '!' : !!working && working !== '!' || index === '?';
  }) })).filter(group => group.files.length > 0);
}

export type PatchLine = { text: string; kind: 'meta' | 'context' | 'added' | 'removed'; oldLine: number | null; newLine: number | null };
export function patchLines(patch: string): PatchLine[] {
  let oldLine = 0, newLine = 0, hunk = false;
  return patch.split('\n').map(text => {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (header) { oldLine = Number(header[1]); newLine = Number(header[2]); hunk = true; }
    else if (text.startsWith('diff --git ')) hunk = false;
    if (!hunk || header || !/^[ +\-]/.test(text)) return { text, kind: 'meta', oldLine: null, newLine: null };
    if (text.startsWith('+')) return { text, kind: 'added', oldLine: null, newLine: newLine++ };
    if (text.startsWith('-')) return { text, kind: 'removed', oldLine: oldLine++, newLine: null };
    return { text, kind: 'context', oldLine: oldLine++, newLine: newLine++ };
  });
}

type ChangesState = { snapshot: ChangesSnapshot | null; loading: boolean; error: string; path: string; staged: boolean; diff: HistoricalChange | null; diffLoading: boolean; diffError: string };
/** A page-owned reader, not a second cache: close/Host/selection fences all awaits. */
export function createChangesReader(source: ChangesSource, read: ChangesRead, current: () => boolean = () => true, notify: () => void = () => {}) {
  let state: ChangesState = { snapshot: null, loading: false, error: '', path: '', staged: false, diff: null, diffLoading: false, diffError: '' };
  let statusSerial = 0, diffSerial = 0;
  const update = (next: Partial<ChangesState>) => { state = { ...state, ...next }; notify(); };
  const failure = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
  async function refresh() {
    if (!current() || source.kind === 'turn') return;
    const serial = ++statusSerial;
    update({ loading: true });
    try {
      const snapshot = changesSnapshot(await read(`/api/git/status?directory=${encodeURIComponent(source.directory)}`));
      if (current() && serial === statusSerial) update({ snapshot, error: '' });
    } catch (cause) { if (current() && serial === statusSerial) update({ error: failure(cause) }); }
    finally { if (current() && serial === statusSerial) update({ loading: false }); }
  }
  async function select(path: string, staged = false) {
    if (!current()) return;
    const serial = ++diffSerial;
    const same = state.path === path && state.staged === staged;
    update({ path, staged, diff: same ? state.diff : null, diffLoading: true, diffError: '' });
    try {
      let diff: HistoricalChange;
      if (source.kind === 'workspace') {
        const body = object(await read(`/api/git/diff?directory=${encodeURIComponent(source.directory)}&path=${encodeURIComponent(path)}&staged=${staged}`));
        if (typeof body.diff !== 'string') throw new Error('Invalid Git diff');
        diff = { path, patch: body.diff, isBinary: /^(Binary files .+ differ|GIT binary patch)/m.test(body.diff) };
      } else {
        const file = source.files.find(file => file.path === path);
        if (!file) throw new Error('Historical file unavailable');
        const hasBody = (file: HistoricalChange) => typeof file.patch === 'string' || typeof file.before === 'string' || typeof file.after === 'string' || file.isBinary === true;
        diff = hasBody(file) ? file : source.loadFile ? await source.loadFile(path) : await historicalFile(source, path, read, () => current() && serial === diffSerial);
        if (diff.path !== path || !hasBody(diff)) throw new Error('Historical diff body unavailable');
      }
      if (current() && serial === diffSerial) update({ diff, diffError: '' });
    } catch (cause) { if (current() && serial === diffSerial) update({ diffError: failure(cause) }); }
    finally { if (current() && serial === diffSerial) update({ diffLoading: false }); }
  }
  return { source, current, state: () => state, refresh, select, retryDiff: () => select(state.path, state.staged),
    back() { diffSerial++; update({ path: '', diff: null, diffLoading: false, diffError: '' }); },
    cancel() { statusSerial++; diffSerial++; update({ loading: false, diffLoading: false }); },
  };
}
export type ChangesReader = ReturnType<typeof createChangesReader>;

/** NSH 0.4 patch refs index reconstructed side texts, while gutters retain source numbers. */
export function nativeSourceHunks<T extends { oldStart: number; newStart: number }>(hunks: readonly T[], patch?: string): T[] {
  if (!patch) return [...hunks];
  const lines = patchLines(patch), old = lines.flatMap(line => line.oldLine === null ? [] : [line.oldLine]), next = lines.flatMap(line => line.newLine === null ? [] : [line.newLine]);
  return hunks.map(hunk => ({ ...hunk, oldStart: old[hunk.oldStart] === undefined ? hunk.oldStart : old[hunk.oldStart] - 1, newStart: next[hunk.newStart] === undefined ? hunk.newStart : next[hunk.newStart] - 1 }));
}

/** NSH uses zero-based side lines; previews use one-based source lines. */
export function nativeChangeLocation(hunks: ReadonlyArray<{ index: number; oldStart: number; oldLines: number; newStart: number; newLines: number }>, targetLine?: number) {
  if (!hunks.length) return undefined;
  const line = targetLine === undefined ? undefined : Math.max(0, Math.trunc(targetLine) - 1);
  const hunk = line === undefined ? hunks[0] : hunks.find(hunk =>
    line >= hunk.newStart && line < hunk.newStart + hunk.newLines || line >= hunk.oldStart && line < hunk.oldStart + hunk.oldLines)
    ?? hunks.reduce((nearest, hunk) => Math.abs(hunk.newStart - line) < Math.abs(nearest.newStart - line) ? hunk : nearest);
  return { index: hunk.index, line: (hunk.newLines > 0 ? hunk.newStart : hunk.oldStart) + 1 };
}
