import { afterEach, expect, test, vi } from 'vitest';
import { queryClient } from '@/lib/queryRuntime';
import { sessionGoalQueryOptions } from '@/queries/sessionGoalQueries';
import { handleEvent } from './sync-context';
import { normalizeOpenCodeEvent, toLegacyEventShape } from './opencode-event-normalizer';
import type { ChildStoreManager } from './child-store';

afterEach(() => queryClient.clear());

test('native Goal envelopes update only their directory/session through the production sync dispatcher without opening a Location', () => {
  const goal = { id: 'g1', objective: 'Verify', status: 'active', rounds: 0, maxRounds: 50, boot: 'boot', updatedAt: 1 };
  const key = sessionGoalQueryOptions('ses_goal', '/repo').queryKey;
  const other = sessionGoalQueryOptions('ses_goal', '/other').queryKey;
  queryClient.setQueryData(other, goal);
  const ensureChild = vi.fn();
  const stores = { getChild: () => undefined, children: new Map(), ensureChild } as unknown as ChildStoreManager;
  const routing = { sessionDirectoryById: new Map(), messageSessionById: new Map(), sessionMessageIdsById: new Map() } as Parameters<typeof handleEvent>[3];
  for (const snapshot of [goal, { ...goal, status: 'paused', reason: 'Paused', updatedAt: 2 }, null]) {
    const normalized = normalizeOpenCodeEvent({
      type: 'rpc.opencode.goal.changed', location: { directory: '/repo' },
      data: { sessionID: 'ses_goal', goal: snapshot },
    });
    expect(normalized.action).toBe('emit');
    if (normalized.action !== 'emit') throw new Error('Goal event was dropped');
    handleEvent(normalized.event.locationDirectory!, toLegacyEventShape(normalized.event), stores, routing);
    expect(queryClient.getQueryData(key)).toEqual(snapshot);
    expect(queryClient.getQueryData(other)).toEqual(goal);
  }
  expect(ensureChild).not.toHaveBeenCalled();
});
