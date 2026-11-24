import { beforeEach, expect, it, vi } from 'vitest';
import { saveRecommendedPlugins } from './tourPlugins';

const fixture = vi.hoisted(() => ({ fetch: vi.fn(), invalidate: vi.fn(), generation: 1 }));
vi.mock('@/lib/runtime-fetch', () => ({ runtimeFetch: fixture.fetch }));
vi.mock('@/lib/queryRuntime', () => ({
  queryClient: { invalidateQueries: fixture.invalidate },
  queryKeys: { plugins: { list: (directory: string | null, transport: string) => [transport, 'plugins', 'list', directory] } },
}));
vi.mock('@/lib/runtime-switch', () => ({ getRuntimeGeneration: () => fixture.generation, getRuntimeTransportIdentity: () => 'test-host' }));

beforeEach(() => {
  fixture.generation = 1;
  fixture.fetch.mockReset().mockResolvedValue(new Response(null, { status: 204 }));
  fixture.invalidate.mockReset();
});

it('uses only one config request and does not refetch plugin lists after saving', async () => {
  const signal = new AbortController().signal;
  const specs = ['one', '@scope/two'];
  expect(await saveRecommendedPlugins(specs, signal)).toBe(true);
  expect(fixture.fetch).toHaveBeenCalledExactlyOnceWith('/api/config/plugins', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ specs }), signal,
  });
  expect(fixture.invalidate).toHaveBeenCalledExactlyOnceWith({ queryKey: ['test-host', 'plugins', 'list'], refetchType: 'none' });
});

it('only recognizes an explicit save confirmation', async () => {
  const signal = new AbortController().signal;
  for (const status of [404, 500, 200]) {
    fixture.fetch.mockResolvedValueOnce(new Response(null, { status }));
    expect(await saveRecommendedPlugins(['one'], signal)).toBe(false);
  }
  expect(fixture.invalidate).not.toHaveBeenCalled();
});

it('does not write an empty selection or write after cancellation', async () => {
  const controller = new AbortController();
  expect(await saveRecommendedPlugins([], controller.signal)).toBe(true);
  controller.abort();
  await expect(saveRecommendedPlugins(['one'], controller.signal)).rejects.toHaveProperty('name', 'AbortError');
  expect(fixture.fetch).not.toHaveBeenCalled();
});

it('does not invalidate a new runtime when the previous save finishes', async () => {
  fixture.fetch.mockImplementationOnce(async () => {
    fixture.generation++;
    return new Response(null, { status: 204 });
  });
  expect(await saveRecommendedPlugins(['one'], new AbortController().signal)).toBe(true);
  expect(fixture.invalidate).not.toHaveBeenCalled();
});
