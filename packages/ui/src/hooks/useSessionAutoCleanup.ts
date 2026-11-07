import React from 'react';
import { opencodeClient } from '@/lib/opencode/client';
import { ensureFullGlobalSessionsLoaded, useGlobalSessionsStore, resolveGlobalSessionDirectory } from '@/stores/useGlobalSessionsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { getAllSyncSessions } from '@/sync/sync-refs';
import { useUIStore } from '@/stores/useUIStore';
import { buildAutoDeleteCandidates, RETENTION_DAY_MS, RETENTION_KEEP_RECENT } from '@/lib/session-retention-policy';

const AUTO_DELETE_KEEP_RECENT = RETENTION_KEEP_RECENT;
const AUTO_DELETE_INTERVAL_MS = RETENTION_DAY_MS;

type CleanupResult = {
  completedIds: string[];
  failedIds: string[];
  action: 'archive' | 'delete';
  skippedReason?: 'disabled' | 'loading' | 'cooldown' | 'no-candidates' | 'running';
};

type CleanupOptions = {
  autoRun?: boolean;
  enabled?: boolean;
};

export const useSessionAutoCleanup = (enabledOrOptions?: boolean | CleanupOptions) => {
  const options = typeof enabledOrOptions === 'object' ? enabledOrOptions : undefined;
  const autoRun = options?.autoRun !== false;
  const enabled = typeof enabledOrOptions === 'boolean' ? enabledOrOptions : (options?.enabled ?? true);

  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const isLoading = useSessionUIStore((state) => state.isLoading);
  const globalSessions = useGlobalSessionsStore((state) => state.activeSessions);
  const hasLoadedFullCatalog = useGlobalSessionsStore((state) => state.hasLoadedFullCatalog);

  const autoDeleteEnabled = useUIStore((state) => state.autoDeleteEnabled);
  const autoDeleteAfterDays = useUIStore((state) => state.autoDeleteAfterDays);
  const sessionRetentionAction = useUIStore((state) => state.sessionRetentionAction);
  const autoDeleteLastRunAt = useUIStore((state) => state.autoDeleteLastRunAt);
  const setAutoDeleteLastRunAt = useUIStore((state) => state.setAutoDeleteLastRunAt);

  const [isRunning, setIsRunning] = React.useState(false);
  const runningRef = React.useRef(false);

  React.useEffect(() => {
    if (!enabled || !autoRun || !autoDeleteEnabled || autoDeleteAfterDays <= 0) return;
    // Retention cleanup needs a broad catalog eventually, but must not race the
    // active-project cold-start send path with an unfiltered global list.
    const timer = window.setTimeout(() => {
      void ensureFullGlobalSessionsLoaded(getAllSyncSessions());
    }, 8000);
    return () => window.clearTimeout(timer);
  }, [autoDeleteAfterDays, autoDeleteEnabled, autoRun, enabled]);

  const candidates = React.useMemo(() => {
    if (autoDeleteAfterDays <= 0) {
      return [];
    }
    return buildAutoDeleteCandidates({
      sessions: globalSessions,
      currentSessionId,
      cutoffDays: autoDeleteAfterDays,
    });
  }, [autoDeleteAfterDays, currentSessionId, globalSessions]);

  const runCleanup = React.useCallback(
      async ({ force = false }: { force?: boolean } = {}): Promise<CleanupResult> => {
      if (runningRef.current) {
        return { completedIds: [], failedIds: [], action: sessionRetentionAction, skippedReason: 'running' };
      }

      if (!autoDeleteEnabled || autoDeleteAfterDays <= 0) {
        if (!force) {
          return { completedIds: [], failedIds: [], action: sessionRetentionAction, skippedReason: 'disabled' };
        }
      }

      if (isLoading) {
        return { completedIds: [], failedIds: [], action: sessionRetentionAction, skippedReason: 'loading' };
      }

      const now = Date.now();
      if (!force && autoDeleteLastRunAt && now - autoDeleteLastRunAt < AUTO_DELETE_INTERVAL_MS) {
        return { completedIds: [], failedIds: [], action: sessionRetentionAction, skippedReason: 'cooldown' };
      }

      const { activeSessions: sessions } = await ensureFullGlobalSessionsLoaded(getAllSyncSessions());

      if (sessions.length === 0) {
        return { completedIds: [], failedIds: [], action: sessionRetentionAction, skippedReason: 'no-candidates' };
      }

      const candidateIds = buildAutoDeleteCandidates({
        sessions,
        currentSessionId,
        cutoffDays: autoDeleteAfterDays,
        now,
      });

      if (candidateIds.length === 0) {
        setAutoDeleteLastRunAt(now);
        return { completedIds: [], failedIds: [], action: sessionRetentionAction, skippedReason: 'no-candidates' };
      }

      runningRef.current = true;
      setIsRunning(true);
      try {
        const sessionMap = new Map(sessions.map((session) => [session.id, session]));
        const completedIds: string[] = [];
        const failedIds: string[] = [];

        for (const id of candidateIds) {
          const session = sessionMap.get(id);
          const directory = session ? resolveGlobalSessionDirectory(session) : null;
          if (!directory) {
            failedIds.push(id);
            continue;
          }

          try {
            if (sessionRetentionAction === 'archive') {
              await opencodeClient.updateSession(id, { time: { archived: Date.now() } }, directory);
            } else {
              await opencodeClient.deleteSession(id, directory);
            }
            completedIds.push(id);
          } catch {
            failedIds.push(id);
          }
        }

        if (sessionRetentionAction === 'archive') {
          useGlobalSessionsStore.getState().archiveSessions(completedIds);
        } else {
          useGlobalSessionsStore.getState().removeSessions(completedIds);
        }
        return { completedIds, failedIds, action: sessionRetentionAction };
      } finally {
        runningRef.current = false;
        setIsRunning(false);
        setAutoDeleteLastRunAt(Date.now());
      }
    },
    [
      autoDeleteAfterDays,
      autoDeleteEnabled,
      autoDeleteLastRunAt,
      currentSessionId,
      isLoading,
      sessionRetentionAction,
      setAutoDeleteLastRunAt,
    ]
  );

  React.useEffect(() => {
    if (!enabled) {
      return;
    }

    if (!autoRun) {
      return;
    }
    if (!autoDeleteEnabled || autoDeleteAfterDays <= 0) {
      return;
    }
    if (isLoading || !hasLoadedFullCatalog || globalSessions.length === 0) {
      return;
    }
    const now = Date.now();
    if (autoDeleteLastRunAt && now - autoDeleteLastRunAt < AUTO_DELETE_INTERVAL_MS) {
      return;
    }
    void runCleanup();
  }, [
    autoDeleteAfterDays,
    autoDeleteEnabled,
    autoDeleteLastRunAt,
    autoRun,
    enabled,
    hasLoadedFullCatalog,
    globalSessions.length,
    isLoading,
    runCleanup,
  ]);

  return {
    candidates,
    isRunning,
    runCleanup,
    keepRecentCount: AUTO_DELETE_KEEP_RECENT,
    action: sessionRetentionAction,
  };
};
