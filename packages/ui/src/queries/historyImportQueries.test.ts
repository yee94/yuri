import { beforeEach, expect, test, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { dismissImport, importJobQueryOptions, importJobsQueryOptions, importSourcesQueryOptions, importStatesQueryOptions, resumeImport, scanImportSources, startSourceImport } from './historyImportQueries';

const fixture = vi.hoisted(() => ({ transport: 'one', generation: 1, fetch: vi.fn(), setQueryData: vi.fn() }));
vi.mock('@/lib/runtime-switch', () => ({ getRuntimeTransportIdentity: () => fixture.transport, getRuntimeGeneration: () => fixture.generation }));
vi.mock('@/lib/runtime-fetch', () => ({ runtimeFetch: (...args: unknown[]) => fixture.fetch(...args) }));
vi.mock('@/lib/queryRuntime', () => ({ queryClient: { setQueryData: (...args: unknown[]) => fixture.setQueryData(...args), cancelQueries: vi.fn(async () => {}) } }));
beforeEach(() => { fixture.transport = 'one'; fixture.generation = 1; fixture.fetch.mockReset(); fixture.setQueryData.mockReset(); });

test('source discovery is one runtime-scoped cancellable query shared by all five cards', async () => {
  const options = importSourcesQueryOptions();
  const controller = new AbortController();
  fixture.fetch.mockResolvedValue(Response.json({ id: 'scan', sessions: [], errors: [] }));
  await options.queryFn({ signal: controller.signal });
  expect(options.queryKey).toEqual(['one', 'history-import', 'sources', 'sample', 5, 'counts']);
  expect(fixture.fetch.mock.calls[0][1].signal).toBe(controller.signal);
  expect(JSON.parse(fixture.fetch.mock.calls[0][1].body)).toEqual({ sources: ['claude', 'codex', 'cursor', 'dsh', 'opencode'], limitPerSource: 5, includeCounts: true });
  expect(options.refetchOnWindowFocus).toBe(false);
});

test('import badges are separately scoped by runtime, scan, destination and completed job revision', async () => {
  const options = importStatesQueryOptions('scan', '/project', 'job:completed');
  const signal = new AbortController().signal;
  fixture.fetch.mockResolvedValue(Response.json({ states: { one: 'unknown' } }));
  expect(await options.queryFn({ signal })).toEqual({ states: { one: 'unknown' } });
  expect(options.queryKey).toEqual(['one', 'history-import', 'imported', 'scan', '/project', 'job:completed']);
  expect(fixture.fetch.mock.calls[0][1].signal).toBe(signal);
  expect(JSON.parse(fixture.fetch.mock.calls[0][1].body)).toEqual({ scanID: 'scan', directory: '/project' });
  fixture.fetch.mockImplementation(async () => { fixture.generation++; return Response.json({ states: { one: 'imported' } }); });
  await expect(options.queryFn({ signal })).rejects.toThrow('runtime_changed');
});

test('job queries are runtime scoped, forward abort, and poll only running jobs', async () => {
  const options = importJobQueryOptions('one');
  expect(options.queryKey).toEqual(['one', 'history-import', 'job']);
  const controller = new AbortController(); fixture.fetch.mockImplementation(async (_url, init) => {
    expect(init.signal).toBe(controller.signal);
    return Response.json(null);
  });
  await options.queryFn({ signal: controller.signal });
  expect(options.refetchInterval({ state: { data: null } })).toBe(false);
  expect(options.refetchInterval({ state: { data: { state: 'running' } as never } })).toBe(1000);
});
test('failed refresh preserves the last successful job rather than claiming an empty success', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const options = importJobQueryOptions(); const previous = { id: 'job', state: 'running', results: [] };
  client.setQueryData(options.queryKey, previous); fixture.fetch.mockRejectedValue(new Error('offline'));
  await expect(client.fetchQuery({ ...options, retry: false })).rejects.toThrow('offline');
  expect(client.getQueryData(options.queryKey)).toEqual(previous); client.clear();
});
test('late mutations after transport or generation changes never update the new runtime cache', async () => {
  fixture.fetch.mockImplementation(async () => { fixture.generation++; return Response.json({ id: 'job' }); });
  await expect(startSourceImport(['claude'], null, new AbortController().signal, 'one', 1)).rejects.toThrow('runtime_changed');
  expect(fixture.setQueryData).not.toHaveBeenCalled();
  fixture.fetch.mockImplementation(async () => { fixture.transport = 'two'; return Response.json({ id: 'scan' }); });
  await expect(scanImportSources({ sources: ['claude'] }, new AbortController().signal, 'one')).rejects.toThrow('runtime_changed');
});

test('source start delegates full discovery to the Host and seeds only the captured runtime job', async () => {
  const job = { id: 'job', state: 'running', progress: { phase: 'scanning', total: 0, completed: 0 } };
  fixture.fetch.mockResolvedValue(Response.json(job)); const signal = new AbortController().signal;
  expect(await startSourceImport(['claude', 'cursor'], null, signal, 'one', 1)).toEqual(job);
  expect(JSON.parse(fixture.fetch.mock.calls[0][1].body)).toEqual({ sources: ['claude', 'cursor'], directory: null, confirm: true });
  expect(fixture.fetch.mock.calls[0][1].signal).toBe(signal);
  expect(fixture.setQueryData).toHaveBeenCalledWith(['one', 'history-import', 'job'], job);
});

test('source start rejects old generations before a request and fences late completions', async () => {
  await expect(startSourceImport(['claude'], null, new AbortController().signal, 'one', 0)).rejects.toThrow('runtime_changed');
  expect(fixture.fetch).not.toHaveBeenCalled();
  fixture.fetch.mockImplementation(async () => { fixture.generation++; return Response.json({ id: 'old' }); });
  await expect(startSourceImport(['claude'], null, new AbortController().signal, 'one', 1)).rejects.toThrow('runtime_changed');
  expect(fixture.setQueryData).not.toHaveBeenCalled();
});

test('unfinished list and resume keep old failed jobs and update the same identity without exposing source intent', async () => {
  const options = importJobsQueryOptions(); const signal = new AbortController().signal;
  const old = { id: 'old', state: 'partial' }; const job = { id: 'job', state: 'running' };
  fixture.fetch.mockResolvedValueOnce(Response.json([old]));
  expect(await options.queryFn({ signal })).toEqual([old]);
  expect(fixture.fetch).toHaveBeenCalledWith('/api/yuri/history-import/jobs', { signal });
  fixture.fetch.mockResolvedValueOnce(Response.json(job));
  expect(await resumeImport('job', 'one', 1)).toEqual(job);
  expect(JSON.parse(fixture.fetch.mock.calls[1][1].body)).toEqual({ id: 'job', confirm: true });
  const update = fixture.setQueryData.mock.calls.find(([key]) => key[2] === 'jobs')![1];
  expect(update([old])).toEqual([old, job]);
  expect(update([old, { ...job, state: 'partial' }])).toEqual([old, job]);
  fixture.fetch.mockImplementation(async () => { fixture.generation++; return Response.json(job); });
  fixture.setQueryData.mockClear();
  await expect(resumeImport('job', 'one', 1)).rejects.toThrow('runtime_changed');
  expect(fixture.setQueryData).not.toHaveBeenCalled();
});

test('dismiss removes only the confirmed task from its captured caches and ignores stale completions', async () => {
  fixture.fetch.mockResolvedValueOnce(Response.json({ id: 'failed' }));
  await dismissImport('failed', 'one', 1);
  expect(JSON.parse(fixture.fetch.mock.calls[0][1].body)).toEqual({ id: 'failed' });
  const updates = fixture.setQueryData.mock.calls;
  const list = updates.find(([key]) => key[2] === 'jobs')![1];
  expect(list([{ id: 'failed' }, { id: 'other' }])).toEqual([{ id: 'other' }]);
  const latest = updates.find(([key]) => key[2] === 'job')![1];
  expect(latest({ id: 'failed' })).toBeNull(); expect(latest({ id: 'other' })).toEqual({ id: 'other' });
  fixture.setQueryData.mockClear();
  fixture.fetch.mockImplementation(async () => { fixture.generation++; return Response.json({ id: 'failed' }); });
  await expect(dismissImport('failed', 'one', 1)).rejects.toThrow('runtime_changed');
  expect(fixture.setQueryData).not.toHaveBeenCalled();
});
