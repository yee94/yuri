import { afterEach, expect, test, vi } from 'vitest';
import type { RuntimeAPIs } from '@/lib/api/types';
import type { ChildStoreManager } from './child-store';
import type { Event } from './types';
import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { handleEvent } from './sync-context';

afterEach(() => registerRuntimeAPIs(null));

test.each([
  { instanceId: ' instance-b ', hostId: ' host-b ', hubId: ' hub-a ', expected: ['instance-b', 'host-b', 'hub-a'] },
  { instanceId: 12, hostId: { value: 'host' }, hubId: ['hub'], expected: [undefined, undefined, undefined] },
  { instanceId: '', hostId: '  ', hubId: null, expected: [undefined, undefined, undefined] },
])('production SSE notification dispatch retains only legal machine identities: %j', async ({ expected, ...identity }) => {
  const notifyAgentCompletion = vi.fn(async () => undefined);
  registerRuntimeAPIs({ notifications: { notifyAgentCompletion } } as unknown as RuntimeAPIs);
  const stores = { children: new Map() } as unknown as ChildStoreManager;
  const routing = { sessionDirectoryById: new Map(), messageSessionById: new Map(), sessionMessageIdsById: new Map() } as Parameters<typeof handleEvent>[3];
  // Exercise the actual directory SSE dispatcher, not the notification identity helper.
  handleEvent('/remote/repo', { type: 'yuri:notification', properties: {
    title: 'Finished', body: 'Remote completed', sessionId: 'same-id', ...identity,
  } } as unknown as Event, stores, routing);
  await Promise.resolve();
  expect(notifyAgentCompletion).toHaveBeenCalledOnce();
  expect(notifyAgentCompletion).toHaveBeenCalledWith(expect.objectContaining({
    instanceId: expected[0], hostId: expected[1], hubId: expected[2], sessionId: 'same-id', directory: '/remote/repo',
  }));
});
