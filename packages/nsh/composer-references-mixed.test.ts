import { afterEach, expect, test, vi } from 'vitest';
import * as webRows from '../ui/src/lib/composer-autocomplete/rows';
import * as webPaths from '../ui/src/lib/search/fileMentionSearch';
import { createMixedReferenceSearch, mixedReferenceRows, type MixedReferenceSearchState, type ReferenceCandidate } from './composer-references';

const scope = { host: 'host-a', draft: 'draft-a', directory: '/workspace' };
const candidate = (kind: ReferenceCandidate['kind'], value: string, label = value, description?: string): ReferenceCandidate => ({ kind, value, label, description, scope });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
function response(path: string) {
  if (path.startsWith('/api/agent?')) return { data: [{ name: 'reviewer', mode: 'subagent', description: 'Native review' }, { name: 'primary', mode: 'primary' }, { name: 'hidden', hidden: true }] };
  if (path.startsWith('/api/skill?')) return { data: [{ id: 'desktop-shell', name: 'Desktop shell', description: 'Native platform integration', content: 'Not retained by the picker' }] };
  if (path.startsWith('/api/session?')) return { data: [{ id: 'prior', title: 'Native previous work', location: { directory: '/other' } }], cursor: {} };
  if (path.includes('type=directory')) return { data: [{ path: 'src/native/', type: 'directory' }] };
  return { data: [{ path: 'src/native.ts', type: 'file' }, { path: 'tests/native.test.ts', type: 'file' }] };
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

test('production mixed rows reuse Web joint relevance, skill description recall and per-kind icons', () => {
  const rows = mixedReferenceRows([
    candidate('agent', 'general', 'general', 'Native is description-only and must not recall this agent'),
    candidate('skill', 'desktop-shell', 'Desktop shell', 'Native platform integration'),
    candidate('skill', 'native', 'Native skill'),
    candidate('session', 'prior', 'Native previous work'),
    candidate('directory', 'src/native/'), candidate('file', 'src/native.ts'), candidate('file', 'tests/native.test.ts'),
  ], 'native');
  expect(rows[0].candidate.value).toBe('native');
  expect(rows.some(row => row.candidate.value === 'general')).toBe(false);
  expect(rows.find(row => row.candidate.value === 'desktop-shell')?.presentation).toMatchObject({ title: '@desktop-shell', subtitle: 'Native platform integration', iconName: 'book-open' });
  expect(rows.find(row => row.candidate.kind === 'session')?.presentation.iconName).toBe('chat-thread');
  expect(rows.find(row => row.candidate.kind === 'directory')?.presentation.iconName).toBe('folder-3-fill');
  expect(rows.find(row => row.candidate.kind === 'file')?.presentation.iconName).toBe('code');
  const general = mixedReferenceRows([candidate('agent', 'general', 'general', 'Agent description')], 'gene');
  expect(general[0].presentation).toMatchObject({ title: '@general', subtitle: 'Agent description', iconName: 'ai-agent' });
});

test('files and directories use the exact Web flat path rank, extension intent and source-over-test policy', () => {
  const paths = [candidate('file', 'tests/native.test.ts'), candidate('directory', 'src/native/'), candidate('file', 'src/native.ts'), candidate('file', 'src/native.md')];
  for (const query of ['native', 'native.ts', 'native/']) {
    const expected = webPaths.rankFileMentionSearch(paths.map(item => ({ relativePath: item.value, name: item.value.replace(/\/$/, '').split('/').pop(), extension: item.value.split('.').pop(), isDirectory: item.kind === 'directory', candidate: item })), query).map(item => item.candidate.value);
    expect(mixedReferenceRows(paths, query).map(row => row.candidate.value)).toEqual(expected);
  }
  expect(mixedReferenceRows(paths, 'native.ts')[0].candidate.value).toBe('src/native.ts');
  expect(mixedReferenceRows(paths, 'native/')[0].candidate.kind).toBe('directory');
  expect(mixedReferenceRows([candidate('file', 'src/native'), candidate('directory', 'src/native')], 'native')).toHaveLength(1);
  expect(mixedReferenceRows([candidate('file', 'src/native'), candidate('directory', 'src/native')], 'native')[0].candidate.kind).toBe('directory');
});

test('Web ten non-session slots do not consume the independently bounded session matches', () => {
  const rows = mixedReferenceRows([
    ...Array.from({ length: 20 }, (_, i) => candidate('skill', `native-${i}`)),
    ...Array.from({ length: 12 }, (_, i) => candidate('session', `session-${i}`, 'Native same title')),
    candidate('file', 'src/native.ts'),
  ], 'native');
  expect(rows.filter(row => row.candidate.kind !== 'session')).toHaveLength(10);
  expect(rows.filter(row => row.candidate.kind === 'session')).toHaveLength(12);
});

test('a bare @ loads metadata and recent other sessions, never starts a filesystem scan', async () => {
  vi.useFakeTimers();
  let state: MixedReferenceSearchState | undefined;
  const send = vi.fn(async (path: string) => path.startsWith('/api/session?') ? { data: Array.from({ length: 6 }, (_, i) => ({ id: i ? `other-${i}` : 'current', title: `Work ${i}` })) } : response(path));
  const search = createMixedReferenceSearch(send, next => { state = next; });
  search.update(scope, '', true, 'current'); await vi.advanceTimersByTimeAsync(180);
  expect(send).toHaveBeenCalledTimes(3);
  expect(send.mock.calls.some(([path]) => path.startsWith('/api/fs/find'))).toBe(false);
  expect(state?.rows.filter(row => row.candidate.kind === 'session')).toHaveLength(5);
  expect(state?.rows.some(row => row.candidate.value === 'current')).toBe(false);
  expect(state?.rows.every(row => row.candidate.scope?.host === scope.host)).toBe(true);
  search.dispose();
});

test('50 rapid opened queries debounce paths/sessions; Agent and Skill catalogs are fetched once while mounted', async () => {
  vi.useFakeTimers();
  let state: MixedReferenceSearchState | undefined;
  const send = vi.fn(async (path: string) => response(path));
  const search = createMixedReferenceSearch(send, next => { state = next; });
  for (let i = 0; i < 50; i++) search.update(scope, 'native.ts', true);
  await vi.advanceTimersByTimeAsync(179); expect(send).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(send).toHaveBeenCalledTimes(5);
  expect(send.mock.calls.find(([path]) => path.includes('type=file'))?.[0]).toContain('query=native&type=file&limit=80');
  expect(send.mock.calls.find(([path]) => path.includes('type=directory'))?.[0]).toContain('query=native&type=directory&limit=40');
  search.update(scope, 'native/', true); await vi.advanceTimersByTimeAsync(180);
  expect(send).toHaveBeenCalledTimes(8);
  expect(send.mock.calls.filter(([path]) => path.startsWith('/api/agent?'))).toHaveLength(1);
  expect(send.mock.calls.filter(([path]) => path.startsWith('/api/skill?'))).toHaveLength(1);
  expect(state?.rows.find(row => row.candidate.kind === 'directory')?.candidate.value).toBe('src/native/');
  search.close(); search.update(scope, '', true); await vi.advanceTimersByTimeAsync(180);
  expect(send).toHaveBeenCalledTimes(9);
  expect(state?.busy).toBe(false); search.dispose();
});

test('closed, opened, then closed 200-query updates do zero network and zero production row/path enumeration', async () => {
  vi.useFakeTimers();
  const build = vi.spyOn(webRows, 'buildMentionRows'), rank = vi.spyOn(webPaths, 'rankFileMentionSearch');
  const send = vi.fn(async (path: string) => response(path));
  const search = createMixedReferenceSearch(send, () => {});
  for (let i = 0; i < 200; i++) search.update(scope, `native${i}`, false);
  await vi.advanceTimersByTimeAsync(300);
  expect(send).not.toHaveBeenCalled(); expect(build).not.toHaveBeenCalled(); expect(rank).not.toHaveBeenCalled();
  search.update(scope, 'native', true); await vi.advanceTimersByTimeAsync(180);
  // Establish that the exact production helpers are actually being measured, not an unrelated host.calls counter.
  expect(send).toHaveBeenCalledTimes(5); expect(build.mock.calls.length).toBeGreaterThan(0); expect(rank.mock.calls.length).toBeGreaterThan(0);
  search.close(); const counts = [send.mock.calls.length, build.mock.calls.length, rank.mock.calls.length];
  for (let i = 0; i < 200; i++) search.update(scope, `native${i}`, false);
  await vi.advanceTimersByTimeAsync(300);
  expect([send.mock.calls.length, build.mock.calls.length, rank.mock.calls.length]).toEqual(counts);
  search.dispose();
});

test('closed and stale-scope responses do not enumerate catalogs or replace the new rows', async () => {
  vi.useFakeTimers();
  const old = deferred<unknown>(); let reads = 0, state: MixedReferenceSearchState | undefined;
  const send = vi.fn(async (path: string) => path.startsWith('/api/agent?') && path.includes('workspace') ? old.promise : response(path));
  const search = createMixedReferenceSearch(send, next => { state = next; });
  search.update(scope, 'native', true); await vi.advanceTimersByTimeAsync(180);
  search.close();
  const nextScope = { ...scope, host: 'host-b', directory: '/other' };
  search.update(nextScope, 'native', true); await vi.advanceTimersByTimeAsync(180);
  old.resolve({ get data() { reads++; return [{ name: 'obsolete', mode: 'subagent' }]; } }); await vi.advanceTimersByTimeAsync(0);
  expect(reads).toBe(0); expect(state?.rows.some(row => row.candidate.value === 'obsolete')).toBe(false);
  expect(state?.rows.every(row => row.candidate.scope?.host === 'host-b')).toBe(true);
  search.dispose();
});

test('a late closed response performs no candidate work, and partial lookup failure preserves complete domains', async () => {
  vi.useFakeTimers();
  const late = deferred<unknown>(); let reads = 0;
  const search = createMixedReferenceSearch(async () => late.promise, () => {});
  search.update(scope, 'native', true); await vi.advanceTimersByTimeAsync(180); search.close();
  late.resolve({ get data() { reads++; return []; } }); await vi.advanceTimersByTimeAsync(0);
  expect(reads).toBe(0); search.dispose();
  let state: MixedReferenceSearchState | undefined;
  const send = vi.fn(async (path: string) => { if (path.includes('type=file')) throw new Error('offline'); return response(path); });
  const partial = createMixedReferenceSearch(send, next => { state = next; });
  partial.update(scope, 'native', true); await vi.advanceTimersByTimeAsync(180);
  expect(state?.failed).toBe(true); expect(state?.busy).toBe(false);
  expect(state?.rows.some(row => row.candidate.kind === 'skill')).toBe(true);
  expect(state?.rows.some(row => row.candidate.kind === 'directory')).toBe(true);
  expect(state?.rows.some(row => row.candidate.kind === 'session')).toBe(true);
  partial.dispose();
});

test('description recall searches the mounted catalog beyond the first twelve entries', async () => {
  vi.useFakeTimers(); let state: MixedReferenceSearchState | undefined;
  const search = createMixedReferenceSearch(async path => path.startsWith('/api/skill?') ? { data: [
    ...Array.from({ length: 300 }, (_, i) => ({ id: `unrelated-${i}`, name: `Unrelated ${i}`, description: 'Other work' })),
    { id: 'desktop-shell', name: 'Desktop shell', description: 'Native platform integration' },
  ] } : response(path), next => { state = next; });
  search.update(scope, 'native', true); await vi.advanceTimersByTimeAsync(180);
  expect(state?.rows.some(row => row.candidate.value === 'desktop-shell' && row.presentation.subtitle === 'Native platform integration')).toBe(true);
  search.dispose();
});
