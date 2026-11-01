import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/lib/i18n';
import { RemoteDesktopSettings } from './RemoteDesktopSettings';

const mock = vi.hoisted(() => ({
  local: true, configure: vi.fn(),
  status: { supported: true, enabled: false, screenRecording: 'denied', accessibility: false, helperAvailable: true, ready: false },
}));
vi.mock('@/lib/desktop', () => ({
  isDesktopShell: () => true, isDesktopLocalOriginActive: () => mock.local,
  configureDesktopRemoteDesktop: mock.configure,
}));
vi.mock('@/lib/runtime-switch', () => ({ getRuntimeTransportIdentity: () => 'local', getRuntimeGeneration: () => 1 }));
let root: Root, client: QueryClient, container: HTMLDivElement;
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 15)); });
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  mock.local = true;
  mock.status = { supported: true, enabled: false, screenRecording: 'denied', accessibility: false, helperAvailable: true, ready: false };
  mock.configure.mockReset().mockImplementation(async (action: { type: string; enabled?: boolean }) => {
    if (action.type === 'enabled') mock.status = { ...mock.status, enabled: action.enabled === true };
    return { ...mock.status };
  });
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); client.clear(); container.remove(); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false }); });
const render = async () => {
  act(() => root.render(<QueryClientProvider client={client}><I18nProvider><RemoteDesktopSettings /></I18nProvider></QueryClientProvider>));
  await flush();
};
const toggle = () => container.querySelector<HTMLElement>('[data-settings-item="remote-instances.remote-desktop"]')!;

it('guides both permissions before enabling, uses native mutations and exposes the search anchors', async () => {
  await render();
  expect(toggle().getAttribute('aria-pressed')).toBe('false');
  expect(toggle().getAttribute('aria-disabled')).toBe('true');
  expect(container.querySelector('[data-settings-item="remote-instances.remote-desktop-screen"]')).not.toBeNull();
  const authorize = [...container.querySelectorAll('button')].filter(button => button.textContent === 'Authorize');
  expect(authorize).toHaveLength(2);
  act(() => authorize[0].click()); await flush();
  expect(mock.configure).toHaveBeenCalledWith({ type: 'permission', permission: 'screen' });
  expect(toggle().getAttribute('aria-pressed')).toBe('false');
  mock.status = { ...mock.status, screenRecording: 'granted', accessibility: true, ready: true };
  const recheck = [...container.querySelectorAll('button')].find(button => button.textContent === 'Check permissions again')!;
  act(() => recheck.click()); await flush();
  expect(toggle().getAttribute('aria-disabled')).toBeNull();
  act(() => toggle().click()); await flush();
  expect(mock.configure).toHaveBeenCalledWith({ type: 'enabled', enabled: true });
  expect(toggle().getAttribute('aria-pressed')).toBe('true');
});

it('preserves prior authoritative state on refresh failure and still allows turning off', async () => {
  mock.status = { ...mock.status, enabled: true, screenRecording: 'granted', accessibility: true, ready: true };
  await render();
  mock.configure.mockRejectedValueOnce(new Error('native read failed'));
  const recheck = [...container.querySelectorAll('button')].find(button => button.textContent === 'Check permissions again')!;
  act(() => recheck.click()); await flush();
  expect(toggle().getAttribute('aria-pressed')).toBe('true');
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
  act(() => toggle().click()); await flush();
  expect(mock.configure).toHaveBeenCalledWith({ type: 'enabled', enabled: false });
});

it('never reads or changes local Mac permissions when viewing a remote runtime', async () => {
  mock.local = false; await render();
  expect(container.textContent).toBe(''); expect(mock.configure).not.toHaveBeenCalled();
});
