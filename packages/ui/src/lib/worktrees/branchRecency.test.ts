import { beforeEach, describe, expect, test } from 'vitest';
import {
  getRecentBranchUsage,
  recordRecentBranchUsage,
  resolveBranchRecencyMap,
} from './branchRecency';

describe('branchRecency', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test('records and retrieves client recent branch usage per directory', () => {
    recordRecentBranchUsage('/repo/a', 'feat/one', 1_000);
    recordRecentBranchUsage('/repo/a', 'remotes/origin/feat/two', 2_000);
    recordRecentBranchUsage('/repo/b', 'main', 3_000);

    expect(Object.fromEntries(getRecentBranchUsage('/repo/a'))).toEqual({
      'feat/one': 1_000,
      'origin/feat/two': 2_000,
    });
    expect(Object.fromEntries(getRecentBranchUsage('/repo/b'))).toEqual({
      main: 3_000,
    });
  });

  test('merges server lastUsedAt and client recency taking the latest timestamp', () => {
    recordRecentBranchUsage('/repo/a', 'feat/client-newer', 5_000);
    recordRecentBranchUsage('/repo/a', 'feat/server-newer', 1_000);

    const merged = resolveBranchRecencyMap({
      directory: '/repo/a',
      branchInfo: {
        'feat/client-newer': { lastUsedAt: 2_000 },
        'feat/server-newer': { lastUsedAt: 9_000 },
        'remotes/origin/feat/remote': { lastUsedAt: 4_000 },
      },
    });

    expect(merged.get('feat/client-newer')).toBe(5_000);
    expect(merged.get('feat/server-newer')).toBe(9_000);
    expect(merged.get('origin/feat/remote')).toBe(4_000);
    expect(merged.get('remotes/origin/feat/remote')).toBe(4_000);
  });
});
