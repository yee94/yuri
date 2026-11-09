import { afterEach, expect, test, vi } from 'vitest';
import { opencodeClient } from '@/lib/opencode/client';
import { queryClient } from '@/lib/queryRuntime';
import { resetOpenCodeReadiness } from '@/lib/runtime-readiness';
import type { SessionIndexSnapshot } from '@/lib/session-index-api';
import { useGlobalSessionsStore } from './useGlobalSessionsStore';

vi.mock('@/stores/useDirectoryStore', async () => {
  const { create } = await import('zustand');
  return { useDirectoryStore: create(() => ({ currentDirectory: null })) };
});
const rows = (start: number, count: number) => Array.from({ length: count }, (_, index) => ({ id: `window-${start + index}`, title: `Window ${start + index}`, directory: '/repo', time: { created: 100 - start - index, updated: 100 - start - index } }));
const snapshot = (revision: number, sessions: SessionIndexSnapshot['directories'][number]['sessions'], hasMore: boolean, failed = false): SessionIndexSnapshot => ({ revision,
  sync: { active: false, completed: failed ? 0 : 1, total: 1, pendingDirectories: [], completedDirectories: failed ? [] : ['/repo'], failedDirectories: failed ? ['/repo'] : [] },
  directories: [{ directory: '/repo', sessions, hasMore, cursor: hasMore ? 96 : null, lastSyncedAt: 1, lastFullSyncedAt: 1, lastAccessedAt: 1 }],
});
async function adopt(value: SessionIndexSnapshot) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ available: true, ...value }), { headers: { 'Content-Type': 'application/json' } })));
  await useGlobalSessionsStore.getState().syncSessionsForDirectories(['/repo']);
}
afterEach(() => {
  useGlobalSessionsStore.getState().resetForRuntimeSwitch(); queryClient.clear(); resetOpenCodeReadiness(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});
test('five-row index heads retain an explicitly loaded twelve-row directory and its terminal page across newer refreshes', async () => {
  vi.spyOn(opencodeClient, 'checkHealth').mockResolvedValue(true);
  const list = vi.fn(async () => ({ data: rows(5, 7), cursor: {} }));
  vi.spyOn(opencodeClient, 'getSdkClient').mockReturnValue({ session: { list } } as unknown as ReturnType<typeof opencodeClient.getSdkClient>);
  await adopt(snapshot(1, rows(0, 5), true));
  await useGlobalSessionsStore.getState().loadMoreSessionsForDirectory('/repo');
  const loaded = useGlobalSessionsStore.getState().activeSessions.map(row => row.id);
  const pagination = useGlobalSessionsStore.getState().activePaginationByDirectory.get('/repo');
  expect(loaded).toHaveLength(12);
  await adopt(snapshot(2, rows(0, 5), true));
  expect(useGlobalSessionsStore.getState().activeSessions.map(row => row.id)).toEqual(loaded);
  expect(useGlobalSessionsStore.getState().activePaginationByDirectory.get('/repo')).toEqual(pagination);
  expect(list).toHaveBeenCalledTimes(1);
  await adopt(snapshot(3, rows(0, 5), false));
  expect(useGlobalSessionsStore.getState().activeSessions.map(row => row.id)).toEqual(rows(0, 5).map(row => row.id));
});
test('a failed directory snapshot cannot erase its confirmed rows or terminal pagination', async () => {
  await adopt(snapshot(1, rows(0, 12), false));
  await adopt(snapshot(2, [], false, true));
  expect(useGlobalSessionsStore.getState().activeSessions.map(row => row.id)).toEqual(rows(0, 12).map(row => row.id));
  expect(useGlobalSessionsStore.getState().activePaginationByDirectory.get('/repo')?.hasMore).toBe(false);
  expect(useGlobalSessionsStore.getState().sessionIndexSyncByDirectory.get('/repo')?.incomplete).toBe('failed');
  await adopt(snapshot(3, [], false));
  expect(useGlobalSessionsStore.getState().activeSessions).toEqual([]);
  expect(useGlobalSessionsStore.getState().sessionIndexSyncByDirectory.get('/repo')?.incomplete).toBeUndefined();
});
test.each(['failed', 'pending'] as const)('%s directories absent from snapshot rows still publish incompleteness and clear it only on explicit completion', async (status) => {
  await adopt(snapshot(1, rows(0, 12), false));
  const before = useGlobalSessionsStore.getState().activeSessions;
  const incomplete = snapshot(2, [], false);
  incomplete.directories = [];
  incomplete.sync.completed = 0;
  incomplete.sync.completedDirectories = [];
  incomplete.sync.failedDirectories = status === 'failed' ? ['/repo'] : [];
  incomplete.sync.pendingDirectories = status === 'pending' ? ['/repo'] : [];
  await adopt(incomplete);
  expect(useGlobalSessionsStore.getState().activeSessions).toBe(before);
  expect(useGlobalSessionsStore.getState().sessionIndexSyncByDirectory.get('/repo')?.incomplete).toBe(status);
  const completed = snapshot(3, [], false);
  completed.directories = [];
  await adopt(completed);
  expect(useGlobalSessionsStore.getState().sessionIndexSyncByDirectory.get('/repo')?.incomplete).toBeUndefined();
  expect(useGlobalSessionsStore.getState().activeSessions).toBe(before);
});
test('explicit catalog retry is GET-only, preserves rows on transport failure and fences a late response after runtime reset', async () => {
  await adopt(snapshot(1, rows(0, 12), false));
  const before = useGlobalSessionsStore.getState().activeSessions;
  const defaults = queryClient.getDefaultOptions();
  queryClient.setDefaultOptions({ ...defaults, queries: { ...defaults.queries, retry: false } });
  try {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('isolated offline'); }));
    await expect(useGlobalSessionsStore.getState().refreshSessionIndex()).rejects.toThrow('isolated offline');
    expect(useGlobalSessionsStore.getState().activeSessions).toBe(before);
    let resolve!: (response: Response) => void;
    const fetch = vi.fn((_input: unknown, _init?: RequestInit) => new Promise<Response>(done => { resolve = done; }));
    vi.stubGlobal('fetch', fetch);
    const pending = useGlobalSessionsStore.getState().refreshSessionIndex();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const init = fetch.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.method ?? 'GET').toBe('GET');
    useGlobalSessionsStore.getState().resetForRuntimeSwitch();
    resolve(new Response(JSON.stringify({ available: true, ...snapshot(2, rows(0, 5), false) }), { headers: { 'Content-Type': 'application/json' } }));
    await pending;
    expect(useGlobalSessionsStore.getState().activeSessions).toEqual([]);
  } finally { queryClient.setDefaultOptions(defaults); }
});
