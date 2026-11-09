/** Runtime-only GET continuity. No credentials, transport objects, timers or live authority. */
export function createNativeCatalogCache(maxEntries = 48, maxBytes = 8 * 1024 * 1024) {
  type Entry = { value?: unknown; bytes: number; revision: number; flight?: Promise<unknown> };
  const entries = new Map<string, Entry>();
  const touch = (key: string, entry: Entry) => { entries.delete(key); entries.set(key, entry); };
  const entryFor = (key: string) => { const entry = entries.get(key) ?? { bytes: 0, revision: 0 }; touch(key, entry); return entry; };
  function trim() {
    let bytes = [...entries.values()].reduce((sum, entry) => sum + entry.bytes, 0);
    for (const [key, entry] of entries) {
      if (entries.size <= maxEntries && bytes <= maxBytes) break;
      bytes -= entry.bytes; entries.delete(key);
    }
  }
  function store<T>(key: string, entry: Entry, value: T): T {
    // UTF-16 upper bound avoids TextEncoder/browser dependencies in QuickJS.
    const encoded = JSON.stringify(value), bytes = encoded.length * 2;
    if (bytes > maxBytes) { entries.delete(key); return value; }
    if (entry.value !== undefined && JSON.stringify(entry.value) === encoded) { touch(key, entry); trim(); return entry.value as T; }
    entry.value = value; entry.bytes = bytes; touch(key, entry); trim();
    return value;
  }
  return {
    peek<T>(key: string): T | undefined { const entry = entries.get(key); if (entry) touch(key, entry); return entry?.value as T | undefined; },
    write<T>(key: string, value: T) { const entry = entryFor(key); entry.revision++; store(key, entry, value); },
    refresh<T>(key: string, load: (previous: T | undefined) => Promise<T>): Promise<T> {
      const entry = entryFor(key);
      if (entry.flight) return entry.flight as Promise<T>;
      const revision = entry.revision;
      const work = Promise.resolve().then(() => load(entry.value as T | undefined)).then(value => {
        // A confirmed mutation wins over the GET that started before it.
        if (entries.get(key) !== entry) return value;
        if (entry.revision !== revision) return entry.value as T;
        return store(key, entry, value);
      });
      entry.flight = work;
      void work.finally(() => { if (entry.flight === work) entry.flight = undefined; trim(); }).catch(() => {});
      return work;
    },
    clear() { entries.clear(); },
  };
}

export const nativeCatalogCache = createNativeCatalogCache();
