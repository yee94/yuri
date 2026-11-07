/** Pure deferred-delete journal. The caller supplies the captured Host boundary. */
const PROJECTS_DELETE_UNDO_MS = 10_000;
export type DeleteSession = { id: string; parentID?: string; directory: string; title: string };
export type DeleteBatch<T> = { id: string; rows: T[]; phase: 'undo' | 'committing' | 'failed'; error: string };
export function createProjectsDeletes<T extends DeleteSession>(dependencies: {
  current: () => boolean;
  remove: (row: T) => Promise<void>;
  committed: (rows: T[]) => void;
}) {
  let sequence = 0;
  let batches: DeleteBatch<T>[] = [];
  const deleted = new Set<string>(), listeners = new Set<() => void>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const publish = () => listeners.forEach(listener => listener());
  const update = (batch: DeleteBatch<T>) => { batches = batches.map(item => item.id === batch.id ? batch : item); publish(); };
  const forget = (id: string) => { batches = batches.filter(item => item.id !== id); publish(); };
  function cancelStale() {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear(); batches = []; publish();
  }
  async function commit(id: string) {
    if (!dependencies.current()) { cancelStale(); return; }
    const batch = batches.find(item => item.id === id);
    if (!batch || batch.phase === 'committing') return;
    const timer = timers.get(id); if (timer) clearTimeout(timer); timers.delete(id);
    update({ ...batch, phase: 'committing', error: '' });
    const byID = new Map(batch.rows.map(row => [row.id, row]));
    const depth = (row: T) => { let level = 0, parent = row.parentID; const seen = new Set([row.id]); while (parent && byID.has(parent) && !seen.has(parent)) { seen.add(parent); level++; parent = byID.get(parent)?.parentID; } return level; };
    const failed = new Set<string>(), blocked = new Set<string>();
    const committed: T[] = [];
    let error = '';
    // Children first. A failed descendant must never be cascade-deleted by its parent.
    for (const row of [...batch.rows].sort((a, b) => depth(b) - depth(a))) {
      if (!dependencies.current()) { cancelStale(); return; }
      if (blocked.has(row.id)) { failed.add(row.id); continue; }
      try {
        await dependencies.remove(row);
        if (!dependencies.current()) { cancelStale(); return; }
        deleted.add(row.id); committed.push(row);
      } catch (failure) {
        failed.add(row.id); error ||= failure instanceof Error ? failure.message : String(failure);
        let parent = row.parentID;
        while (parent && byID.has(parent) && !blocked.has(parent)) { blocked.add(parent); parent = byID.get(parent)?.parentID; }
      }
    }
    if (!dependencies.current()) { cancelStale(); return; }
    if (committed.length) dependencies.committed(committed);
    const remaining = batch.rows.filter(row => failed.has(row.id));
    if (remaining.length) update({ ...batch, rows: remaining, phase: 'failed', error });
    else forget(id);
  }
  function schedule(rows: T[]) {
    if (!dependencies.current() || !rows.length) return null;
    const owned = new Set(batches.flatMap(batch => batch.rows.map(row => row.id)));
    // Do not split a subtree between overlapping operations.
    if (rows.some(row => owned.has(row.id) || deleted.has(row.id))) return null;
    const batch: DeleteBatch<T> = { id: `projects-delete-${++sequence}`, rows: [...rows], phase: 'undo', error: '' };
    batches = [...batches, batch];
    timers.set(batch.id, setTimeout(() => { timers.delete(batch.id); void commit(batch.id); }, PROJECTS_DELETE_UNDO_MS));
    publish(); return batch.id;
  }
  function undo(id: string) {
    if (!dependencies.current()) { cancelStale(); return false; }
    if (batches.find(batch => batch.id === id)?.phase !== 'undo') return false;
    const timer = timers.get(id); if (timer) clearTimeout(timer); timers.delete(id);
    forget(id); return true;
  }
  return {
    schedule, undo, cancelStale,
    retry: (id: string) => batches.find(batch => batch.id === id)?.phase === 'failed' ? commit(id) : Promise.resolve(),
    batches: () => batches,
    hiddenIDs: () => new Set([...deleted, ...batches.filter(batch => batch.phase !== 'failed').flatMap(batch => batch.rows.map(row => row.id))]),
    observe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
