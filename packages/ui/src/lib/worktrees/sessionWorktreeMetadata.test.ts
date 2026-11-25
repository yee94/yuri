import { describe, expect, test } from 'vitest';
import type { Session } from '@/lib/opencode/v2-types';
import {
  buildSessionWorktreeMetadataPatch,
  formatWorktreeFooterLabel,
  readSessionWorktreeMetadata,
  sessionWorktreeToMetadata,
} from './sessionWorktreeMetadata';

describe('sessionWorktreeMetadata', () => {
  test('builds and reads durable worktree metadata for linked worktrees', () => {
    const patch = buildSessionWorktreeMetadataPatch(
      {
        source: 'sdk',
        name: 'feat-sidebar',
        path: '/worktrees/feat-sidebar/packages/ui',
        projectDirectory: '/monorepo/packages/ui',
        branch: 'feat/flat-sidebar',
        label: 'feat/flat-sidebar',
        worktreeRoot: '/worktrees/feat-sidebar',
        relativePath: 'packages/ui',
      },
      { id: 'proj-ui', path: '/monorepo/packages/ui' },
    );

    expect(patch).toEqual({
      yuri: {
        worktree: {
          projectId: 'proj-ui',
          projectDirectory: '/monorepo/packages/ui',
          worktreeRoot: '/worktrees/feat-sidebar',
          path: '/worktrees/feat-sidebar/packages/ui',
          branch: 'feat/flat-sidebar',
          name: 'feat-sidebar',
          relativePath: 'packages/ui',
        },
      },
    });

    const session = { id: 'ses_1', directory: '/worktrees/feat-sidebar/packages/ui', metadata: patch } as unknown as Session;
    expect(readSessionWorktreeMetadata(session)).toEqual({
      projectId: 'proj-ui',
      projectDirectory: '/monorepo/packages/ui',
      worktreeRoot: '/worktrees/feat-sidebar',
      path: '/worktrees/feat-sidebar/packages/ui',
      branch: 'feat/flat-sidebar',
      name: 'feat-sidebar',
      relativePath: 'packages/ui',
    });

    expect(sessionWorktreeToMetadata(session)).toMatchObject({
      path: '/worktrees/feat-sidebar/packages/ui',
      worktreeRoot: '/worktrees/feat-sidebar',
      projectDirectory: '/monorepo/packages/ui',
      branch: 'feat/flat-sidebar',
      name: 'feat-sidebar',
      relativePath: 'packages/ui',
    });
  });

  test('omits patch when worktree path matches the project root', () => {
    expect(
      buildSessionWorktreeMetadataPatch(
        {
          source: 'sdk',
          name: 'repo',
          path: '/repo',
          projectDirectory: '/repo',
          branch: 'main',
          label: 'main',
        },
        { id: 'proj-1', path: '/repo' },
      ),
    ).toBeUndefined();
  });

  test('formats compact worktree footer label with branch and distinct worktree name', () => {
    expect(formatWorktreeFooterLabel({
      branch: 'feat/flat-sidebar',
      name: 'sidebar-wt',
      path: '/worktrees/sidebar-wt',
      label: 'feat/flat-sidebar',
    })).toBe('feat/flat-sidebar · sidebar-wt');

    expect(formatWorktreeFooterLabel({
      branch: 'main',
      name: 'main',
      path: '/worktrees/main',
      label: 'main',
    })).toBe('main');

    expect(formatWorktreeFooterLabel({
      branch: '',
      name: 'detached-wt',
      path: '/worktrees/detached-wt',
      label: 'detached-wt',
    })).toBe('detached-wt');
  });
});
