import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test, vi } from 'vitest';

import type { SessionIndexSnapshot } from '@/lib/session-index-api';

const fixture = vi.hoisted(() => ({
  transport: 'settle-test',
  generation: 1,
  settle: vi.fn<(id: string) => Promise<void>>(),
  unsettle: vi.fn<(id: string) => Promise<void>>(),
  error: vi.fn(),
}));
vi.mock('@/lib/session-index-api', async (original) => ({
  ...await original<typeof import('@/lib/session-index-api')>(),
  settleSession: fixture.settle,
  unsettleSession: fixture.unsettle,
}));
vi.mock('@/lib/runtime-switch', async (original) => ({
  ...await original<typeof import('@/lib/runtime-switch')>(),
  getRuntimeTransportIdentity: () => fixture.transport,
  getRuntimeGeneration: () => fixture.generation,
}));
vi.mock('@/components/ui', () => ({ toast: { error: fixture.error } }));

import { patchSessionIndexSettled, readSettledSessionIds, unsettleSessionOnSend, useSetSessionSettled } from './sessionIndexSettleQueries';
import { readSessionIndexSnapshotQuery, writeSessionIndexSnapshotQuery } from './sessionIndexQueries';

const snapshot = (settledIds: string[], revision = 1): SessionIndexSnapshot => ({
  revision,
  sync: { active: false, completed: 0, total: 0, pendingDirectories: [], completedDirectories: [], failedDirectories: [] },
  directories: [
    {
      directory: '/a',
      sessions: Array.from({ length: 4 }, (_, index) => ({
        id: `a${index}`,
        time: { created: 1, updated: revision, settled: settledIds.includes(`a${index}`) ? 5 : null },
      })),
    },
    { directory: '/b', sessions: [{ id: 'b0', time: { created: 1, updated: 1, settled: null } }] },
  ],
}) as unknown as SessionIndexSnapshot;

const clientFor = (current: SessionIndexSnapshot | null) => ({
  getQueryData: () => current,
}) as unknown as Parameters<typeof readSettledSessionIds>[0];

describe('settled id set', () => {
  test('keeps one reference across new snapshots with the same settled members', () => {
    const first = readSettledSessionIds(clientFor(snapshot(['a1'], 1)), 'transport-stable');
    const second = readSettledSessionIds(clientFor(snapshot(['a1'], 2)), 'transport-stable');
    expect(second).toBe(first);
    const changed = readSettledSessionIds(clientFor(snapshot(['a1', 'a2'], 3)), 'transport-stable');
    expect(changed).not.toBe(first);
    expect([...changed].sort()).toEqual(['a1', 'a2']);
  });

  test('repeated reads of one snapshot do no new derivation', () => {
    const current = snapshot(['a0']);
    const client = clientFor(current);
    const first = readSettledSessionIds(client, 'transport-repeat');
    for (let i = 0; i < 50; i += 1) expect(readSettledSessionIds(client, 'transport-repeat')).toBe(first);
  });
});

describe('settle patch', () => {
  test('touches only the target session and keeps every other reference', () => {
    const before = snapshot([]);
    const after = patchSessionIndexSettled(before, 'a2', 99);
    expect(after).not.toBe(before);
    expect(after.directories[1]).toBe(before.directories[1]);
    const [aBefore, aAfter] = [before.directories[0].sessions, after.directories[0].sessions];
    expect(aAfter[2].time.settled).toBe(99);
    for (const index of [0, 1, 3]) expect(aAfter[index]).toBe(aBefore[index]);
  });

  test('is a no-op when the value already matches or the session is unknown', () => {
    const before = snapshot(['a1']);
    expect(patchSessionIndexSettled(before, 'a1', 5)).toBe(before);
    expect(patchSessionIndexSettled(before, 'a0', null)).toBe(before);
    expect(patchSessionIndexSettled(before, 'missing', 7)).toBe(before);
  });
});

const hostSnapshot = (settledIds: string[]): SessionIndexSnapshot => {
  const next = snapshot(settledIds);
  for (const directory of next.directories) {
    Object.assign(directory, { cursor: null, hasMore: false, lastSyncedAt: 1, lastFullSyncedAt: 1, lastAccessedAt: 1 });
    for (const row of directory.sessions) Object.assign(row, { title: row.id, directory: directory.directory });
  }
  return next;
};

describe('unsettle on send', () => {
  test('leaves the shelf at once and writes the Host override only for settled sessions', async () => {
    fixture.unsettle.mockReset();
    fixture.unsettle.mockResolvedValue(undefined);
    const client = new QueryClient();
    writeSessionIndexSnapshotQuery(hostSnapshot(['a1']), { client, transport: 'send-test', persist: false });

    unsettleSessionOnSend('a0', client, 'send-test');
    expect(fixture.unsettle).not.toHaveBeenCalled();

    unsettleSessionOnSend('a1', client, 'send-test');
    expect(readSessionIndexSnapshotQuery(client, 'send-test')?.directories[0].sessions[1].time.settled).toBeNull();
    expect(readSettledSessionIds(client, 'send-test').has('a1')).toBe(false);
    expect(fixture.unsettle).toHaveBeenCalledExactlyOnceWith('a1');
    client.clear();
  });

  test('a failed Host write falls back to the Host snapshot without a toast', async () => {
    fixture.unsettle.mockReset();
    fixture.unsettle.mockRejectedValue(new Error('write failed'));
    fixture.error.mockClear();
    fixture.transport = 'send-fail';
    const client = new QueryClient();
    const fetchQuery = vi.spyOn(client, 'fetchQuery').mockResolvedValue(null);
    writeSessionIndexSnapshotQuery(hostSnapshot(['a1']), { client, transport: 'send-fail', persist: false });
    try {
      unsettleSessionOnSend('a1', client, 'send-fail');
      await vi.waitFor(() => expect(fetchQuery).toHaveBeenCalledOnce());
      expect(fixture.error).not.toHaveBeenCalled();
    } finally {
      fixture.transport = 'settle-test';
      client.clear();
    }
  });
});

test.each(['success', 'failure', 'stale-generation', 'stale-transport', 'concurrent'] as const)('settle completion callback is confirmed and runtime-fenced (%s)', async (mode) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture.transport = 'settle-test';
  fixture.generation = 1;
  fixture.error.mockClear();
  const completions = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  fixture.settle.mockImplementation((id) => new Promise<void>((resolve, reject) => {
    completions.set(id, { resolve, reject });
  }));
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const initial = snapshot([], 1);
  for (const directory of initial.directories) {
    Object.assign(directory, { cursor: null, hasMore: false, lastSyncedAt: 1, lastFullSyncedAt: 1, lastAccessedAt: 1 });
    for (const row of directory.sessions) Object.assign(row, { title: row.id, directory: directory.directory });
  }
  writeSessionIndexSnapshotQuery(initial, { client, persist: false });
  let submit: ReturnType<typeof useSetSessionSettled> | undefined;
  function Surface() {
    submit = useSetSessionSettled();
    return null;
  }
  const host = document.createElement('div');
  const root = createRoot(host);
  const onSuccess = vi.fn();
  const secondSuccess = vi.fn();
  try {
    await act(async () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(Surface))));
    await act(async () => submit!('a0', true, { onSuccess }));
    expect(onSuccess).not.toHaveBeenCalled();
    expect(readSessionIndexSnapshotQuery(client)?.directories[0].sessions[0].time.settled).toBeGreaterThan(0);
    if (mode === 'concurrent') {
      await act(async () => submit!('a1', true, { onSuccess: secondSuccess }));
    }
    if (mode === 'stale-generation') fixture.generation++;
    if (mode === 'stale-transport') fixture.transport = 'other-runtime';
    await act(async () => {
      if (mode === 'failure') completions.get('a0')!.reject(new Error('write failed'));
      else completions.get('a0')!.resolve();
    });
    expect(onSuccess).toHaveBeenCalledTimes(mode === 'success' || mode === 'concurrent' ? 1 : 0);
    if (mode === 'failure') {
      expect(readSessionIndexSnapshotQuery(client)?.directories[0].sessions[0].time.settled).toBeNull();
      expect(fixture.error).toHaveBeenCalledOnce();
    }
    if (mode === 'concurrent') {
      expect(secondSuccess).not.toHaveBeenCalled();
      await act(async () => completions.get('a1')!.resolve());
      expect(secondSuccess).toHaveBeenCalledOnce();
    }
  } finally {
    await act(async () => root.unmount());
    client.clear();
    fixture.transport = 'settle-test';
    fixture.generation = 1;
    vi.unstubAllGlobals();
  }
});
