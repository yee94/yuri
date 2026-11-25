import { describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/opencode/v2-types';

import { createSessionOwnershipIndex } from './sessionOwnership';

describe('createSessionOwnershipIndex', () => {
  test('assigns sessions to the deepest project and registered worktree', () => {
    const sessions = [
      { id: 'nested', directory: '/projects/app/packages/admin/src' },
      { id: 'external-worktree', directory: '/worktrees/app-feature/src' },
      { id: 'worktree-fallback', project: { worktree: '/worktrees/app-feature/src' } },
      { id: 'directory-wins', directory: '/projects/app/packages/admin', project: { worktree: '/projects/app' } },
      { id: 'windows', directory: 'c:\\Projects\\App\\src' },
      { id: 'unassigned', directory: '/elsewhere' },
    ] as unknown as Session[];
    const projects = [
      { id: 'app', normalizedPath: '/projects/app' },
      { id: 'admin', normalizedPath: '/projects/app/packages/admin' },
      { id: 'windows-app', normalizedPath: 'C:/Projects/App' },
    ];
    const worktrees = new Map([
      ['/projects/app', [{ path: '/worktrees/app-feature' }]],
    ]);

    const ownership = createSessionOwnershipIndex(sessions, projects, worktrees, false);

    expect(ownership.bySessionId.get('nested')?.projectId).toBe('admin');
    expect(ownership.bySessionId.get('external-worktree')).toEqual({
      projectId: 'app',
      projectRoot: '/projects/app',
      scopeDirectory: '/worktrees/app-feature',
      kind: 'worktree',
    });
    expect(ownership.bySessionId.get('worktree-fallback')?.scopeDirectory).toBe('/worktrees/app-feature');
    expect(ownership.bySessionId.get('directory-wins')?.projectId).toBe('admin');
    expect(ownership.bySessionId.get('windows')?.projectId).toBe('windows-app');
    expect(ownership.bySessionId.has('unassigned')).toBe(false);
    expect(ownership.sessionsByProject.get('admin')?.map((session) => session.id)).toEqual([
      'nested',
      'directory-wins',
    ]);
    expect(ownership.sessionsByScope.get('/worktrees/app-feature')).toEqual(new Set([
      'external-worktree',
      'worktree-fallback',
    ]));
  });

  test('gives an exact project precedence over a colliding worktree', () => {
    const ownership = createSessionOwnershipIndex(
      [{ id: 'nested', directory: '/projects/app/packages/admin/src' } as Session],
      [
        { id: 'app', normalizedPath: '/projects/app' },
        { id: 'admin', normalizedPath: '/projects/app/packages/admin' },
      ],
      new Map([['/projects/app', [{ path: '/projects/app/packages/admin' }]]]),
      false,
    );

    expect(ownership.bySessionId.get('nested')?.projectId).toBe('admin');
    expect(ownership.bySessionId.get('nested')?.kind).toBe('project');
  });

  test('indexes archived sessions separately', () => {
    const ownership = createSessionOwnershipIndex(
      [],
      [{ id: 'app', normalizedPath: '/projects/app' }],
      new Map([['/projects/app', [{ path: '/worktrees/app-feature' }]]]),
      false,
      [
        { id: 'archived-child', directory: '/worktrees/app-feature/src', time: { archived: 1 } },
        { id: 'archived-fallback', project: { worktree: '/worktrees/app-feature' }, time: { archived: 1 } },
      ] as unknown as Session[],
    );

    expect(ownership.archivedSessionsByProject.get('app')?.map((session) => session.id)).toEqual([
      'archived-child',
      'archived-fallback',
    ]);
  });

  test('requires exact workspace directories in VS Code', () => {
    const ownership = createSessionOwnershipIndex(
      [
        { id: 'workspace', directory: '/projects/app' },
        { id: 'nested', directory: '/projects/app/packages/ui' },
      ] as Session[],
      [{ id: 'app', normalizedPath: '/projects/app' }],
      new Map(),
      true,
    );

    expect(ownership.bySessionId.get('workspace')?.projectId).toBe('app');
    expect(ownership.bySessionId.has('nested')).toBe(false);
  });

  test('supports a Windows drive root project', () => {
    const ownership = createSessionOwnershipIndex(
      [{ id: 'windows-root', directory: 'c:\\Users\\name\\project' } as Session],
      [{ id: 'drive', normalizedPath: 'C:/' }],
      new Map(),
      false,
    );

    expect(ownership.bySessionId.get('windows-root')?.projectId).toBe('drive');
  });

  test('resolves report-sized data once instead of once per project consumer', () => {
    const projects = Array.from({ length: 15 }, (_, index) => ({
      id: `project-${index}`,
      normalizedPath: `/projects/${index}`,
    }));
    const worktrees = new Map(projects.map((project, projectIndex) => [
      project.normalizedPath,
      Array.from({ length: projectIndex < 7 ? 5 : 4 }, (_, index) => ({
        path: `/worktrees/${projectIndex}/${index}`,
      })),
    ]));
    const sessions = Array.from({ length: 14_561 }, (_, index) => ({
      id: `session-${index}`,
      directory: `/worktrees/${index % 15}/${index % 4}/session/${index}`,
    })) as unknown as Session[];

    const ownership = createSessionOwnershipIndex(sessions, projects, worktrees, false);

    expect(ownership.bySessionId.size).toBe(14_561);
    expect(ownership.directoryResolutions).toBeLessThan(14_561 * 2);
    expect([...ownership.sessionsByProject.values()].reduce((total, bucket) => total + bucket.length, 0)).toBe(14_561);
  });

  test('binds monorepo subdirectory worktree sessions via durable metadata without auto-discovered worktrees', () => {
    const sessions = [
      {
        id: 'sub-wt-session',
        directory: '/worktrees/feat-a/packages/web',
        metadata: {
          yuri: {
            worktree: {
              projectId: 'web-sub',
              projectDirectory: '/monorepo/packages/web',
              worktreeRoot: '/worktrees/feat-a',
              path: '/worktrees/feat-a/packages/web',
              branch: 'feat/a',
              name: 'feat-a',
              relativePath: 'packages/web',
            },
          },
        },
      },
      {
        id: 'api-wt-session',
        directory: '/worktrees/feat-b/packages/api',
        metadata: {
          yuri: {
            worktree: {
              projectDirectory: '/monorepo/packages/api',
              worktreeRoot: '/worktrees/feat-b',
              path: '/worktrees/feat-b/packages/api',
              branch: 'feat/b',
              name: 'feat-b',
            },
          },
        },
      },
    ] as unknown as Session[];

    const projects = [
      { id: 'web-sub', normalizedPath: '/monorepo/packages/web' },
      { id: 'api-sub', normalizedPath: '/monorepo/packages/api' },
    ];

    const ownership = createSessionOwnershipIndex(sessions, projects, new Map(), false);

    expect(ownership.bySessionId.get('sub-wt-session')).toEqual({
      projectId: 'web-sub',
      projectRoot: '/monorepo/packages/web',
      scopeDirectory: '/worktrees/feat-a/packages/web',
      kind: 'worktree',
    });
    expect(ownership.bySessionId.get('api-wt-session')).toEqual({
      projectId: 'api-sub',
      projectRoot: '/monorepo/packages/api',
      scopeDirectory: '/worktrees/feat-b/packages/api',
      kind: 'worktree',
    });
    expect(ownership.sessionsByProject.get('web-sub')?.map((s) => s.id)).toEqual(['sub-wt-session']);
    expect(ownership.sessionsByProject.get('api-sub')?.map((s) => s.id)).toEqual(['api-wt-session']);
  });

  test('binds explicit metadata.yuri.workspaceId sessions to multi-path workspaces without stealing legacy single-path sessions', () => {
    const sessions = [
      {
        id: 'multi-ws-session',
        directory: '/code/yuri',
        metadata: { yuri: { workspaceId: 'ws_combo' } },
      },
      {
        id: 'legacy-yuri-session',
        directory: '/code/yuri',
      },
      {
        id: 'fallback-extra-session',
        directory: '/code/agent-tracker',
      },
    ] as unknown as Session[];

    const projects = [
      { id: 'path_yuri', normalizedPath: '/code/yuri' },
      { id: 'ws_combo', normalizedPath: '/code/yuri', paths: ['/code/yuri', '/code/agent-tracker'] },
    ];

    const ownership = createSessionOwnershipIndex(sessions, projects, new Map(), false);

    expect(ownership.bySessionId.get('multi-ws-session')?.projectId).toBe('ws_combo');
    expect(ownership.bySessionId.get('legacy-yuri-session')?.projectId).toBe('path_yuri');
    expect(ownership.bySessionId.get('fallback-extra-session')?.projectId).toBe('ws_combo');
    expect(ownership.sessionsByProject.get('ws_combo')?.map((s) => s.id)).toEqual([
      'multi-ws-session',
      'fallback-extra-session',
    ]);
    expect(ownership.sessionsByProject.get('path_yuri')?.map((s) => s.id)).toEqual(['legacy-yuri-session']);
  });
});
