import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test, vi } from 'vitest';

const live = vi.hoisted(() => ({ running: new Set<string>() as ReadonlySet<string>, listeners: new Set<() => void>() }));
vi.mock('@/sync/sync-context', async () => {
  const { useSyncExternalStore } = await import('react');
  const subscribe = (listener: () => void) => {
    live.listeners.add(listener);
    return () => { live.listeners.delete(listener); };
  };
  return { useActiveSessionTreeIds: () => useSyncExternalStore(subscribe, () => live.running) };
});
vi.mock('@/sync/session-ui-store', async () => {
  const { create } = await import('zustand');
  return { useSessionUIStore: create<{ currentSessionId: string | null }>(() => ({ currentSessionId: 'viewing' })) };
});

import { useSessionUIStore } from '@/sync/session-ui-store';
import { useAlwaysVisibleSessionIds } from './useAlwaysVisibleSessionIds';

test('the viewed session finishing its turn keeps the always-visible set by reference', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const seen: ReadonlySet<string>[] = [];
  function Probe() {
    seen.push(useAlwaysVisibleSessionIds());
    return null;
  }
  const setRunning = (ids: string[]) => act(async () => {
    live.running = new Set(ids);
    live.listeners.forEach((listener) => listener());
  });
  const root = createRoot(document.createElement('div'));
  try {
    await setRunning(['viewing']);
    await act(async () => root.render(<Probe />));
    const initial = seen.at(-1)!;
    expect([...initial]).toEqual(['viewing']);
    await setRunning([]);
    expect(seen.at(-1)).toBe(initial);
    await setRunning(['other']);
    expect([...seen.at(-1)!].sort()).toEqual(['other', 'viewing']);
    await act(async () => useSessionUIStore.setState({ currentSessionId: null }));
    expect([...seen.at(-1)!]).toEqual(['other']);
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
