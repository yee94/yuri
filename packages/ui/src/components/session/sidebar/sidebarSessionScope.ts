import type { Session } from '@/lib/opencode/v2-types';
import { normalizePath } from '@/lib/pathNormalization';
import { resolveGlobalSessionDirectory } from '@/stores/useGlobalSessionsStore';
import type { SessionOwnershipIndex } from './sessionOwnership';

const normalizeDirectoryKey = (directory: string | null | undefined): string | null =>
  normalizePath(directory ?? null)?.toLowerCase() ?? null;

/**
 * VS Code only shows sessions of the opened workspace paths: an active session
 * outside every project path is dropped before ownership is resolved.
 */
export const filterVSCodeWorkspaceSessions = (
  sessions: Session[],
  projects: ReadonlyArray<{ path: string }>,
): Session[] => {
  const knownDirectories = new Set<string>();
  for (const project of projects) {
    const normalized = normalizeDirectoryKey(project.path);
    if (normalized) knownDirectories.add(normalized);
  }
  return sessions.filter((session) => {
    if (session.time?.archived) return true;
    const directory = normalizeDirectoryKey(resolveGlobalSessionDirectory(session));
    if (!directory) return false;
    return knownDirectories.has(directory);
  });
};

/**
 * Desktop/Web active sessions are scoped by the ownership index, which resolves
 * parent directories, worktrees, `projectID` and workspace members. Sessions
 * outside every registered project stay hidden once projects exist; sessions
 * without any directory and archived rows are never dropped here.
 */
export const filterOwnedSessions = (
  sessions: Session[],
  ownership: SessionOwnershipIndex,
  hasProjects: boolean,
): Session[] => {
  if (!hasProjects) return sessions;
  return sessions.filter((session) => {
    if (session.time?.archived) return true;
    if (ownership.bySessionId.has(session.id)) return true;
    return normalizeDirectoryKey(resolveGlobalSessionDirectory(session)) === null;
  });
};
