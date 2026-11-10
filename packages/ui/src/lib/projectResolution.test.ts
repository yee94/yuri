import { describe, expect, test } from 'vitest';
import { resolveProjectForSessionDirectory } from './projectResolution';
import { createSessionOwnershipIndex } from '@/components/session/sidebar/sessionOwnership';
import type { Session } from '@/lib/opencode/v2-types';

describe('nested project ownership', () => {
  const projects = [{ id: 'repo', path: '/repo' }, { id: 'src', path: '/repo/src' }];
  const worktrees = new Map([
    ['/repo', [{ path: '/feature', projectDirectory: '/repo', branch: 'feature', label: 'feature' }]],
    ['/repo/src', [{ path: '/feature/src', worktreeRoot: '/feature', projectDirectory: '/repo/src', branch: 'feature', label: 'feature' }]],
  ]);

  test('a repository-root worktree cannot override an explicitly registered nested project', () => {
    const catalog = new Map([['/repo', [{ path: '/repo', projectDirectory: '/repo', branch: 'main', label: 'main' }]]]);
    expect(resolveProjectForSessionDirectory(projects, catalog, '/repo/src')?.id).toBe('src');
  });

  test.each(['/repo', '/repo/src', '/feature', '/feature/src', '/feature/src/deep'])('creation and sidebar agree for %s', (directory) => {
    const session = { id: 'test', directory } as Session;
    const owner = createSessionOwnershipIndex([session], projects.map(p => ({ ...p, normalizedPath: p.path })), worktrees, false);
    expect(resolveProjectForSessionDirectory(projects, worktrees, directory)?.id).toBe(owner.bySessionId.get(session.id)?.projectId);
    expect(resolveProjectForSessionDirectory(projects, worktrees, directory)?.id).toBe(directory.includes('/src') ? 'src' : 'repo');
  });

  test('a project opened inside a worktree owns its own sessions instead of the canonical repository', () => {
    const opened = [...projects, { id: 'feature-src', path: '/feature/src' }];
    expect(resolveProjectForSessionDirectory(opened, worktrees, '/feature/src')?.id).toBe('feature-src');
  });
});
