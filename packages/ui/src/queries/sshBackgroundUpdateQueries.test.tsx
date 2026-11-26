import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { DesktopSshInstanceStatus } from '@/lib/desktopSsh';
import { useSshBackgroundUpdate, type SshBackgroundUpdate } from './sshBackgroundUpdateQueries';

const fixture = vi.hoisted(() => ({
  local: false, runtimeKey: 'host:devbox', apiBaseUrl: 'http://127.0.0.1:4100',
  statuses: [] as DesktopSshInstanceStatus[], statusCalls: vi.fn(), listener: null as null | ((status: DesktopSshInstanceStatus) => void),
}));
vi.mock('@/lib/desktop', () => ({ isElectronShell: () => true, isDesktopLocalOriginActive: () => fixture.local }));
vi.mock('@/lib/runtime-switch', () => ({ getRuntimeKey: () => fixture.runtimeKey, getRuntimeApiBaseUrl: () => fixture.apiBaseUrl }));
vi.mock('@/lib/queryRuntime', () => ({ get queryClient() { return client; } }));
vi.mock('@/lib/desktopSsh', () => ({
  desktopSshStatus: async () => { fixture.statusCalls(); return fixture.statuses; },
  listenDesktopSshStatus: async (listener: (status: DesktopSshInstanceStatus) => void) => { fixture.listener = listener; return async () => { fixture.listener = null; }; },
}));

let client: QueryClient; let root: Root; let host: HTMLDivElement;
let observed: SshBackgroundUpdate | null = null;
const onFailed = vi.fn();
const status = (id: string, backgroundUpdate?: DesktopSshInstanceStatus['backgroundUpdate'], localUrl = 'http://127.0.0.1:4100'): DesktopSshInstanceStatus => ({
  id, phase: 'ready', localUrl, startedByUs: true, retryAttempt: 0, requiresUserAction: false, updatedAtMs: 1, ...(backgroundUpdate ? { backgroundUpdate } : {}),
});
const running = { state: 'running' as const, from: '1.2.2', to: '1.2.3' };
const failed = { state: 'failed' as const, from: '1.2.2', to: '1.2.3', error: 'network unreachable' };

function Probe() {
  observed = useSshBackgroundUpdate('transport', onFailed);
  return null;
}
const render = async () => {
  await act(async () => root.render(<QueryClientProvider client={client}><Probe /></QueryClientProvider>));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
};
const emit = async (next: DesktopSshInstanceStatus) => {
  await act(async () => { fixture.listener?.(next); await new Promise((resolve) => setTimeout(resolve, 0)); });
};

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.assign(fixture, { local: false, runtimeKey: 'host:devbox', apiBaseUrl: 'http://127.0.0.1:4100', statuses: [], listener: null });
  fixture.statusCalls.mockReset(); onFailed.mockReset(); observed = null;
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); host.remove(); });

test('a local window never reads or subscribes to SSH background updates', async () => {
  fixture.local = true;
  fixture.runtimeKey = 'local';
  fixture.statuses = [status('devbox', running)];
  await render();
  expect(fixture.statusCalls).not.toHaveBeenCalled();
  expect(fixture.listener).toBeNull();
  expect(observed).toBeNull();
});

test('an SSH window sees only its own Host update, never another SSH Host', async () => {
  fixture.statuses = [status('other', running, 'http://127.0.0.1:4200'), status('devbox', running)];
  await render();
  expect(observed).toEqual({ ...running, hostId: 'devbox' });
  await emit(status('other', failed, 'http://127.0.0.1:4200'));
  expect(observed).toEqual({ ...running, hostId: 'devbox' });
  expect(onFailed).not.toHaveBeenCalled();
});

test('a window opened on the forwarded SSH address is matched without a host runtime key', async () => {
  fixture.runtimeKey = 'http://127.0.0.1:4100';
  fixture.statuses = [status('devbox', running)];
  await render();
  expect(observed?.hostId).toBe('devbox');
});

test('failure notifies once per running→failed transition and success clears the task', async () => {
  fixture.statuses = [status('devbox', running)];
  await render();
  await emit(status('devbox', failed));
  await emit(status('devbox', failed));
  expect(onFailed).toHaveBeenCalledExactlyOnceWith({ ...failed, hostId: 'devbox' });
  expect(observed?.state).toBe('failed');
  await emit(status('devbox', running));
  await emit(status('devbox'));
  expect(observed).toBeNull();
  expect(onFailed).toHaveBeenCalledTimes(1);
});
