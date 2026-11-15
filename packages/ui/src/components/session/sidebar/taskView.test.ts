import { describe, expect, test } from 'vitest';
import type { Session } from '@/lib/opencode/v2-types';

import {
  SETTLED_SHELF_PAGE_SIZE,
  deriveTaskBuckets,
  listVisibleTaskSessions,
} from './taskView';

const session = (id: string, extra: Record<string, unknown> = {}): Session => ({
  id,
  title: id,
  directory: '/work',
  time: { created: 1, updated: 1 },
  ...extra,
}) as unknown as Session;

const none = new Set<string>();

describe('task view partition', () => {
  test('caps the settled shelf at its page limit and ignores collapsed shelves', () => {
    const settled = Array.from({ length: 344 }, (_, index) => session(`s${index}`));
    const buckets = deriveTaskBuckets({
      sessions: [session('a'), ...settled],
      pinnedSessionIds: none,
      settledSessionIds: new Set(settled.map((item) => item.id)),
      runningSessionIds: none,
      pendingRequestSessionIds: none,
      unseenBySession: {},
    });
    expect(buckets.settled).toHaveLength(344);

    const collapsed = listVisibleTaskSessions(buckets, { settledOpen: false, settledLimit: SETTLED_SHELF_PAGE_SIZE });
    expect(collapsed.map((item) => item.id)).toEqual(['a']);

    const open = listVisibleTaskSessions(buckets, { settledOpen: true, settledLimit: SETTLED_SHELF_PAGE_SIZE });
    expect(open).toHaveLength(1 + SETTLED_SHELF_PAGE_SIZE);
  });

  test('running and waiting sessions stay in the active list even when the Host settled them', () => {
    const buckets = deriveTaskBuckets({
      sessions: [session('running'), session('waiting'), session('quiet')],
      pinnedSessionIds: none,
      settledSessionIds: new Set(['running', 'waiting', 'quiet']),
      runningSessionIds: new Set(['running']),
      pendingRequestSessionIds: new Set(['waiting']),
      unseenBySession: {},
    });
    expect(buckets.active.map((item) => item.id).sort()).toEqual(['running', 'waiting']);
    expect(buckets.settled.map((item) => item.id)).toEqual(['quiet']);
  });
});
