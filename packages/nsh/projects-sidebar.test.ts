import { describe, expect, it, vi } from 'vitest';
import { createProjectsSidebar, parseSidebarFolders, sidebarSessionKey, type SidebarSession, type SidebarWriteJournal } from './projects-sidebar';
import { record, text, type Project } from './model';
import { desktopSidebarOutline } from './desktop-sidebar-tree';
import { formatSessionAsMarkdown } from '../ui/src/lib/export-session-core';

const row = (id: string, directory = '/synthetic', archived = false, parentID?: string): SidebarSession => ({ id, title: id, directory, archived, pinned: false, parentID, updated: 10 });
function fixture(journal: SidebarWriteJournal = new Map()) {
  let live = true;
  let folders = parseSidebarFolders({ version: 1, foldersMap: {}, collapsedFolderIds: [], updatedAt: 0, foreign: { retained: true } });
  let projects = [{ id: 'z', path: '/z', name: 'Z', extra: 'keep' }, { id: 'a', path: '/a', name: 'A' }];
  const writes: Array<{ path: string; body: unknown }> = [];
  const restored = vi.fn(), adopted = vi.fn();
  let handler = async (path: string, method = 'GET', body?: unknown): Promise<unknown> => {
    if (path === '/api/session-folders') { if (method === 'POST') { writes.push({ path, body }); folders = parseSidebarFolders(body); return { success: true }; } return folders; }
    if (path === '/api/config/settings') { if (method === 'PUT') { writes.push({ path, body }); projects = record(body).projects as typeof projects; return { projects }; } return { projects, activeProjectId: 'z' }; }
    if (path.startsWith('/api/session/z?')) return { data: { id: 'z', directory: '/synthetic' } };
    throw new Error(`Unexpected synthetic request: ${path}`);
  };
  const request = vi.fn((path: string, method?: string, body?: unknown) => handler(path, method, body));
  const parse = (value: unknown, directory = '/synthetic'): SidebarSession => { const raw = record(value); return { ...row(text(raw.id), text(record(raw.location).directory) || text(raw.directory) || directory, Number(record(raw.time).archived) > 0, text(raw.parentID) || undefined), title: text(raw.title) || text(raw.id) }; };
  const owner = createProjectsSidebar({ capture: () => ({ current: () => live, request }), current: () => live, changed: () => {}, session: parse, visible: value => !text(record(value).title).startsWith('[Scheduled]'), restored, projects: (rows: Project[]) => adopted(rows), journal, directories: scope => [scope] });
  return { owner, request, writes, restored, adopted, journal, folders: () => folders,
    replaceFolders: (value: typeof folders) => { folders = value; }, retire: () => { live = false; owner.pause(); },
    intercept: (next: typeof handler) => { const previous = handler; handler = next; return previous; },
  };
}
describe('Projects sidebar owning extension: real protocols, synthetic Host only', () => {
  it('round trips folders, nested membership, collapse, delete and foreign snapshot fields', async () => {
    const f = fixture(); await f.owner.loadFolders();
    const folder = f.owner.newFolder('Root'); await f.owner.folders('/synthetic', { kind: 'create', folder });
    const child = f.owner.newFolder('Child', folder.id); await f.owner.folders('/synthetic', { kind: 'create', folder: child });
    await f.owner.folders('/synthetic', { kind: 'member', sessionId: 'z', folderId: child.id });
    await f.owner.folders('/synthetic', { kind: 'collapse', id: folder.id });
    expect(f.folders().collapsedFolderIds).toEqual([folder.id]); expect(f.folders().foreign).toEqual({ retained: true });
    expect(f.folders().foldersMap['/synthetic']?.[1]?.sessionIds).toEqual(['z']);
    await f.owner.folders('/synthetic', { kind: 'delete', id: folder.id });
    expect(f.folders().foldersMap['/synthetic']).toEqual([]); expect(f.folders().collapsedFolderIds).toEqual([]);
  });
  it('failed reads preserve prior, and an observed snapshot conflict never writes over another client', async () => {
    const f = fixture(); await f.owner.loadFolders(); const prior = f.owner.snapshot().folders;
    let previous!: ReturnType<typeof f.intercept>;
    previous = f.intercept(async (...args) => { if (args[0] === '/api/session-folders') throw new Error('offline'); return previous(...args); });
    await f.owner.loadFolders(); expect(f.owner.snapshot().folders).toBe(prior);
    f.intercept(previous); f.replaceFolders({ ...f.folders(), updatedAt: 1 });
    await f.owner.folders('/synthetic', { kind: 'create', folder: f.owner.newFolder('Not saved') });
    expect(f.writes).toEqual([]); expect(f.owner.snapshot().errors['folders-write']).toContain('conflict');
  });
  it('unknown snapshot ACK survives owner replacement and reconciles without a duplicate POST', async () => {
    const f = fixture(); await f.owner.loadFolders(); let writes = 0, rejectRead = false;
    let previous!: ReturnType<typeof f.intercept>;
    previous = f.intercept(async (...args) => {
      if (args[0] === '/api/session-folders' && args[1] === 'POST') { writes++; await previous(...args); rejectRead = true; throw new Error('lost ACK'); }
      if (rejectRead && args[0] === '/api/session-folders') throw new Error('read offline');
      return previous(...args);
    });
    await f.owner.folders('/synthetic', { kind: 'create', folder: f.owner.newFolder('Saved') });
    expect(f.owner.snapshot().unknown).toEqual(['folders-write']); f.owner.dispose(); rejectRead = false;
    const next = fixture(f.journal); next.replaceFolders(f.folders());
    expect(await next.owner.retry('folders-write')).toBe(true); expect(writes).toBe(1); expect(next.writes).toEqual([]);
    expect(next.owner.snapshot().folders?.foldersMap['/synthetic']?.[0]?.name).toBe('Saved');
  });
  it('child expansion follows opaque short pages, keeps prior on failure and rejects foreign directory/parent', async () => {
    const f = fixture(), parent = row('parent'); let broken = false;
    f.intercept(async path => {
      if (broken) throw new Error('child offline');
      const params = new URL(`https://synthetic.invalid${path}`).searchParams, cursor = params.get('cursor');
      expect(params.has('archived')).toBe(false); expect(params.has('order')).toBe(false);
      if (cursor) { expect(params.has('directory')).toBe(false); expect(params.has('parentID')).toBe(false); }
      else { expect(params.get('directory')).toBe('/synthetic'); expect(params.get('parentID')).toBe('parent'); }
      return { data: [row(cursor ? 'child-a' : 'child-z', '/synthetic', false, 'parent')], cursor: cursor ? {} : { next: 'opaque' } };
    });
    await f.owner.loadChildren(parent); expect(f.owner.snapshot().children[sidebarSessionKey(parent)]?.rows.map(row => row.id)).toEqual(['child-z', 'child-a']);
    const prior = f.owner.snapshot().children; broken = true; await f.owner.loadChildren(parent); expect(f.owner.snapshot().children).toBe(prior);
    f.intercept(async () => ({ data: [row('foreign', '/elsewhere', false, 'parent')], cursor: {} }));
    await f.owner.loadChildren(parent); expect(f.owner.snapshot().children).toBe(prior);
    f.intercept(async () => ({ data: [row('foreign', '/synthetic', false, 'other-parent')], cursor: {} }));
    await f.owner.loadChildren(parent); expect(f.owner.snapshot().children).toBe(prior);
  });
  it('filters mixed archive children and keeps walking filtered-empty opaque pages', async () => {
    const f = fixture(), parent = row('parent');
    f.intercept(async path => {
      const cursor = new URL(`https://synthetic.invalid${path}`).searchParams.get('cursor');
      return { data: cursor ? [row('active', '/synthetic', false, 'parent'), { ...row('archived', '/synthetic', true, 'parent'), time: { archived: 10 } }] : [{ ...row('archived-only', '/synthetic', true, 'parent'), time: { archived: 10 } }], cursor: cursor ? {} : { next: 'opaque' } };
    });
    await f.owner.loadChildren(parent);
    expect(f.owner.snapshot().children[sidebarSessionKey(parent)]?.rows.map(row => row.id)).toEqual(['active']);
    expect(f.request).toHaveBeenCalledTimes(2);
    await f.owner.loadChildren({ ...parent, archived: true });
    expect(f.owner.snapshot().children[sidebarSessionKey(parent)]?.rows.map(row => row.id)).toEqual(['archived-only', 'archived']);
  });
  it('archived pages use normal list with client filtering, continue empty pages and retain an explicit next page', async () => {
    const f = fixture();
    f.intercept(async path => {
      const params = new URL(`https://synthetic.invalid${path}`).searchParams, cursor = params.get('cursor');
      expect(params.has('archived')).toBe(false); expect(params.has('order')).toBe(false);
      expect(params.get('directory')).toBe('/synthetic'); expect(params.get('parentID')).toBe('null');
      const archived = (id: string, title = id) => ({ ...row(id), title, time: { archived: 10 } });
      if (!cursor) return { data: [row('active'), archived('scheduled', '[Scheduled] hidden')], cursor: { next: 'filtered' } };
      if (cursor === 'filtered') return { data: [row('another-active'), archived('kept')], cursor: { next: 'last' } };
      return { data: [archived('last')], cursor: {} };
    });
    await f.owner.loadArchived('/synthetic');
    expect(f.owner.snapshot().archived['/synthetic']?.rows.map(row => row.id)).toEqual(['kept']);
    expect(f.owner.snapshot().archived['/synthetic']?.cursor).toBe('last'); expect(f.request).toHaveBeenCalledTimes(2);
    await f.owner.loadArchived('/synthetic', true);
    expect(f.owner.snapshot().archived['/synthetic']?.rows.map(row => row.id)).toEqual(['kept', 'last']);
    const prior = f.owner.snapshot().archived;
    f.intercept(async () => ({ data: [{ ...row('wrong', '/foreign'), time: { archived: 10 } }], cursor: {} }));
    await f.owner.loadArchived('/synthetic'); expect(f.owner.snapshot().archived).toBe(prior);
    expect(f.owner.snapshot().errors['archived:/synthetic']).toContain('scope mismatch');
  });
  it('rejects repeating raw archive cursors instead of treating filtering as exhaustion', async () => {
    const f = fixture(); f.intercept(async () => ({ data: [], cursor: { next: 'cycle' } }));
    await f.owner.loadArchived('/synthetic');
    expect(f.owner.snapshot().archived).toEqual({}); expect(f.request).toHaveBeenCalledTimes(2);
    expect(f.owner.snapshot().errors['archived:/synthetic']).toContain('did not advance');
  });
  it('archive paging isolates directories and restore unknown results only perform GET on retry', async () => {
    const f = fixture(); let archived = true, writes = 0, failRead = false;
    f.intercept(async (path, method) => {
      if (path.startsWith('/api/session?')) { if (path.includes('%2Ffailed')) throw new Error('directory offline'); return { data: [{ ...row('archived'), time: { archived: 10 } }], cursor: {} }; }
      if (method === 'PUT') { writes++; archived = false; failRead = true; throw new Error('unknown ACK'); }
      if (failRead) throw new Error('read offline');
      return { data: { id: 'archived', directory: '/synthetic', time: { archived: archived ? 10 : 0 } } };
    });
    await f.owner.loadArchived('/synthetic'); await f.owner.loadArchived('/failed'); expect(f.owner.snapshot().archived['/synthetic']?.rows).toHaveLength(1);
    const target = row('archived', '/synthetic', true); await f.owner.restore(target); failRead = false;
    await f.owner.retry(`restore:${sidebarSessionKey(target)}`); expect(writes).toBe(1); expect(f.restored).toHaveBeenCalledOnce(); expect(f.owner.snapshot().archived['/synthetic']?.rows).toEqual([]);
  });
  it('project drag writes the real settings registry and preserves non-order metadata', async () => {
    const f = fixture(); expect(await f.owner.reorderProjects('z', 'a')).toBe(true);
    expect(f.writes).toHaveLength(1); expect(f.writes[0]?.path).toBe('/api/config/settings');
    expect((record(f.writes[0]?.body).projects as Array<{ id: string }>).map(row => row.id)).toEqual(['a', 'z']);
    expect((record(f.writes[0]?.body).projects as Array<{ extra?: string }>)[1]?.extra).toBe('keep');
  });
  it('fences delayed child reads and admits no write after lifecycle retirement', async () => {
    const f = fixture(); let release!: (value: unknown) => void;
    f.intercept(() => new Promise(resolve => { release = resolve; }));
    const pending = f.owner.loadChildren(row('parent')); f.retire(); release({ data: [row('child', '/synthetic', false, 'parent')], cursor: {} }); await pending;
    expect(f.owner.snapshot().children).toEqual({}); await f.owner.reorderProjects('z', 'a'); expect(f.writes).toEqual([]);
  });
  it('exports every short opaque history page through the shared Web formatter, never a session mutation', async () => {
    const f = fixture(); f.intercept(async path => {
      if (path.startsWith('/api/session/z?')) return { data: row('z') };
      const older = path.includes('cursor=older');
      return { data: [{ id: older ? 'message-old' : 'message-new', sessionID: 'z', type: 'user', text: older ? 'Earlier' : 'Later' }], cursor: older ? {} : { next: 'older' } };
    });
    const result = await f.owner.exportMarkdown(row('z'), false, 'en');
    expect(result?.content).toBe(formatSessionAsMarkdown([{ info: { role: 'user', time: {} }, parts: [{ type: 'text', text: 'Earlier' }] }, { info: { role: 'user', time: {} }, parts: [{ type: 'text', text: 'Later' }] }], 'z', [], 'en'));
    expect(f.request).toHaveBeenCalledTimes(3); expect(f.writes).toEqual([]);
    await f.owner.share(); expect(f.owner.snapshot().errors.share).toContain('unavailable'); expect(f.request).toHaveBeenCalledTimes(3);
  });
  it('exports only messages before the authoritative revert position, never lexicographic message IDs', async () => {
    const f = fixture(); f.intercept(async path => path.startsWith('/api/session/z?')
      ? { data: { ...row('z'), title: 'Current title', revert: { messageID: 'msg-a' } } }
      : { data: [{ id: 'msg-b', type: 'user', text: 'After revert' }, { id: 'msg-a', type: 'user', text: 'Reverted' }, { id: 'msg-z', type: 'user', text: 'Retained earlier' }], cursor: {} });
    const result = await f.owner.exportMarkdown(row('z'), false, 'en');
    expect(result?.content).toContain('# Current title'); expect(result?.content).toContain('Retained earlier');
    expect(result?.content).not.toContain('Reverted'); expect(result?.content).not.toContain('After revert');
    expect(result?.filename).toMatch(/^current-title-/);
    f.intercept(async () => ({ data: row('foreign', '/elsewhere') }));
    expect(await f.owner.exportMarkdown(row('z'), false)).toBeUndefined();
    expect(f.owner.snapshot().errors[`export:${sidebarSessionKey(row('z'))}`]).toContain('identity mismatch');
  });
  it('exports an explicitly requested subtree with current child agent/model metadata and multipart text', async () => {
    const f = fixture(); f.intercept(async path => {
      if (path.startsWith('/api/session?')) return { data: path.includes('parentID=z') ? [row('child', '/synthetic', false, 'z')] : [], cursor: {} };
      if (path.includes('/message?')) return { data: [{ id: 'message', sessionID: path.includes('/child/') ? 'child' : 'z', type: 'assistant', model: { id: 'model', providerID: 'provider' }, content: [{ type: 'text', text: 'First' }, { type: 'reasoning', text: 'Hidden reasoning' }, { type: 'text', text: 'Second' }] }], cursor: {} };
      return { data: path.includes('/child?') ? { ...row('child', '/synthetic', false, 'z'), agent: 'Agent' } : row('z') };
    });
    const result = await f.owner.exportMarkdown(row('z'), true, 'en');
    expect(result?.content).toContain('Sub-agent: child — Agent'); expect(result?.content).toContain('provider/model');
    expect(result?.content.match(/FirstSecond/g)).toHaveLength(2); expect(result?.content).not.toContain('Hidden reasoning');
    expect(f.writes).toEqual([]);
  });
  it('builds folder-first logical rows with nested children and keeps pinned original homes', () => {
    const f = fixture(), parent = row('parent'), child = row('child', '/synthetic', false, 'parent');
    const folder = { id: 'folder', name: 'Folder', createdAt: 0, sessionIds: ['parent'] };
    const state = { ...f.owner.snapshot(), folders: parseSidebarFolders({ version: 1, foldersMap: { '/synthetic': [folder] }, collapsedFolderIds: [], updatedAt: 0 }), children: { [sidebarSessionKey(parent)]: { rows: [child], cursor: null, loaded: true } } };
    const outline = desktopSidebarOutline({ scope: '/synthetic', roots: [row('ungrouped'), parent], state, expanded: new Set([sidebarSessionKey(parent)]), count: 3, running: new Set(), pins: new Set(['parent']) });
    expect(outline.rows.map(row => row.kind === 'folder' ? row.folder.id : row.session.id)).toEqual(['folder', 'parent', 'child', 'ungrouped']);
    expect(outline.sortable.sessionIds).toEqual(['parent', 'ungrouped']);
  });
  it('does not coalesce distinct simultaneous folder commands into a false success', async () => {
    const f = fixture(); await f.owner.loadFolders(); let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }); let previous!: ReturnType<typeof f.intercept>;
    previous = f.intercept(async (...args) => { if (args[0] === '/api/session-folders' && !args[1]) await gate; return previous(...args); });
    const first = f.owner.folders('/synthetic', { kind: 'create', folder: f.owner.newFolder('First') });
    expect(await f.owner.folders('/synthetic', { kind: 'create', folder: f.owner.newFolder('Second') })).toBeUndefined();
    release(); expect(await first).toBe(true); expect(f.writes).toHaveLength(1);
  });
  it('does not acknowledge a new edit by merely reconciling an earlier unknown write', async () => {
    const f = fixture(); await f.owner.loadFolders(); let previous!: ReturnType<typeof f.intercept>, offline = false;
    previous = f.intercept(async (...args) => {
      if (offline) throw new Error('offline');
      if (args[1] === 'POST') { await previous(...args); offline = true; throw new Error('unknown ACK'); }
      return previous(...args);
    });
    await f.owner.folders('/synthetic', { kind: 'create', folder: f.owner.newFolder('First') });
    offline = false;
    expect(await f.owner.folders('/synthetic', { kind: 'create', folder: f.owner.newFolder('Second') })).toBeUndefined();
    expect(f.owner.snapshot().errors['folders-write']).toContain('prior_write_unresolved');
    expect(await f.owner.retry('folders-write')).toBe(true); expect(f.writes).toHaveLength(1);
    expect(f.folders().foldersMap['/synthetic']?.map(row => row.name)).toEqual(['First']);
  });
  it('does not let an in-flight child snapshot resurrect a confirmed removed session', async () => {
    const f = fixture(), parent = row('parent'); let resolve!: (value: unknown) => void;
    f.intercept(() => new Promise(done => { resolve = done; }));
    const loading = f.owner.loadChildren(parent); f.owner.remove(new Set(['child']));
    resolve({ data: [row('child', '/synthetic', false, 'parent')], cursor: {} }); await loading;
    expect(f.owner.snapshot().children).toEqual({}); expect(f.owner.snapshot().pending).toEqual([]);
  });
  it('rejects malformed schema/ancestry instead of clearing a valid folder catalog', () => {
    for (const foldersMap of ['bad', { '/synthetic': [{ id: 'loop', name: 'Loop', parentId: 'loop', createdAt: 1, sessionIds: [] }] }]) {
      expect(() => parseSidebarFolders({ version: 1, foldersMap, collapsedFolderIds: [], updatedAt: 0 })).toThrow();
    }
  });
  it('validates membership against the real session directory, root and archive state before POST', async () => {
    const f = fixture(); await f.owner.loadFolders(); const folder = f.owner.newFolder('Folder');
    await f.owner.folders('/synthetic', { kind: 'create', folder });
    let previous!: ReturnType<typeof f.intercept>;
    for (const invalid of [row('z', '/foreign'), row('z', '/synthetic', false, 'parent'), { ...row('z'), time: { archived: 10 } }]) {
      previous = f.intercept(async (...args) => args[0].startsWith('/api/session/z?') ? { data: invalid } : previous(...args));
      expect(await f.owner.folders('/synthetic', { kind: 'member', sessionId: 'z', folderId: folder.id })).toBeUndefined();
      expect(f.writes).toHaveLength(1); f.intercept(previous);
    }
    expect(f.folders().foldersMap['/synthetic']?.[0]?.sessionIds).toEqual([]);
  });
});
