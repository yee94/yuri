import { changeGroups, changesSnapshot, type ChangesReader } from './chat-changes-model';

type Call = (path: string, method?: string, body?: unknown) => Promise<unknown>;
type ActionState = { pending: boolean; error: string; failedPaths: string[]; success: boolean; committed: boolean };
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};

/** Explicit user actions only. No background retries of possibly completed writes. */
export function createChangesActions(reader: ChangesReader, call: Call, current: () => boolean = reader.current, notify: () => void = () => {}) {
  let state: ActionState = { pending: false, error: '', failedPaths: [], success: false, committed: false }, serial = 0;
  const update = (value: Partial<ActionState>) => { state = { ...state, ...value }; notify(); };
  const source = reader.source;
  const ready = () => current() && source.kind === 'workspace' && !state.pending && !reader.state().loading && !reader.state().error && reader.state().snapshot !== null;
  const route = (name: string) => `/api/git/${name}?directory=${encodeURIComponent(source.directory)}`;
  const check = (value: unknown) => { if (object(value).success === false) throw new Error(String(object(value).error || 'Git operation failed')); };
  async function run(work: (valid: () => boolean) => Promise<void>) {
    if (!ready()) return false;
    const attempt = ++serial, valid = () => current() && attempt === serial;
    update({ pending: true, error: '', failedPaths: [], success: false, committed: false });
    try { await work(valid); if (!valid()) return false; update({ success: true }); return true; }
    catch (cause) { if (valid()) update({ error: cause instanceof Error ? cause.message : String(cause) }); return false; }
    finally { if (valid()) { await reader.refresh(); if (valid()) update({ pending: false }); } }
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
    check(await call(route('fetch'), 'POST', { remote: remote.name }));
    if (!valid()) return;
    const fetched = changesSnapshot(await call(route('status')));
    if (!valid()) return;
    if ((fetched.behind ?? 0) > 0) {
      if (fetched.files.length > 0) throw new Error('gitView.toast.commitOrStashBeforeSync');
      const prefix = String(remote.name) + '/';
      check(await call(route('pull'), 'POST', { remote: remote.name, ...(fetched.tracking?.startsWith(prefix) ? { branch: fetched.tracking.slice(prefix.length) } : {}), rebase: true }));
    }
    if (!valid()) return;
    const pulled = changesSnapshot(await call(route('status')));
    if (!valid()) return;
    if ((pulled.ahead ?? 0) > 0) check(await call(route('push'), 'POST', {}));
  }
  return { state: () => state,
    move(paths: string[], staged: boolean) {
      if (!ready() || !allowed(paths, staged)) return Promise.resolve(false);
      return run(async valid => { check(await call(route(staged ? 'unstage' : 'stage'), 'POST', { paths: [...new Set(paths)] })); if (!valid()) return; });
    },
    revert(paths: string[], confirmed: boolean) {
      if (!confirmed || !ready() || !allowed(paths)) return Promise.resolve(false);
      return run(async valid => {
        const failed: string[] = [], errors: string[] = [];
        // Bound write fanout and stop dispatching when the owner/Host goes away.
        for (const path of new Set(paths)) {
          if (!valid()) return;
          try { check(await call(route('revert'), 'POST', { path })); }
          catch (cause) { failed.push(path); errors.push(`${path}: ${cause instanceof Error ? cause.message : String(cause)}`); }
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
        const result = await call(route('commit'), 'POST', { message: message.trim(), files, stageFiles: [] });
        check(result);
        if (object(result).success !== true) throw new Error('Invalid commit response');
        if (valid()) update({ committed: true });
        if (valid() && pushAfter) await syncWork(valid);
      });
    },
    sync: () => run(syncWork),
    cancel() { serial++; update({ pending: false }); },
  };
}
