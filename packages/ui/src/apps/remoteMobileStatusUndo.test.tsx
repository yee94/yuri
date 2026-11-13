import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { deleteRemoteMobileSessions } from './remoteMobileStatusUndo';
import type { RemoteMobileStatusOwner } from './remoteMobileStatusCatalog';

const f = vi.hoisted(() => ({ render: undefined as undefined | ((id: string) => React.ReactNode), error: vi.fn(), dismiss: vi.fn() }));
vi.mock('@/lib/sessionMutationUndo', () => ({ SESSION_DELETE_UNDO_MS: 100 }));
vi.mock('@/components/ui/toast', () => ({ toast: { custom: (render: (id: string) => React.ReactNode) => { f.render = render; }, error: f.error, dismiss: f.dismiss } }));
vi.mock('@/components/ui/UndoCountdownRing', () => ({ UndoCountdownRing: () => null }));

beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); });
afterEach(() => vi.useRealTimers());

function setup(failedHost?: string) {
  const deleted: string[] = [];
  const hidden = new Set<string>();
  const rows = ['a', 'b'].map((hostId) => ({ key: hostId, remote: {
    sessionId: 'same', directory: hostId === 'a' ? 'C:\\raw\\cwd' : '/repo',
    entry: { service: () => ({ deleteSession: async (id: string, directory: string) => {
      deleted.push(`${hostId}:${id}:${directory}`);
      if (hostId === failedHost) throw new Error('offline');
      return true;
    } }) },
  } as unknown as RemoteMobileStatusOwner }));
  const refresh = vi.fn(async () => {});
  deleteRemoteMobileSessions({ rows, message: 'deleted', undoLabel: 'undo', errorMessage: 'failed',
    hide: (keys) => keys.forEach((key) => hidden.add(key)), restore: (keys) => keys.forEach((key) => hidden.delete(key)), refresh });
  return { deleted, hidden, refresh };
}

it('waits for the original Undo interval and deletes by raw ID/cwd on each captured Host', async () => {
  const state = setup();
  expect(state.hidden).toEqual(new Set(['a', 'b'])); expect(state.deleted).toEqual([]);
  await vi.advanceTimersByTimeAsync(100);
  expect(state.deleted).toEqual(['b:same:/repo', 'a:same:C:\\raw\\cwd']);
  expect(state.refresh).toHaveBeenCalledTimes(2); expect(f.error).not.toHaveBeenCalled();
});

it('Undo restores all staged rows and prevents every deletion request', async () => {
  const state = setup();
  const node = document.createElement('div'); const root = createRoot(node);
  await act(async () => root.render(f.render!('toast')));
  await act(async () => node.querySelector('button')!.click());
  await vi.advanceTimersByTimeAsync(100);
  expect(state.hidden.size).toBe(0); expect(state.deleted).toEqual([]); expect(f.dismiss).toHaveBeenCalledWith('toast');
  await act(async () => root.unmount());
});

it('a failed Host restores only its own row and does not block the successful sibling', async () => {
  const state = setup('b');
  await vi.advanceTimersByTimeAsync(100);
  expect(state.hidden).toEqual(new Set(['a']));
  expect(state.deleted).toEqual(['b:same:/repo', 'a:same:C:\\raw\\cwd']);
  expect(state.refresh).toHaveBeenCalledTimes(2); expect(f.error).toHaveBeenCalledWith('failed');
});
