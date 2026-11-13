import { beforeEach, expect, test } from 'vitest';
import { useSessionNavigationStore } from './useSessionNavigationStore';

const project = { id: 'ref', hostId: 'host', path: '/root' };
const location = { hubId: 'hub', hostId: 'host', directory: '/root' };
beforeEach(() => useSessionNavigationStore.getState().clearRemoteSession());

test('remote worktree draft metadata is carried independently from Hub drafts and cleared at session navigation', () => {
  const store = useSessionNavigationStore.getState();
  store.openRemoteSession(project, location, null, { title: 'Remote title', pendingWorktreeRequestId: 'request', bootstrapPendingDirectory: '/worktree', targetFolderId: 'folder', initialPrompt: 'seed', parentID: 'parent' });
  const pending = useSessionNavigationStore.getState().remoteSession!;
  expect(pending.draft).toMatchObject({ title: 'Remote title', pendingWorktreeRequestId: 'request', parentID: 'parent' });
  expect(store.updateRemoteDraft(pending, { pendingWorktreeRequestId: null, bootstrapPendingDirectory: null }, { ...location, directory: '/worktree' })).toBe(true);
  expect(useSessionNavigationStore.getState().remoteSession).toMatchObject({ location: { directory: '/worktree' }, draft: { title: 'Remote title', initialPrompt: 'seed', pendingWorktreeRequestId: null } });
  store.openRemoteSession(project, { ...location, directory: '/worktree' }, 'real-id');
  expect(useSessionNavigationStore.getState().remoteSession?.draft).toBeUndefined();
});

test('late worktree completion cannot steal another selection or cross the captured Host boundary', () => {
  const store = useSessionNavigationStore.getState();
  store.openRemoteSession(project, location, null, { title: 'keep' });
  const first = useSessionNavigationStore.getState().remoteSession!;
  expect(() => store.updateRemoteDraft(first, { title: 'wrong' }, { ...location, hostId: 'other' })).toThrow('another Host');
  expect(useSessionNavigationStore.getState().remoteSession).toBe(first);
  store.openRemoteSession(project, location, 'other-session');
  expect(store.updateRemoteDraft(first, { title: 'late' })).toBe(false);
  expect(useSessionNavigationStore.getState().remoteSession?.sessionId).toBe('other-session');
  expect(store.updateRemoteDraft(useSessionNavigationStore.getState().remoteSession!, { title: 'not a draft' })).toBe(false);
});
