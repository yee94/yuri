import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, test, vi } from 'vitest';
import type { HostRuntimeEntry, HostRuntimeRegistry } from '@/lib/remote-projects/registry';
import { useRemoteSessionViewed } from './useRemoteSessionViewed';

const fixture = vi.hoisted(() => ({ save: vi.fn(async () => undefined), revision: 17, manual: true }));
vi.mock('@/queries/sessionUnreadQueries', () => ({
  sessionUnreadQueryOptions: (_transport: string, entry: HostRuntimeEntry) => ({
    queryKey: [entry.key, 'unread'], staleTime: Infinity,
    queryFn: async () => ({ revision: fixture.revision, sessions: { same: { directory: '/repo', unreadCount: 1, hasError: false, manual: fixture.manual, revision: fixture.revision } } }),
  }),
  saveSessionUnread: fixture.save,
}));
afterEach(() => vi.restoreAllMocks());

test('remote open/focus acknowledges the actual revision and preserves a later manual reminder', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  fixture.save.mockClear(); fixture.revision = 17; fixture.manual = true;
  const entry = { key: 'host-a', location: { hubId: 'hub', hostId: 'a', directory: '/repo' }, sdk: vi.fn() } as unknown as HostRuntimeEntry;
  const registry = { subscribeEvents: vi.fn(() => () => {}) } as unknown as HostRuntimeRegistry;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const node = document.createElement('div'); document.body.append(node);
  const root = createRoot(node);
  function View() { useRemoteSessionViewed(registry, entry, 'same', true); return null; }
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><View /></QueryClientProvider>));
    await vi.waitFor(() => expect(fixture.save).toHaveBeenCalledWith('same', false, 17, entry));
    fixture.save.mockClear();
    await act(async () => { client.setQueryData([entry.key, 'unread'], { revision: 18, sessions: { same: { directory: '/repo', unreadCount: 1, hasError: false, manual: true, revision: 18 } } }); });
    expect(fixture.save).not.toHaveBeenCalled();
    await act(async () => window.dispatchEvent(new Event('focus')));
    await vi.waitFor(() => expect(fixture.save).toHaveBeenCalledWith('same', false, 18, entry));
    expect(registry.subscribeEvents).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount()); client.clear(); node.remove();
  }
});
