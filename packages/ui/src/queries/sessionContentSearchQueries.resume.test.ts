import { beforeEach, expect, test, vi } from 'vitest';
import { resumeSessionContentIndex } from './sessionContentSearchQueries';

const fixture = vi.hoisted(() => ({ generation: 1, fetch: vi.fn(), cache: vi.fn() }));
vi.mock('@/lib/runtime-switch', () => ({ getRuntimeTransportIdentity: () => 'host', getRuntimeGeneration: () => fixture.generation }));
vi.mock('@/lib/runtime-fetch', () => ({ runtimeFetch: (...args: unknown[]) => fixture.fetch(...args) }));
vi.mock('@/lib/queryRuntime', () => ({ queryKeys: {}, queryClient: { setQueryData: (...args: unknown[]) => fixture.cache(...args) } }));
beforeEach(() => { fixture.generation = 1; fixture.fetch.mockReset(); fixture.cache.mockReset(); });
const index = { phase: 'indexing', completed: 79, total: 357, failed: 0, messages: 500 };

test('resume updates only the captured runtime index status from a confirmed valid response', async () => {
  fixture.fetch.mockResolvedValue(Response.json({ index }, { status: 202 }));
  expect(await resumeSessionContentIndex('host', 1)).toEqual(index);
  expect(fixture.fetch).toHaveBeenCalledWith('/api/yuri/content-search/resume', { method: 'POST' });
  expect(fixture.cache).toHaveBeenCalledWith(['host', 'contentSearchStatus', 1], index);
});

test('failures and malformed responses never erase the prior status', async () => {
  fixture.fetch.mockResolvedValueOnce(Response.json({}, { status: 503 }));
  await expect(resumeSessionContentIndex('host', 1)).rejects.toThrow('index_resume_failed');
  fixture.fetch.mockResolvedValueOnce(Response.json({ index: {} }));
  await expect(resumeSessionContentIndex('host', 1)).rejects.toThrow('Invalid content index status');
  expect(fixture.cache).not.toHaveBeenCalled();
});

test('stale runtime recovery never submits or caches across a generation switch', async () => {
  await expect(resumeSessionContentIndex('host', 0)).rejects.toThrow('runtime_changed');
  expect(fixture.fetch).not.toHaveBeenCalled();
  fixture.fetch.mockImplementation(async () => { fixture.generation++; return Response.json({ index }); });
  await expect(resumeSessionContentIndex('host', 1)).rejects.toThrow('runtime_changed');
  expect(fixture.cache).not.toHaveBeenCalled();
});
