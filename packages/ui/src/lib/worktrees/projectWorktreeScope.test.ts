import { describe, expect, test } from 'vitest';
import { scopeProjectWorktrees } from './projectWorktreeScope';
import type { WorktreeMetadata } from '@/types/worktree';

const tree = (path: string, projectDirectory = '/repo'): WorktreeMetadata => ({ path, worktreeRoot: path, projectDirectory, branch: 'feature', label: 'feature' });

describe('project worktree scope', () => {
  test('repairs persisted repository-root catalogs before first paint and is idempotent', () => {
    const result = scopeProjectWorktrees('/repo/src', [tree('/repo'), tree('/feature')]);
    expect(result).toMatchObject([{ path: '/feature/src', worktreeRoot: '/feature', relativePath: 'src' }]);
    const again = scopeProjectWorktrees('/repo/src', result);
    expect(again).toEqual(result);
    expect(again[0]).toBe(result[0]);
  });

  test('does not associate similarly named directories or independent clones', () => {
    const result = scopeProjectWorktrees('/repo-other', [tree('/feature', '/repo-other')]);
    expect(result[0].path).toBe('/feature');
    expect(result[0].relativePath).toBeUndefined();
  });

  test('chooses a nested checkout boundary before its containing checkout', () => {
    const result = scopeProjectWorktrees('/repo/.trees/feature/src', [tree('/repo'), tree('/repo/.trees/feature')]);
    expect(result).toMatchObject([{ path: '/repo/src', relativePath: 'src' }]);
  });

  test('does no I/O and scales with catalog entries, not session count', () => {
    let reads = 0;
    const entries = Array.from({ length: 200 }, (_, i) => ({ ...tree(`/feature-${i}`), get worktreeRoot() { reads++; return `/feature-${i}`; } }));
    expect(scopeProjectWorktrees('/repo/src', entries)).toHaveLength(200);
    expect(reads).toBeLessThanOrEqual(600);
  });
});
