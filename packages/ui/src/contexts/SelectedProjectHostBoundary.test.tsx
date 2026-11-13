import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { SelectedProjectHostBoundary } from './SelectedProjectHostBoundary';
import { useHostRuntime } from './HostRuntimeProvider';
import { HostRuntimeRegistry } from '@/lib/remote-projects/registry';
import type { ProjectEntry } from '@/lib/api/types';
import { useSessionNavigationStore } from '@/stores/useSessionNavigationStore';

const fixture = vi.hoisted(() => ({ project: undefined as ProjectEntry | undefined, registry: undefined as HostRuntimeRegistry | undefined, catalogCalls: vi.fn(), supported: true }));
vi.mock('@/stores/useProjectsStore', () => ({ useProjectsStore: (selector: (state: { projects: ProjectEntry[]; activeProjectId?: string }) => unknown) => selector({ projects: fixture.project ? [fixture.project] : [], activeProjectId: fixture.project?.id }) }));
vi.mock('@/queries/remoteProjectQueries', () => ({
  supportsRemoteProjects: () => fixture.supported,
  useRemoteProjectRuntime: () => { fixture.catalogCalls(); return { catalog: { supported: true, hubId: 'hub' }, registry: fixture.registry }; },
  getHostRuntimeRegistry: () => fixture.registry,
}));
vi.mock('@/lib/yuriEvents', () => ({ subscribeYuriEvents: () => () => {} }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

it('mounts actual project capabilities in the selected Host and resets same-path cross-Host view state, with no local discovery', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const fetch = vi.fn();
  const registry = new HostRuntimeRegistry('hub', { transportIdentity: 'transport', isCurrent: () => true, fetch, sdk: () => { throw new Error('Not demanded'); } });
  registry.applyCatalog({ supported: true, hubId: 'hub', projects: [], hosts: ['a', 'b'].map((id) => ({ id, name: id, source: 'direct' as const, state: 'connected' as const })) });
  fixture.registry = registry;
  fixture.project = { id: 'local', path: '/same/path' };
  let mounts = 0;
  function Tool() {
    const host = useHostRuntime();
    const [mount] = React.useState(() => ++mounts);
    return <output data-mount={mount}>{host ? `${host.entry.location.hostId}:${host.entry.location.directory}` : 'local'}</output>;
  }
  const rootElement = document.createElement('div'); document.body.append(rootElement); const root = createRoot(rootElement);
  const render = () => <SelectedProjectHostBoundary><Tool /></SelectedProjectHostBoundary>;
  try {
    await act(async () => root.render(render()));
    expect(rootElement.textContent).toBe('local');
    expect(fixture.catalogCalls).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    fixture.project = { id: 'remote-a', hubId: 'hub', hostId: 'a', path: '/same/path' };
    await act(async () => root.render(render()));
    expect(rootElement.textContent).toBe('a:/same/path');
    const before = rootElement.querySelector('output')!.dataset.mount;
    fixture.project = { id: 'remote-b', hubId: 'hub', hostId: 'b', path: '/same/path' };
    await act(async () => root.render(render()));
    expect(rootElement.textContent).toBe('b:/same/path');
    expect(rootElement.querySelector('output')!.dataset.mount).not.toBe(before);
    await act(async () => {
      useSessionNavigationStore.getState().openRemoteSession(fixture.project!, { hubId: 'hub', hostId: 'b', directory: '/worktrees/feature' }, 'session');
    });
    expect(rootElement.textContent).toBe('b:/worktrees/feature');
    expect(fetch).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); rootElement.remove(); registry.dispose(); fixture.project = undefined; useSessionNavigationStore.getState().clearRemoteSession(); }
});
