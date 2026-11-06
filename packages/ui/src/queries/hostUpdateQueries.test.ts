import { beforeEach, expect, test, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { hostUpdateQueryOptions, resumeHostUpdate, type HostUpdateOperation, type HostUpdateSnapshot } from './hostUpdateQueries';

const fixture = vi.hoisted(() => ({ transport: 'one', generation: 1, fetch: vi.fn() }));
vi.mock('@/lib/runtime-switch', () => ({ getRuntimeTransportIdentity: () => fixture.transport, getRuntimeGeneration: () => fixture.generation }));
vi.mock('@/lib/runtime-fetch', () => ({ runtimeFetch: (...args: unknown[]) => fixture.fetch(...args) }));
vi.mock('@/lib/queryRuntime', () => ({ get queryClient() { return client; } }));
let client: QueryClient;
const operation: HostUpdateOperation = { id: 'failed', planId: 'expired', version: '2.0.0', channel: 'beta', kind: 'ota', status: 'failed', progress: 42, error: 'interrupted' };
const snapshot = (): HostUpdateSnapshot => ({ serverId: 'host', host: 'electron', currentVersion: '1.0.0', channel: 'beta', supported: true,
  reason: null, checkError: null, operation,
  update: { version: '2.0.0', kind: 'ota', planId: 'fresh', rollback: false, restartRequired: true, releaseNotes: null },
});
beforeEach(() => {
  client?.clear(); client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  fixture.transport = 'one'; fixture.generation = 1; fixture.fetch.mockReset();
});

test('resume refreshes the original channel, validates exact version/kind and never reuses an expired plan', async () => {
  fixture.fetch.mockResolvedValueOnce(Response.json(snapshot())).mockResolvedValueOnce(Response.json({ operation: { ...operation, id: 'resumed', status: 'downloading' } }));
  await resumeHostUpdate(operation, 'one', 1);
  expect(fixture.fetch.mock.calls[0][0]).toBe('/api/system/update?channel=beta');
  expect(JSON.parse(fixture.fetch.mock.calls[1][1].body)).toEqual({ version: '2.0.0', channel: 'beta', planId: 'fresh', allowDowngrade: false });
  expect(client.getQueryData<HostUpdateSnapshot>(hostUpdateQueryOptions('one', 1).queryKey)?.operation?.id).toBe('resumed');
});

test('a newer release or failed discovery cannot silently replace a failed update target', async () => {
  const next = snapshot(); next.update!.version = '2.1.0';
  fixture.fetch.mockResolvedValue(Response.json(next));
  await expect(resumeHostUpdate(operation, 'one', 1)).rejects.toThrow('update_plan_changed');
  expect(fixture.fetch).toHaveBeenCalledTimes(1);
  fixture.fetch.mockReset().mockResolvedValue(Response.json({ ...snapshot(), checkError: 'offline', update: null }, { status: 502 }));
  await expect(resumeHostUpdate(operation, 'one', 1)).rejects.toThrow('update_plan_changed');
  expect(fixture.fetch).toHaveBeenCalledTimes(1);
});

test('switching runtime during revalidation never submits or seeds another runtime', async () => {
  fixture.fetch.mockImplementation(async () => { fixture.generation++; return Response.json(snapshot()); });
  await expect(resumeHostUpdate(operation, 'one', 1)).rejects.toThrow('Stale update runtime');
  expect(fixture.fetch).toHaveBeenCalledTimes(1);
  expect(client.getQueryData(hostUpdateQueryOptions('one', 2).queryKey)).toBeUndefined();
});
