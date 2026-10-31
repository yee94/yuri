import { afterEach, expect, it, vi } from 'vitest';
import { opencodeClient } from '@/lib/opencode/client';
import { queryClient } from '@/lib/queryRuntime';
import { ChildStoreManager } from './child-store';
import { handleEvent } from './sync-context';
import type { Event } from './types';

afterEach(() => { queryClient.clear(); vi.restoreAllMocks(); });

it('reconnect re-bootstraps only the visible directory and defers the rest to their next demand', () => {
  vi.spyOn(opencodeClient, 'getDirectory').mockReturnValue('/current');
  const stores = new ChildStoreManager();
  const onBootstrap = vi.fn();
  stores.configure({ onBootstrap });
  const directories = ['/current', ...Array.from({ length: 12 }, (_, i) => `/history/${i}`)];
  for (const directory of directories) {
    stores.ensureChild(directory, { bootstrap: false }).setState({ status: 'complete', session_status_snapshot_at: 1 });
  }
  const routing = { sessionDirectoryById: new Map<string, string>(), messageSessionById: new Map<string, string>(), sessionMessageIdsById: new Map<string, Set<string>>() };

  handleEvent('global', { type: 'server.connected', properties: {} } as Event, stores, routing);

  expect(onBootstrap.mock.calls).toEqual([['/current']]);
  for (const directory of directories) {
    const state = stores.getChild(directory)!.getState();
    expect(state.status).toBe('loading');
    expect(state.session_status_snapshot_at).toBeUndefined();
  }

  onBootstrap.mockClear();
  stores.ensureChild('/history/3');
  expect(onBootstrap.mock.calls).toEqual([['/history/3']]);
  stores.ensureChild('/history/4', { bootstrap: false });
  expect(onBootstrap).toHaveBeenCalledTimes(1);
  stores.disposeAll();
});
