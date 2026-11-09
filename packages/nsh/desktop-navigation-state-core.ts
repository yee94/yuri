import type { RuntimeScope } from './runtime-scope';

export type DesktopNavigationHomeSection = 'assistants' | 'schedules';

/** Navigation metadata only. Draft text/receipts stay with openDraft/openNativeNewSession.
 * There was no persisted NSH route consumer before this key; no legacy migration. */
export type DesktopNavigationTarget = Readonly<
  | { kind: 'home'; section: DesktopNavigationHomeSection }
  | { kind: 'session'; sessionID: string; directory: string; messageID?: string }
  | { kind: 'assistant'; assistantID: string; directory: string }
  | { kind: 'new-session'; directory: string; projectID?: string }
  | { kind: 'project'; projectID: string; directory: string }
>;
export type DesktopNavigationPartition = Readonly<{ connectionID: string; origin: string; authorizationID: string }>;
export type DesktopNavigationAuthority = Readonly<{
  connection: { id: string; url: string; authorizationID?: string } | null;
  runtimeScope: RuntimeScope | null;
  /** Actual adopted native selection AND foreground operation authority. Never inferred from a route. */
  confirmed: boolean;
}>;
export type DesktopNavigationContext = Readonly<{
  partition: DesktopNavigationPartition; runtimeScope: RuntimeScope; current: () => boolean;
}>;
export interface DesktopNavigationStorage {
  getItem(key: string): Promise<string | null>;
  /** Atomic replacement: reject without replacing prior data on failure (NSH Storage contract). */
  setItem(key: string, value: string): Promise<unknown>;
}
export type DesktopNavigationRestoreDecision =
  | { status: 'ready'; target: DesktopNavigationTarget }
  | { status: 'missing' }
  | { status: 'blocked' };
export type DesktopNavigationState = Readonly<{
  restore: 'idle' | 'loading' | 'empty' | 'restored' | 'missing' | 'blocked' | 'superseded' | 'error';
  write: 'idle' | 'pending' | 'error'; restoreError: unknown; writeError: unknown;
}>;
export interface DesktopNavigationOptions {
  storage: DesktopNavigationStorage;
  authority: () => DesktopNavigationAuthority;
  /** Explicit read-only action admission. Lookup exact session/assistant/project and validate
   * its directory here; never authorize from a partial local catalog. GET 404 => missing;
   * 401/5xx must throw, not return missing. Use the captured native scope, check current()
   * across awaits, and respect the existing navigation/dirty guards. No create/send. */
  requestRestore: (target: DesktopNavigationTarget, context: DesktopNavigationContext) => Promise<DesktopNavigationRestoreDecision>;
  /** Synchronous CAS apply only, after the above admission. Return false if a root guard
   * refuses. Do not select/connect a Host, send a model request or replay a receipt.
   * Use raw root route apply, not a wrapper that calls userNavigated for user intents. */
  onRestore: (target: DesktopNavigationTarget, context: DesktopNavigationContext) => boolean;
  onChange?: (state: DesktopNavigationState) => void;
}
export const desktopNavigationStorageKey = 'desktop.navigation.v1';
export const desktopNavigationLimits = Object.freeze({ hosts: 32, bytes: 64 * 1024, entryBytes: 8 * 1024 });

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('navigation_invalid_record');
  return value as Record<string, unknown>;
}
function exact(row: Record<string, unknown>, keys: readonly string[]) {
  if (Object.keys(row).some(key => !keys.includes(key))) throw new Error('navigation_private_fields');
}
function field(value: unknown, max: number, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value) || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('navigation_invalid_field');
  return value;
}
/** UTF-8 budget without depending on DOM TextEncoder in QuickJS. */
export function desktopNavigationBytes(value: string): number {
  let size = 0;
  for (const char of value) { const code = char.codePointAt(0)!; size += code < 128 ? 1 : code < 2048 ? 2 : code < 65536 ? 3 : 4; }
  return size;
}
export function desktopNavigationTargetFrom(value: unknown): DesktopNavigationTarget {
  const row = object(value);
  if (row.kind === 'home') {
    exact(row, ['kind', 'section']);
    if (row.section !== 'assistants' && row.section !== 'schedules') throw new Error('navigation_invalid_home_section');
    return Object.freeze({ kind: 'home', section: row.section });
  }
  const directory = field(row.directory, 4096, row.kind === 'assistant' || row.kind === 'new-session');
  switch (row.kind) {
    case 'session':
      exact(row, ['kind', 'sessionID', 'directory', 'messageID']);
      return Object.freeze({ kind: 'session', sessionID: field(row.sessionID, 256), directory,
        ...(row.messageID === undefined ? {} : { messageID: field(row.messageID, 256) }) });
    case 'assistant':
      exact(row, ['kind', 'assistantID', 'directory']);
      return Object.freeze({ kind: 'assistant', assistantID: field(row.assistantID, 256), directory });
    case 'new-session':
      exact(row, ['kind', 'projectID', 'directory']);
      return Object.freeze({ kind: 'new-session', directory, ...(row.projectID === undefined ? {} : { projectID: field(row.projectID, 256) }) });
    case 'project':
      exact(row, ['kind', 'projectID', 'directory']);
      return Object.freeze({ kind: 'project', projectID: field(row.projectID, 256), directory });
    default: throw new Error('navigation_invalid_kind');
  }
}
function partitionFrom(value: unknown): DesktopNavigationPartition {
  const row = object(value); exact(row, ['connectionID', 'origin', 'authorizationID']);
  const connectionID = field(row.connectionID, 256), origin = field(row.origin, 2048), authorizationID = field(row.authorizationID, 128);
  // Origin only: no userinfo, path, query, fragment or credentials. Native owns endpoint parsing.
  if (!/^https?:\/\/(?:[a-z0-9.-]+|\[[a-f0-9:]+\])(?::[0-9]{1,5})?$/.test(origin)
    || !/^[a-zA-Z0-9_-]+$/.test(authorizationID) || authorizationID === 'legacy') throw new Error('navigation_invalid_partition');
  return Object.freeze({ connectionID, origin, authorizationID });
}
export function desktopNavigationPartition(authority: DesktopNavigationAuthority): DesktopNavigationPartition | null {
  const { connection, runtimeScope, confirmed } = authority;
  if (!confirmed || !connection || runtimeScope?.hostID !== connection.id || typeof runtimeScope.lease !== 'string' || !runtimeScope.lease || runtimeScope.lease.trim() !== runtimeScope.lease) return null;
  try {
    // Normalize the optional root slash and case, but never drop a non-origin URL component.
    return partitionFrom({ connectionID: connection.id, origin: connection.url.replace(/\/$/, '').toLowerCase(), authorizationID: connection.authorizationID });
  } catch { return null; }
}
const partitionKey = (partition: DesktopNavigationPartition) => JSON.stringify([partition.connectionID, partition.origin, partition.authorizationID]);
type Entry = { partition: DesktopNavigationPartition; target: DesktopNavigationTarget };
type Mutation = Entry & { revision: number; remove?: string };
const entryKey = (entry: Entry) => partitionKey(entry.partition);
function serialize(entries: readonly Entry[]): string { return JSON.stringify({ version: 1, entries }); }
function entryFrom(value: unknown): Entry {
  const row = object(value); exact(row, ['partition', 'target']);
  const entry = { partition: partitionFrom(row.partition), target: desktopNavigationTargetFrom(row.target) };
  if (desktopNavigationBytes(JSON.stringify(entry)) > desktopNavigationLimits.entryBytes) throw new Error('navigation_entry_too_large');
  return entry;
}
function deserialize(raw: string | null): Entry[] {
  if (raw === null) return [];
  if (desktopNavigationBytes(raw) > desktopNavigationLimits.bytes) throw new Error('navigation_store_too_large');
  const row = object(JSON.parse(raw)); exact(row, ['version', 'entries']);
  if (row.version !== 1 || !Array.isArray(row.entries) || row.entries.length > desktopNavigationLimits.hosts) throw new Error('navigation_invalid_store');
  const entries = row.entries.map(entryFrom);
  if (new Set(entries.map(entryKey)).size !== entries.length) throw new Error('navigation_duplicate_partition');
  return entries;
}
function bounded(entries: Entry[]): Entry[] {
  while (entries.length > desktopNavigationLimits.hosts || desktopNavigationBytes(serialize(entries)) > desktopNavigationLimits.bytes) entries.shift();
  return entries;
}
function sameResource(left: DesktopNavigationTarget, right: DesktopNavigationTarget): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'home' && right.kind === 'home') return left.section === right.section;
  if (left.kind === 'session' && right.kind === 'session') return left.sessionID === right.sessionID && left.messageID === right.messageID;
  if (left.kind === 'assistant' && right.kind === 'assistant') return left.assistantID === right.assistantID;
  if (left.kind === 'project' && right.kind === 'project') return left.projectID === right.projectID;
  return left.kind === 'new-session' && right.kind === 'new-session' && left.directory === right.directory && left.projectID === right.projectID;
}

/** One application-root owner per Storage key, not a global store. One load, one validation
 * flight, one serial write flight, <=32 coalesced pending partitions. Lease changes fence
 * requests without changing disk identity. Queued writes retain their EXACT partition even
 * after navigation/Host retirement. All user intents (including same-route/back/overlays)
 * must call userNavigated BEFORE awaiting; startup restore never outranks that intent.
 * A failed flush/close preserves disk prior + bounded pending values for explicit retry. */
export function createDesktopNavigationPersistence(options: DesktopNavigationOptions) {
  let state: DesktopNavigationState = { restore: 'idle', write: 'idle', restoreError: null, writeError: null };
  let alive = true, epoch = 0, userRevision = 0, mutationRevision = 0, observed: string | null = null;
  let entries: Entry[] = [], loaded = false, loading: Promise<void> | undefined;
  let writeFlight: Promise<boolean> | undefined, restoreFlight: Promise<void> | undefined, restoreRequested = false;
  let settled: { partition: string; status: 'empty' | 'missing' | 'restored' } | undefined;
  const pending = new Map<string, Mutation>();
  const publish = (patch: Partial<DesktopNavigationState>) => { state = { ...state, ...patch }; if (alive) options.onChange?.(state); };
  const authority = () => {
    const source = options.authority(), partition = desktopNavigationPartition(source);
    return partition && source.runtimeScope ? { partition, runtimeScope: Object.freeze({ ...source.runtimeScope }) } : null;
  };
  const identity = (value: ReturnType<typeof authority>) => value ? JSON.stringify([partitionKey(value.partition), value.runtimeScope.lease]) : null;
  async function load() {
    if (loaded) return;
    if (!loading) loading = options.storage.getItem(desktopNavigationStorageKey).then(raw => { entries = deserialize(raw); loaded = true; }).finally(() => { loading = undefined; });
    await loading;
  }
  async function drain(): Promise<boolean> {
    try {
      await load();
      while (pending.size) {
        const batch = [...pending.values()];
        let next = [...entries];
        for (const mutation of batch) {
          const key = entryKey(mutation), previous = next.find(entry => entryKey(entry) === key);
          if (mutation.remove !== undefined && JSON.stringify(previous?.target) !== mutation.remove) continue;
          next = next.filter(entry => entryKey(entry) !== key);
          if (mutation.remove === undefined) next.push({ partition: mutation.partition, target: mutation.target });
        }
        next = bounded(next);
        const raw = serialize(next);
        if (raw !== serialize(entries)) await options.storage.setItem(desktopNavigationStorageKey, raw);
        entries = next; // Only confirmed replacement may become the next write's base.
        for (const mutation of batch) if (pending.get(entryKey(mutation))?.revision === mutation.revision) pending.delete(entryKey(mutation));
      }
      publish({ write: 'idle', writeError: null }); return true;
    } catch (writeError) { publish({ write: 'error', writeError }); return false; }
  }
  function flush(): Promise<boolean> {
    if (writeFlight) return writeFlight;
    if (!pending.size) return Promise.resolve(true);
    writeFlight = drain().then(success => {
      writeFlight = undefined;
      return success && pending.size ? flush() : success;
    });
    return writeFlight;
  }
  function enqueue(entry: Entry, remove?: string) {
    const key = entryKey(entry);
    pending.delete(key); pending.set(key, { ...entry, revision: ++mutationRevision, ...(remove === undefined ? {} : { remove }) });
    while (pending.size > desktopNavigationLimits.hosts) pending.delete(pending.keys().next().value!);
    publish({ write: 'pending', writeError: null }); void flush();
  }
  function context(): DesktopNavigationContext | null {
    const captured = authority(), ticket = epoch, revision = userRevision, signature = identity(captured);
    if (!captured) return null;
    return Object.freeze({ ...captured, current: () => alive && epoch === ticket && userRevision === revision && identity(authority()) === signature });
  }
  async function attemptRestore() {
    const captured = context();
    if (!captured || userRevision) return;
    settled = undefined;
    publish({ restore: 'loading', restoreError: null });
    try {
      await load();
      if (!captured.current()) return;
      const entry = entries.find(row => entryKey(row) === partitionKey(captured.partition));
      if (!entry) { settled = { partition: partitionKey(captured.partition), status: 'empty' }; publish({ restore: 'empty', restoreError: null }); return; }
      let decision: DesktopNavigationRestoreDecision;
      try { decision = await options.requestRestore(entry.target, captured); }
      catch (error) {
        if (!captured.current()) return;
        if (entry.target.kind !== 'home' && error && typeof error === 'object' && 'status' in error && error.status === 404) decision = { status: 'missing' };
        else throw error;
      }
      if (!captured.current()) return;
      if (decision.status === 'missing') {
        if (entry.target.kind === 'home') throw new Error('navigation_home_cannot_be_missing');
        enqueue(entry, JSON.stringify(entry.target));
        if (captured.current()) { settled = { partition: partitionKey(captured.partition), status: 'missing' }; publish({ restore: 'missing', restoreError: null }); }
        return;
      }
      if (decision.status === 'blocked') { publish({ restore: 'blocked', restoreError: null }); return; }
      if (decision.status !== 'ready') throw new Error('navigation_invalid_admission');
      const target = entryFrom({ partition: captured.partition, target: decision.target }).target;
      if (!sameResource(entry.target, target)) throw new Error('navigation_admission_resource_mismatch');
      if (!captured.current()) return;
      if (options.onRestore(target, captured) !== true) { if (captured.current()) publish({ restore: 'blocked' }); return; }
      if (!captured.current()) return;
      settled = { partition: partitionKey(captured.partition), status: 'restored' };
      publish({ restore: 'restored', restoreError: null });
      if (captured.current() && JSON.stringify(target) !== JSON.stringify(entry.target)) enqueue({ partition: captured.partition, target });
    } catch (restoreError) { if (captured.current()) publish({ restore: 'error', restoreError }); }
  }
  function restore(): Promise<void> {
    if (!alive || userRevision) return Promise.resolve();
    if (restoreFlight) return restoreFlight;
    restoreRequested = true;
    restoreFlight = (async () => {
      while (restoreRequested && alive && !userRevision) { restoreRequested = false; await attemptRestore(); }
    })().then(() => {
      restoreFlight = undefined;
      if (restoreRequested && alive && !userRevision) return restore();
    });
    return restoreFlight;
  }
  function synchronize() {
    const current = authority(), next = identity(current);
    if (observed === next) return;
    observed = next; epoch++;
    publish({ restore: userRevision ? 'superseded' : 'idle', restoreError: null });
    if (next && current && !userRevision) {
      // Foreground lease adoption is not another navigation/restart. Only unfinished
      // validation needs reissuing; a settled route must not be pushed twice.
      if (settled?.partition === partitionKey(current.partition)) { publish({ restore: settled.status }); return; }
      settled = undefined;
      if (restoreFlight) restoreRequested = true; else void restore();
    }
  }
  function save(target: DesktopNavigationTarget, expected: DesktopNavigationAuthority): boolean {
    const partition = desktopNavigationPartition(expected), now = authority();
    if (!alive || !partition || !now || partitionKey(partition) !== partitionKey(now.partition) || expected.runtimeScope?.lease !== now.runtimeScope.lease) return false;
    const entry = entryFrom({ partition, target });
    userNavigated(); enqueue(entry); return true;
  }
  function captureAuthority(): DesktopNavigationAuthority | null {
    const value = authority();
    return value ? Object.freeze({ confirmed: true, runtimeScope: value.runtimeScope,
      connection: Object.freeze({ id: value.partition.connectionID, url: value.partition.origin, authorizationID: value.partition.authorizationID }) }) : null;
  }
  function userNavigated() {
    userRevision++; epoch++; restoreRequested = false;
    if (alive) publish({ restore: 'superseded', restoreError: null });
  }
  const dispose = () => { alive = false; epoch++; restoreRequested = false; return flush(); };
  return {
    snapshot: () => state, synchronize, restore, retryRestore: restore, userNavigated, captureAuthority, save,
    flush, retryWrite: flush,
    async close() { if (!await flush()) return false; await dispose(); return true; },
    dispose,
  };
}
