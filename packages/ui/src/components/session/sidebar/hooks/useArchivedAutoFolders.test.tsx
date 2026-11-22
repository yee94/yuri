import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Session } from '@/lib/opencode/v2-types';
import { useSessionFoldersStore } from '@/stores/useSessionFoldersStore';
import { createSessionOwnershipIndex } from '../sessionOwnership';
import { getArchivedScopeKey } from '../utils';
import { useArchivedAutoFolders } from './useArchivedAutoFolders';

const buildSession = (id: string, directory: string, archivedAt?: number): Session => ({
  id,
  directory,
  title: id,
  time: archivedAt ? { created: 1, updated: 2, archived: archivedAt } : { created: 1, updated: 2 },
} as Session);

describe('useArchivedAutoFolders', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    useSessionFoldersStore.setState({
      foldersMap: {},
      collapsedFolderIds: new Set(),
      sessionOrderByScope: {},
      sessionOrderActivityByScope: {},
      foldersHydrationGeneration: 0,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('does not infinite-loop when an archived session is missing from a stale fullCatalogSessionIds snapshot', () => {
    const project = { id: 'proj_1', normalizedPath: '/repo/app' };
    const scopeKey = getArchivedScopeKey(project.normalizedPath);
    const archivedSession = buildSession('ses_archived_new', '/repo/app', 123456);
    const ownership = createSessionOwnershipIndex([], [project], new Map(), false, [archivedSession]);
    const staleCatalog = new Set(['ses_existing']);

    let renderCount = 0;
    function Probe() {
      renderCount += 1;
      const foldersHydrationGeneration = useSessionFoldersStore((state) => state.foldersHydrationGeneration);
      const createFolder = useSessionFoldersStore((state) => state.createFolder);
      const addSessionsToFolder = useSessionFoldersStore((state) => state.addSessionsToFolder);
      const cleanupSessions = useSessionFoldersStore((state) => state.cleanupSessions);

      useArchivedAutoFolders({
        normalizedProjects: [project],
        ownership,
        isSessionsLoading: false,
        fullCatalogSessionIds: staleCatalog,
        fullCatalogGeneration: 1,
        foldersHydrationGeneration,
        createFolder,
        addSessionsToFolder,
        cleanupSessions,
      });

      return null;
    }

    const host = document.createElement('div');
    const root = createRoot(host);
    try {
      act(() => root.render(<Probe />));

      expect(renderCount).toBe(1);
      const folders = useSessionFoldersStore.getState().foldersMap[scopeKey] ?? [];
      expect(folders).toHaveLength(1);
      expect(folders[0]?.name).toBe('project root');
      expect(folders[0]?.sessionIds).toEqual(['ses_archived_new']);
    } finally {
      act(() => root.unmount());
    }
  });

  test('batches archived session additions per folder and re-reconciles after disk hydration', () => {
    const project = { id: 'proj_1', normalizedPath: '/repo/app' };
    const scopeKey = getArchivedScopeKey(project.normalizedPath);
    const archived = [
      buildSession('ses_a', '/repo/app', 100),
      buildSession('ses_b', '/repo/app', 200),
      buildSession('ses_c', '/repo/app', 300),
    ];
    const ownership = createSessionOwnershipIndex([], [project], new Map(), false, archived);
    const addSpy = vi.fn(useSessionFoldersStore.getState().addSessionsToFolder);

    function Probe() {
      const foldersHydrationGeneration = useSessionFoldersStore((state) => state.foldersHydrationGeneration);
      const createFolder = useSessionFoldersStore((state) => state.createFolder);
      const cleanupSessions = useSessionFoldersStore((state) => state.cleanupSessions);

      useArchivedAutoFolders({
        normalizedProjects: [project],
        ownership,
        isSessionsLoading: false,
        fullCatalogSessionIds: new Set(['ses_a', 'ses_b', 'ses_c']),
        fullCatalogGeneration: 1,
        foldersHydrationGeneration,
        createFolder,
        addSessionsToFolder: addSpy,
        cleanupSessions,
      });

      return null;
    }

    const host = document.createElement('div');
    const root = createRoot(host);
    try {
      act(() => root.render(<Probe />));

      expect(addSpy).toHaveBeenCalledTimes(1);
      expect(useSessionFoldersStore.getState().foldersMap[scopeKey]?.[0]?.sessionIds).toEqual([
        'ses_a',
        'ses_b',
        'ses_c',
      ]);

      // Simulate disk hydration replacing foldersMap with a stale snapshot
      act(() => {
        useSessionFoldersStore.setState((state) => ({
          foldersMap: {
            [scopeKey]: [
              { id: 'disk-folder', name: 'project root', sessionIds: ['ses_a'], createdAt: 1 },
            ],
          },
          foldersHydrationGeneration: state.foldersHydrationGeneration + 1,
        }));
      });

      expect(addSpy).toHaveBeenCalledTimes(2);
      expect(useSessionFoldersStore.getState().foldersMap[scopeKey]?.[0]?.sessionIds).toEqual([
        'ses_a',
        'ses_b',
        'ses_c',
      ]);
    } finally {
      act(() => root.unmount());
    }
  });
});
