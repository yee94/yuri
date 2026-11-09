import { resourceKind, resourcePath, resourceWithin, RESOURCE_TEXT_LIMIT } from './resources-model';
import { desktopPanelFilePath, desktopPanelScopeKey, type DesktopPanelScope, type DesktopPanelStoredScope } from './desktop-panel-model';

export type DesktopEditorOperation = {
  scope: DesktopPanelScope;
  current: () => boolean;
  request: (path: string, method?: string, body?: unknown) => Promise<unknown>;
};
export type DesktopEditorError = '' | 'read' | 'write' | 'conflict' | 'unknown' | 'capacity' | 'stale';
type PendingWrite = Readonly<{ text: string; wire: string }>;
export type DesktopEditorState = Readonly<{
  text: string; base: string | null; wire: string | null; eol: '\n' | '\r\n' | '\r'; bom: boolean;
  loaded: boolean; readOnly: boolean; loading: boolean; saving: boolean; discarding: boolean;
  error: DesktopEditorError; detail: string; pending: PendingWrite | null;
  durability: 'ready' | 'pending' | 'error';
}>;
export type DesktopEditorDocument = {
  readonly key: string; readonly scopeKey: string; readonly hostID: string; readonly authorityKey: string; readonly directory: string; readonly path: string;
  readonly storedScope: DesktopPanelStoredScope;
  state: () => DesktopEditorState;
  subscribe: (listener: () => void) => () => void;
};
type Entry = DesktopEditorDocument & { value: DesktopEditorState; listeners: Set<() => void>; refs: number; editRevision: number; retired: boolean; recovered: boolean };
type Stat = { path: string; size: number; mtimeMs: number; isBinary: boolean; mimeType: string };
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
const initial: DesktopEditorState = { text: '', base: null, wire: null, eol: '\n', bom: false, loaded: false, readOnly: false, loading: false, saving: false, discarding: false, error: '', detail: '', pending: null, durability: 'ready' };
export const DESKTOP_EDITOR_LIMITS = Object.freeze({ documents: 20, bytes: 16 * 1024 * 1024, text: RESOURCE_TEXT_LIMIT });
export const desktopEditorDirty = (state: DesktopEditorState) => state.base !== null && state.text !== state.base;
export const desktopEditorProtected = (state: DesktopEditorState) => desktopEditorDirty(state) || state.saving || state.discarding || state.pending !== null || state.error === 'conflict' || state.durability !== 'ready';
const bytes = (state: DesktopEditorState) => 2 * (state.text.length + (state.base?.length ?? 0) + (state.wire?.length ?? 0) + (state.pending?.text.length ?? 0) + (state.pending?.wire.length ?? 0));
const failure = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const normalize = (text: string) => text.replace(/\r\n|\r/g, '\n');
function utf8Bytes(text: string) {
  let size = 0;
  for (const value of text) {
    const code = value.codePointAt(0)!;
    if (code >= 0xD800 && code <= 0xDFFF) return Infinity;
    size += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return size;
}
function decoded(wire: string) {
  const bom = wire.startsWith('\uFEFF'), body = bom ? wire.slice(1) : wire;
  const endings = body.match(/\r\n|\r|\n/g) ?? [];
  const eol = (endings[0] ?? '\n') as DesktopEditorState['eol'];
  // The native editor normalizes newlines. Mixed endings, replacement characters
  // and NUL cannot be round-tripped losslessly through this UTF-8 Host route.
  const readOnly = endings.some(value => value !== eol) || /[\u0000\uFFFD]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(body);
  return { text: normalize(body), bom, eol, readOnly };
}
function statFrom(value: unknown, root: string): Stat {
  const body = object(value);
  if (typeof body.path !== 'string' || body.isFile !== true || typeof body.isBinary !== 'boolean' || !Number.isSafeInteger(body.size) || Number(body.size) < 0 || typeof body.mtimeMs !== 'number' || !Number.isFinite(body.mtimeMs)) throw new Error('desktop_file_invalid_stat');
  const path = resourcePath(body.path);
  if (!resourceWithin(path, root)) throw new Error('desktop_file_outside_workspace');
  return { path, size: Number(body.size), mtimeMs: body.mtimeMs, isBinary: body.isBinary, mimeType: typeof body.mimeType === 'string' ? body.mimeType : '' };
}

/** Window-owned, bounded editable documents, separate from mounted views and tab
 * scopes. 20 entries / 16MiB of UTF-16 source strings / 1M code units per file.
 * Only clean detached entries may be evicted. Capacity refuses new work instead
 * of losing dirty, mounted or unconfirmed content. No per-keystroke network or
 * collection scan: byte accounting and dirty-scope counts update incrementally. */
export function createDesktopEditors(options: { documents?: number; bytes?: number; text?: number; onProtectionChange?: () => void; onChange?: (document: DesktopEditorDocument) => void; persist?: (document: DesktopEditorDocument, next: DesktopEditorState) => Promise<boolean> } = {}) {
  const limits = { ...DESKTOP_EDITOR_LIMITS, ...options }, entries = new Map<string, Entry>(), protectedScopes = new Map<string, number>();
  const writers = new Map<string, Entry>();
  const mutations = new Set<{ hostID: string; authorityKey: string; directory: string; path: string }>();
  const mutating = (entry: Entry) => [...mutations].some(owner => owner.hostID === entry.hostID && owner.authorityKey === entry.authorityKey && resourceWithin(entry.path, owner.path));
  let used = 0;
  function touch(entry: Entry) { entries.delete(entry.key); entries.set(entry.key, entry); }
  function remove(entry: Entry) { used -= bytes(entry.value); entries.delete(entry.key); entry.retired = true; }
  function reserve(extraBytes: number, extraDocuments: number, except?: Entry) {
    if (extraBytes > limits.bytes) return false;
    for (const entry of entries.values()) {
      if (used + extraBytes <= limits.bytes && entries.size + extraDocuments <= limits.documents) break;
      if (entry !== except && !entry.refs && !entry.value.loading && !desktopEditorProtected(entry.value)) remove(entry);
    }
    return used + extraBytes <= limits.bytes && entries.size + extraDocuments <= limits.documents;
  }
  function update(entry: Entry, patch: Partial<DesktopEditorState>, bounded = true) {
    const prior = entry.value, next = { ...prior, ...patch }, delta = bytes(next) - bytes(prior);
    if (entry.retired) return false;
    if (bounded && delta > 0 && !reserve(delta, 0, entry)) { update(entry, { error: 'capacity', detail: 'desktop_editor_capacity' }, false); return false; }
    used += delta; entry.value = next;
    const protectedBefore = desktopEditorProtected(prior), protectedAfter = desktopEditorProtected(next);
    if (protectedBefore !== protectedAfter) {
      const count = (protectedScopes.get(entry.scopeKey) ?? 0) + (protectedAfter ? 1 : -1);
      if (count) protectedScopes.set(entry.scopeKey, count); else protectedScopes.delete(entry.scopeKey);
      options.onProtectionChange?.();
    }
    entry.listeners.forEach(listener => listener());
    if (prior.text !== next.text || prior.base !== next.base || prior.wire !== next.wire || prior.pending !== next.pending || (prior.error === 'conflict') !== (next.error === 'conflict')) options.onChange?.(entry);
    return true;
  }
  function entryFor(document: DesktopEditorDocument) {
    const entry = entries.get(document.key);
    if (!entry || entry !== document || entry.retired) throw new Error('desktop_editor_retired');
    return entry;
  }
  function admitted(entry: Entry, operation: DesktopEditorOperation) {
    return !entry.retired && !!operation.scope.host.lease && operation.current() && operation.scope.authorityKey === entry.authorityKey && desktopPanelScopeKey(operation.scope) === entry.scopeKey && operation.scope.host.hostID === entry.hostID && resourcePath(operation.scope.directory) === entry.directory;
  }
  const persist = (entry: Entry, next: DesktopEditorState) => options.persist ? options.persist(entry, next) : Promise.resolve(true);
  async function commit(entry: Entry, patch: Partial<DesktopEditorState>) {
    if (!await persist(entry, { ...entry.value, ...patch })) return false;
    return update(entry, patch);
  }
  const route = (entry: Entry, action: string) => `/api/fs/${action}?directory=${encodeURIComponent(entry.directory)}&path=${encodeURIComponent(entry.path)}`;
  async function read(entry: Entry, operation: DesktopEditorOperation) {
    if (!admitted(entry, operation)) throw new Error('desktop_editor_stale');
    const before = statFrom(await operation.request(route(entry, 'stat')), entry.directory);
    if (!admitted(entry, operation)) throw new Error('desktop_editor_stale');
    if (before.size > limits.text || resourceKind(entry.path, before.mimeType, before.isBinary) !== 'text') return { readOnly: true as const, wire: null };
    const wire = await operation.request(route(entry, 'read'));
    if (!admitted(entry, operation)) throw new Error('desktop_editor_stale');
    if (typeof wire !== 'string' || wire.length > limits.text) throw new Error('desktop_file_invalid_text');
    const after = statFrom(await operation.request(route(entry, 'stat')), entry.directory);
    if (!admitted(entry, operation)) throw new Error('desktop_editor_stale');
    if (before.path !== after.path || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.isBinary !== after.isBinary) throw new Error('desktop_file_changed_during_read');
    return { wire, ...decoded(wire) };
  }
  async function load(document: DesktopEditorDocument, operation: DesktopEditorOperation, discard = false) {
    const entry = entryFor(document);
    entry.recovered = false;
    if (!admitted(entry, operation) || entry.value.loading || entry.value.saving || entry.value.discarding || entry.value.pending || mutating(entry)) return false;
    const revision = entry.editRevision;
    update(entry, { loading: true });
    try {
      const next = await read(entry, operation);
      if (!admitted(entry, operation) || revision !== entry.editRevision) return false;
      if (desktopEditorDirty(entry.value) && !discard) {
        if (next.wire !== entry.value.wire) update(entry, { error: 'conflict', detail: 'desktop_file_changed_on_host' });
        else update(entry, { error: '', detail: '' });
        return false;
      }
      if (next.wire === null || next.readOnly) {
        if (desktopEditorDirty(entry.value)) { update(entry, { error: 'conflict', detail: 'desktop_file_changed_format_on_host' }); return false; }
        return update(entry, { loaded: true, readOnly: true, ...(next.wire === null ? {} : { wire: next.wire }), error: '', detail: '' });
      }
      if (discard && desktopEditorProtected(entry.value)) {
        if (!await discardDocument(document)) return false;
        if (!admitted(entry, operation) || entry.editRevision !== revision + 1) return false;
      }
      return update(entry, { loaded: true, readOnly: false, text: next.text, base: next.text, wire: next.wire, bom: next.bom, eol: next.eol, error: '', detail: '' });
    } catch (cause) { if (!entry.retired) update(entry, { error: admitted(entry, operation) ? 'read' : 'stale', detail: failure(cause) }); return false; }
    finally { update(entry, { loading: false }); }
  }
  async function verify(entry: Entry, operation: DesktopEditorOperation) {
    const pending = entry.value.pending;
    if (!pending || !admitted(entry, operation)) return false;
    const latest = await read(entry, operation);
    if (latest.wire === pending.wire) {
      if (!await commit(entry, { base: pending.text, wire: pending.wire, pending: null, error: '', detail: '' })) return false;
      return !desktopEditorDirty(entry.value);
    }
    // Unchanged old contents do not prove a lost POST will never finish. Do not
    // infer a negative receipt or replay that write after a transport failure.
    update(entry, { error: 'unknown', detail: 'desktop_file_write_unconfirmed' });
    return false;
  }
  async function save(document: DesktopEditorDocument, operation: DesktopEditorOperation) {
    const entry = entryFor(document);
    entry.recovered = false;
    if (!admitted(entry, operation) || entry.value.loading || entry.value.saving || entry.value.discarding || entry.value.readOnly || entry.value.base === null) return false;
    if (mutating(entry)) { update(entry, { error: 'write', detail: 'desktop_file_mutation_in_progress' }); return false; }
    if (!desktopEditorDirty(entry.value) && !entry.value.pending) return true;
    const text = entry.value.text, wire = (entry.value.bom ? '\uFEFF' : '') + normalize(text).replace(/\n/g, entry.value.eol);
    if (!entry.value.pending && utf8Bytes(wire) > limits.text) { update(entry, { error: 'capacity', detail: 'desktop_editor_utf8_limit' }); return false; }
    const writerKey = JSON.stringify([entry.hostID, entry.authorityKey, entry.path]), writer = writers.get(writerKey);
    if (writer && writer !== entry) { update(entry, { error: 'write', detail: 'desktop_file_write_in_progress' }); return false; }
    writers.set(writerKey, entry);
    update(entry, { saving: true });
    try {
      if (entry.value.pending) return await verify(entry, operation);
      const latest = await read(entry, operation);
      if (!admitted(entry, operation)) return false;
      if (latest.readOnly || latest.wire !== entry.value.wire) { update(entry, { error: 'conflict', detail: 'desktop_file_changed_on_host' }); return false; }
      if (!update(entry, { pending: { text, wire }, error: '', detail: '' })) return false;
      if (!await persist(entry, entry.value)) { update(entry, { pending: null, error: 'write', detail: 'desktop_editor_journal_failed_before_post' }); return false; }
      if (!admitted(entry, operation)) { update(entry, { error: 'unknown', detail: 'desktop_editor_stale_before_post' }); return false; }
      // Current Host accepts only path/content. No fabricated expectedVersion or
      // If-Match field: this preflight is NOT an atomic compare-and-swap.
      let receipt: unknown;
      try {
        receipt = await operation.request(`/api/fs/write?directory=${encodeURIComponent(entry.directory)}`, 'POST', { path: entry.path, content: wire });
      } catch (cause) {
        // Only this POST's explicit negative receipt can release an uncertain
        // writer. A failed verification GET says nothing about the POST result.
        const status = Number(object(cause).status);
        if (status === 409 || status === 412) update(entry, { pending: null, error: 'conflict', detail: failure(cause) });
        else if (status >= 400 && status < 500 && status !== 408) update(entry, { pending: null, error: 'write', detail: failure(cause) });
        else update(entry, { error: 'unknown', detail: failure(cause) });
        return false;
      }
      const response = object(receipt);
      if (response.success !== true || typeof response.path !== 'string' || resourcePath(response.path) !== entry.path) throw new Error('desktop_file_invalid_write_receipt');
      // This receipt belongs to this exact retained document, even when the user
      // selected another scope after POST. It never clears a newer local edit.
      if (admitted(entry, operation)) {
        const confirmed = await read(entry, operation);
        if (confirmed.wire !== wire) { await commit(entry, { base: text, wire, pending: null, error: 'conflict', detail: 'desktop_file_changed_after_write' }); return false; }
      }
      if (!await commit(entry, { base: text, wire, pending: null, error: '', detail: '' })) return false;
      return !desktopEditorDirty(entry.value);
    } catch (cause) {
      update(entry, { error: entry.value.pending ? 'unknown' : 'write', detail: failure(cause) });
      return false;
    } finally {
      update(entry, { saving: false });
      if (!entry.value.pending && writers.get(writerKey) === entry) writers.delete(writerKey);
    }
  }
  async function discardDocument(document: DesktopEditorDocument) {
    const entry = entryFor(document);
    entry.recovered = false;
    if (entry.value.saving || entry.value.discarding || entry.value.pending || entry.value.base === null) return false;
    const revision = entry.editRevision, base = entry.value.base;
    update(entry, { discarding: true });
    try {
      if (!await persist(entry, { ...entry.value, text: base, error: '', detail: '' })) return false;
      if (revision !== entry.editRevision || entry.value.saving || entry.value.pending) { options.onChange?.(entry); return false; }
      entry.editRevision++;
      return update(entry, { text: base, error: '', detail: '' });
    } finally { update(entry, { discarding: false }); }
  }
  return {
    acquire(scope: DesktopPanelScope, path: string): { document: DesktopEditorDocument; release: () => void } | null {
      const scopeKey = desktopPanelScopeKey(scope), absolute = desktopPanelFilePath(scope.directory, path), key = JSON.stringify([scopeKey, absolute]);
      let entry = entries.get(key);
      if (!entry) {
        if (!reserve(0, 1)) return null;
        const listeners = new Set<() => void>();
        const storedScope = { host: { hostID: scope.host.hostID }, authorityKey: scope.authorityKey, sessionID: scope.sessionID, directory: resourcePath(scope.directory) };
        entry = { key, scopeKey, hostID: scope.host.hostID, authorityKey: scope.authorityKey, storedScope, directory: resourcePath(scope.directory), path: absolute, value: initial, refs: 0, editRevision: 0, retired: false, recovered: false, listeners, state() { return this.value; }, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
        entries.set(key, entry);
      }
      entry.recovered = false; entry.refs++; touch(entry);
      const captured = entry;
      let released = false;
      return { document: captured, release() { if (!released) { released = true; captured.refs--; } } };
    },
    peek(scope: DesktopPanelScope, path: string): DesktopEditorDocument | undefined { return entries.get(JSON.stringify([desktopPanelScopeKey(scope), desktopPanelFilePath(scope.directory, path)])); },
    scopeProtected: (key: string) => protectedScopes.has(key),
    /** A cold buffer can receive its tab metadata without replacing its source.
     * Once adopted or edited, live work wins over every delayed metadata read. */
    scopeRestoreProtected: (key: string) => [...entries.values()].some(entry => entry.scopeKey === key && !entry.recovered && desktopEditorProtected(entry.value)),
    revision: (document: DesktopEditorDocument) => entryFor(document).editRevision,
    admitted: (document: DesktopEditorDocument, operation: DesktopEditorOperation) => admitted(entryFor(document), operation),
    durability(document: DesktopEditorDocument, durability: DesktopEditorState['durability']) { const entry = entryFor(document); return entry.value.durability === durability || update(entry, { durability }); },
    restore(scope: DesktopPanelStoredScope, path: string, state: DesktopEditorState) {
      const scopeKey = desktopPanelScopeKey(scope), absolute = desktopPanelFilePath(scope.directory, path), key = JSON.stringify([scopeKey, absolute]);
      const prior = entries.get(key);
      if (prior) return false;
      if (!reserve(bytes(state), 1)) return false;
      const listeners = new Set<() => void>();
      const entry: Entry = { key, scopeKey, hostID: scope.host.hostID, authorityKey: scope.authorityKey, storedScope: scope, directory: resourcePath(scope.directory), path: absolute, value: initial, refs: 0, editRevision: 1, retired: false, recovered: true, listeners, state() { return this.value; }, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
      const writerKey = JSON.stringify([entry.hostID, entry.authorityKey, entry.path]);
      if (state.pending && writers.has(writerKey)) return false;
      entries.set(key, entry); update(entry, state);
      if (state.pending) writers.set(writerKey, entry);
      return true;
    },
    invalidate(document: DesktopEditorDocument) {
      const entry = entryFor(document);
      entry.editRevision++;
      if (desktopEditorProtected(entry.value)) return update(entry, { error: 'conflict', detail: 'desktop_file_path_changed_on_host' });
      return update(entry, initial);
    },
    beginMutation(scope: DesktopPanelScope, path: string, restoring = false) {
      const owner = { hostID: scope.host.hostID, authorityKey: scope.authorityKey, directory: resourcePath(scope.directory), path: desktopPanelFilePath(scope.directory, path) };
      if ([...mutations].some(other => other.hostID === owner.hostID && other.authorityKey === owner.authorityKey && (resourceWithin(owner.path, other.path) || resourceWithin(other.path, owner.path)))) return null;
      if (!restoring && [...entries.values()].some(entry => entry.hostID === owner.hostID && entry.authorityKey === owner.authorityKey && resourceWithin(entry.path, owner.path) && desktopEditorProtected(entry.value))) return null;
      mutations.add(owner);
      return () => { mutations.delete(owner); };
    },
    dirty: (document: DesktopEditorDocument) => desktopEditorDirty(document.state()),
    protected: (document: DesktopEditorDocument) => desktopEditorProtected(document.state()),
    edit(document: DesktopEditorDocument, text: string) {
      const entry = entryFor(document);
      entry.recovered = false;
      if (entry.value.discarding) return false;
      if (!entry.value.loaded || entry.value.readOnly || text.length > limits.text) { update(entry, { error: 'capacity', detail: 'desktop_editor_text_limit' }); return false; }
      if (entry.value.text === text) return true;
      if (!update(entry, { text: normalize(text) })) return false;
      entry.editRevision++; return true;
    },
    load, save,
    discard: discardDocument,
    forget(document: DesktopEditorDocument) { const entry = entryFor(document); if (entry.refs || entry.value.loading || desktopEditorProtected(entry.value)) return false; remove(entry); return true; },
    stats: () => ({ documents: entries.size, bytes: used, protectedScopes: protectedScopes.size }),
    documents: (): DesktopEditorDocument[] => [...entries.values()],
    dispose() {
      if ([...entries.values()].some(entry => desktopEditorProtected(entry.value))) return false;
      for (const entry of entries.values()) remove(entry);
      return true;
    },
  };
}
export type DesktopEditors = ReturnType<typeof createDesktopEditors>;
