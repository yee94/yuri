import { validateDesktopJournalSnapshot, type DesktopJournalStorage } from './desktop-files-journal';

/** Private native journal only; never native filesystem paths, auth or NSH Storage. */
type NativeCall = <T>(method: string, body: Record<string, unknown>) => Promise<T>;
type Snapshot = { status: 'ready'; version: number; requestID: string | null; records: Record<string, string> };
type Attempt = { before: Snapshot; records: Record<string, string>; requestID: string };
const prefix = 'desktop.files.journal.';
export const desktopFileJournalCapabilities = [prefix + 'snapshot', prefix + 'commit', prefix + 'sync'] as const;
const exact = (value: object, fields: string[]) => Object.keys(value).sort().join(',') === fields.sort().join(',');
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
function read(value: unknown): Snapshot {
  const v = object(value);
  if (v.status !== 'ready' || !exact(v, ['status', 'version', 'requestID', 'records']) || !Number.isSafeInteger(v.version) || Number(v.version) < 0 || !(v.requestID === null || typeof v.requestID === 'string' && /^[\w-]{1,128}$/.test(v.requestID)) || (v.version === 0) !== (v.requestID === null)) throw new Error('desktop_journal_native_receipt');
  return { status: 'ready', version: Number(v.version), requestID: v.requestID as string | null, records: validateDesktopJournalSnapshot(v.records) };
}
function denied(value: unknown) {
  const v = object(value);
  return v.status === 'denied' && exact(v, ['status', 'code']) && typeof v.code === 'string' && /^file_journal_[a-z_]+$/.test(v.code) ? v.code : null;
}
const equal = (a: Record<string, string>, b: Record<string, string>) => Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => a[key] === b[key]);

/** Main: createNativeDesktopPanelTabs({ storage: createDesktopFileJournalStorage(native) }).
 * Mutations commit the whole bounded snapshot using native version CAS, and only
 * return after the native data/metadata barrier. sync() reconfirms that exact
 * version/receipt, never a timer or memory readback. All lanes stay window-local.
 */
export function createDesktopFileJournalStorage(native: NativeCall): DesktopJournalStorage {
  let snapshot: Snapshot | undefined, uncertain: Attempt | undefined, serial = 0;
  let recoveryRecords: Record<string, string> | undefined;
  const owner = 'journal_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 16);
  let lane: Promise<unknown> = Promise.resolve();
  const run = <T>(work: () => Promise<T>) => { const task = lane.then(work); lane = task.catch(() => {}); return task; };
  const id = () => owner + '_' + (++serial).toString(36);
  async function current() {
    if (uncertain) throw new Error('desktop_journal_native_commit_unknown');
    if (!snapshot) { const v = await native(prefix + 'snapshot', {}); const code = denied(v); if (code) throw new Error(code); snapshot = read(v); }
    return snapshot;
  }
  function accept(value: unknown, attempt: Attempt) {
    const next = read(value);
    if (next.version !== attempt.before.version + 1 || next.requestID !== attempt.requestID || !equal(next.records, attempt.records)) throw new Error('desktop_journal_native_receipt');
    snapshot = next; uncertain = undefined;
  }
  async function inspect(attempt: Attempt) {
    const v = await native(prefix + 'sync', { version: attempt.before.version + 1, requestID: attempt.requestID });
    const code = denied(v);
    if (code === 'file_journal_not_committed') { uncertain = undefined; snapshot = attempt.before; return false; }
    if (code) throw new Error('desktop_journal_native_commit_unknown');
    accept(v, attempt); return true;
  }
  async function commit(records: Record<string, string>) {
    const before = await current();
    if (before.version === Number.MAX_SAFE_INTEGER) throw new Error('desktop_journal_native_version_capacity');
    const attempt: Attempt = { before, records: validateDesktopJournalSnapshot(records), requestID: id() };
    uncertain = attempt;
    try {
      const value = await native(prefix + 'commit', { expectedVersion: before.version, requestID: attempt.requestID, records: attempt.records });
      const code = denied(value);
      if (code) { uncertain = undefined; throw new Error(code); }
      accept(value, attempt);
    } catch (cause) {
      if (!uncertain) throw cause;
      // One receipt-only verification. Never resubmit a commit on transport error.
      try { if (await inspect(attempt)) return; }
      catch { throw new Error('desktop_journal_native_commit_unknown'); }
      throw new Error('desktop_journal_native_not_committed');
    }
  }
  return {
    keys: () => run(async () => Object.keys((await current()).records)),
    getItem: key => run(async () => (await current()).records[key] ?? null),
    setItem: (key, value) => run(async () => { const prior = await current(); await commit({ ...prior.records, [key]: value }); }),
    removeItem: key => run(async () => { const rows = { ...(await current()).records }; delete rows[key]; await commit(rows); }),
    sync: () => run(async () => {
      const prior = await current();
      const value = read(await native(prefix + 'sync', { version: prior.version, requestID: prior.requestID }));
      if (value.version !== prior.version || value.requestID !== prior.requestID || !equal(value.records, prior.records)) throw new Error('desktop_journal_native_receipt');
    }),
    recover: () => run(async () => {
      if (!uncertain && !recoveryRecords) return;
      if (uncertain) {
        const attempt = uncertain;
        recoveryRecords ??= attempt.before.records;
        await inspect(attempt);
      }
      if (recoveryRecords && !equal((await current()).records, recoveryRecords)) {
        // The caller already observed failure and kept its prior journal cache.
        // Only an explicit retry may CAS-rollback a verified native commit. This
        // is a new durable transaction, never a replay or a Host document write.
        try { await commit(recoveryRecords); }
        catch { throw new Error('desktop_journal_rollback_unconfirmed'); }
      }
      recoveryRecords = undefined;
    }),
  };
}
