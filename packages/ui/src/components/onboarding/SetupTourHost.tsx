import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useIsVSCodeRuntime } from '@/hooks/useRuntimeAPIs';
import { getRuntimeKey, getRuntimeGeneration, getRuntimeTransportIdentity, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { getSettingsHydrationPromise } from '@/lib/settingsStartup';
import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery';
import { projectOrderQueryOptions } from '@/queries/projectOrderQueries';
import { useSetupTourStore } from '@/stores/useSetupTourStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useConfigStore } from '@/stores/useConfigStore';

const SetupTourDialog = lazyWithChunkRecovery(() => import('./SetupTourDialog').then((module) => ({ default: module.SetupTourDialog })));

function RuntimeTour({ runtime, autoStart }: { runtime: string; autoStart: boolean }) {
  const opened = useSetupTourStore((state) => state.openedRuntime === runtime);
  const progress = useSetupTourStore((state) => state.progress[runtime]);
  const ready = useDirectoryStore((state) => state.isHomeReady);
  const directory = useDirectoryStore((state) => state.currentDirectory);
  const initialized = useConfigStore((state) => state.isInitialized);
  const [hydrated, setHydrated] = React.useState(false);
  React.useEffect(() => {
    let active = true;
    void Promise.resolve(getSettingsHydrationPromise(runtime)).then((result) => {
      if (active && result !== false) setHydrated(true);
    });
    return () => { active = false; };
  }, [runtime]);
  const eligible = autoStart && hydrated && ready && initialized && !progress;
  const projects = useQuery({ ...projectOrderQueryOptions(), enabled: eligible });
  React.useEffect(() => {
    if (!autoStart || !hydrated || !ready || !initialized || opened || progress?.dismissed) return;
    const store = useSetupTourStore.getState();
    if (progress) { store.open(runtime); return; }
    if (!projects.isSuccess || projects.isError || !projects.isFetchedAfterMount) return;
    if (projects.data.projects?.length) store.dismiss(runtime);
    else store.open(runtime);
  }, [autoStart, hydrated, ready, initialized, runtime, opened, progress, projects.isSuccess, projects.isError, projects.isFetchedAfterMount, projects.data]);
  if (!opened) return null;
  return <React.Suspense fallback={null}><SetupTourDialog key={directory} runtime={runtime} onClose={() => useSetupTourStore.getState().dismiss(runtime)} /></React.Suspense>;
}

/** Desktop auto-onboarding; other Host-backed surfaces can reopen the same tour explicitly. */
export function SetupTourHost({ autoStart = true }: { autoStart?: boolean }) {
  const vscode = useIsVSCodeRuntime();
  const runtime = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeKey, getRuntimeKey);
  const generation = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeGeneration, getRuntimeGeneration);
  if (vscode) return null;
  return <RuntimeTour key={`${runtime}:${generation}:${getRuntimeTransportIdentity()}`} runtime={runtime} autoStart={autoStart} />;
}
