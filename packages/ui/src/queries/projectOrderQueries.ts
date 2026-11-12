import { queryClient } from '@/lib/queryRuntime';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeGeneration, getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import type { DesktopSettings } from '@/lib/desktop';
import { withConfigQueryDeadline } from './configQueryDeadline';
import { parseHubProjectLayout, type HubProjectLayout } from './hubProjectLayout';
import { waitForPendingSettingsUpdates } from '@/lib/persistence';

function parseProjectOrderSnapshot(settings: unknown): Pick<DesktopSettings, 'projects' | 'projectSortOrder' | 'hubProjectLayout' | 'hasRemoteProjects'> {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Invalid project order snapshot');
  const value = settings as Record<string, unknown>;
  const projects = Object.hasOwn(value, 'projects') ? value.projects : [];
  if (!Array.isArray(projects) || projects.some((project: unknown) => !project || typeof project !== 'object'
    || !('path' in project) || typeof project.path !== 'string' || !project.path.trim())) throw new Error('Invalid project order snapshot');
  if (value.hasRemoteProjects !== undefined && typeof value.hasRemoteProjects !== 'boolean') throw new Error('Invalid remote project discovery hint');
  return { projects, projectSortOrder: value.projectSortOrder as DesktopSettings['projectSortOrder'],
    ...(value.hasRemoteProjects === undefined ? {} : { hasRemoteProjects: value.hasRemoteProjects }),
    ...(value.hubProjectLayout === undefined ? {} : { hubProjectLayout: parseHubProjectLayout(value.hubProjectLayout) }) };
}

export const projectOrderQueryOptions = (transport = getRuntimeTransportIdentity()) => ({
  queryKey: [transport, 'settings', 'project-order'] as const,
  queryFn: ({ signal }: { signal: AbortSignal }) => withConfigQueryDeadline(signal, async (signal) => {
    if (getRuntimeTransportIdentity() !== transport) throw new Error('Project order runtime changed');
    const response = await runtimeFetch('/api/config/settings', { signal });
    if (!response.ok) throw new Error(`Project order request failed (${response.status})`);
    const settings = parseProjectOrderSnapshot(await response.json());
    if (getRuntimeTransportIdentity() !== transport) throw new Error('Project order runtime changed');
    // Cache only the shared project fields, never the full settings response.
    return settings;
  }),
  staleTime: 0,
  retry: 1,
});

export const refreshProjectOrderSnapshot = (transport = getRuntimeTransportIdentity()) =>
  queryClient.fetchQuery(projectOrderQueryOptions(transport));

const layoutWrites = new Map<string, Promise<unknown>>();

export async function waitForPendingHubProjectLayoutUpdates(transport: string): Promise<void> {
  while (layoutWrites.has(transport)) await layoutWrites.get(transport)!.catch(() => undefined);
}

/** Serialize explicit layout writes; never send remote references through settings.projects. */
export function saveHubProjectLayout(layout: HubProjectLayout, transport = getRuntimeTransportIdentity()) {
  const captured = parseHubProjectLayout(layout);
  const generation = getRuntimeGeneration();
  const assertCurrent = () => {
    if (transport !== getRuntimeTransportIdentity() || generation !== getRuntimeGeneration()) throw new Error('Hub project layout runtime changed');
  };
  const flight = (layoutWrites.get(transport) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    await waitForPendingSettingsUpdates(transport);
    assertCurrent();
    const response = await runtimeFetch('/api/config/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hubProjectLayout: captured }) });
    if (!response.ok) throw new Error(`Hub project layout save failed (${response.status})`);
    const snapshot = parseProjectOrderSnapshot(await response.json());
    assertCurrent();
    if (snapshot.hubProjectLayout?.hubId !== captured.hubId) throw new Error('Hub project layout response identity mismatch');
    queryClient.setQueryData(projectOrderQueryOptions(transport).queryKey, snapshot);
    return snapshot;
  });
  layoutWrites.set(transport, flight);
  const clear = () => { if (layoutWrites.get(transport) === flight) layoutWrites.delete(transport); };
  void flight.then(clear, clear);
  return flight;
}
