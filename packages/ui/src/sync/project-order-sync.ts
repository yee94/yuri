import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { subscribeYuriEvents } from '@/lib/yuriEvents';
import { invalidateSettingsCache, waitForPendingSettingsUpdates } from '@/lib/persistence';
import { getRuntimeGeneration, getRuntimeTransportIdentity, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { refreshProjectOrderSnapshot, waitForPendingHubProjectLayoutUpdates } from '@/queries/projectOrderQueries';
import { settingsBootstrapQueryOptions } from '@/queries/settingsBootstrapQueries';
import type { SettingsBootstrap } from '@/queries/settingsBootstrapDto';
import { queryClient } from '@/lib/queryRuntime';
import { supportsRemoteProjects } from '@/queries/remoteProjectQueries';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';

/** One host snapshot flight, coalescing tips without losing a tip during a GET. */
export function mountProjectOrderSync(): () => void {
  // VS Code owns its workspace registry rather than the Host project list.
  if (getRegisteredRuntimeAPIs()?.runtime.isVSCode) return () => undefined;
  let disposed = false;
  let running = false;
  let dirty = false;
  let runId = 0;

  const refresh = async () => {
    dirty = true;
    if (running) return;
    running = true;
    const run = ++runId;
    try {
      while (dirty && !disposed && run === runId) {
        dirty = false;
        const transport = getRuntimeTransportIdentity();
        const generation = getRuntimeGeneration();
        const current = () => !disposed && run === runId && generation === getRuntimeGeneration()
          && transport === getRuntimeTransportIdentity();
        await waitForPendingSettingsUpdates(transport);
        await waitForPendingHubProjectLayoutUpdates(transport);
        if (!current()) continue;
        const projects = useProjectsStore.getState().projects;
        const sortOrder = useSessionDisplayStore.getState().projectSortOrder;
        try {
          const snapshot = await refreshProjectOrderSnapshot(transport);
          if (!current()) continue;
          if (projects !== useProjectsStore.getState().projects
            || sortOrder !== useSessionDisplayStore.getState().projectSortOrder) {
            dirty = true;
            continue;
          }
          const activeProjectId = useProjectsStore.getState().activeProjectId;
          if (typeof snapshot.hasRemoteProjects === 'boolean') {
            queryClient.setQueryData<SettingsBootstrap>(settingsBootstrapQueryOptions(transport).queryKey, (previous) => ({
              schemaVersion: 1, ...previous, hasRemoteProjects: snapshot.hasRemoteProjects,
            }));
            if (supportsRemoteProjects() && (snapshot.hasRemoteProjects || projects.some((project) => project.hostId))) {
              void queryClient.invalidateQueries({ queryKey: [transport, 'remote-projects', 'catalog'], exact: true });
            }
          }
          // A remote edit invalidates the save deduplicator's old baseline too.
          invalidateSettingsCache(transport);
          useProjectsStore.getState().synchronizeFromSettings({
            ...snapshot,
            ...(activeProjectId && snapshot.projects?.some((project) => project.id === activeProjectId) ? { activeProjectId } : {}),
          });
          useSessionDisplayStore.getState().synchronizeFromSettings(snapshot);
        } catch (error) {
          if (current()) console.warn('Failed to synchronize project order:', error);
        }
      }
    } finally {
      if (run === runId) running = false;
    }
  };
  const unsubscribeEvents = subscribeYuriEvents((event) => {
    if (event.type === 'project-order-changed' || event.type === 'event-stream-ready') void refresh();
  });
  const unsubscribeRuntime = subscribeRuntimeEndpointChanged(() => {
    runId += 1;
    running = false;
    void refresh();
  });
  void refresh();
  return () => {
    disposed = true;
    unsubscribeEvents();
    unsubscribeRuntime();
  };
}
