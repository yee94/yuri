import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessionWorktreeStore } from '@/sync/session-worktree-store';
import { getAttachedSessionDirectory } from '@/sync/session-worktree-contract';
import { useSessionDirectory } from '@/sync/sync-context';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionNavigationStore } from '@/stores/useSessionNavigationStore';
import { useHostRuntime } from '@/contexts/HostRuntimeProvider';
import { locationKey } from '@/lib/remote-projects/location';

/**
 * Resolve the effective working directory for tabs (Git, Diff, Files, Terminal).
 *
 * Priority order:
 * 1. Worktree metadata path (for worktree sessions)
 * 2. Session directory (for active sessions)
 * 3. Draft session directoryOverride (when creating a new session)
 * 4. Fallback directory from DirectoryStore
 *
 * Imperative twin of useEffectiveDirectory — for keyboard/menu handlers that
 * cannot subscribe via hooks.
 */
export const resolveEffectiveDirectory = (): string | undefined => {
    const projects = useProjectsStore.getState();
    const project = projects.projects.find((item) => item.id === projects.activeProjectId);
    if (project?.hostId) {
        const remote = useSessionNavigationStore.getState().remoteSession;
        return remote?.projectId === project.id && remote.location.hostId === project.hostId && (!project.hubId || remote.location.hubId === project.hubId) ? remote.location.directory : project.path;
    }
    const sessionUI = useSessionUIStore.getState();
    const currentSessionId = sessionUI.currentSessionId;
    const newSessionDraft = sessionUI.newSessionDraft;
    const worktreeMap = sessionUI.worktreeMetadata;
    const fallbackDirectory = useDirectoryStore.getState().currentDirectory;

    // If we have an active session, use its directory
    if (currentSessionId) {
        const worktreeAttachment = useSessionWorktreeStore.getState().getAttachment(currentSessionId);
        const attachmentDirectory = getAttachedSessionDirectory(worktreeAttachment);
        if (attachmentDirectory) {
            return attachmentDirectory;
        }
        const worktreeMetadata = worktreeMap.get(currentSessionId);
        if (worktreeMetadata?.path) {
            return worktreeMetadata.path;
        }
        const currentSessionDirectory = sessionUI.getDirectoryForSession(currentSessionId);
        if (currentSessionDirectory) {
            return currentSessionDirectory;
        }
    }

    // If a draft session is open, use its directoryOverride
    if (newSessionDraft?.open && (newSessionDraft.bootstrapPendingDirectory || newSessionDraft.directoryOverride)) {
        return (newSessionDraft.bootstrapPendingDirectory || newSessionDraft.directoryOverride) ?? undefined;
    }

    // Fall back to the global directory
    return fallbackDirectory ?? undefined;
};

/**
 * Hook that resolves the effective working directory for tabs (Git, Diff, Files, Terminal).
 *
 * Priority order:
 * 1. Worktree metadata path (for worktree sessions)
 * 2. Session directory (for active sessions)
 * 3. Draft session directoryOverride (when creating a new session)
 * 4. Fallback directory from DirectoryStore
 *
 * This ensures that tabs show content from the correct project directory
 * even when a draft session is being created.
 */
export const useEffectiveDirectory = (): string | undefined => {
    const host = useHostRuntime();
    const project = useProjectsStore((state) => state.projects.find((item) => item.id === state.activeProjectId));
    const remote = useSessionNavigationStore((state) => state.remoteSession);
    const remoteScope = !!(host?.entry.location.hostId || project?.hostId);
    const currentSessionId = useSessionUIStore((s) => remoteScope ? null : s.currentSessionId);
    const newSessionDraft = useSessionUIStore((s) => remoteScope ? null : s.newSessionDraft);
    const currentSessionDirectory = useSessionDirectory(currentSessionId);
    const worktreeAttachment = useSessionWorktreeStore((s) => currentSessionId ? s.getAttachment(currentSessionId) : undefined);
    const worktreeMap = useSessionUIStore((s) => remoteScope ? undefined : s.worktreeMetadata);
    const fallbackDirectory = useDirectoryStore((s) => remoteScope ? undefined : s.currentDirectory);

    if (host?.entry.location.hostId) {
        if (remote && remote.projectId === project?.id && remote.location.hostId === host.entry.location.hostId && remote.location.hubId === host.entry.location.hubId) return remote.location.directory;
        return host.entry.location.directory;
    }
    if (project?.hostId) return remote?.projectId === project.id && remote.location.hostId === project.hostId && (!project.hubId || remote.location.hubId === project.hubId) ? remote.location.directory : project.path;

    // If we have an active session, use its directory
    if (currentSessionId) {
        const attachmentDirectory = getAttachedSessionDirectory(worktreeAttachment);
        if (attachmentDirectory) {
            return attachmentDirectory;
        }
        const worktreeMetadata = worktreeMap?.get(currentSessionId);
        if (worktreeMetadata?.path) {
            return worktreeMetadata.path;
        }
        if (currentSessionDirectory) {
            return currentSessionDirectory;
        }
    }

    // If a draft session is open, use its directoryOverride
    if (newSessionDraft?.open && (newSessionDraft.bootstrapPendingDirectory || newSessionDraft.directoryOverride)) {
        return (newSessionDraft.bootstrapPendingDirectory || newSessionDraft.directoryOverride) ?? undefined;
    }

    // Fall back to the global directory
    return fallbackDirectory ?? undefined;
};

/** UI identity only; API callers must continue using useEffectiveDirectory's raw path. */
export const useEffectiveLocationKey = (): string => {
    const directory = useEffectiveDirectory();
    const host = useHostRuntime();
    const project = useProjectsStore((state) => state.projects.find((item) => item.id === state.activeProjectId));
    const remote = useSessionNavigationStore((state) => state.remoteSession);
    if (host?.entry.location.hostId) return directory ? locationKey({ ...host.entry.location, directory }) : host.entry.key;
    if (project?.hostId) {
        const location = remote?.projectId === project.id && remote.location.hostId === project.hostId && (!project.hubId || remote.location.hubId === project.hubId) ? remote.location : undefined;
        if (location) return locationKey(location);
        if (!project.hubId) return '';
        return locationKey({ hubId: project.hubId, hostId: project.hostId, directory: directory ?? project.path });
    }
    return directory ?? '';
};
