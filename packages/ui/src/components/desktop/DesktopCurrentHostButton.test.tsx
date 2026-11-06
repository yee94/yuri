import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  key: 'local', transport: 'direct:local', connected: true,
  hosts: [] as Array<{ id: string; label: string; url: string; apiUrl?: string; relay?: object }>,
  ssh: [] as Array<{ id: string }>, statuses: [] as Array<{ id: string; phase: string }>,
  probe: vi.fn(), relayProbe: vi.fn(), click: vi.fn(),
}));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string, values?: { current: string }) => values?.current || key }) }));
vi.mock('@/lib/desktop', () => ({ canManageDesktopHosts: () => true }));
vi.mock('@/lib/desktopHosts', () => ({
  desktopHostsGet: async () => ({ hosts: state.hosts }),
  desktopHostProbe: state.probe, probeRelayDesktopHost: state.relayProbe,
  getDesktopHostApiUrl: (host: { url: string; apiUrl?: string }) => host.apiUrl || host.url,
  isVisibleDesktopHost: () => true, locationMatchesHost: (a: string, b: string) => a === b,
  redactSensitiveUrl: (value: string) => value,
}));
vi.mock('@/lib/desktopSsh', () => ({
  desktopSshInstancesGet: async () => ({ instances: state.ssh }), desktopSshStatus: async () => state.statuses,
}));
vi.mock('@/lib/runtime-switch', () => ({
  getRuntimeKey: () => state.key, getRuntimeTransportIdentity: () => state.transport,
  getRuntimeApiBaseUrl: () => 'http://local.test', subscribeRuntimeEndpointChanged: () => () => {},
}));
vi.mock('@/stores/useUIStore', () => ({ useUIStore: (select: (value: object) => unknown) => select({ isSettingsDialogOpen: false }) }));
vi.mock('@/stores/useConfigStore', () => ({ useConfigStore: (select: (value: object) => unknown) => select({ isConnected: state.connected }) }));
vi.mock('@/components/icon/Icon', () => ({ Icon: ({ name }: { name: string }) => <svg data-icon={name} /> }));
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: React.PropsWithChildren) => <>{children}</>,
  TooltipTrigger: ({ children }: React.PropsWithChildren) => <>{children}</>, TooltipContent: () => null,
}));

import { DesktopCurrentHostButton } from './DesktopCurrentHostButton';

let root: Root;
let element: HTMLDivElement;
let client: QueryClient;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  state.key = 'local'; state.transport = 'direct:local'; state.connected = true;
  state.hosts = []; state.ssh = []; state.statuses = [];
  state.probe.mockResolvedValue({ status: 'ok' }); state.relayProbe.mockResolvedValue({ status: 'ok' });
  element = document.createElement('div'); document.body.append(element); root = createRoot(element);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => {
  await act(async () => root.unmount()); client.clear(); element.remove();
});
async function render() {
  await act(async () => {
    root.render(<QueryClientProvider client={client}><DesktopCurrentHostButton open={false} onClick={state.click} /></QueryClientProvider>);
  });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
}

it('hides the entry for a single local instance and for offline remote instances', async () => {
  await render();
  expect(element.querySelector('button')).toBeNull();
  state.hosts = [{ id: 'remote', label: 'Offline', url: 'http://remote.test' }];
  state.probe.mockResolvedValue({ status: 'unreachable' });
  await act(async () => { await client.invalidateQueries(); });
  expect(element.querySelector('button')).toBeNull();
});

it('shows a neutral local icon without a visible machine name and opens on click', async () => {
  state.hosts = [{ id: 'remote', label: 'Remote', url: 'http://remote.test' }];
  await render();
  expect(element.querySelector('[data-icon="connection-local"]')).not.toBeNull();
  expect(element.querySelector('button')?.textContent).toBe('');
  await act(async () => element.querySelector('button')!.click());
  expect(state.click).toHaveBeenCalledOnce();
});

it('uses the live relay transport rather than an SSH host origin or stale probe', async () => {
  state.hosts = [{ id: 'remote', label: 'Studio', url: 'relay://studio', relay: {} }];
  state.ssh = [{ id: 'remote' }]; state.statuses = [{ id: 'remote', phase: 'idle' }];
  state.key = 'host:remote'; state.transport = 'relay:studio';
  await render();
  expect(element.querySelector('[data-icon="connection-relay"]')).not.toBeNull();
  expect(element.querySelector('button')?.getAttribute('aria-label')).toBe('Studio');
});

it('keeps an independently reachable host when another probe fails', async () => {
  state.hosts = [
    { id: 'broken', label: 'Broken', url: 'http://broken.test' },
    { id: 'ssh', label: 'Server', url: 'http://ssh.test' },
  ];
  state.probe.mockRejectedValue(new Error('probe unavailable'));
  state.ssh = [{ id: 'ssh' }]; state.statuses = [{ id: 'ssh', phase: 'ready' }];
  state.key = 'host:ssh';
  await render();
  expect(element.querySelector('[data-icon="connection-ssh"]')).not.toBeNull();
});
