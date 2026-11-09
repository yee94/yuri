import { describe, expect, it, vi } from 'vitest';
import { createDesktopNavigationRestoreAdmission, projectDesktopNavigation, resolveDesktopNavigation, type DesktopNavigationOperation } from './desktop-navigation-application-core';
import type { DesktopNavigationContext, DesktopNavigationTarget } from './desktop-navigation-state-core';

const scope = { hostID: 'host-A', lease: 'native-lease' };
const target: DesktopNavigationTarget = { kind: 'session', sessionID: 's/1', directory: '/project', messageID: 'm-1' };
const session = { id: 's/1', title: 'Real session', location: { directory: '/project' }, time: { archived: 0 } };
const projects = { projects: [{ id: 'first', path: '/decoy', label: 'Decoy' }, { id: 'p-1', path: '/project', label: 'Real project' }] };
const assistant = { id: 'bot-1', revision: 2, name: 'Real bot', enabled: true, tombstoneAt: null, effectiveWorkspacePath: '/project', defaultPrompt: 'must not retain' };
const snapshot = { enabled: true, revision: 4, assistants: [assistant] };
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
function setup() {
  let current = true;
  const read = vi.fn(async (path: string): Promise<unknown> => {
    if (path.startsWith('/api/session/')) return session;
    if (path === '/api/config/settings') return projects;
    if (path === '/api/yuri/assistants/snapshot') return snapshot;
    if (path.startsWith('/api/fs/list?')) return { path: decodeURIComponent(path.split('path=')[1]), entries: [] };
    if (path.startsWith('/api/git/worktrees?')) return [{ path: '/other/verified-worktree', branch: 'topic' }];
    throw new Error('Unexpected read');
  });
  const context: DesktopNavigationContext = { partition: { connectionID: 'host-A', origin: 'https://a.example', authorizationID: 'auth-A' }, runtimeScope: scope, current: () => current };
  const operation: DesktopNavigationOperation = { scope, current: () => current, request: read };
  return { read, context, operation, retire: () => { current = false; }, resolve: (next = target) => resolveDesktopNavigation(next, context, operation) };
}

describe('real read-only navigation wire resolution', () => {
  it('exact session lookup returns fresh ChatTarget, preserves message anchor and no transcript/content', async () => {
    const f = setup(); const result = await f.resolve();
    expect(result).toEqual({ status: 'ready', target, resource: { kind: 'session', target: { kind: 'session', id: 's/1', directory: '/project', title: 'Real session' }, messageID: 'm-1' } });
    expect(f.read).toHaveBeenCalledExactlyOnceWith('/api/session/s%2F1?directory=%2Fproject');
  });
  it.each([
    { ...session, id: 'wrong' }, { ...session, directory: '/wrong' }, { ...session, location: { directory: '/wrong' } },
    { ...session, time: { archived: '123' } }, { ...session, time: undefined }, { ...session, partial: true }, {},
  ])('malformed/wrong session response is failure, not empty/missing: %#', async row => {
    const f = setup(); f.read.mockResolvedValueOnce(row); await expect(f.resolve()).rejects.toThrow();
  });
  it('archived session is not reopened or unarchived', async () => {
    const f = setup(); f.read.mockResolvedValueOnce({ ...session, time: { archived: 123 } });
    expect(await f.resolve()).toEqual({ status: 'missing' }); expect(f.read).toHaveBeenCalledOnce();
  });
  it.each([401, 403, 500, 503])('HTTP %s remains an error with status available to caller', async status => {
    const f = setup(), error = Object.assign(new Error('lookup failure'), { status }); f.read.mockRejectedValueOnce(error);
    await expect(f.resolve()).rejects.toBe(error);
  });
  it('HTTP 404 is missing, but stale 404 is not allowed to clear an entry', async () => {
    const f = setup(); f.read.mockRejectedValueOnce(Object.assign(new Error('gone'), { status: 404 }));
    expect(await f.resolve()).toEqual({ status: 'missing' });
    const wait = deferred<unknown>(); f.read.mockReturnValueOnce(wait.promise);
    const resolving = f.resolve(); f.retire(); wait.resolve(session);
    await expect(resolving).rejects.toThrow('stale');
  });
  it('projectID comes from fresh settings, not first project or inferred path; actual directory is checked', async () => {
    const f = setup(); const projection: DesktopNavigationTarget = { kind: 'project', projectID: 'p-1', directory: '/project' };
    expect(await f.resolve(projection)).toEqual({ status: 'ready', target: projection, resource: { kind: 'project', project: { id: 'p-1', path: '/project', name: 'Real project' } } });
    expect(f.read.mock.calls.map(([path]) => path)).toEqual(['/api/config/settings', '/api/fs/list?path=%2Fproject']);
    await expect(f.resolve({ ...projection, directory: '/decoy' })).rejects.toThrow('directory_mismatch');
    expect(await f.resolve({ ...projection, projectID: 'absent' })).toEqual({ status: 'missing' });
  });
  it.each([{}, { projects: null }, { projects: [{ id: 'p-1' }] }, { projects: [projects.projects[1], projects.projects[1]] }, { ...projects, partial: true }])('invalid/partial project authority cannot imply absence: %#', async response => {
    const f = setup(); f.read.mockResolvedValueOnce(response);
    await expect(f.resolve({ kind: 'project', projectID: 'p-1', directory: '/project' })).rejects.toThrow();
  });
  it('new session without a directory remains an unbound draft and does zero reads', async () => {
    const f = setup(), projection: DesktopNavigationTarget = { kind: 'new-session', directory: '' };
    expect(await f.resolve(projection)).toEqual({ status: 'ready', target: projection, resource: { kind: 'new-session', directory: '' } });
    expect(f.read).not.toHaveBeenCalled();
    await expect(f.resolve({ ...projection, projectID: 'p-1' })).rejects.toThrow('requires_directory');
  });
  it('unregistered explicit draft directory is validated without choosing any project or registering it', async () => {
    const f = setup(), projection: DesktopNavigationTarget = { kind: 'new-session', directory: '/unregistered' };
    expect(await f.resolve(projection)).toEqual({ status: 'ready', target: projection, resource: { kind: 'new-session', directory: '/unregistered' } });
    expect(f.read).toHaveBeenCalledExactlyOnceWith('/api/fs/list?path=%2Funregistered');
    f.read.mockResolvedValueOnce({ path: '/wrong', entries: [] }); await expect(f.resolve(projection)).rejects.toThrow('directory_mismatch');
  });
  it('new-session worktree membership must come from its actual project, including worktrees outside the parent path', async () => {
    const f = setup(), projection: DesktopNavigationTarget = { kind: 'new-session', projectID: 'p-1', directory: '/other/verified-worktree' };
    expect((await f.resolve(projection)).status).toBe('ready');
    expect(f.read.mock.calls.map(([path]) => path)).toEqual(['/api/config/settings', '/api/git/worktrees?directory=%2Fproject', '/api/fs/list?path=%2Fother%2Fverified-worktree']);
    await expect(f.resolve({ ...projection, directory: '/project/not-an-authoritative-worktree' })).rejects.toThrow('directory_mismatch');
  });
  it('file-only fs/stat is never fabricated; special plans missing-directory empty success requires a parent stat entry', async () => {
    const f = setup(), projection: DesktopNavigationTarget = { kind: 'new-session', directory: '/project/.opencode/plans' };
    expect(await f.resolve(projection)).toEqual({ status: 'missing' });
    f.read.mockResolvedValueOnce({ path: projection.directory, entries: [] }).mockResolvedValueOnce({ path: '/project/.opencode', entries: [{ path: projection.directory, isDirectory: true }] });
    expect((await f.resolve(projection)).status).toBe('ready');
    expect(f.read.mock.calls.some(([path]) => path.startsWith('/api/fs/stat'))).toBe(false);
  });
  it('assistant uses existing snapshot by exact ID, not a session ensure or contact-message lookup', async () => {
    const f = setup(), projection: DesktopNavigationTarget = { kind: 'assistant', assistantID: 'bot-1', directory: '/project' };
    const result = await f.resolve(projection);
    expect(result).toEqual({ status: 'ready', target: projection, resource: { kind: 'assistant', target: { kind: 'assistant', id: 'bot-1', title: 'Real bot', directory: '/project' } } });
    expect(JSON.stringify(result)).not.toContain('must not retain');
    expect(f.read).toHaveBeenCalledExactlyOnceWith('/api/yuri/assistants/snapshot');
    expect(await f.resolve({ ...projection, assistantID: 'gone' })).toEqual({ status: 'missing' });
    await expect(f.resolve({ ...projection, directory: '/other' })).rejects.toThrow('directory_mismatch');
  });
  it.each([
    [{ ...snapshot, enabled: false }, 'blocked'],
    [{ ...snapshot, assistants: [{ ...assistant, tombstoneAt: 123 }] }, 'missing'],
    [{ ...snapshot, assistants: [{ ...assistant, enabled: false }] }, 'blocked'],
  ] as const)('assistant disabled/tombstoned authorities do not reopen a contact: %#', async (response, status) => {
    const f = setup(); f.read.mockResolvedValueOnce(response);
    expect(await f.resolve({ kind: 'assistant', assistantID: 'bot-1', directory: '/project' })).toEqual({ status });
  });
});

describe('one-slot resolved admission and explicit projection', () => {
  it('only an admitted resource with exact same core context can apply, exactly once', async () => {
    const f = setup(), rawApply = vi.fn(() => true);
    const owner = createDesktopNavigationRestoreAdmission({ captureOperation: () => f.operation, rawApply });
    const result = await owner.requestRestore(target, f.context);
    expect(owner.pendingResolvedCount()).toBe(1); expect(rawApply).not.toHaveBeenCalled();
    if (result.status !== 'ready') throw new Error('expected ready');
    expect(owner.onRestore(result.target, f.context)).toBe(true);
    expect(owner.pendingResolvedCount()).toBe(0); expect(owner.onRestore(result.target, f.context)).toBe(false);
    expect(rawApply).toHaveBeenCalledOnce();
  });
  it('user navigation while async authorize awaits retires data before apply', async () => {
    const f = setup(), wait = deferred<boolean>(), rawApply = vi.fn(() => true), entered = vi.fn();
    const owner = createDesktopNavigationRestoreAdmission({ captureOperation: () => f.operation, rawApply, authorize: () => { entered(); return wait.promise; } });
    const resolving = owner.requestRestore(target, f.context); for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(entered).toHaveBeenCalledOnce(); owner.retire(); wait.resolve(true);
    await expect(resolving).rejects.toThrow('stale'); expect(owner.pendingResolvedCount()).toBe(0); expect(rawApply).not.toHaveBeenCalled();
  });
  it('refused authorization, mismatched apply, failure and disposal clear the single slot', async () => {
    const f = setup(), authorize = vi.fn(async () => false), rawApply = vi.fn(() => true);
    const owner = createDesktopNavigationRestoreAdmission({ captureOperation: () => f.operation, authorize, rawApply });
    expect(await owner.requestRestore(target, f.context)).toEqual({ status: 'blocked' }); expect(owner.pendingResolvedCount()).toBe(0);
    authorize.mockResolvedValue(true); await owner.requestRestore(target, f.context);
    expect(owner.onRestore(target, { ...f.context })).toBe(false); expect(owner.pendingResolvedCount()).toBe(1);
    owner.retire(); expect(owner.pendingResolvedCount()).toBe(0);
    await owner.requestRestore(target, f.context); owner.dispose(); expect(owner.pendingResolvedCount()).toBe(0);
    expect(owner.onRestore(target, f.context)).toBe(false); expect(rawApply).not.toHaveBeenCalled();
  });
  it('wrong captured native lease does no reads', async () => {
    const f = setup(); await expect(resolveDesktopNavigation(target, f.context, { ...f.operation, scope: { ...scope, lease: 'old' } })).rejects.toThrow('stale');
    expect(f.read).not.toHaveBeenCalled();
  });
  it('projects only owning public route metadata; actual directory publication affects drafts, never Chat/project or overlays', () => {
    const project = { id: 'p-1', path: '/project', name: 'Private title' };
    expect(projectDesktopNavigation({ kind: 'new-session', project }, '/other/verified-worktree')).toEqual({ kind: 'new-session', projectID: 'p-1', directory: '/other/verified-worktree' });
    expect(projectDesktopNavigation({ kind: 'root' })).toBeNull();
    expect(projectDesktopNavigation({ kind: 'root' }, '')).toEqual({ kind: 'new-session', directory: '' });
    expect(projectDesktopNavigation({ kind: 'project', project }, '/decoy')).toEqual({ kind: 'project', projectID: 'p-1', directory: '/project' });
    expect(projectDesktopNavigation({ kind: 'chat', target: { kind: 'session', id: 's', title: 'Private title', directory: '/real' } }, '/decoy')).toEqual({ kind: 'session', sessionID: 's', directory: '/real' });
    expect(projectDesktopNavigation({ kind: 'settings', directory: '/project' }, '/decoy')).toBeNull();
  });
});
