import { describe, expect, test } from 'vitest';
import type { Session } from '@/lib/opencode/v2-types';
import { parseRemoteHostSummaries } from '@/lib/remote-projects/summaries';

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

  test('remote rows join the active list beside local rows without the local index filtering them', () => {
    const buckets = deriveTaskBuckets({
      sessions: [session('local', { time: { created: 1, updated: 10 } })],
      pinnedSessionIds: none,
      settledSessionIds: none,
      indexedSessionIds: new Set(['local']),
      runningSessionIds: none,
      pendingRequestSessionIds: none,
      unseenBySession: { 'remote-unread': 1 },
      remoteSessions: [
        session('remote-new', { time: { created: 1, updated: 20 } }),
        session('remote-unread', { time: { created: 1, updated: 5 } }),
      ],
    });
    expect(buckets.active.map((item) => item.id)).toEqual(['remote-unread', 'remote-new', 'local']);
    expect(buckets.settled).toEqual([]);
  });

  test('new remote activity reorders an existing task even when the session update time is old', () => {
    const local = session('local', { time: { created: 1, updated: 20 } });
    const remote = session('remote', { time: { created: 1, updated: 10 } });
    const order = (activityUpdatedAt: number, type: 'idle' | 'busy') => {
      const { directories } = parseRemoteHostSummaries({
        hubId: 'hub', hostId: 'host', stale: false, directories: [{ directory: '/work', sessions: [{
          ...remote, metadata: { yuri: { titleRefresh: { activityUpdatedAt }, sessionStatus: { type } } },
        }] }],
      }, 'hub', 'host');
      return deriveTaskBuckets({
        sessions: [local],
        remoteSessions: directories[0].sessions,
        pinnedSessionIds: none,
        settledSessionIds: none,
        runningSessionIds: type === 'busy' ? new Set([remote.id]) : none,
        pendingRequestSessionIds: none,
        unseenBySession: {},
      }).active.map(({ id }) => id);
    };
    expect(order(10, 'idle')).toEqual(['local', 'remote']);
    expect(order(30, 'busy')).toEqual(['remote', 'local']);
    expect(order(30, 'idle')).toEqual(['remote', 'local']);
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
