import React from 'react';
import { useSessionFoldersStore, type SessionFolder } from '@/stores/useSessionFoldersStore';
import {
  getArchivedScopeKey,
  resolveArchivedFolderName,
} from '../utils';
import type { SessionOwnershipIndex } from '../sessionOwnership';

type ProjectForArchivedFolders = {
  id: string;
  normalizedPath: string;
};

type Args = {
  normalizedProjects: ProjectForArchivedFolders[];
  ownership: SessionOwnershipIndex;
  isSessionsLoading: boolean;
  fullCatalogSessionIds: Set<string>;
  fullCatalogGeneration: number;
  foldersHydrationGeneration?: number;
  createFolder: (scopeKey: string, name: string, parentId?: string | null) => SessionFolder;
  addSessionsToFolder: (scopeKey: string, folderId: string, sessionIds: string[]) => void;
  cleanupSessions: (scopeKey: string, existingSessionIds: Set<string>) => void;
  /** When false, skip archived-folder derivation (hidden sidebar). */
  enabled?: boolean;
};

export const useArchivedAutoFolders = (args: Args): void => {
  const {
    normalizedProjects,
    ownership,
    isSessionsLoading,
    fullCatalogSessionIds,
    fullCatalogGeneration,
    foldersHydrationGeneration = 0,
    createFolder,
    addSessionsToFolder,
    cleanupSessions,
    enabled = true,
  } = args;

  React.useEffect(() => {
    if (!enabled || isSessionsLoading) {
      return;
    }

    const currentFoldersMap = useSessionFoldersStore.getState().foldersMap;

    normalizedProjects.forEach((project) => {
      const scopeKey = getArchivedScopeKey(project.normalizedPath);
      const projectArchivedSessions = ownership.archivedSessionsByProject.get(project.id) ?? [];

      const existingFolders = currentFoldersMap[scopeKey] ?? [];
      const folderByName = new Map(existingFolders.map((folder) => [folder.name.toLowerCase(), folder]));
      const missingSessionsByFolderId = new Map<string, string[]>();

      projectArchivedSessions.forEach((session) => {
        const folderName = resolveArchivedFolderName(session, project.normalizedPath);
        const key = folderName.toLowerCase();
        let folder = folderByName.get(key);
        if (!folder) {
          folder = createFolder(scopeKey, folderName);
          folderByName.set(key, folder);
        }

        if (!folder.sessionIds.includes(session.id)) {
          const batch = missingSessionsByFolderId.get(folder.id);
          if (batch) {
            batch.push(session.id);
          } else {
            missingSessionsByFolderId.set(folder.id, [session.id]);
          }
        }
      });

      missingSessionsByFolderId.forEach((sessionIds, folderId) => {
        addSessionsToFolder(scopeKey, folderId, sessionIds);
      });

      if (fullCatalogGeneration > 0) {
        const validSessionIds = projectArchivedSessions.some((session) => !fullCatalogSessionIds.has(session.id))
          ? new Set([...fullCatalogSessionIds, ...projectArchivedSessions.map((session) => session.id)])
          : fullCatalogSessionIds;
        cleanupSessions(scopeKey, validSessionIds);
      }
    });
  }, [
    enabled,
    normalizedProjects,
    ownership,
    isSessionsLoading,
    fullCatalogGeneration,
    fullCatalogSessionIds,
    foldersHydrationGeneration,
    createFolder,
    addSessionsToFolder,
    cleanupSessions,
  ]);
};
