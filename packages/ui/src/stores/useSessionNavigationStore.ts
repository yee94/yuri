import { create } from 'zustand';
import type { HostLocation } from '@/lib/remote-projects/location';
import type { ProjectEntry } from '@/lib/api/types';
import type { GitWorktreeBootstrapStatus } from '@/lib/api/types';
import type { WorktreeMetadata } from '@/types/worktree';
import type { NewSessionDraftState } from '@/sync/session-ui-store';
import { subscribeRuntimeEndpointChanged, isRuntimeInstanceChange } from '@/lib/runtime-switch';

export type RemoteSessionDraftOptions = Pick<Partial<NewSessionDraftState>,
  'title' | 'initialPrompt' | 'parentID' | 'syntheticParts' | 'targetFolderId'
  | 'permissionAutoAcceptEnabled' | 'pendingWorktreeRequestId' | 'bootstrapPendingDirectory'
  | 'preserveDirectoryOverride'> & {
  worktreeMetadata?: WorktreeMetadata;
  bootstrapStatus?: GitWorktreeBootstrapStatus;
  bootstrapWaitEnabled?: boolean;
  defaultModel?: string;
};

export interface RemoteSessionNavigation {
  projectId: string;
  location: HostLocation;
  sessionId: string | null;
  draft?: RemoteSessionDraftOptions;
}

/** Remote raw IDs never enter the Hub's local session selection or send queue. */
export const useSessionNavigationStore = create<{
  remoteSession: RemoteSessionNavigation | null;
  openRemoteSession(project: Pick<ProjectEntry, 'id' | 'hostId' | 'path'>, location: HostLocation, sessionId: string | null, draft?: RemoteSessionDraftOptions): void;
  updateRemoteDraft(expected: RemoteSessionNavigation, patch: Partial<RemoteSessionDraftOptions>, location?: HostLocation): boolean;
  clearRemoteSession(): void;
}>((set) => ({
  remoteSession: null,
  openRemoteSession: (project, location, sessionId, draft) => {
    if (!project.hostId || project.hostId !== location.hostId || !location.hubId) throw new Error('Remote navigation requires an explicit Host location');
    set({ remoteSession: { projectId: project.id, location: { ...location }, sessionId, ...(draft ? { draft: { ...draft } } : {}) } });
  },
  updateRemoteDraft: (expected, patch, location) => {
    let applied = false;
    set((state) => {
      if (state.remoteSession !== expected || expected.sessionId !== null) return state;
      if (location && (location.hubId !== expected.location.hubId || location.hostId !== expected.location.hostId)) throw new Error('A pending draft cannot move to another Host');
      applied = true;
      return { remoteSession: { ...expected, ...(location ? { location: { ...location } } : {}), draft: { ...expected.draft, ...patch } } };
    });
    return applied;
  },
  clearRemoteSession: () => set((state) => state.remoteSession ? { remoteSession: null } : state),
}));

subscribeRuntimeEndpointChanged((event) => {
  if (isRuntimeInstanceChange(event)) useSessionNavigationStore.getState().clearRemoteSession();
});
