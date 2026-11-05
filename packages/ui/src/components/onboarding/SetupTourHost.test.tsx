import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { SetupTourHost } from './SetupTourHost';
import { useSetupTourStore } from '@/stores/useSetupTourStore';

const fixture = vi.hoisted(() => ({
  runtime: 'tour-host-a', generation: 1, vscode: false, ready: true, initialized: true, directory: null as string | null,
  hydrate: null as Promise<boolean> | null, fetch: vi.fn(),
}));
vi.mock('@/lib/runtime-switch', () => ({
  getRuntimeKey: () => fixture.runtime,
  getRuntimeGeneration: () => fixture.generation,
  getRuntimeTransportIdentity: () => fixture.runtime,
  getRuntimeApiBaseUrl: () => '',
  isRuntimeInstanceChange: () => false,
  subscribeRuntimeEndpointChanged: () => () => {},
}));
vi.mock('@/lib/desktop', () => ({ isDesktopShell: () => false, isDesktopLocalOriginActive: () => false }));
vi.mock('@/hooks/useRuntimeAPIs', () => ({ useIsVSCodeRuntime: () => fixture.vscode }));
vi.mock('@/lib/settingsStartup', () => ({ getSettingsHydrationPromise: () => fixture.hydrate }));
vi.mock('@/stores/useDirectoryStore', () => ({ useDirectoryStore: (select: (state: unknown) => unknown) => select({ isHomeReady: fixture.ready, currentDirectory: fixture.directory }) }));
vi.mock('@/stores/useConfigStore', () => ({ useConfigStore: (select: (state: unknown) => unknown) => select({ isInitialized: fixture.initialized }) }));
vi.mock('@/lib/queryRuntime', () => ({ queryClient: new QueryClient() }));
vi.mock('@/lib/runtime-fetch', () => ({ runtimeFetch: async () => Response.json(await fixture.fetch()) }));
vi.mock('./SetupTourDialog', () => ({ SetupTourDialog: ({ runtime, onClose }: { runtime: string; onClose: () => void }) => <div data-tour={runtime}><button onClick={onClose}>Later</button></div> }));

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
const render = async (autoStart = true) => {
  await act(async () => {
    root.render(<QueryClientProvider client={client}><SetupTourHost autoStart={autoStart} /></QueryClientProvider>);
    await vi.advanceTimersByTimeAsync(5);
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(5); });
};
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  fixture.runtime = 'tour-host-a'; fixture.generation = 1; fixture.vscode = false;
  fixture.ready = true; fixture.initialized = true; fixture.hydrate = null; fixture.directory = null;
  fixture.fetch.mockReset().mockResolvedValue({ projects: [] });
  useSetupTourStore.setState({ progress: {}, openedRuntime: null });
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  await import('./SetupTourDialog');
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); vi.useRealTimers(); });

test('waits for settings hydration and an authoritative empty project snapshot before opening', async () => {
  let release!: (value: boolean) => void;
  fixture.hydrate = new Promise<boolean>((resolve) => { release = resolve; });
  await render();
  expect(fixture.fetch).not.toHaveBeenCalled();
  expect(container.querySelector('[data-tour]')).toBeNull();
  await act(async () => { release(true); });
  await render();
  expect(container.querySelector('[data-tour]')).not.toBeNull();
  expect(useSetupTourStore.getState().progress[fixture.runtime].dismissed).toBe(false);
});

test('a failed project read never certifies a fresh install or dismisses its pending tour', async () => {
  fixture.fetch.mockRejectedValue(new Error('offline'));
  await render();
  expect(container.querySelector('[data-tour]')).toBeNull();
  expect(useSetupTourStore.getState().progress[fixture.runtime]).toBeUndefined();
});

test('fresh settings open the tour even while OpenCode is using the home directory', async () => {
  fixture.directory = '/root';
  fixture.fetch.mockResolvedValue({ darkThemeId: 'cursor-dark', homeDirectory: '/root', lastDirectory: '/root' });
  await render();
  expect(container.querySelector('[data-tour]')).not.toBeNull();
  expect(useSetupTourStore.getState().progress[fixture.runtime].dismissed).toBe(false);
});

test.each([null, [], { projects: null }, { projects: {} }, { projects: [null] }, { projects: [{ path: '' }] }].map((settings) => [settings]))(
  'malformed settings never certify a fresh install: %j', async (settings) => {
    fixture.fetch.mockResolvedValue(settings);
    await render();
    expect(container.querySelector('[data-tour]')).toBeNull();
    expect(useSetupTourStore.getState().progress[fixture.runtime]).toBeUndefined();
  },
);

test('existing projects consume only automatic eligibility; deleting the last project does not open a tour', async () => {
  fixture.fetch.mockResolvedValue({ projects: [{ path: '/workspace/existing' }] });
  await render();
  expect(container.querySelector('[data-tour]')).toBeNull();
  expect(useSetupTourStore.getState().progress[fixture.runtime].dismissed).toBe(true);
  await act(async () => { client.setQueryData([fixture.runtime, 'settings', 'project-order'], { projects: [] }); });
  await render();
  expect(container.querySelector('[data-tour]')).toBeNull();
  await act(async () => { useSetupTourStore.getState().open(fixture.runtime); });
  await render();
  expect(container.querySelector('[data-tour]')).not.toBeNull();
});

test('dismissal and reopening preserve the step while a different runtime has its own eligibility', async () => {
  await render();
  await act(async () => { useSetupTourStore.getState().move(fixture.runtime, 1); container.querySelector('button')?.click(); });
  await render();
  expect(container.querySelector('[data-tour]')).toBeNull();
  expect(useSetupTourStore.getState().progress[fixture.runtime]).toEqual({ step: 1, dismissed: true });
  fixture.runtime = 'tour-host-b'; fixture.generation++;
  await render();
  expect(container.querySelector('[data-tour]')?.getAttribute('data-tour')).toBe('tour-host-b');
});

test('manual-only mobile mode performs no automatic catalog reads and VS Code never mounts the tour', async () => {
  await render(false);
  expect(fixture.fetch).not.toHaveBeenCalled();
  await act(async () => { useSetupTourStore.getState().open(fixture.runtime); });
  await render(false);
  expect(container.querySelector('[data-tour]')).not.toBeNull();
  fixture.vscode = true;
  await render();
  expect(container.querySelector('[data-tour]')).toBeNull();
});

test('a dismissed tour does no requests across 50 unrelated parent renders', async () => {
  useSetupTourStore.getState().dismiss(fixture.runtime);
  for (let i = 0; i < 50; i++) await render();
  expect(fixture.fetch).not.toHaveBeenCalled();
  expect(container.querySelector('[data-tour]')).toBeNull();
});
