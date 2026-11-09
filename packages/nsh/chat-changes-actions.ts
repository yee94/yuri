import { changeGroups, changesSnapshot, nextChangesAuthorityRevision, type ChangesReader } from './chat-changes-model';

type Call = (path: string, method?: string, body?: unknown) => Promise<unknown>;
type ActionState = { pending: boolean; error: string; failedPaths: string[]; success: boolean; committed: boolean; unknown: boolean };
type WriteJournal = { pending: boolean; unknown: boolean; revision?: number; ready?: boolean; restore?: Promise<void>; beforeWrite?: () => Promise<void>; completed?: () => Promise<void>; listeners?: Set<() => void> };
type JournalStorage = { getItem: (key: string) => Promise<string | null>; setItem: (key: string, value: string) => Promise<void>; removeItem: (key: string) => Promise<void> };
const publishJournal = (journal: WriteJournal) => { journal.listeners?.forEach(listener => { try { listener(); } catch { /* One retired view cannot block other scope observers. */ } }); };
const journals = new Map<string, WriteJournal>();
// Evicting a settled journal must not make a retained reader's older status fresh again.
let retiredRevision = 0;
/** Keep uncertain outcomes across Sheet remounts and Host reconnects. Never evict an unresolved write. */
export function changesWriteJournal(hostID: string, directory: string, storage?: JournalStorage): WriteJournal {
  const key = JSON.stringify([hostID, directory]);
  let journal = journals.get(key);
  if (!journal) {
    if (journals.size >= 150) {
      const inactive = [...journals].find(([, entry]) => !entry.unknown && !entry.pending && entry.ready !== false && !entry.listeners?.size);
      if (inactive) { retiredRevision = Math.max(retiredRevision, inactive[1].revision ?? 0); journals.delete(inactive[0]); }
    }
    // Fail closed if the bounded scope catalog is exhausted.
    journal = { pending: false, unknown: !hostID || journals.size >= 150, revision: retiredRevision };
    if (hostID && journals.size < 150) journals.set(key, journal);
    if (storage && !journal.unknown) {
      const entry = journal, storageKey = `changes-write-v1:${key}`;
      entry.ready = false;
      entry.restore = storage.getItem(storageKey).then(value => { if (value !== null) entry.unknown = true; }, () => { entry.unknown = true; }).then(() => { entry.ready = true; publishJournal(entry); });
      entry.beforeWrite = () => storage.setItem(storageKey, 'pending');
      entry.completed = () => storage.removeItem(storageKey);
    }
  }
  return journal;
}
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};

/** Explicit user actions only. No background retries of possibly completed writes. */
export function createChangesActions(reader: ChangesReader, call: Call, current: () => boolean = reader.current, notify: () => void = () => {}, journal: WriteJournal = { pending: false, unknown: false }) {
  (journal.listeners ??= new Set()).add(notify);
  let state: ActionState = { pending: false, error: '', failedPaths: [], success: false, committed: false, unknown: journal.unknown }, serial = 0;
  const update = (value: Partial<ActionState>) => { state = { ...state, ...value }; notify(); };
  const source = reader.source;
  const needsRefresh = () => reader.state().statusAuthorityRevision <= (journal.revision ?? 0);
  const ready = () => current() && source.kind === 'workspace' && !!source.directory.trim() && journal.ready !== false && !journal.pending && !journal.unknown && !needsRefresh() && !state.pending && !reader.state().loading && !reader.state().error && reader.state().snapshot !== null;
  const route = (name: string) => `/api/git/${name}?directory=${encodeURIComponent(source.directory)}`;
  const write = async (name: string, body: unknown, valid: () => boolean) => {
    // Persist BEFORE dispatch. A restart with this marker can only restore read-only uncertainty.
    try { await journal.beforeWrite?.(); }
    catch (cause) { journal.unknown = true; throw cause; }
    let dispatched = false;
    try {
      if (!valid()) throw Object.assign(new Error('page_operation_stale'), { status: 400 });
      dispatched = true;
      const result = await call(route(name), 'POST', body);
      if (object(result).success === false) throw Object.assign(new Error(String(object(result).error || 'Git operation failed')), { status: 400 });
      if (object(result).success !== true) throw new Error('Invalid Git operation response');
      return result;
    } catch (cause) {
      const status = Number(object(cause).status);
      if (!Number.isInteger(status) || status >= 500) journal.unknown = true;
      throw cause;
    } finally {
      // Every existing reader must adopt a status GET dispatched after this write settled.
      if (dispatched) journal.revision = nextChangesAuthorityRevision();
      if (!journal.unknown) {
        try { await journal.completed?.(); }
        catch (cause) { journal.unknown = true; throw cause; }
      }
    }
  };
  async function run(work: (valid: () => boolean) => Promise<void>) {
    if (!ready()) return false;
    const attempt = ++serial, valid = () => current() && attempt === serial;
    journal.pending = true;
    publishJournal(journal);
    update({ pending: true, error: '', failedPaths: [], success: false, committed: false });
    try { await work(valid); if (!valid()) return false; update({ success: true }); return true; }
    catch (cause) { if (valid()) update({ error: cause instanceof Error ? cause.message : String(cause) }); return false; }
    finally {
      if (valid()) await reader.refresh();
      journal.pending = false; publishJournal(journal);
      if (valid()) update({ pending: false, unknown: journal.unknown });
    }
  }
  function allowed(paths: string[], staged?: boolean) {
    const groups = changeGroups(reader.state().snapshot);
    const present = new Set(groups.filter(group => staged === undefined || group.staged === staged).flatMap(group => group.files.map(file => file.path)));
    return paths.length > 0 && paths.every(path => present.has(path));
  }
  async function syncWork(valid: () => boolean) {
    const value = await call(route('remotes'));
    if (!valid()) return;
    if (!Array.isArray(value)) throw new Error('Invalid Git remotes');
    const remotes = value.map(object).filter(remote => typeof remote.name === 'string' && remote.name);
    const tracking = reader.state().snapshot?.tracking;
    const remote = remotes.find(remote => typeof tracking === 'string' && tracking.startsWith(String(remote.name) + '/')) ?? remotes[0];
    if (!remote) throw new Error('mobile.changes.noRemote');
    await write('fetch', { remote: remote.name }, valid);
    if (!valid()) return;
    const fetched = changesSnapshot(await call(route('status')));
    if (!valid()) return;
    if ((fetched.behind ?? 0) > 0) {
      if (fetched.files.length > 0) throw new Error('gitView.toast.commitOrStashBeforeSync');
      const prefix = String(remote.name) + '/';
      await write('pull', { remote: remote.name, ...(fetched.tracking?.startsWith(prefix) ? { branch: fetched.tracking.slice(prefix.length) } : {}), rebase: true }, valid);
    }
    if (!valid()) return;
    const pulled = changesSnapshot(await call(route('status')));
    if (!valid()) return;
    if ((pulled.ahead ?? 0) > 0) await write('push', {}, valid);
  }
  return { state: () => ({ ...state, unknown: journal.unknown, needsRefresh: needsRefresh(), pending: state.pending || journal.pending || journal.ready === false }),
    move(paths: string[], staged: boolean) {
      if (!ready() || !allowed(paths, staged)) return Promise.resolve(false);
      return run(async valid => { await write(staged ? 'unstage' : 'stage', { paths: [...new Set(paths)] }, valid); if (!valid()) return; });
    },
    revert(paths: string[], confirmed: boolean) {
      if (!confirmed || !ready() || !allowed(paths)) return Promise.resolve(false);
      return run(async valid => {
        const failed: string[] = [], errors: string[] = [];
        // Bound write fanout and stop dispatching when the owner/Host goes away.
        for (const path of new Set(paths)) {
          if (!valid()) return;
          try { await write('revert', { path }, valid); }
          catch (cause) { if (journal.unknown) throw cause; failed.push(path); errors.push(`${path}: ${cause instanceof Error ? cause.message : String(cause)}`); }
        }
        if (valid() && failed.length) { update({ failedPaths: failed }); throw new Error(errors.join('\n')); }
      });
    },
    commit(message: string, pushAfter = false) {
      if (!ready() || !message.trim()) return Promise.resolve(false);
      const files = changeGroups(reader.state().snapshot).find(group => group.staged)?.files.map(file => file.path) ?? [];
      if (!files.length) return Promise.resolve(false);
      return run(async valid => {
        // Preserve partially staged working changes: do not let commit add them.
        await write('commit', { message: message.trim(), files, stageFiles: [] }, valid);
        if (valid()) update({ committed: true });
        if (valid() && pushAfter) await syncWork(valid);
      });
    },
    sync: () => run(syncWork),
    cancel() { serial++; journal.listeners?.delete(notify); update({ pending: false }); },
  };
}
