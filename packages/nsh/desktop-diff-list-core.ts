import type { ChangesReader, ChangesSnapshot, ChangesSource, HistoricalChange } from './chat-changes-model';

export type DesktopDiffScope = 'working' | 'staged' | 'turn';
export type DesktopDiffListFile = Readonly<{ path: string; staged: boolean; status: string; isNew?: boolean }>;
export type DesktopDiffListEntry = Readonly<{
  key: string; file: DesktopDiffListFile; expanded: boolean; loading: boolean; error: string;
  diff: HistoricalChange | null;
  fullContext: HistoricalChange | null; fullContextLoading: boolean; fullContextError: string;
}>;
export const desktopDiffListDefaultExpandedCount = (count: number) => count <= 6 ? count : count <= 12 ? 6 : count <= 25 ? 4 : 2;
export function desktopDiffListFiles(source: ChangesSource, snapshot: ChangesSnapshot | null, scope: DesktopDiffScope): readonly DesktopDiffListFile[] {
  if (source.kind === 'turn') return scope === 'turn' ? source.files.map(file => ({ path: file.path, staged: false, status: '' })) : [];
  if (scope === 'turn' || !snapshot) return [];
  const staged = scope === 'staged';
  return snapshot.files.filter(file => {
    const index = file.index.trim(), working = file.working_dir.trim();
    return staged ? !!index && !['?', '!'].includes(index) : !!working && working !== '!' || index === '?';
  }).map(file => ({ path: file.path, staged, status: staged ? file.index : file.working_dir || file.index,
    isNew: ['A', '?'].includes(file.index.trim()) || ['A', '?'].includes(file.working_dir.trim()) }));
}

/** One captured original reader, serialized visible+expanded demand. This is not
 * a transport or a second catalog. Completed bodies remain source-local; failure
 * never clears prior. No file-count/body truncation or speculative background read. */
export function createDesktopDiffList(input: { reader: ChangesReader; current: () => boolean; notify?: () => void }) {
  const entries = new Map<string, DesktopDiffListEntry>();
  const refresh = new Set<string>();
  let rows: readonly DesktopDiffListEntry[] = [], visible = new Set<string>(), scope: DesktopDiffScope | undefined;
  let alive = true, active = false, full = false, epoch = 0, flight: Promise<void> | undefined, pending: string | undefined, pendingRefresh = false;
  const emit = () => input.notify?.();
  const set = (key: string, patch: Partial<DesktopDiffListEntry>) => {
    const prior = entries.get(key); if (!prior) return;
    const next = { ...prior, ...patch }; entries.set(key, next); rows = rows.map(row => row.key === key ? next : row); emit();
  };
  const admitted = () => alive && active && input.current();
  const demanded = (row: DesktopDiffListEntry) => row.expanded && visible.has(row.key);
  function cancel() {
    epoch++; if (pending) input.reader.cancel();
    if (pending) { if (pendingRefresh) refresh.add(pending); const row = entries.get(pending); if (row?.loading || row?.fullContextLoading) set(pending, { loading: false, fullContextLoading: false }); }
    pending = undefined; pendingRefresh = false;
  }
  function pump() {
    if (flight || !admitted()) return;
    const work = async () => {
      while (admitted()) {
        const row = rows.find(row => demanded(row) && (!row.diff || refresh.has(row.key) || full && !row.fullContext && !row.fullContextError) && !row.loading && !row.fullContextLoading && !row.error);
        if (!row) break;
        const ticket = epoch, key = row.key, fullOnly = !!row.diff && !refresh.has(key);
        pending = key; pendingRefresh = refresh.has(key); refresh.delete(key); set(key, fullOnly ? { fullContextLoading: true } : { loading: true });
        const valid = () => admitted() && ticket === epoch && rows.some(row => row.key === key) && demanded(entries.get(key)!);
        try {
          if (fullOnly) {
            if (input.reader.state().diff !== row.diff || input.reader.state().path !== row.file.path || input.reader.state().staged !== row.file.staged) {
              await input.reader.select(row.file.path, row.file.staged);
              if (!valid()) continue;
              const selected = input.reader.state();
              if (selected.diffError || !selected.diff) { set(key, { fullContextLoading: false, fullContextError: selected.diffError || 'diff_unavailable' }); continue; }
              set(key, { diff: selected.diff });
            }
            await input.reader.loadFullContext();
            if (!valid()) continue;
            const selected = input.reader.state();
            set(key, { fullContextLoading: false, fullContext: selected.fullContext ?? entries.get(key)!.fullContext, fullContextError: selected.fullContextError || (selected.fullContext ? '' : 'diff_unavailable') });
            continue;
          }
          await input.reader.select(row.file.path, row.file.staged);
          if (!valid()) continue;
          const state = input.reader.state();
          if (state.path !== row.file.path || state.staged !== row.file.staged) continue;
          set(key, { loading: false, diff: state.diff ?? entries.get(key)!.diff, error: state.diffError || (state.diff ? '' : 'diff_unavailable'), ...(state.diffError ? {} : { fullContext: null, fullContextError: '' }) });
        } catch { if (valid()) set(key, fullOnly ? { fullContextLoading: false, fullContextError: 'diff_unavailable' } : { loading: false, error: 'diff_unavailable' }); }
        finally { if (pending === key) { pending = undefined; pendingRefresh = false; } }
      }
    };
    flight = Promise.resolve().then(work).finally(() => { flight = undefined; if (admitted() && rows.some(row => demanded(row) && (!row.diff || refresh.has(row.key) || full && !row.fullContext && !row.fullContextError) && !row.loading && !row.fullContextLoading && !row.error)) pump(); });
  }
  return {
    rows: () => rows,
    entry: (key: string) => entries.get(key),
    configure(files: readonly DesktopDiffListFile[], nextScope: DesktopDiffScope, options: { collapsedAll?: boolean; toolSnapshot?: boolean; targetPath?: string } = {}) {
      const valid = input.reader.source.kind === 'turn' ? nextScope === 'turn' : nextScope !== 'turn';
      if (!valid) throw new Error('desktop_diff_source_scope_mismatch');
      const seen = new Set<string>();
      for (const file of files) {
        if (!file.path || file.staged !== (nextScope === 'staged') || seen.has(file.path)) throw new Error('desktop_diff_invalid_catalog');
        seen.add(file.path);
      }
      if (scope !== nextScope) { cancel(); scope = nextScope; visible = new Set(); }
      const defaults = options.collapsedAll || nextScope === 'turn' && !options.toolSnapshot ? 0 : desktopDiffListDefaultExpandedCount(files.length);
      const next = files.map((file, index) => {
        const key = JSON.stringify([nextScope, file.path]), prior = entries.get(key);
        const row = prior ? (prior.file.path === file.path && prior.file.staged === file.staged && prior.file.status === file.status && prior.file.isNew === file.isNew ? prior : { ...prior, file })
          : { key, file, expanded: file.path === options.targetPath || index < defaults, loading: false, error: '', diff: null, fullContext: null, fullContextLoading: false, fullContextError: '' };
        entries.set(key, row); return row;
      });
      const nextKeys = new Set(next.map(row => row.key));
      if (pending && !nextKeys.has(pending)) cancel();
      for (const [key] of entries) if (key.startsWith('["' + nextScope + '",') && !nextKeys.has(key)) { entries.delete(key); refresh.delete(key); }
      if (rows.length === next.length && rows.every((row, index) => row === next[index])) return;
      rows = next; emit(); pump();
    },
    active(value: boolean) { if (active === value) return; active = value; if (!value) cancel(); else pump(); },
    visible(keys: readonly string[], deferDemand = false) {
      const next = new Set(keys);
      if (next.size === visible.size && [...next].every(key => visible.has(key))) { if (!deferDemand) pump(); return; }
      visible = next;
      if (pending && !visible.has(pending)) cancel();
      if (!deferDemand) pump();
    },
    expand(key: string, expanded: boolean) {
      const row = entries.get(key); if (!admitted() || !row || row.expanded === expanded) return false;
      set(key, { expanded }); if (!expanded && pending === key) cancel(); pump(); return true;
    },
    toggleAll() {
      if (!admitted()) return;
      const expanded = !rows.some(row => row.expanded);
      if (!expanded) cancel();
      rows = rows.map(row => { const next = row.expanded === expanded ? row : { ...row, expanded }; entries.set(row.key, next); return next; }); emit(); pump();
    },
    focus(path: string) {
      if (!admitted()) return -1;
      const index = rows.findIndex(row => row.file.path === path); if (index >= 0) { const row = rows[index]; if (!row.expanded) set(row.key, { expanded: true }); pump(); }
      return index;
    },
    retry(key: string) {
      const row = entries.get(key); if (!admitted() || !row || row.loading || !demanded(row)) return false;
      // A failed refresh keeps prior visible until this single original reader
      // supplies another complete body. No automatic retry on remount/input.
      refresh.add(key); set(key, { error: '' }); pump();
      return true;
    },
    refresh() { if (!alive || !input.current()) return; cancel(); for (const [key, row] of entries) { refresh.add(key); if (row.error) set(key, { error: '' }); } pump(); },
    full(value: boolean) { if (!admitted() || input.reader.source.kind !== 'workspace' || value === full) return; full = value; if (!value && pending) cancel(); else pump(); },
    retryFull(key: string) { const row = entries.get(key); if (!admitted() || !row || !demanded(row)) return; set(key, { fullContextError: '' }); pump(); },
    idle: () => flight ?? Promise.resolve(),
    dispose() { if (!alive) return; alive = false; active = false; cancel(); },
  };
}
