import { resourceEntries, resourceParent, resourcePath, resourceResolve, type ResourceEntry } from './resources-model';

type DirectoryState = Readonly<{ entries: readonly ResourceEntry[]; resolved: boolean; loading: boolean; error: string; more?: boolean }>;
export type DesktopFileRow = { entry: ResourceEntry; depth: number; expanded: boolean; state?: DirectoryState };
const empty: DirectoryState = Object.freeze({ entries: Object.freeze([]), resolved: false, loading: false, error: '' });

/** One scope-owned lazy tree. A failed directory preserves only its own prior
 * children; retries are explicit. Hidden trees invalidate reads, not snapshots. */
export function createDesktopFilesTree(directory: string, read: (path: string) => Promise<unknown>, current: () => boolean, notify: () => void = () => {}) {
  const root = resourcePath(directory), directories = new Map<string, DirectoryState>();
  const expanded = new Set<string>([root]), serials = new Map<string, number>();
  let search: DirectoryState = empty, query = '', searchSerial = 0, alive = true, showHidden = false, showIgnored = false;
  let searchType: 'all' | 'file' | 'directory' = 'all', searchQueue: string[] = [], expansionQueue: string[] = [];
  const searchQueued = new Set<string>(), expansionQueued = new Set<string>();
  const found = new Map<string, ResourceEntry>(), searched = new Set<string>(), linked = new Set<string>();
  let searchRowsSource = search.entries, searchRowsHidden = showHidden, searchRows: DesktopFileRow[] = [];
  const filtered = (entries: readonly ResourceEntry[]) => entries.filter(entry => showHidden || !entry.name.startsWith('.'));
  const state = (path = root) => directories.get(path) ?? empty;
  const update = (path: string, next: Partial<DirectoryState>) => { directories.set(path, { ...state(path), ...next }); notify(); };
  function within(path: string) {
    return resourceResolve(path, root);
  }
  async function load(path = root) {
    path = within(path);
    if (!alive || !current() || state(path).loading) return false;
    const serial = (serials.get(path) ?? 0) + 1;
    serials.set(path, serial); update(path, { loading: true });
    const valid = () => alive && current() && serials.get(path) === serial;
    try {
      const raw = await read(`/api/fs/list?directory=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}&respectGitignore=${!showIgnored}`);
      const entries = resourceEntries(raw, root);
      if (entries.some(entry => entry.path === path || resourceParent(entry.path, root) !== path)) throw new Error('Invalid directory children');
      if (valid()) {
        for (const entry of entries) linked.delete(entry.path);
        for (const entry of (raw as { entries: Array<{ path: string; isSymbolicLink?: boolean }> }).entries) if (entry.isSymbolicLink) linked.add(entry.path);
        update(path, { entries, resolved: true, error: '' }); return true;
      }
    } catch (cause) { if (valid()) update(path, { error: String(cause) }); }
    finally { if (valid()) update(path, { loading: false }); }
    return false;
  }
  async function continueSearch() {
    if (!alive || !current() || search.loading || !query) return;
    const serial = searchSerial, term = query.toLocaleLowerCase();
    search = { ...search, loading: true }; notify();
    const valid = () => alive && current() && serial === searchSerial;
    const results = () => [...found.values()].sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.path.localeCompare(b.path));
    let budget = 64;
    while (valid() && searchQueue.length && budget-- > 0) {
      const path = searchQueue[0];
      if (!state(path).resolved || state(path).error) {
        if (!await load(path)) { if (valid()) { search = { ...search, ...(found.size ? { entries: results() } : {}), loading: false, error: state(path).error || 'desktop_file_search_interrupted', more: true }; notify(); } return; }
      }
      if (!valid()) return;
      searchQueue.shift(); searchQueued.delete(path); searched.add(path);
      for (const entry of filtered(state(path).entries)) {
        if (entry.path.slice(root.length).toLocaleLowerCase().includes(term) && (searchType === 'all' || entry.isDirectory === (searchType === 'directory'))) found.set(entry.path, entry);
        if (entry.isDirectory && !linked.has(entry.path) && !searched.has(entry.path) && !searchQueued.has(entry.path)) { searchQueue.push(entry.path); searchQueued.add(entry.path); }
      }
    }
    if (valid()) { search = { entries: results(), resolved: true, error: '', loading: false, more: searchQueue.length > 0 }; notify(); }
  }
  async function find(term: string) {
    cancel(); query = term.trim(); ++searchSerial; search = { ...search, loading: false };
    searchQueue = [root]; searchQueued.clear(); searchQueued.add(root); found.clear(); searched.clear();
    if (!query) { search = empty; notify(); return; }
    await continueSearch();
  }
  function cancel() {
    searchSerial++;
    for (const [path, value] of directories) { serials.set(path, (serials.get(path) ?? 0) + 1); if (value.loading) directories.set(path, { ...value, loading: false }); }
    search = { ...search, loading: false }; notify();
  }
  return { root, state, load, find, continueSearch, search: () => search, query: () => query,
    filters: () => ({ showHidden, showIgnored, searchType }),
    async filtersChanged(next: { showHidden?: boolean; showIgnored?: boolean; searchType?: typeof searchType }) {
      cancel();
      expansionQueue = []; expansionQueued.clear();
      if (next.showHidden !== undefined) showHidden = next.showHidden;
      if (next.searchType !== undefined) searchType = next.searchType;
      if (next.showIgnored !== undefined && next.showIgnored !== showIgnored) {
        showIgnored = next.showIgnored;
        for (const [path, value] of directories) directories.set(path, { ...value, resolved: false });
      }
      notify();
      if (query) await find(query); else await this.refresh();
    },
    async toggle(path: string) {
      path = within(path);
      if (!alive || !current()) return;
      if (expanded.has(path)) { expanded.delete(path); notify(); return; }
      expanded.add(path); notify();
      if (!state(path).resolved && !state(path).error) await load(path);
    },
    rows(): DesktopFileRow[] {
      if (query) {
        if (searchRowsSource !== search.entries || searchRowsHidden !== showHidden) { searchRowsSource = search.entries; searchRowsHidden = showHidden; searchRows = filtered(search.entries).map(entry => ({ entry, depth: 0, expanded: false })); }
        return searchRows;
      }
      const rows: DesktopFileRow[] = [];
      function visit(path: string, depth: number) {
        for (const entry of filtered(state(path).entries)) {
          const open = entry.isDirectory && expanded.has(entry.path);
          rows.push({ entry, depth, expanded: open, ...(entry.isDirectory ? { state: state(entry.path) } : {}) });
          if (open) visit(entry.path, depth + 1);
        }
      }
      visit(root, 0); return rows;
    },
    async refresh() {
      if (query) { for (const [path, value] of directories) directories.set(path, { ...value, resolved: false }); return find(query); }
      // Refresh only the expanded visible frontier, not every visited directory.
      await load(root);
      const visible = this.rows().filter(row => row.expanded).map(row => row.entry.path);
      for (const path of visible) { if (!alive || !current()) return; await load(path); }
    },
    collapseAll() { expansionQueue = []; expansionQueued.clear(); expanded.clear(); expanded.add(root); notify(); },
    expansionRemaining: () => expansionQueue.length,
    async expandAll() {
      if (!expansionQueue.length) { expansionQueue = [root]; expansionQueued.add(root); }
      let budget = 64;
      while (alive && current() && expansionQueue.length && budget-- > 0) {
        const path = expansionQueue[0]; expanded.add(path);
        if ((!state(path).resolved || state(path).error) && !await load(path)) return;
        expansionQueue.shift(); expansionQueued.delete(path);
        for (const entry of filtered(state(path).entries)) if (entry.isDirectory && !linked.has(entry.path) && !expanded.has(entry.path) && !expansionQueued.has(entry.path)) { expansionQueue.push(entry.path); expansionQueued.add(entry.path); }
        notify();
      }
    },
    async reveal(path: string) {
      path = within(path); const parents: string[] = [];
      for (let parent = resourceParent(path, root); parent !== null; parent = resourceParent(parent, root)) parents.unshift(parent);
      for (const parent of parents) {
        if (!alive || !current()) return false;
        expanded.add(parent);
        if ((!state(parent).resolved || state(parent).error) && !await load(parent)) return false;
      }
      notify(); return this.rows().some(row => row.entry.path === path);
    },
    cancel,
    dispose() { alive = false; cancel(); directories.clear(); expanded.clear(); },
  };
}
