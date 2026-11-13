import { afterEach, expect, test, vi } from 'vitest';
import { useSessionUIStore } from './session-ui-store';
import { useSessionNavigationStore } from '@/stores/useSessionNavigationStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { opencodeClient } from '@/lib/opencode/client';
import { openSessionFromNotification } from './openSessionFromNotification';

const catalog = vi.hoisted(() => ({ ensure: vi.fn(async () => ({ supported: true, hubId: 'hub', hosts: [], projects: [{ id: 'remote', hostId: 'host', path: '/same' }] })) }));
vi.mock('@/queries/remoteProjectQueries', async (original) => ({ ...await original<typeof import('@/queries/remoteProjectQueries')>(), ensureRemoteHostCatalog: catalog.ensure }));
afterEach(() => { useSessionNavigationStore.getState().clearRemoteSession(); vi.restoreAllMocks(); });

test('global New validates the active remote Hub and preserves draft metadata without constructing a Hub draft/session', async () => {
  const remote = { id: 'remote', hubId: 'hub', hostId: 'host', path: '/same' };
  useProjectsStore.setState({ projects: [remote], activeProjectId: remote.id });
  const before = useSessionUIStore.getState().newSessionDraft;
  const create = vi.spyOn(opencodeClient, 'createSession');
  useSessionUIStore.getState().openNewSessionDraft({ title: 'Remote title', initialPrompt: 'Remote prompt', targetFolderId: 'folder' });
  await vi.waitFor(() => expect(useSessionNavigationStore.getState().remoteSession?.draft?.title).toBe('Remote title'));
  expect(catalog.ensure).toHaveBeenCalled();
  expect(useSessionNavigationStore.getState().remoteSession).toMatchObject({ projectId: 'remote', sessionId: null,
    location: { hubId: 'hub', hostId: 'host', directory: '/same' }, draft: { initialPrompt: 'Remote prompt', targetFolderId: 'folder' } });
  expect(useSessionUIStore.getState().newSessionDraft).toBe(before);
  expect(create).not.toHaveBeenCalled();
});

test('local notification clears the remote bridge and resolves same-path ownership only against local projects', () => {
  const remote = { id: 'remote', hubId: 'hub', hostId: 'host', path: '/same' };
  const local = { id: 'local', path: '/same' };
  useProjectsStore.setState({ projects: [remote, local], activeProjectId: remote.id });
  useSessionNavigationStore.getState().openRemoteSession(remote, { hubId: 'hub', hostId: 'host', directory: '/same' }, 'same-id');
  openSessionFromNotification({ sessionId: 'local-session', directory: '/same' });
  expect(useSessionNavigationStore.getState().remoteSession).toBeNull();
  expect(useProjectsStore.getState().activeProjectId).toBe('local');
  expect(useSessionUIStore.getState().currentSessionId).toBe('local-session');
});

test('explicit local New stays local even while a same-path Remote Project was selected', () => {
  const remote = { id: 'remote', hubId: 'hub', hostId: 'host', path: '/same' };
  useProjectsStore.setState({ projects: [remote, { id: 'local', path: '/same' }], activeProjectId: remote.id });
  useSessionNavigationStore.getState().openRemoteSession(remote, { hubId: 'hub', hostId: 'host', directory: '/same' }, 'same-id');
  useSessionUIStore.getState().openNewSessionDraft({ directoryOverride: '/same', selectedProjectId: 'local' });
  expect(useSessionNavigationStore.getState().remoteSession).toBeNull();
  expect(useSessionUIStore.getState().newSessionDraft.selectedProjectId).toBe('local');
  expect(useProjectsStore.getState().activeProjectId).toBe('local');
});
