import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  key: 'host:ssh-a', local: false, transport: 'direct:a',
  listeners: new Set<() => void>(),
  hosts: vi.fn(), setTitle: vi.fn(),
}));
vi.mock('@/stores/useProjectsStore', () => ({ useProjectsStore: (select: (s: object) => unknown) => select({ projects: [], activeProjectId: null }) }));
vi.mock('@/lib/desktop', () => ({ isDesktopShell: () => true, isDesktopLocalOriginActive: () => state.local }));
vi.mock('@/lib/desktopHosts', () => ({ desktopHostsGet: state.hosts, getDesktopHostApiUrl: (h: { url: string }) => h.url, locationMatchesHost: (a: string, b: string) => a === b, redactSensitiveUrl: (s: string) => s }));
vi.mock('@/lib/desktopNative', () => ({ setDesktopWindowTitle: state.setTitle }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: () => 'Instance' }) }));
vi.mock('@/lib/runtime-switch', () => ({
  getRuntimeApiBaseUrl: () => 'http://localhost:3000', getRuntimeKey: () => state.key,
  getRuntimeTransportIdentity: () => state.transport,
  subscribeRuntimeEndpointChanged: (fn: () => void) => { state.listeners.add(fn); return () => state.listeners.delete(fn); },
}));
import { useWindowTitle } from './useWindowTitle';

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
function Title() { useWindowTitle(); return null; }
const render = () => root.render(<QueryClientProvider client={client}><Title /></QueryClientProvider>);
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  state.key = 'host:ssh-a'; state.local = false; state.transport = 'direct:a'; state.listeners.clear();
  state.hosts.mockResolvedValue({ hosts: [{ id: 'ssh-a', label: 'build-a', url: 'http://remote-a' }, { id: 'ssh-b', label: 'build-b', url: 'http://remote-b' }] });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement('div'); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); }); };

it('uses the saved host identity even when a relay/loopback address resembles local', async () => {
  window.__YURI_LOCAL_ORIGIN__ = 'http://localhost:3000';
  await act(async () => render()); await settle();
  expect(document.title).toBe('build-a | Yuri');
  expect(state.setTitle).toHaveBeenLastCalledWith('build-a | Yuri');
});

it('updates on instance switches without focus, ignores unrelated renders, and restores local title', async () => {
  await act(async () => render()); await settle();
  const calls = state.hosts.mock.calls.length;
  for (let i = 0; i < 50; i++) await act(async () => render());
  expect(state.hosts).toHaveBeenCalledTimes(calls);
  await act(async () => { state.key = 'host:ssh-b'; state.transport = 'relay:b'; state.listeners.forEach(fn => fn()); });
  await settle();
  expect(document.title).toBe('build-b | Yuri');
  await act(async () => { state.key = 'local'; state.local = true; state.transport = 'direct:local'; state.listeners.forEach(fn => fn()); });
  expect(document.title).toBe('Yuri');
});
