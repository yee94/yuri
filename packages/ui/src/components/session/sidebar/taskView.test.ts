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

  test('sessions the Host index does not hold stay out unless they are live', () => {
    const buckets = deriveTaskBuckets({
      sessions: [session('indexed'), session('old'), session('live-old')],
      pinnedSessionIds: none,
      settledSessionIds: none,
      indexedSessionIds: new Set(['indexed']),
      runningSessionIds: new Set(['live-old']),
      pendingRequestSessionIds: none,
      unseenBySession: {},
    });
    expect(buckets.active.map((item) => item.id).sort()).toEqual(['indexed', 'live-old']);
    expect(buckets.settled).toEqual([]);
  });

  test('project-view archives join the shelf, newest archive or settle first', () => {
    const buckets = deriveTaskBuckets({
      sessions: [
        session('archived-old', { time: { created: 1, updated: 1, archived: 100 } }),
        session('archived-new', { time: { created: 1, updated: 1, archived: 300 } }),
        session('settled-mid', { time: { created: 1, updated: 1 } }),
        session('open'),
      ],
      pinnedSessionIds: none,
      settledSessionIds: new Set(['settled-mid']),
      indexedSessionIds: new Set(['settled-mid', 'open']),
      settledAtBySessionId: new Map([['settled-mid', 200]]),
      runningSessionIds: none,
      pendingRequestSessionIds: none,
      unseenBySession: {},
    });
    expect(buckets.active.map((item) => item.id)).toEqual(['open']);
    expect(buckets.settled.map((item) => item.id)).toEqual(['archived-new', 'settled-mid', 'archived-old']);
  });
});
