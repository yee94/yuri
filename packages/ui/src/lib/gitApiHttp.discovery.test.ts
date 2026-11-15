import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  generation: 0,
  fetch: vi.fn<typeof fetch>(),
}));
vi.mock('./runtime-fetch', () => ({ runtimeFetch: (...args: Parameters<typeof fetch>) => fixture.fetch(...args) }));
vi.mock('./runtime-switch', () => ({
  getRuntimeGeneration: () => fixture.generation,
  getRuntimeTransportIdentity: () => `runtime-${fixture.generation}`,
}));
vi.mock('./runtime-url', () => ({
  getRuntimeUrlResolver: () => ({ api: (path: string, query?: Record<string, string>) => `${path}?${new URLSearchParams(query)}` }),
}));
import { checkIsGitRepository, discoverGitRepositories, resolveGitPrimaryRoot } from './gitApiHttp';

const directories = Array.from({ length: 61 }, (_, index) => `/repo-${index}`);
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

beforeEach(() => { fixture.generation++; fixture.fetch.mockReset(); });
afterEach(() => vi.restoreAllMocks());

test('61 concurrent repository checks share the discovery budget and leave ordinary requests free', async () => {
  let active = 0;
  let peak = 0;
  fixture.fetch.mockImplementation(async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 1));
    active--;
    return response({ isGitRepository: true });
  });
  const result = await Promise.all(directories.map(checkIsGitRepository));
  expect(result.every(Boolean)).toBe(true);
  expect(fixture.fetch).toHaveBeenCalledTimes(61);
  expect(peak).toBeLessThanOrEqual(2);
});

test('single readers join an in-flight batch instead of sending 61 checks and roots', async () => {
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  fixture.fetch.mockImplementation(async input => {
    if (!String(input).includes('/discover')) throw new Error('unexpected single discovery');
    await ready;
    return response(directories.map(directory => ({ directory, isGitRepository: true, primaryRoot: directory })));
  });
  const batch = discoverGitRepositories(directories);
  const checks = directories.map(checkIsGitRepository);
  const roots = directories.map(resolveGitPrimaryRoot);
  await Promise.resolve();
  release();
  await batch;
  expect(await Promise.all(checks)).toEqual(directories.map(() => true));
  expect(await Promise.all(roots)).toEqual(directories.map(root => ({ root })));
  expect(fixture.fetch).toHaveBeenCalledTimes(1);
});

test('overlapping batches reuse discovered directories and request only the remainder', async () => {
  fixture.fetch.mockImplementation(async input => {
    const dirs = new URL(String(input), 'https://example.test').searchParams.getAll('directories');
    return response(dirs.map(directory => ({ directory, isGitRepository: true, primaryRoot: directory })));
  });
  const [first, second] = await Promise.all([
    discoverGitRepositories(['/one', '/shared']),
    discoverGitRepositories(['/shared', '/two']),
  ]);
  expect([...first.keys()]).toEqual(['/one', '/shared']);
  expect([...second.keys()]).toEqual(['/shared', '/two']);
  expect(fixture.fetch.mock.calls.map(([input]) =>
    new URL(String(input), 'https://example.test').searchParams.getAll('directories'),
  )).toEqual([['/one', '/shared'], ['/two']]);
});

test('unavailable batch endpoint releases its slot before single-reader fallback', async () => {
  fixture.fetch.mockImplementation(async input => {
    const url = new URL(String(input), 'https://example.test');
    if (url.pathname.endsWith('/discover')) return response({}, 501);
    if (url.pathname.endsWith('/check')) return response({ isGitRepository: true });
    return response({ root: url.searchParams.get('directory') });
  });
  const result = await discoverGitRepositories(directories);
  expect(result.size).toBe(61);
  expect(fixture.fetch).toHaveBeenCalledTimes(123);
});

test('an omitted batch entry falls back without deadlocking or caching a failed check as false', async () => {
  fixture.fetch.mockImplementation(async input => {
    if (String(input).includes('/discover')) return response([{ directory: '/known', isGitRepository: false, primaryRoot: null }]);
    return response({}, 503);
  });
  await discoverGitRepositories(['/known', '/missing']);
  await expect(checkIsGitRepository('/missing')).rejects.toThrow();
  expect(await checkIsGitRepository('/known')).toBe(false);
});

test('a pending old-runtime batch cannot seed or dispatch a reader into the next runtime', async () => {
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  fixture.fetch.mockImplementation(async () => {
    await ready;
    return response([{ directory: '/same', isGitRepository: true, primaryRoot: '/same' }]);
  });
  const batch = discoverGitRepositories(['/same']);
  const check = checkIsGitRepository('/same');
  const rejected = expect(check).rejects.toThrow();
  fixture.generation++;
  release();
  await batch;
  await rejected;
  fixture.fetch.mockResolvedValue(response({ isGitRepository: false }));
  expect(await checkIsGitRepository('/same')).toBe(false);
});

test('runtime switching during fallback cannot launch a primary-root read on the new runtime', async () => {
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  const checking = new Promise<void>(resolve => { started = resolve; });
  fixture.fetch.mockImplementation(async input => {
    if (String(input).includes('/discover')) return response({}, 501);
    started();
    await ready;
    return response({ isGitRepository: true });
  });
  const discovery = discoverGitRepositories(['/same']);
  await checking;
  fixture.generation++;
  release();
  expect((await discovery).size).toBe(0);
  expect(fixture.fetch).toHaveBeenCalledTimes(2);
});
