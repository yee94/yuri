import { describe, expect, test } from 'vitest';

import type { SessionIndexSnapshot } from '@/lib/session-index-api';

import { patchSessionIndexSettled, readSettledSessionIds } from './sessionIndexSettleQueries';

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
