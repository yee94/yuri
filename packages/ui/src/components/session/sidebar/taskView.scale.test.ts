import { describe, expect, test } from 'vitest';

import type { Session } from '@/lib/opencode/v2-types';

import { deriveTaskBuckets, listVisibleTaskSessions } from './taskView';

const COUNT = 2000;

const makeSessions = (): Session[] => Array.from({ length: COUNT }, (_, index) => ({
  id: `ses_${index}`,
  time: { created: 1_000 + index, updated: 1_000 + ((index * 7919) % COUNT) },
}) as unknown as Session);

const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

describe('task view at scale', () => {
  const sessions = makeSessions();
  const settled = new Set(sessions.filter((_, index) => index % 3 !== 0).map((session) => session.id));
  const running = new Set(['ses_1', 'ses_2', 'ses_3']);
  const pending = new Set(['ses_10']);
  const unseen = { ses_20: 1, ses_30: 2 };
  const pinned = new Set(['ses_40']);

  test('partitioning 2000 sessions stays far below a frame', () => {
    const samples: number[] = [];
    for (let run = 0; run < 25; run += 1) {
      const start = performance.now();
      deriveTaskBuckets({
        sessions,
        pinnedSessionIds: pinned,
        settledSessionIds: settled,
        runningSessionIds: running,
        pendingRequestSessionIds: pending,
        unseenBySession: unseen,
      });
      samples.push(performance.now() - start);
    }
    expect(median(samples)).toBeLessThan(8);
    expect(Math.max(...samples)).toBeLessThan(40);
  });

  test('a collapsed shelf contributes no rows and an open one stops at its page', () => {
    const buckets = deriveTaskBuckets({
      sessions,
      pinnedSessionIds: pinned,
      settledSessionIds: settled,
      runningSessionIds: running,
      pendingRequestSessionIds: pending,
      unseenBySession: unseen,
    });
    expect(listVisibleTaskSessions(buckets, { settledOpen: false, settledLimit: 30 })).toHaveLength(buckets.active.length);
    expect(listVisibleTaskSessions(buckets, { settledOpen: true, settledLimit: 30 })).toHaveLength(buckets.active.length + 30);
  });
});
