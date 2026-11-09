import { record, type ChatTarget, type Connection, type Message, type MessagePage } from './model';
import type { NativeRevert } from './transcript-actions-core';

type Snapshot = MessagePage & { revert: NativeRevert | null };
type Storage = { getItem: (key: string) => Promise<string | null>; setItem: (key: string, value: string) => Promise<void>; removeItem: (key: string) => Promise<void> };
type Entry = { key: string; slot: string; bytes: number };
type Index = { version: 1; entries: Entry[]; garbage: string[]; pending?: string; retired?: string[]; owners?: Record<string, string | null> };
const indexKey = 'nsh:history-cache:v1:index', prefix = 'nsh:history-cache:v1:record:';
function authorizationOf(key: string): string | undefined {
  try { const value: unknown = JSON.parse(key); if (Array.isArray(value) && typeof value[0] === 'string' && typeof value[1] === 'string') return JSON.stringify(value.slice(0, 2)); } catch { /* Legacy non-JSON keys have no authorization owner. */ }
}

/** Authorization generation, not endpoint or short-lived runtime lease, partitions disk data. */
export function nativeHistoryCacheKey(connection: Connection | null, target: ChatTarget): string | null {
  return connection?.authorizationID ? JSON.stringify([connection.id, connection.authorizationID, target.kind, target.directory, target.id]) : null;
}

/** A cached prefix must stay contiguous and must never restore an unfinished reply as live. */
export function settledHistoryPrefix(messages: readonly Message[]): Message[] {
  const end = messages.findIndex(message => message.contextLive === true || message.role !== 'user' && !Number.isFinite(message.time?.completed));
  return (end < 0 ? messages : messages.slice(0, end)).slice();
}

/** Presentation seeds only. createChat remains the sole message/stream/cursor authority. */
export function createNativeHistoryCache(storage: Storage, limits = { sessions: 12, bytes: 32 * 1024 * 1024, durableSessions: 150 }) {
  const memory = new Map<string, { snapshot: Snapshot; bytes: number }>();
  const revisions = new Map<string, number>();
  const retired = new Set<string>();
  const isRetired = (key: string) => retired.has(authorizationOf(key) ?? '');
  let tail: Promise<unknown> = Promise.resolve(), nextSlot = 0, nextRevision = 0;
  let clearFlight: Promise<void> | undefined, clearVersion = 0;
  function serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = tail.catch(() => {}).then(work); tail = result; return result;
  }
  async function readIndex(): Promise<Index> {
    const raw = await storage.getItem(indexKey);
    if (raw === null) return { version: 1, entries: [], garbage: [] };
    const value = record(JSON.parse(raw));
    const validEntry = (entry: unknown): entry is Entry => { const e = record(entry); return typeof e.key === 'string' && typeof e.slot === 'string' && e.slot.startsWith(prefix) && typeof e.bytes === 'number' && e.bytes >= 0; };
    if (value.version !== 1 || !Array.isArray(value.entries) || !value.entries.every(validEntry) || !Array.isArray(value.garbage) || value.garbage.some(slot => typeof slot !== 'string' || !slot.startsWith(prefix)) || value.pending !== undefined && (typeof value.pending !== 'string' || !value.pending.startsWith(prefix))) throw Error('invalid-history-cache-index');
    if (value.retired !== undefined && (!Array.isArray(value.retired) || value.retired.some(pair => typeof pair !== 'string' || authorizationOf(pair) !== pair))) throw Error('invalid-history-cache-retirements');
    if (value.owners !== undefined && (!value.owners || typeof value.owners !== 'object' || Array.isArray(value.owners) || Object.entries(value.owners).some(([slot, pair]) => !slot.startsWith(prefix) || pair !== null && (typeof pair !== 'string' || authorizationOf(pair) !== pair)))) throw Error('invalid-history-cache-owners');
    const index = value as Index;
    for (const pair of index.retired ?? []) retired.add(pair);
    return index;
  }
  async function clean(index: Index) {
    const garbage = [...new Set([...index.garbage, ...(index.pending ? [index.pending] : [])])];
    const failed = new Map<string, unknown>(), owners: Record<string, string | null> = {};
    for (const slot of garbage) {
      let owner = index.owners?.[slot];
      // Old v1 journals have no owner. Recover from the record before deleting;
      // unreadable/malformed records remain unknown, never proof of exact completion.
      if (owner === undefined) {
        try {
          const raw = await storage.getItem(slot);
          if (raw !== null) {
            const value = record(JSON.parse(raw));
            if (value.version === 1 && typeof value.key === 'string') owner = authorizationOf(value.key) ?? null;
          }
        } catch { /* Deletion may still succeed; only failed slots need an owner. */ }
      }
      try { await storage.removeItem(slot); }
      catch (error) { failed.set(slot, error); if (owner !== undefined) owners[slot] = owner; }
    }
    if (garbage.length) {
      index.garbage = [...failed.keys()]; index.owners = owners; delete index.pending;
      // ACK depends on this journal write, including when every deletion succeeded.
      await storage.setItem(indexKey, JSON.stringify(index));
    }
    return failed;
  }
  function garbageOwners(index: Index, entries: Entry[]): Record<string, string | null> {
    return { ...index.owners, ...Object.fromEntries(entries.map(entry => [entry.slot, authorizationOf(entry.key) ?? null])) };
  }
  function retain(key: string, snapshot: Snapshot, bytes: number) {
    memory.delete(key);
    if (bytes <= limits.bytes) memory.set(key, { snapshot, bytes });
    let total = [...memory.values()].reduce((sum, entry) => sum + entry.bytes, 0);
    for (const [old, entry] of memory) {
      if (memory.size <= limits.sessions && total <= limits.bytes) break;
      total -= entry.bytes; memory.delete(old);
    }
  }
  return {
    /** Capture before peek/read; recheck synchronously at the consumer's seed write. */
    captureRead(key: string | null): () => boolean {
      const version = clearVersion;
      return () => !!key && version === clearVersion && !isRetired(key);
    },
    peek(key: string | null): Snapshot | undefined {
      if (!key || isRetired(key)) return;
      const entry = memory.get(key);
      if (entry) { memory.delete(key); memory.set(key, entry); }
      return entry?.snapshot;
    },
    async read(key: string | null): Promise<Snapshot | undefined> {
      if (!key || isRetired(key)) return;
      const revision = revisions.get(key), version = clearVersion;
      return serialize(async () => {
        if (version !== clearVersion) return;
        const index = await readIndex(); await clean(index);
        if (version !== clearVersion || isRetired(key)) return;
        const entry = index.entries.find(entry => entry.key === key);
        if (!entry) return;
        const raw = await storage.getItem(entry.slot);
        if (version !== clearVersion || raw === null || raw.length * 2 > limits.bytes || revisions.get(key) !== revision) return;
        const value = record(JSON.parse(raw)), snapshot = record(value.snapshot);
        const objectRows = (items: unknown) => Array.isArray(items) && items.every(item => item !== null && typeof item === 'object' && !Array.isArray(item));
        const validMessage = (item: unknown) => { const m = record(item); return typeof m.id === 'string' && !!m.id && ['user', 'assistant', 'compaction'].includes(String(m.role)) && typeof m.text === 'string' && typeof m.reasoning === 'string' && typeof m.error === 'string' && ['tools', 'cards', 'files'].every(field => objectRows(m[field])) && (m.content === undefined || objectRows(m.content)); };
        if (value.version !== 1 || value.key !== key || !Array.isArray(snapshot.messages) || !snapshot.messages.every(validMessage) || new Set(snapshot.messages.map(item => record(item).id)).size !== snapshot.messages.length || !(snapshot.cursor === null || typeof snapshot.cursor === 'string') || typeof snapshot.complete !== 'boolean' || snapshot.revert !== null && typeof record(snapshot.revert).messageID !== 'string') return;
        const result = snapshot as Snapshot;
        if (settledHistoryPrefix(result.messages).length !== result.messages.length) return;
        const originalContent = new Set(Array.isArray(value.originalContentIDs) ? value.originalContentIDs : []);
        for (const message of result.messages) if (originalContent.has(message.id)) message.contextContent = message.content;
        index.entries = [...index.entries.filter(e => e !== entry), entry]; await storage.setItem(indexKey, JSON.stringify(index));
        if (version !== clearVersion || isRetired(key) || revisions.get(key) !== revision) return;
        retain(key, result, raw.length * 2);
        return result;
      });
    },
    write(key: string | null, snapshot: Snapshot, current: () => boolean): Promise<void> {
      if (!key || isRetired(key) || !current()) return Promise.resolve();
      const revision = ++nextRevision, version = clearVersion; revisions.set(key, revision);
      // Serialization happens only after successful history/exact-fill commits, never per token/input.
      const data: Snapshot = { ...snapshot, messages: settledHistoryPrefix(snapshot.messages) };
      const originalContentIDs = data.messages.filter(message => message.contextContent && message.contextContent === message.content).map(message => message.id);
      const raw = JSON.stringify({ version: 1, key, snapshot: data, originalContentIDs }), bytes = raw.length * 2;
      const work = serialize(async () => {
        if (version !== clearVersion || isRetired(key) || !current() || revisions.get(key) !== revision || bytes > limits.bytes) return;
        const index = await readIndex(); await clean(index);
        if (version !== clearVersion || isRetired(key) || !current() || revisions.get(key) !== revision) return;
        retain(key, data, bytes);
        const reserved = new Set([...index.entries.map(entry => entry.slot), ...index.garbage, ...(index.pending ? [index.pending] : [])]);
        let slot: string;
        do { slot = `${prefix}${Date.now().toString(36)}-${++nextSlot}-${Math.random().toString(36).slice(2)}`; } while (reserved.has(slot));
        // Journal the candidate before writing it. A crash/failed commit keeps the old index authoritative.
        const candidate: Index = { ...index, pending: slot, owners: { ...index.owners, [slot]: authorizationOf(key) ?? null } };
        await storage.setItem(indexKey, JSON.stringify(candidate));
        await storage.setItem(slot, raw);
        if (version !== clearVersion || isRetired(key) || !current() || revisions.get(key) !== revision) { await clean(candidate); return; }
        const replaced = index.entries.filter(entry => entry.key === key);
        const entries = [...index.entries.filter(entry => entry.key !== key), { key, slot, bytes }];
        let total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
        while (entries.length > limits.durableSessions || total > limits.bytes) { const entry = entries.shift()!; total -= entry.bytes; replaced.push(entry); }
        const next: Index = { ...index, entries, garbage: [...new Set([...index.garbage, ...replaced.map(entry => entry.slot)])], owners: garbageOwners(index, replaced) };
        await storage.setItem(indexKey, JSON.stringify(next));
        await clean(next);
      });
      return work.finally(() => { if (revisions.get(key) === revision) revisions.delete(key); });
    },
    invalidate(key: string | null): Promise<void> {
      if (!key) return Promise.resolve();
      const revision = ++nextRevision; revisions.set(key, revision); memory.delete(key);
      const work = serialize(async () => {
        const index = await readIndex(); await clean(index);
        const removed = index.entries.filter(entry => entry.key === key);
        const next: Index = { ...index, entries: index.entries.filter(entry => entry.key !== key), garbage: [...new Set([...index.garbage, ...removed.map(entry => entry.slot)])], owners: garbageOwners(index, removed) };
        await storage.setItem(indexKey, JSON.stringify(next)); await clean(next);
      });
      return work.finally(() => { if (revisions.get(key) === revision) revisions.delete(key); });
    },
    retireAuthorization(connectionID: string, authorizationID: string): Promise<void> {
      if (typeof connectionID !== 'string' || !connectionID || typeof authorizationID !== 'string' || !authorizationID) return Promise.reject(Error('invalid-history-cache-authorization'));
      const pair = JSON.stringify([connectionID, authorizationID]);
      retired.add(pair);
      for (const key of memory.keys()) if (authorizationOf(key) === pair) memory.delete(key);
      return serialize(async () => {
        const index = await readIndex();
        const removed = index.entries.filter(entry => authorizationOf(entry.key) === pair);
        const next: Index = { ...index, entries: index.entries.filter(entry => authorizationOf(entry.key) !== pair), retired: [...new Set([...(index.retired ?? []), pair])], garbage: [...new Set([...index.garbage, ...removed.map(entry => entry.slot)])], owners: garbageOwners(index, removed) };
        // Tombstone and deletion journal must be durable before any physical deletion.
        await storage.setItem(indexKey, JSON.stringify(next));
        const failed = await clean(next);
        for (const [slot, error] of failed) if (next.owners?.[slot] === undefined || next.owners[slot] === pair) throw error;
      });
    },
    /** Explicit, confirmed local history cleanup; never an authorization retirement ACK. */
    clear(): Promise<void> {
      if (clearFlight) return clearFlight;
      clearVersion++; memory.clear();
      const work = serialize(async () => {
        const index = await readIndex();
        const next: Index = { ...index, entries: [], garbage: [...new Set([...index.garbage, ...index.entries.map(entry => entry.slot)])], owners: garbageOwners(index, index.entries) };
        await storage.setItem(indexKey, JSON.stringify(next));
        const failed = await clean(next);
        if (failed.size) throw failed.values().next().value;
      });
      clearFlight = work.finally(() => { clearFlight = undefined; });
      return clearFlight;
    },
    clearMemory() { memory.clear(); },
  };
}
