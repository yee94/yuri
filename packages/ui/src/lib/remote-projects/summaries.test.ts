import { describe, expect, it } from 'vitest';
import { parseRemoteHostSummaries, readRemoteTaskRunStartedAt, remoteHostSummariesKey, resolveRemoteProjectOwner } from './summaries';

const snapshot = () => ({
  hubId: 'hub', hostId: 'host', stale: true, revision: 2, token: 'must-not-cross',
  directories: [{ directory: 'C:\\Raw Path\\', hasMore: true, cursor: 4, sessions: [{ id: 'same-session', title: 'Title',
    time: { created: 1, updated: 2, pinned: '2026-01-01' }, parts: ['must-not-cross'],
    metadata: { token: 'must-not-cross', yuri: { sessionStatus: { type: 'busy' } } },
  }] }],
  pinnedSessionIds: ['same-session'], unread: { revision: 1, sessions: { 'same-session': { directory: 'C:\\Raw Path\\', unreadCount: 2, manual: true } } },
  folders: { version: 1, foldersMap: { root: [{ id: 'folder', name: 'Folder', sessionIds: ['same-session'] }] }, collapsedFolderIds: ['folder'] },
  order: { revision: 5, sessionOrderByScope: { root: ['same-session'] }, sessionOrderActivityByScope: { root: { 'same-session': 123 } } },
});

describe('Hub remote summary projection', () => {
  it('keeps raw paths and organization while excluding content and marking stale activity unknown', () => {
    const parsed = parseRemoteHostSummaries(snapshot(), 'hub', 'host');
    expect(parsed.directories[0].directory).toBe('C:\\Raw Path\\');
    expect(parsed.directories[0].sessions[0].metadata).toEqual({ yuri: { sessionStatus: { type: 'unknown', lastKnown: 'busy' } } });
    expect(parsed.unread?.sessions['same-session'].unreadCount).toBe(2);
    expect(parsed.folders?.foldersMap.root[0].sessionIds).toEqual(['same-session']);
    expect(parsed.order?.sessionOrderByScope.root).toEqual(['same-session']);
    expect(JSON.stringify(parsed)).not.toContain('must-not-cross');
    expect(remoteHostSummariesKey('transport', 'hub', 'host')).not.toEqual(remoteHostSummariesKey('transport', 'hub-2', 'host'));
  });

  it('rejects scope mismatch or malformed authoritative data instead of producing empty success', () => {
    expect(() => parseRemoteHostSummaries(snapshot(), 'hub', 'another-host')).toThrow();
    expect(() => parseRemoteHostSummaries({ ...snapshot(), directories: null }, 'hub', 'host')).toThrow();
    expect(() => parseRemoteHostSummaries({ ...snapshot(), hubId: 'other-hub' }, 'hub', 'host')).toThrow();
  });

  it('keeps workspace identity and uses only a current running status for elapsed time', () => {
    const source = snapshot();
    const session = source.directories[0].sessions[0];
    session.metadata.yuri = { workspaceId: 'ws_1', sessionStatus: { type: 'busy', changedAt: 12_000 } } as typeof session.metadata.yuri;
    const read = (stale: boolean) => parseRemoteHostSummaries({ ...source, stale }, 'hub', 'host').directories[0].sessions[0];
    expect(read(false).metadata?.yuri).toMatchObject({ workspaceId: 'ws_1' });
    expect(readRemoteTaskRunStartedAt(read(false))).toBe(12_000);
    expect(readRemoteTaskRunStartedAt(read(true))).toBeNull();
  });

  it('retains stale topology paths but excludes non-path data and rejects malformed topology instead of clearing it', () => {
    const worktrees = { projectDirectories: { '/repo': ['/repo', '/external checkout'] }, staleProjectDirectories: ['/repo'], token: 'must-not-cross' };
    const parsed = parseRemoteHostSummaries({ ...snapshot(), worktrees }, 'hub', 'host');
    expect(parsed.worktrees).toEqual({ projectDirectories: worktrees.projectDirectories, staleProjectDirectories: ['/repo'] });
    expect(JSON.stringify(parsed)).not.toContain('must-not-cross');
    for (const malformed of [null, { ...worktrees, projectDirectories: { '/repo': null } }, { ...worktrees, staleProjectDirectories: null }]) {
      expect(() => parseRemoteHostSummaries({ ...snapshot(), worktrees: malformed }, 'hub', 'host')).toThrow();
    }
  });

  it('resolves verified external checkouts with longest ownership and Host isolation, without inferring nested aliases', () => {
    const root = { id: 'root', path: '/repo', hostId: 'host', hubId: 'hub' };
    const nested = { ...root, id: 'nested', path: '/repo/src' };
    const otherHost = { ...nested, id: 'foreign', hostId: 'other' };
    const worktrees = { projectDirectories: { '/repo': ['/repo', '/external checkout'], '/repo/src': [] }, staleProjectDirectories: ['/repo/src'] };
    expect(resolveRemoteProjectOwner([root, nested, otherHost], 'hub', 'host', '/external checkout/src/lib', worktrees)).toBe(root);
    expect(resolveRemoteProjectOwner([root, nested], 'hub', 'host', '/external checkout/docs', worktrees)).toBe(root);
    expect(resolveRemoteProjectOwner([nested], 'hub', 'host', '/external checkout/docs', worktrees)).toBeUndefined();
    expect(resolveRemoteProjectOwner([root], 'hub', 'host', '/external checkout-elsewhere', worktrees)).toBeUndefined();
    expect(resolveRemoteProjectOwner([root], 'other-hub', 'host', '/repo', worktrees)).toBeUndefined();
    expect(resolveRemoteProjectOwner([root, nested], 'hub', 'host', '/repo/src')).toBe(nested);
    const verifiedNested = { projectDirectories: { '/repo/src': ['/repo/src', '/external checkout/src'] }, staleProjectDirectories: [] };
    expect(resolveRemoteProjectOwner([root, nested], 'hub', 'host', '/external checkout/src/lib', verifiedNested)).toBe(nested);
    const effectiveSuffix = { projectDirectories: { '/repo/src': ['/repo/src', '/other/src'] }, staleProjectDirectories: [] };
    expect(resolveRemoteProjectOwner([nested], 'hub', 'host', '/other/src', effectiveSuffix)).toBe(nested);
    expect(resolveRemoteProjectOwner([nested], 'hub', 'host', '/other/src/lib', effectiveSuffix)).toBe(nested);
    expect(resolveRemoteProjectOwner([nested], 'hub', 'host', '/other', effectiveSuffix)).toBeUndefined();
    expect(resolveRemoteProjectOwner([nested], 'hub', 'host', '/other/docs', effectiveSuffix)).toBeUndefined();
  });

  it('rejects ambiguous aliases rather than depending on catalog order, while preserving explicit project roots', () => {
    const a = { path: '/repo-a', hostId: 'host' };
    const b = { path: '/repo-b', hostId: 'host' };
    const worktrees = { projectDirectories: { '/repo-a': ['/repo-a', '/shared'], '/repo-b': ['/repo-b', '/shared'] }, staleProjectDirectories: [] };
    expect(resolveRemoteProjectOwner([a, b], 'hub', 'host', '/shared', worktrees)).toBeUndefined();
    expect(resolveRemoteProjectOwner([b, a], 'hub', 'host', '/shared', worktrees)).toBeUndefined();
    expect(resolveRemoteProjectOwner([a, b, { path: '/shared', hostId: 'host' }], 'hub', 'host', '/shared', worktrees)?.path).toBe('/shared');
    const explicitParent = { path: '/', hostId: 'host' };
    expect(resolveRemoteProjectOwner([a, explicitParent], 'hub', 'host', '/shared/nested', worktrees)).toBe(explicitParent);
  });

  it('owns every member of a same-Host workspace, keeps shared roots with the single project unless the session names the workspace', () => {
    const single = { id: 'single', path: '/repo', hostId: 'host' };
    const workspace = { id: 'workspace', path: '/repo', paths: ['/repo', '/lib'], remoteProjectId: 'ws_1', hostId: 'host' };
    const elsewhere = { ...workspace, id: 'elsewhere', hostId: 'other' };
    const topology = { projectDirectories: { '/lib': ['/lib', '/lib-checkout'] }, staleProjectDirectories: [] };
    expect(resolveRemoteProjectOwner([single, workspace, elsewhere], 'hub', 'host', '/lib/src')).toBe(workspace);
    expect(resolveRemoteProjectOwner([single, workspace], 'hub', 'host', '/lib-checkout/src', topology)).toBe(workspace);
    expect(resolveRemoteProjectOwner([workspace, single], 'hub', 'host', '/repo/src')).toBe(single);
    expect(resolveRemoteProjectOwner([single, workspace], 'hub', 'host', '/repo/src', undefined, 'ws_1')).toBe(workspace);
    expect(resolveRemoteProjectOwner([single, workspace], 'hub', 'host', '/lib/src', topology, 'ws_1')).toBe(workspace);
    expect(resolveRemoteProjectOwner([single, workspace], 'hub', 'host', '/elsewhere', undefined, 'ws_1')).toBeUndefined();
    expect(resolveRemoteProjectOwner([single, workspace], 'hub', 'host', '/repo', undefined, 'ws_other')).toBe(single);
    expect(resolveRemoteProjectOwner([workspace], 'hub', 'other', '/lib')).toBeUndefined();
  });

  it('compares Windows catalog paths without changing raw project or target paths', () => {
    const project = { path: 'c:\\Repo\\', hostId: 'host', hubId: 'hub' };
    const directory = 'd:\\Work Trees\\topic\\src';
    const topology = { projectDirectories: { 'C:/Repo': ['C:/Repo', 'D:/Work Trees/topic/'] }, staleProjectDirectories: [] };
    expect(resolveRemoteProjectOwner([project], 'hub', 'host', directory, topology)).toBe(project);
    expect(project.path).toBe('c:\\Repo\\');
    expect(directory).toBe('d:\\Work Trees\\topic\\src');
    expect(resolveRemoteProjectOwner([project], 'hub', 'host', 'D:/Work Trees/topic-other', topology)).toBeUndefined();
  });
});
