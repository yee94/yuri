import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, test, vi } from 'vitest';
import type { Session } from '@/lib/opencode/v2-types';
import type { WorktreeMetadata } from '@/types/worktree';

vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

import { useSessionGrouping } from './useSessionGrouping';

describe('useSessionGrouping (flat sidebar)', () => {
  test('flattens root and worktree sessions into the single root group and preserves node.worktree', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    let capturedGroups: ReturnType<ReturnType<typeof useSessionGrouping>['buildGroupedSessions']> = [];

    const worktree: WorktreeMetadata = {
      source: 'sdk',
      name: 'feat-wt',
      path: '/worktrees/feat-wt',
      worktreeRoot: '/worktrees/feat-wt',
      projectDirectory: '/repo',
      branch: 'feat/flat-sidebar',
      label: 'feat/flat-sidebar',
    };

    const sessions = [
      { id: 'root-1', title: 'Root chat', directory: '/repo', time: { created: 1, updated: 100 } },
      {
        id: 'wt-meta',
        title: 'Metadata worktree chat',
        directory: '/worktrees/meta-wt',
        time: { created: 2, updated: 200 },
        metadata: {
          yuri: {
            worktree: {
              projectDirectory: '/repo',
              worktreeRoot: '/worktrees/meta-wt',
              path: '/worktrees/meta-wt',
              branch: 'feat/meta-branch',
              name: 'meta-wt',
            },
          },
        },
      },
      { id: 'wt-catalog', title: 'Catalog worktree chat', directory: '/worktrees/feat-wt', time: { created: 3, updated: 150 } },
      { id: 'archived-1', title: 'Archived chat', directory: '/repo', time: { created: 4, updated: 50, archived: 60 } },
    ] as unknown as Session[];

    const Harness = () => {
      const { buildGroupedSessions } = useSessionGrouping({
        homeDirectory: null,
        worktreeMetadata: new Map(),
        pinnedSessionIds: new Set(),
        gitBranches: new Map(),
        isVSCode: false,
      });
      capturedGroups = buildGroupedSessions(sessions, '/repo', [worktree], 'main', true);
      return null;
    };

    const host = document.createElement('div');
    const root = createRoot(host);
    try {
      await act(async () => root.render(<Harness />));
      expect(capturedGroups.map((g) => g.id)).toEqual(['root', 'archived']);
      const rootGroup = capturedGroups[0];
      expect(rootGroup.sessions.map((node) => node.session.id)).toEqual([
        'wt-meta',
        'wt-catalog',
        'root-1',
      ]);
      expect(rootGroup.sessions[0].worktree).toMatchObject({
        branch: 'feat/meta-branch',
        name: 'meta-wt',
        path: '/worktrees/meta-wt',
      });
      expect(rootGroup.sessions[1].worktree).toMatchObject({
        branch: 'feat/flat-sidebar',
        name: 'feat-wt',
        path: '/worktrees/feat-wt',
      });
      expect(rootGroup.sessions[2].worktree).toBeNull();
      expect(capturedGroups[1].sessions.map((node) => node.session.id)).toEqual(['archived-1']);
    } finally {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
    }
  });
});
