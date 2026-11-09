import { describe, expect, test } from 'vitest';
import { createDesktopFilesTree } from './desktop-files-model';
const listed = (...entries: Array<[string, boolean]>) => ({ entries: entries.map(([path, isDirectory]) => ({ path, isDirectory })) });
describe('desktop Host file tree', () => {
  test('loads only expanded directories, keeps their state on collapse/reopen and scopes query to the effective root', async () => {
    const requests: string[] = [];
    const tree = createDesktopFilesTree('/workspace', async path => {
      requests.push(path);
      return path.includes('path=%2Fworkspace%2Fsrc') ? listed(['/workspace/src/a.ts', false]) : listed(['/workspace/z.ts', false], ['/workspace/src', true]);
    }, () => true);
    await tree.load(); expect(requests.length).toBe(1);
    expect(tree.rows().map(row => [row.entry.path, row.depth])).toEqual([['/workspace/src', 0], ['/workspace/z.ts', 0]]);
    await tree.toggle('/workspace/src'); expect(requests.length).toBe(2);
    expect(tree.rows()[1].depth).toBe(1);
    await tree.toggle('/workspace/src'); await tree.toggle('/workspace/src'); expect(requests.length).toBe(2);
    expect(requests[0]).toBe('/api/fs/list?directory=%2Fworkspace&path=%2Fworkspace&respectGitignore=true');
    await expect(tree.load('/elsewhere')).rejects.toThrow();
  });
  test('failed refresh preserves prior children, explicit retry adopts authoritative empty', async () => {
    let mode = 0;
    const tree = createDesktopFilesTree('/workspace', async () => { if (mode === 1) throw new Error('offline'); return mode === 2 ? listed() : listed(['/workspace/a.ts', false]); }, () => true);
    await tree.load(); const previous = tree.state().entries;
    mode = 1; await tree.refresh(); expect(tree.state().entries).toBe(previous); expect(tree.state().error).toContain('offline');
    mode = 2; await tree.refresh(); expect(tree.state()).toMatchObject({ resolved: true, entries: [], error: '' });
  });
  test('Windows drive/UNC roots keep absolute Host listing and search identities', async () => {
    for (const root of ['C:/workspace', '//host/share/project', 'C:/']) {
      const file = root.replace(/\/$/, '') + '/a.ts', calls: string[] = [];
      const tree = createDesktopFilesTree(root, async path => {
        calls.push(path);
        return path.startsWith('/api/fs/find?') ? { data: [{ path: 'a.ts', type: 'file' }] } : listed([file, false]);
      }, () => true);
      await tree.load();
      expect(tree.state().error).toBe(''); expect(tree.rows()[0]?.entry.path).toBe(file);
      await tree.find('a'); expect(tree.rows()[0]?.entry.path).toBe(file);
      expect(calls[0]).toContain('directory=' + encodeURIComponent(root));
      await expect(tree.load('D:/outside')).rejects.toThrow();
    }
  });
  test('one failed directory does not erase another and malformed cyclic/nested children fail explicitly', async () => {
    const tree = createDesktopFilesTree('/workspace', async path => {
      if (path.includes('path=%2Fworkspace%2Fa')) throw new Error('a offline');
      if (path.includes('path=%2Fworkspace%2Fb')) return listed(['/workspace/b/c.ts', false]);
      return listed(['/workspace/a', true], ['/workspace/b', true]);
    }, () => true);
    await tree.load(); await tree.toggle('/workspace/a'); await tree.toggle('/workspace/b');
    expect(tree.state('/workspace/a').error).toContain('offline'); expect(tree.rows().some(row => row.entry.path.endsWith('/c.ts'))).toBe(true);
    const cyclic = createDesktopFilesTree('/workspace', async () => listed(['/workspace', true]), () => true);
    await cyclic.load(); expect(cyclic.state().error).toContain('Invalid directory children');
  });
  test('hide, Host retirement and dispose fence in-flight reads and hidden interaction performs no request', async () => {
    let active = true, calls = 0; const pending: Array<(value: unknown) => void> = [];
    const tree = createDesktopFilesTree('/workspace', () => { calls++; return new Promise(resolve => pending.push(resolve)); }, () => active);
    const old = tree.load(); active = false; tree.cancel(); pending[0](listed(['/workspace/stale', false])); await old;
    expect(tree.rows()).toEqual([]); await tree.load(); await tree.toggle('/workspace/sub'); expect(calls).toBe(1);
    active = true; const next = tree.load(); tree.dispose(); pending[1](listed(['/workspace/retired', false])); await next;
    expect(tree.rows()).toEqual([]);
  });
  test('search uses real listing filters, rejects old queries and preserves previous successful results on failure', async () => {
    const pending: Array<(value: unknown) => void> = [], calls: string[] = [];
    const tree = createDesktopFilesTree('/workspace', path => { calls.push(path); return new Promise(resolve => pending.push(resolve)); }, () => true);
    const one = tree.find('old'), two = tree.find('new');
    pending[1](listed(['/workspace/new.ts', false])); await two;
    pending[0](listed(['/workspace/old.ts', false])); await one;
    expect(tree.rows().map(row => row.entry.name)).toEqual(['new.ts']);
    expect(calls[1]).toBe('/api/fs/list?directory=%2Fworkspace&path=%2Fworkspace&respectGitignore=true');
    const failed = tree.refresh(); pending[2](listed(['/outside/other.ts', false])); await failed;
    expect(tree.search().error).toContain('outside project'); expect(tree.rows()[0].entry.name).toBe('new.ts');
  });
  test('hidden and ignored options affect directory listings and directory/file search consistently without invented find parameters', async () => {
    const calls: string[] = [];
    const tree = createDesktopFilesTree('/workspace', async route => {
      calls.push(route); const url = new URL('https://synthetic.invalid' + route), path = url.searchParams.get('path');
      if (path !== '/workspace') return listed([path + '/match.ts', false]);
      return listed(['/workspace/.hidden-match', true], ['/workspace/match-dir', true], ['/workspace/match-file.ts', false], ...(url.searchParams.get('respectGitignore') === 'false' ? [['/workspace/ignored-match', true] as [string, boolean]] : []));
    }, () => true);
    await tree.load(); expect(tree.rows().map(row => row.entry.name)).toEqual(['match-dir', 'match-file.ts']);
    await tree.filtersChanged({ showHidden: true, showIgnored: true }); await tree.find('match');
    expect(tree.rows().some(row => row.entry.name === '.hidden-match')).toBe(true);
    expect(tree.rows().some(row => row.entry.name === 'ignored-match')).toBe(true);
    await tree.filtersChanged({ searchType: 'directory' }); expect(tree.rows().every(row => row.entry.isDirectory)).toBe(true);
    await tree.filtersChanged({ searchType: 'file' }); expect(tree.rows().every(row => !row.entry.isDirectory)).toBe(true);
    expect(calls.every(route => route.startsWith('/api/fs/list?') && !route.includes('includeHidden'))).toBe(true);
  });
  test('search and expand-all visit bounded frontiers, expose continuation, and collapse/reveal never traverse symbolic links automatically', async () => {
    let calls = 0;
    const tree = createDesktopFilesTree('/workspace', async route => {
      calls++; const path = new URL('https://synthetic.invalid' + route).searchParams.get('path')!;
      return path === '/workspace' ? { entries: [...Array.from({ length: 70 }, (_, i) => ({ path: '/workspace/dir' + i, isDirectory: true })), { path: '/workspace/link', isDirectory: true, isSymbolicLink: true }] } : listed([path + '/match.ts', false]);
    }, () => true);
    await tree.find('match'); expect(calls).toBe(64); expect(tree.search().more).toBe(true);
    await tree.continueSearch(); expect(tree.search().more).toBe(false); expect(tree.rows()).toHaveLength(70); expect(calls).toBe(71);
    await tree.find(''); await tree.expandAll(); expect(tree.expansionRemaining()).toBeGreaterThan(0);
    await tree.expandAll(); expect(tree.expansionRemaining()).toBe(0);
    expect(tree.rows().filter(row => row.depth === 1)).toHaveLength(70);
    tree.collapseAll(); expect(tree.rows().every(row => row.depth === 0)).toBe(true);
    expect(await tree.reveal('/workspace/dir3/match.ts')).toBe(true);
    expect(tree.rows().some(row => row.entry.path === '/workspace/dir3/match.ts')).toBe(true);
    expect(calls).toBe(71);
  });
});
