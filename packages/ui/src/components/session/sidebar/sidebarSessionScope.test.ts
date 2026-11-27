import { describe, expect, test } from 'vitest';
import type { Session } from '@/lib/opencode/v2-types';

import { createSessionOwnershipIndex } from './sessionOwnership';
import { filterOwnedSessions, filterVSCodeWorkspaceSessions } from './sidebarSessionScope';

const session = (id: string, extra: Record<string, unknown> = {}): Session =>
  ({ id, time: { created: 1, updated: 1 }, ...extra }) as unknown as Session;

describe('filterOwnedSessions (desktop/web)', () => {
  const projects = [{ id: 'app', normalizedPath: '/projects/app' }];

  test('keeps a session in an externally created worktree that the worktree map does not know', () => {
    const external = session('external', {
      directory: '/projects/app-worktrees/feature',
      projectID: 'oc-app',
    });
    const sessions = [external];
    const ownership = createSessionOwnershipIndex(
      sessions,
      projects,
      new Map(),
      false,
      [],
      new Map([['oc-app', '/projects/app']]),
    );

    expect(ownership.bySessionId.get('external')?.projectId).toBe('app');
    expect(filterOwnedSessions(sessions, ownership, true)).toEqual([external]);
  });

  test('keeps a session nested under a registered project directory', () => {
    const nested = session('nested', { directory: '/projects/app/packages/web' });
    const ownership = createSessionOwnershipIndex([nested], projects, new Map(), false);

    expect(filterOwnedSessions([nested], ownership, true)).toEqual([nested]);
  });

  test('keeps a session in a multi-path workspace member directory', () => {
    const workspaces = [{ id: 'ws_one', normalizedPath: '/work/a', paths: ['/work/a', '/work/b'] }];
    const member = session('member', { directory: '/work/b/src' });
    const ownership = createSessionOwnershipIndex([member], workspaces, new Map(), false);

    expect(ownership.bySessionId.get('member')?.projectId).toBe('ws_one');
    expect(filterOwnedSessions([member], ownership, true)).toEqual([member]);
  });

  test('drops active sessions no registered project owns', () => {
    const stranger = session('stranger', { directory: '/elsewhere/repo' });
    const owned = session('owned', { directory: '/projects/app' });
    const ownership = createSessionOwnershipIndex([stranger, owned], projects, new Map(), false);

    expect(filterOwnedSessions([stranger, owned], ownership, true)).toEqual([owned]);
  });

  test('never drops archived or directory-less sessions, and is a no-op without projects', () => {
    const archived = session('archived', { directory: '/elsewhere', time: { created: 1, updated: 1, archived: 2 } });
    const blank = session('blank');
    const ownership = createSessionOwnershipIndex([archived, blank], projects, new Map(), false);
    expect(filterOwnedSessions([archived, blank], ownership, true)).toEqual([archived, blank]);

    const stranger = session('stranger', { directory: '/elsewhere' });
    const empty = createSessionOwnershipIndex([stranger], [], new Map(), false);
    expect(filterOwnedSessions([stranger], empty, false)).toEqual([stranger]);
  });
});

describe('filterVSCodeWorkspaceSessions', () => {
  test('keeps the strict workspace-path filter', () => {
    const inside = session('inside', { directory: '/Workspace/App' });
    const worktree = session('worktree', { directory: '/worktrees/app-feature' });
    const blank = session('blank');
    const archived = session('archived', { directory: '/other', time: { created: 1, updated: 1, archived: 2 } });

    const result = filterVSCodeWorkspaceSessions(
      [inside, worktree, blank, archived],
      [{ path: '/workspace/app/' }],
    );

    expect(result.map((item) => item.id)).toEqual(['inside', 'archived']);
  });
});
