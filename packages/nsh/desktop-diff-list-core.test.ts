import { describe, expect, it, vi } from 'vitest';
import { createChangesReader, type ChangesSnapshot, type ChangesSource } from './chat-changes-model';
import { createDesktopDiffList, desktopDiffListDefaultExpandedCount, desktopDiffListFiles } from './desktop-diff-list-core';

const source: ChangesSource = { kind: 'workspace', directory: '/workspace' };
const files = ['z.ts', 'a.ts', 'middle.ts'].map(path => ({ path, staged: false, status: 'M' }));
const patch = (body: string) => `--- a/z.ts\n+++ b/z.ts\n@@ -1 +1 @@\n-OLD\n+${body}\n`;
function fixture() {
  let current = true, fail = false;
  const read = vi.fn(async (path: string) => { if (fail) throw new Error('synthetic failed prior'); return { diff: patch(path) }; });
  const reader = createChangesReader(source, read, () => current), notify = vi.fn();
  const list = createDesktopDiffList({ reader, current: () => current, notify });
  list.configure(files, 'working'); list.active(true);
  return { list, read, reader, notify, fail: (value: boolean) => { fail = value; }, current: (value: boolean) => { current = value; } };
}
describe('desktop diff list, one original source reader', () => {
  it('keeps complete catalog order, truthful workspace/staged membership and Web expansion defaults without a read', () => {
    const snapshot: ChangesSnapshot = { isClean: false, files: [{ path: 'z.ts', index: 'M', working_dir: 'M' }, { path: 'a.ts', index: ' ', working_dir: 'M' }, { path: 'new.ts', index: '?', working_dir: '?' }] };
    expect(desktopDiffListFiles(source, snapshot, 'working').map(file => file.path)).toEqual(['z.ts', 'a.ts', 'new.ts']);
    expect(desktopDiffListFiles(source, snapshot, 'staged').map(file => file.path)).toEqual(['z.ts']);
    expect([6, 7, 12, 13, 25, 26, 1000].map(desktopDiffListDefaultExpandedCount)).toEqual([6, 6, 6, 4, 4, 2, 2]);
    const f = fixture(); expect(f.list.rows().map(row => row.file.path)).toEqual(files.map(file => file.path)); expect(f.read).not.toHaveBeenCalled();
    expect(() => f.list.configure(files, 'turn')).toThrow('source_scope_mismatch');
    expect(() => f.list.configure([...files, files[0]], 'working')).toThrow('invalid_catalog');
  });
  it('reads only genuinely visible+expanded rows, serializes one original reader and reuses cached bodies on revisit', async () => {
    const f = fixture(), [first, second] = f.list.rows();
    f.list.visible([first.key]); await f.list.idle(); expect(f.read).toHaveBeenCalledTimes(1);
    const body = f.list.rows()[0].diff; expect(body).not.toBeNull(); expect(f.list.rows()[1].diff).toBeNull();
    f.list.visible([second.key]); await f.list.idle(); expect(f.read).toHaveBeenCalledTimes(2);
    f.list.visible([first.key]); await f.list.idle(); expect(f.list.rows()[0].diff).toBe(body); expect(f.read).toHaveBeenCalledTimes(2);
    f.list.toggleAll(); f.list.visible(files.map((_, index) => f.list.rows()[index].key)); await f.list.idle(); expect(f.read).toHaveBeenCalledTimes(2);
    f.list.toggleAll(); await f.list.idle(); expect(f.read).toHaveBeenCalledTimes(3);
  });
  it('preserves failed-refresh prior and errors through hide/remount until explicit retry', async () => {
    const f = fixture(), key = f.list.rows()[0].key; f.list.visible([key]); await f.list.idle();
    const body = f.list.rows()[0].diff; f.fail(true); f.list.refresh(); await f.list.idle();
    expect(f.list.rows()[0].diff).toBe(body); expect(f.list.rows()[0].error).toContain('failed prior');
    f.list.active(false); f.list.active(true); f.list.visible([key]); await f.list.idle(); expect(f.read).toHaveBeenCalledTimes(2);
    f.fail(false); f.list.retry(key); await f.list.idle(); expect(f.read).toHaveBeenCalledTimes(3); expect(f.list.rows()[0].error).toBe(''); expect(f.list.rows()[0].diff).not.toBe(body);
  });
  it('keeps working/staged body caches isolated and drives the original select(path, staged) action', async () => {
    const f = fixture(); f.list.visible([f.list.rows()[0].key]); await f.list.idle(); const working = f.list.rows()[0].diff;
    f.list.configure(files.map(file => ({ ...file, staged: true })), 'staged'); f.list.visible([f.list.rows()[0].key]); await f.list.idle();
    expect(f.read.mock.calls[1][0]).toContain('staged=true'); expect(f.list.rows()[0].diff).not.toBe(working);
    f.list.configure(files, 'working'); f.list.visible([f.list.rows()[0].key]); await f.list.idle(); expect(f.list.rows()[0].diff).toBe(working); expect(f.read).toHaveBeenCalledTimes(2);
  });
  it('rejected late results after visibility/target/lane retirement cannot replace body or start another read', async () => {
    for (const retire of ['inactive', 'target', 'hidden', 'dispose', 'authority']) {
      const f = fixture(); let resolve!: (value: { diff: string }) => void;
      f.read.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
      const first = f.list.rows()[0]; f.list.visible([first.key]); await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
      if (retire === 'inactive') f.list.active(false);
      if (retire === 'target') f.list.configure(files.slice(1), 'working');
      if (retire === 'hidden') f.list.visible([]);
      if (retire === 'dispose') f.list.dispose();
      if (retire === 'authority') { f.current(false); f.list.active(false); }
      resolve({ diff: patch('FORBIDDEN_LATE') }); await f.list.idle();
      expect(f.list.rows().some(row => row.diff?.patch?.includes('FORBIDDEN_LATE'))).toBe(false); expect(f.read).toHaveBeenCalledTimes(1);
    }
  });
  it('historical exact snapshots never read current Git and thin failures never become fabricated empty success', async () => {
    const read = vi.fn(async () => { throw new Error('No current Git'); });
    const historical: ChangesSource = { kind: 'turn', directory: '/other', sessionID: 'child', messageID: 'message', files: [{ path: 'z.ts', before: '', after: '' }, { path: 'a.ts' }], loadFile: async () => { throw new Error('exact resolver unavailable'); } };
    const reader = createChangesReader(historical, read), list = createDesktopDiffList({ reader, current: () => true });
    list.configure(desktopDiffListFiles(historical, null, 'turn'), 'turn', { targetPath: 'z.ts' }); list.active(true);
    const [first, thin] = list.rows(); expect(first.expanded).toBe(true); expect(thin.expanded).toBe(false);
    list.visible([first.key]); await list.idle(); expect(list.rows()[0].diff).toBe(historical.files[0]);
    list.focus('a.ts'); list.visible([thin.key]); await list.idle(); expect(list.rows()[1].diff).toBeNull(); expect(list.rows()[1].error).toContain('exact resolver unavailable');
    expect(read).not.toHaveBeenCalled(); expect(() => list.configure(files, 'working')).toThrow('source_scope_mismatch');
  });
  it('1000 metadata rows are retained, but expand-all and 50 no-op visibility/configure updates only demand the real viewport', async () => {
    const f = fixture(), catalog = Array.from({ length: 1000 }, (_, index) => ({ path: 'file-' + index + '.ts', staged: false, status: 'M' }));
    f.list.configure(catalog, 'working'); f.list.toggleAll(); f.list.toggleAll();
    const key = f.list.rows()[999].key; f.list.visible([key]); await f.list.idle();
    expect(f.list.rows()).toHaveLength(1000); expect(f.read).toHaveBeenCalledTimes(1);
    const rows = f.list.rows(), count = f.notify.mock.calls.length;
    for (let index = 0; index < 50; index++) { f.list.configure(catalog, 'working'); f.list.visible([key]); }
    await f.list.idle(); expect(f.list.rows()).toBe(rows); expect(f.notify).toHaveBeenCalledTimes(count); expect(f.read).toHaveBeenCalledTimes(1);
  });
  it('explicit full context uses the original serialized reader, caches per file and never fetches for hidden/collapsed rows', async () => {
    const read = vi.fn(async (route: string) => {
      const url = new URL(route, 'https://fixture.invalid'), path = url.searchParams.get('path')!;
      if (url.pathname === '/api/git/status') return { isClean: false, files: files.map(file => ({ path: file.path, index: ' ', working_dir: 'M' })) };
      if (url.pathname === '/api/git/file-diff') return { path, original: 'OLD\nFULL_CONTEXT_END', modified: 'NEW\nFULL_CONTEXT_END', isBinary: false };
      return { diff: patch('NEW') };
    });
    const reader = createChangesReader(source, read), list = createDesktopDiffList({ reader, current: () => true });
    list.configure(files, 'working'); list.active(true); const [first, second] = list.rows();
    list.visible([first.key]); await list.idle(); list.full(true); await list.idle();
    expect(list.rows()[0].fullContext?.after).toContain('FULL_CONTEXT_END'); expect(list.rows()[1].fullContext).toBeNull();
    expect(read.mock.calls.filter(([route]) => route.includes('file-diff'))).toHaveLength(1);
    list.full(false); list.full(true); await list.idle(); expect(read.mock.calls.filter(([route]) => route.includes('file-diff'))).toHaveLength(1);
    list.visible([second.key]); await list.idle(); expect(list.rows()[1].fullContext?.after).toContain('FULL_CONTEXT_END');
    list.visible([first.key]); await list.idle(); expect(read.mock.calls.filter(([route]) => route.includes('file-diff'))).toHaveLength(2);
  });
  it('authoritative invalidation covers cached scopes, retains prior, cancels old refresh and only rereads demanded scope', async () => {
    const f = fixture(), first = f.list.rows()[0]; f.list.visible([first.key]); await f.list.idle();
    f.list.configure(files.map(file => ({ ...file, staged: true })), 'staged'); f.list.visible([f.list.rows()[0].key]); await f.list.idle();
    f.list.refresh(); await f.list.idle(); expect(f.read).toHaveBeenCalledTimes(3);
    f.list.configure(files, 'working'); f.list.visible([first.key]); await f.list.idle(); expect(f.read).toHaveBeenCalledTimes(4);
    const prior = f.list.rows()[0].diff; let release!: (value: { diff: string }) => void;
    f.read.mockImplementationOnce(() => new Promise(done => { release = done; })); f.list.refresh();
    await vi.waitFor(() => expect(release).toBeTypeOf('function')); f.list.active(false); release({ diff: patch('RETIRED') }); await f.list.idle();
    expect(f.list.rows()[0].diff).toBe(prior); f.list.active(true); await f.list.idle(); expect(f.read).toHaveBeenCalledTimes(6);
    expect(f.list.rows()[0].loading).toBe(false); expect(f.list.rows()[0].diff).not.toBe(prior);
  });
});
