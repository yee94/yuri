import { desktopPanelFilePath, desktopPanelScopeKey, type DesktopPanelStoredScope } from './desktop-panel-model';
import { desktopEditorDirty, DESKTOP_EDITOR_LIMITS, type DesktopEditorDocument, type DesktopEditorState, type DesktopEditors } from './desktop-files-editor-model';
import { decodeDesktopFileOperationRecord, DESKTOP_FILE_OPERATION_PREFIX } from './desktop-files-operation-record';

export type DesktopJournalStorage = {
  keys(): Promise<string[]>; getItem(key: string): Promise<string | null>; setItem(key: string, value: string): Promise<void>; removeItem(key: string): Promise<void>;
  /** Real native durability barrier, not a timer or readback of Storage's memory cache.
   * Resolve only after all preceding changes reached disk; reject on I/O failure. */
  sync?: () => Promise<void>;
  /** Explicit recovery may verify an unknown native receipt and durably restore
   * its prior snapshot. It must never replay a Host document write. */
  recover?: () => Promise<void>;
};
export const DESKTOP_JOURNAL_PREFIX = 'desktop-file-journal-v1:';
export const DESKTOP_JOURNAL_LIMITS = { records: 20, bytes: 4 * 1024 * 1024 };
type RecordV1 = { version: 1; scope: DesktopPanelStoredScope; path: string; text: string; base: string; wire: string; eol: DesktopEditorState['eol']; bom: boolean; pending: DesktopEditorState['pending']; conflict: boolean };
const utf8Size = (value: string) => { let count = 0; for (const char of value) { const code = char.codePointAt(0)!; count += code < 128 ? 1 : code < 2048 ? 2 : code < 65536 ? 3 : 4; } return count; };
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const exact = (value: object, keys: string[]) => Object.keys(value).sort().join(',') === keys.sort().join(',');
const text = (value: unknown): value is string => typeof value === 'string' && value.length <= DESKTOP_EDITOR_LIMITS.text && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value);
function decode(raw: string, key: string): RecordV1 {
  if (utf8Size(raw) > DESKTOP_JOURNAL_LIMITS.bytes) throw new Error('desktop_journal_record_capacity');
  const record = object(JSON.parse(raw)), scope = object(record.scope), host = object(scope.host), pending = record.pending === null ? null : object(record.pending);
  if (!exact(record, ['version', 'scope', 'path', 'text', 'base', 'wire', 'eol', 'bom', 'pending', 'conflict']) || record.version !== 1 || !exact(scope, ['host', 'authorityKey', 'sessionID', 'directory']) || !exact(host, ['hostID']) || typeof host.hostID !== 'string' || !host.hostID || typeof scope.authorityKey !== 'string' || !scope.authorityKey || !(scope.sessionID === null || typeof scope.sessionID === 'string' && !!scope.sessionID) || typeof scope.directory !== 'string' || typeof record.path !== 'string' || !text(record.text) || !text(record.base) || !text(record.wire) || !['\n', '\r\n', '\r'].includes(String(record.eol)) || typeof record.bom !== 'boolean' || typeof record.conflict !== 'boolean' || pending !== null && (!exact(pending, ['text', 'wire']) || !text(pending.text) || !text(pending.wire))) throw new Error('desktop_journal_invalid_record');
  const storedScope: DesktopPanelStoredScope = { host: { hostID: host.hostID }, authorityKey: scope.authorityKey, sessionID: scope.sessionID, directory: scope.directory };
  const path = desktopPanelFilePath(storedScope.directory, record.path);
  if (path !== record.path || DESKTOP_JOURNAL_PREFIX + JSON.stringify([desktopPanelScopeKey(storedScope), path]) !== key) throw new Error('desktop_journal_identity_mismatch');
  const wire = (value: string) => (record.bom ? '\uFEFF' : '') + value.replace(/\n/g, String(record.eol));
  if (record.base.includes('\r') || record.text.includes('\r') || wire(record.base) !== record.wire || pending && (String(pending.text).includes('\r') || wire(String(pending.text)) !== pending.wire)) throw new Error('desktop_journal_invalid_baseline');
  return { version: 1, scope: storedScope, path, text: record.text, base: record.base, wire: record.wire, eol: record.eol as RecordV1['eol'], bom: record.bom, pending: pending === null ? null : { text: String(pending.text), wire: String(pending.wire) }, conflict: record.conflict };
}
function encode(document: DesktopEditorDocument, state: DesktopEditorState) {
  if (!desktopEditorDirty(state) && !state.pending && state.error !== 'conflict') return null;
  if (state.base === null || state.wire === null) throw new Error('desktop_journal_missing_baseline');
  // Whitelist document data only: no RuntimeScope lease, request, URL resolver or credentials.
  const record: RecordV1 = { version: 1, scope: document.storedScope, path: document.path, text: state.text, base: state.base, wire: state.wire, eol: state.eol, bom: state.bom, pending: state.pending, conflict: state.error === 'conflict' };
  return JSON.stringify(record);
}
export function validateDesktopJournalSnapshot(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('desktop_journal_invalid_snapshot');
  const rows = Object.entries(value);
  if (rows.length > DESKTOP_JOURNAL_LIMITS.records) throw new Error('desktop_journal_capacity');
  let size = 0;
  const result: Record<string, string> = {};
  for (const [key, raw] of rows) {
    if ((!key.startsWith(DESKTOP_JOURNAL_PREFIX) && !key.startsWith(DESKTOP_FILE_OPERATION_PREFIX)) || typeof raw !== 'string') throw new Error('desktop_journal_invalid_snapshot');
    size += utf8Size(key) + utf8Size(raw);
    if (size > DESKTOP_JOURNAL_LIMITS.bytes) throw new Error('desktop_journal_capacity');
    if (key.startsWith(DESKTOP_FILE_OPERATION_PREFIX)) decodeDesktopFileOperationRecord(key, raw); else decode(raw, key);
    result[key] = raw;
  }
  return result;
}

/** One window's bounded journal. Storage's ordered calls are not cross-process CAS.
 * Each write checks its last observed value; foreign changes fail closed. Failed
 * writes retain prior Storage and buffers; only explicit retry resumes the lane. */
export function createDesktopEditorJournal(storage: DesktopJournalStorage, model: DesktopEditors, notify: () => void = () => {}) {
  const stored = new Map<string, string>(), pending = new Map<string, { document: DesktopEditorDocument; version: number }>();
  let hydrated = false, hydrating = false, error = '', serial = 0, used = 0, timer: ReturnType<typeof setTimeout> | undefined;
  let lane: Promise<unknown> = Promise.resolve();
  const keyOf = (document: DesktopEditorDocument) => DESKTOP_JOURNAL_PREFIX + document.key;
  const enqueue = <T>(work: () => Promise<T>) => { const flight = lane.then(work); lane = flight.catch(() => {}); return flight; };
  function fail(cause: unknown) {
    error = cause instanceof Error ? cause.message : String(cause);
    for (const { document } of pending.values()) model.durability(document, 'error');
    notify(); return false;
  }
  async function rollback(key: string, prior: string | null, expected: string | null) {
    const actual = await storage.getItem(key);
    if (actual !== prior && actual !== expected) throw new Error('desktop_journal_rollback_unconfirmed');
    if (actual === prior) return;
    if (prior === null) await storage.removeItem(key); else await storage.setItem(key, prior);
  }
  async function write(document: DesktopEditorDocument, state: DesktopEditorState) {
    const key = keyOf(document), before = stored.get(key) ?? null, next = encode(document, state);
    if (next === before) return;
    if (next !== null) decode(next, key);
    const size = used - (before ? utf8Size(key) + utf8Size(before) : 0) + (next ? utf8Size(key) + utf8Size(next) : 0);
    if (size > DESKTOP_JOURNAL_LIMITS.bytes || stored.size + (before === null && next !== null ? 1 : next === null && before !== null ? -1 : 0) > DESKTOP_JOURNAL_LIMITS.records) throw new Error('desktop_journal_capacity');
    if (await storage.getItem(key) !== before) throw new Error('desktop_journal_changed_by_another_owner');
    try { if (next === null) await storage.removeItem(key); else await storage.setItem(key, next); }
    catch (cause) {
      try { await rollback(key, before, next); await storage.sync?.(); }
      catch { throw new Error('desktop_journal_rollback_unconfirmed'); }
      throw cause;
    }
    used = size;
    if (next === null) stored.delete(key); else stored.set(key, next);
  }
  function schedule() {
    if (timer || error || !hydrated) return;
    timer = setTimeout(() => { timer = undefined; void flush(); }, 150);
  }
  function queue(document: DesktopEditorDocument) {
    if (hydrating) return;
    const key = keyOf(document), state = document.state();
    // Input only replaces a bounded job reference. Serialize/measure the full
    // source at flush/checkpoint time, never at every native Editor keystroke.
    if (!pending.has(key) && !stored.has(key) && !desktopEditorDirty(state) && !state.pending && state.error !== 'conflict') { model.durability(document, 'ready'); return; }
    const first = !pending.has(key);
    pending.set(key, { document, version: ++serial });
    model.durability(document, error ? 'error' : 'pending'); schedule(); if (first) notify();
  }
  function flush() {
    if (timer) { clearTimeout(timer); timer = undefined; }
    return enqueue(async () => {
      if (!hydrated || error) return false;
      try {
        while (pending.size) {
          const [key, job] = pending.entries().next().value!;
          await write(job.document, job.document.state());
          if (pending.get(key) === job) { pending.delete(key); model.durability(job.document, 'ready'); }
        }
        notify(); return true;
      } catch (cause) { return fail(cause); }
    });
  }
  function checkpoint(document: DesktopEditorDocument, next: DesktopEditorState) {
    const key = keyOf(document), job = pending.get(key);
    return enqueue(async () => {
      if (!hydrated || error) return false;
      const prior = stored.get(key) ?? null, priorUsed = used;
      try {
        // NSH 0.4 setItem resolves after updating its in-memory Store; its file
        // backend writes asynchronously without returning disk errors. Never
        // mistake that acknowledgement for crash-safe POST/discard admission.
        if (!storage.sync) throw new Error('desktop_journal_durable_checkpoint_unavailable');
        // An older queued flush can persist a later edit before this checkpoint
        // runs. Keep the latest buffer while committing only the intended base /
        // receipt transition. Discard alone freezes input until its checkpoint.
        await write(document, next.discarding ? next : { ...next, text: document.state().text });
        await storage.sync();
        if (pending.get(key) === job) { pending.delete(key); model.durability(document, 'ready'); }
        schedule(); notify(); return true;
      } catch (cause) {
        // A failing native barrier must not make a failed Discard look cleared
        // in Storage's cache. Restore the last observed value where possible;
        // failure of that rollback remains explicit and blocks all admission.
        if ((stored.get(key) ?? null) !== prior) {
          try {
            await rollback(key, prior, stored.get(key) ?? null);
            if (prior === null) stored.delete(key); else stored.set(key, prior);
            used = priorUsed;
            await storage.sync?.();
          } catch { cause = new Error('desktop_journal_rollback_unconfirmed'); }
        }
        if (!pending.has(key)) pending.set(key, { document, version: ++serial });
        return fail(cause);
      }
    });
  }
  function restore() {
    return enqueue(async () => {
      if (hydrated) return true;
      hydrating = true;
      try {
        const keys = (await storage.keys()).filter(key => key.startsWith(DESKTOP_JOURNAL_PREFIX));
        if (keys.length > DESKTOP_JOURNAL_LIMITS.records) throw new Error('desktop_journal_capacity');
        const records: Array<{ key: string; raw: string; record: RecordV1 }> = [];
        let size = 0;
        for (const key of keys) {
          const raw = await storage.getItem(key);
          if (raw === null) throw new Error('desktop_journal_changed_during_restore');
          size += utf8Size(key) + utf8Size(raw);
          if (size > DESKTOP_JOURNAL_LIMITS.bytes) throw new Error('desktop_journal_capacity');
          records.push({ key, raw, record: decode(raw, key) });
        }
        for (const { key, raw, record } of records) {
          // Records already restored during a partial failed pass are never applied twice.
          if (stored.has(key)) continue;
          const state: DesktopEditorState = { text: record.text, base: record.base, wire: record.wire, eol: record.eol, bom: record.bom, pending: record.pending, loaded: true, readOnly: false, loading: false, saving: false, discarding: false, error: record.pending ? 'unknown' : record.conflict ? 'conflict' : '', detail: record.pending ? 'desktop_file_write_unconfirmed' : '', durability: 'ready' };
          if (!model.restore(record.scope, record.path, state)) throw new Error('desktop_journal_restore_capacity_or_collision');
          stored.set(key, raw);
        }
        used = size; hydrated = true; error = ''; notify(); return true;
      } catch (cause) { return fail(cause); }
      finally { hydrating = false; }
    });
  }
  const ready = restore();
  return { ready, storage, queue, checkpoint, flush,
    state: () => ({ hydrated, error, pending: pending.size, records: stored.size, bytes: used }),
    async retry() { try { await storage.recover?.(); } catch (cause) { return fail(cause); } error = ''; if (!await restore()) return false; for (const { document } of pending.values()) model.durability(document, 'pending'); return flush(); },
    stop() { if (timer) clearTimeout(timer); timer = undefined; },
  };
}
