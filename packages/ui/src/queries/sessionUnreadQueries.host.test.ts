import { afterEach, expect, it, vi } from 'vitest';
import type { OpenCodeClient } from '@/lib/opencode/v2-types';
import { HostRuntimeRegistry, type HostRuntimeDependencies } from '@/lib/remote-projects/registry';
import { getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import { queryClient } from '@/lib/queryRuntime';
import { sessionUnreadKey, sessionUnreadQueryOptions, saveSessionUnread } from './sessionUnreadQueries';

const snapshot = { revision: 4, sessions: { same: { directory: 'C:\\Raw\\', unreadCount: 0, hasError: false, manual: false, revision: 4 } } };
afterEach(() => queryClient.clear());

it('reads and writes the selected Host with the observed revision and never changes the Hub unread cache', async () => {
  const fetch = vi.fn<HostRuntimeDependencies['fetch']>(async () => Response.json(snapshot));
  const registry = new HostRuntimeRegistry('hub', { transportIdentity: getRuntimeTransportIdentity(), isCurrent: () => true, fetch, sdk: () => ({} as OpenCodeClient) });
  const entry = registry.resolve({ hubId: 'hub', hostId: 'host', directory: 'C:\\Raw\\' });
  const other = registry.resolve({ hubId: 'hub', hostId: 'other-host', directory: 'C:\\Raw\\' });
  const local = { revision: 2, sessions: {} };
  queryClient.setQueryData(sessionUnreadKey(), local);
  const controller = new AbortController();
  const options = sessionUnreadQueryOptions(getRuntimeTransportIdentity(), entry);
  expect(await options.queryFn({ signal: controller.signal })).toEqual(snapshot);
  expect(fetch.mock.calls[0]).toEqual(['/api/hosts/host/api/yuri/session-unread', { signal: controller.signal }]);
  await saveSessionUnread('same', false, 3, entry);
  expect(fetch.mock.calls[1]).toEqual(['/api/hosts/host/api/yuri/session-unread/same', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ unread: false, expectedRevision: 3 }),
  }]);
  expect(queryClient.getQueryData(sessionUnreadKey())).toBe(local);
  expect(queryClient.getQueryData(options.queryKey)).toEqual(snapshot);
  expect(queryClient.getQueryData(sessionUnreadKey(getRuntimeTransportIdentity(), other))).toBeUndefined();
  registry.dispose();
});

it('rejects a delayed Host body after a connection generation change without committing unread success', async () => {
  let finish!: (value: unknown) => void;
  const response = { ok: true, json: () => new Promise((resolve) => { finish = resolve; }) } as Response;
  const registry = new HostRuntimeRegistry('hub', { transportIdentity: getRuntimeTransportIdentity(), isCurrent: () => true,
    fetch: async () => response, sdk: () => ({} as OpenCodeClient) });
  const entry = registry.resolve({ hubId: 'hub', hostId: 'host', directory: '/raw' });
  const write = saveSessionUnread('same', false, 3, entry);
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  registry.dispose(); finish(snapshot);
  await expect(write).rejects.toThrow('Inactive Hub');
  expect(queryClient.getQueryData(sessionUnreadKey(getRuntimeTransportIdentity(), entry))).toBeUndefined();
});
