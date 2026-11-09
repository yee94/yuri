import { describe, expect, test, vi } from 'vitest';
import { readDesktopWorkStatusChildren, desktopWorkStatusChildReadLimits } from './desktop-work-status-source-children';
import type { PageOperation } from './page-operations';
import type { DesktopWorkStatusScope } from './desktop-work-status-core';

const scope: DesktopWorkStatusScope = { host: { hostID: 'fixture', lease: 'one' }, authorityKey: 'scope', sessionID: 'parent', directory: '/fixture/project' };
const row = (id = 'child') => ({ id, parentID: scope.sessionID, location: { directory: scope.directory }, title: id, execution: { type: 'running' } });
const page = (data = [row()], next: string | null = null) => ({ data, cursor: { next } });
function lane(read: (path: string, method?: string, body?: unknown) => Promise<unknown>, current = () => true): PageOperation { return { scope: scope.host, generation: 1, current, request: read }; }

describe('explicit exact-parent WorkStatus child reader', () => {
  test('formal scoped context plus actual session.list directory filter, no active GET or historical idle inference', async () => {
    const read = vi.fn(async () => page());
    expect(await readDesktopWorkStatusChildren(lane(read), scope)).toEqual([{ id: 'child', parentID: 'parent', directory: '/fixture/project', title: 'child', activity: 'unknown' }]);
    expect(read.mock.calls).toEqual([['/api/session?location%5Bdirectory%5D=%2Ffixture%2Fproject&directory=%2Ffixture%2Fproject&parentID=parent&limit=200', 'GET']]);
  });
  test('cursor pages follow the exact-parent cursor through completion, retaining order, no directory enumeration', async () => {
    const read = vi.fn().mockResolvedValueOnce(page([row('z')], 'opaque/a')).mockResolvedValueOnce(page([row('a')], null));
    expect((await readDesktopWorkStatusChildren(lane(read), scope, id => id === 'z' ? 'working' : 'idle')).map(child => [child.id, child.activity])).toEqual([['z', 'working'], ['a', 'idle']]);
    expect(read.mock.calls[1]).toEqual(['/api/session?location%5Bdirectory%5D=%2Ffixture%2Fproject&cursor=opaque%2Fa&limit=200', 'GET']);
  });
  test.each([
    undefined, [], { data: [] }, { data: [], cursor: null }, { data: [], cursor: [] },
    { data: [], cursor: { next: '' } }, { data: [], cursor: { next: 0 } },
    { ...page([]), complete: false }, { ...page([]), hasMore: true }, { ...page([]), partial: true },
    page([{ ...row(), parentID: 'other' }]), page([{ ...row(), location: { directory: '/other' } }]),
    page([{ ...row(), directory: '/other' }]), page([{ id: 'missing-location', parentID: 'parent' } as ReturnType<typeof row>]),
    page([row(), row()]), page([{ ...row(), title: 4 } as unknown as ReturnType<typeof row>]),
  ])('malformed/partial/mismatched result throws, never authoritative empty: %j', async response => {
    await expect(readDesktopWorkStatusChildren(lane(async () => response), scope)).rejects.toThrow();
  });
  test('successful terminal empty is distinct; omitted next inside the formal cursor object is terminal', async () => {
    expect(await readDesktopWorkStatusChildren(lane(async () => page([])), scope)).toEqual([]);
    expect(await readDesktopWorkStatusChildren(lane(async () => ({ data: [], cursor: {} })), scope)).toEqual([]);
  });
  test('empty continuation/repeated cursor/duplicates fail without exposing partial data', async () => {
    const cycle = vi.fn().mockResolvedValueOnce(page([row('first')], 'same')).mockResolvedValueOnce(page([row('second')], 'same'));
    await expect(readDesktopWorkStatusChildren(lane(cycle), scope)).rejects.toThrow('cursor_did_not_advance');
    await expect(readDesktopWorkStatusChildren(lane(async () => page([], 'next')), scope)).rejects.toThrow('cursor_did_not_advance');
    const duplicate = vi.fn().mockResolvedValueOnce(page([row()], 'next')).mockResolvedValueOnce(page());
    await expect(readDesktopWorkStatusChildren(lane(duplicate), scope)).rejects.toThrow('invalid_scope');
  });
  test('bounded 5-page/1000-row read throws rather than truncating a sixth page', async () => {
    let requests = 0;
    const read = vi.fn(async () => { const index = requests++; return page(Array.from({ length: 200 }, (_, id) => row(`p${index}-${id}`)), `next-${index}`); });
    await expect(readDesktopWorkStatusChildren(lane(read), scope)).rejects.toThrow('incomplete');
    expect(requests).toBe(desktopWorkStatusChildReadLimits.pages);
  });
  test('failed second page and stale response throw; mismatched lease never reaches a request', async () => {
    const read = vi.fn().mockResolvedValueOnce(page([row()], 'next')).mockRejectedValueOnce(new Error('offline'));
    await expect(readDesktopWorkStatusChildren(lane(read), scope)).rejects.toThrow('offline');
    let current = true, release!: (value: unknown) => void;
    const pending = readDesktopWorkStatusChildren(lane(() => new Promise(resolve => { release = resolve; }), () => current), scope);
    current = false; release(page()); await expect(pending).rejects.toThrow('stale');
    const forbidden = vi.fn(async () => page());
    await expect(readDesktopWorkStatusChildren({ ...lane(forbidden), scope: { hostID: 'fixture', lease: 'other' } }, scope)).rejects.toThrow('stale'); expect(forbidden).not.toHaveBeenCalled();
  });
});
