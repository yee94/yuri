import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { useEffectiveDirectory, useEffectiveLocationKey, resolveEffectiveDirectory } from './useEffectiveDirectory';
import { HostRuntimeContext, type HostRuntimeContextValue } from '@/contexts/hostRuntimeContext';
import { locationKey } from '@/lib/remote-projects/location';

const fixture = vi.hoisted(() => ({
  project: { id: 'project', hostId: 'ssh://host', hubId: 'https://hub.example', path: 'C:\\project' },
  remote: { projectId: 'project', sessionId: 'same-id', location: { hubId: 'https://hub.example', hostId: 'ssh://host', directory: 'C:\\worktrees\\feature' } },
  local: { currentSessionId: 'same-id', newSessionDraft: null, worktreeMetadata: new Map([['same-id', { path: '/local-worktree' }]]) },
}));
vi.mock('@/stores/useProjectsStore', () => ({ useProjectsStore: Object.assign((select: (state: unknown) => unknown) => select({ activeProjectId: 'project', projects: [fixture.project] }), { getState: () => ({ activeProjectId: 'project', projects: [fixture.project] }) }) }));
vi.mock('@/stores/useSessionNavigationStore', () => ({ useSessionNavigationStore: Object.assign((select: (state: unknown) => unknown) => select({ remoteSession: fixture.remote }), { getState: () => ({ remoteSession: fixture.remote }) }) }));
vi.mock('@/sync/session-ui-store', () => ({ useSessionUIStore: Object.assign((select: (state: unknown) => unknown) => select(fixture.local), { getState: () => fixture.local }) }));
vi.mock('@/sync/session-worktree-store', () => ({ useSessionWorktreeStore: Object.assign((select: (state: unknown) => unknown) => select({ getAttachment: () => undefined }), { getState: () => ({ getAttachment: () => undefined }) }) }));
vi.mock('@/sync/sync-context', () => ({ useSessionDirectory: () => '/local-session' }));
vi.mock('@/stores/useDirectoryStore', () => ({ useDirectoryStore: Object.assign((select: (state: unknown) => unknown) => select({ currentDirectory: '/local' }), { getState: () => ({ currentDirectory: '/local' }) }) }));

function Consumer() { return <output data-directory={useEffectiveDirectory()} data-identity={useEffectiveLocationKey()} />; }
let root: Root, node: HTMLDivElement;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); node = document.createElement('div'); document.body.append(node); root = createRoot(node); });
afterEach(async () => { await act(async () => root.unmount()); node.remove(); });
it('real consumers resolve selected remote worktree raw bytes independently from the retained same-ID local session', async () => {
  const scope = { entry: { location: { ...fixture.remote.location, directory: fixture.project.path }, key: locationKey({ ...fixture.remote.location, directory: fixture.project.path }) } } as unknown as HostRuntimeContextValue;
  await act(async () => root.render(<HostRuntimeContext.Provider value={scope}><Consumer /></HostRuntimeContext.Provider>));
  expect(node.querySelector('output')?.dataset.directory).toBe('C:\\worktrees\\feature');
  expect(node.querySelector('output')?.dataset.identity).toBe(locationKey(fixture.remote.location));
  expect(resolveEffectiveDirectory()).toBe('C:\\worktrees\\feature');
  expect(fixture.local.worktreeMetadata.get('same-id')?.path).toBe('/local-worktree');
});
