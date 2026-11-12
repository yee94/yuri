import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { HostRuntimeRegistry } from '@/lib/remote-projects/registry';
import type { HostCatalog } from '@/lib/remote-projects/types';
import { RemoteDirectoryExplorerDialog } from './RemoteDirectoryExplorerDialog';
import { RemoteHostIndicator } from './RemoteHostIndicator';
import { TooltipProvider } from '@/components/ui/tooltip';
import { remoteProjectMessages } from '@/lib/i18n/messages/remote-projects';

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string, args?: Record<string, string>) => args?.time ? `${key}:${args.time}` : key }) }));
vi.mock('@/lib/device', () => ({ useDeviceInfo: () => ({ isMobile: false }) }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => <span /> }));
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => open ? children : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <header>{children}</header>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <footer>{children}</footer>,
}));
vi.mock('@/components/ui/ScrollableOverlay', () => ({ ScrollableOverlay: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
const catalog: HostCatalog = { supported: true, hubId: 'hub', hosts: [
  { id: 'a', name: 'Machine A', source: 'direct', state: 'connected' },
  { id: 'b', name: 'Machine B', source: 'ssh', state: 'connected' },
], projects: [] };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const flush = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 15)); }); };

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); vi.restoreAllMocks(); });

test.each(['a', 'b'])('remote picker preserves same-path identity for host %s and registers without local IPC', async (hostId) => {
  const fetch = vi.fn(async (path: string) => {
    if (path.endsWith('/api/fs/home')) return json({ home: '/workspace' });
    if (path.endsWith('/api/fs/list')) return json({ entries: [{ name: 'Code', path: '/workspace/Code', isDirectory: true }] });
    if (path.endsWith('/projects')) return json({ project: { id: `hub-project-${hostId}`, hostId, path: '/workspace/Code', remoteProjectId: 'remote-project', remoteState: 'ok' }, created: true });
    return json({ error: 'Unexpected request' }, 500);
  });
  const registry = new HostRuntimeRegistry('hub', { transportIdentity: 'transport', isCurrent: () => true, fetch, sdk: () => { throw new Error('No local client'); }, service: () => { throw new Error('No local service'); } });
  registry.applyCatalog(catalog);
  const registered = vi.fn(async () => {}); const close = vi.fn();
  await act(async () => root.render(<QueryClientProvider client={client}><RemoteDirectoryExplorerDialog open onOpenChange={close} registry={registry} hostId={hostId} machinePicker={null} onRegistered={registered} /></QueryClientProvider>));
  await flush(); await flush();
  const code = [...container.querySelectorAll('button')].find(button => button.textContent === 'Code')!;
  await act(async () => code.click()); await flush();
  const add = [...container.querySelectorAll('button')].find(button => button.textContent === 'directoryExplorerDialog.actions.addProject')!;
  await act(async () => add.click()); await flush();
  expect(fetch).toHaveBeenCalledWith(`/api/hosts/${hostId}/api/fs/list`, expect.objectContaining({ query: { path: '/workspace/Code' } }));
  expect(fetch).toHaveBeenCalledWith(`/api/hosts/${hostId}/projects`, expect.objectContaining({ body: JSON.stringify({ path: '/workspace/Code' }) }));
  expect(registered).toHaveBeenCalledWith(expect.objectContaining({ hostId, id: `hub-project-${hostId}`, path: '/workspace/Code' }));
  expect(registered).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledWith(false);
});

test('failed Hub registration preserves the raw path and dialog for idempotent retry', async () => {
  const fetch = vi.fn(async (path: string) => {
    if (path.endsWith('/api/fs/home')) return json({ home: '/workspace' });
    if (path.endsWith('/api/fs/list')) return json({ entries: [] });
    return json({ code: 'remote_offline', error: 'Remote machine went offline' }, 503);
  });
  const registry = new HostRuntimeRegistry('hub', { transportIdentity: 'transport', isCurrent: () => true, fetch, sdk: () => { throw new Error('Unused'); }, service: () => { throw new Error('Unused'); } });
  registry.applyCatalog(catalog);
  const registered = vi.fn(async () => {}); const close = vi.fn();
  await act(async () => root.render(<QueryClientProvider client={client}><RemoteDirectoryExplorerDialog open onOpenChange={close} registry={registry} hostId="a" machinePicker={null} onRegistered={registered} /></QueryClientProvider>));
  await flush(); await flush();
  const add = [...container.querySelectorAll('button')].find(button => button.textContent === 'directoryExplorerDialog.actions.addProject')!;
  await act(async () => add.click()); await flush();
  expect(container.querySelector('input')!.value).toBe('/workspace');
  expect(container.querySelector('button[aria-label="Remote machine went offline"]')).not.toBeNull();
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.textContent).not.toContain('Remote machine went offline');
  expect(close).not.toHaveBeenCalled(); expect(registered).not.toHaveBeenCalled();
  expect(add.disabled).toBe(false);
});

test('host indicators stay mounted offline, expose removed state and do not notify unrelated hosts', async () => {
  const registry = new HostRuntimeRegistry('hub', { transportIdentity: 'transport', isCurrent: () => true, fetch: vi.fn(), sdk: () => { throw new Error('Unused'); }, service: () => { throw new Error('Unused'); } });
  registry.applyCatalog(catalog);
  const unrelated = vi.fn(); registry.subscribeHost('b', unrelated);
  await act(async () => root.render(<><RemoteHostIndicator registry={registry} hostId="a" composer /><RemoteHostIndicator registry={registry} hostId="b" remoteState="remote-removed" /></>));
  expect(container.textContent).toContain('Machine A');
  await act(async () => registry.ingest({ type: 'yuri:host-status', properties: { hubId: 'hub', hostId: 'a', host: { ...catalog.hosts[0], state: 'offline', lastSyncedAt: 1000 } } }));
  expect(container.textContent).toContain('remoteProjects.sendBlocked');
  expect(container.querySelector('[data-remote-host="a"]')?.getAttribute('aria-label')).toContain('remoteProjects.lastSync');
  expect(container.querySelector('[data-remote-host="b"]')?.getAttribute('aria-label')).toContain('remoteProjects.remote-removed');
  expect(unrelated).not.toHaveBeenCalled();
});

test('all shipped locales have the same remote-project keys and preserve time placeholder', () => {
  const keys = Object.keys(remoteProjectMessages.en).sort();
  for (const messages of Object.values(remoteProjectMessages)) {
    expect(Object.keys(messages).sort()).toEqual(keys);
    expect(messages['remoteProjects.lastSync']).toContain('{time}');
  }
});

test('compact SSH identity prioritizes the host while its tooltip and full-name surface retain the login', async () => {
  const registry = new HostRuntimeRegistry('hub', { transportIdentity: 'transport', isCurrent: () => true, fetch: vi.fn(), sdk: () => { throw new Error('Unused'); }, service: () => { throw new Error('Unused'); } });
  const name = 'root@development.devcloud.example.com';
  registry.applyCatalog({ ...catalog, hosts: [{ ...catalog.hosts[1], name }] });
  await act(async () => root.render(<RemoteHostIndicator registry={registry} hostId="b" compactName />));
  expect(container.querySelector('[data-remote-host]')?.textContent).toBe('development.devcloud.example.com');
  expect(container.querySelector('[data-remote-host]')?.getAttribute('aria-label')).toContain(name);
  await act(async () => root.render(<RemoteHostIndicator registry={registry} hostId="b" showName />));
  expect(container.querySelector('[data-remote-host]')?.textContent).toBe(name);
  await act(async () => registry.applyCatalog({ ...catalog, hosts: [{ ...catalog.hosts[1], name: 'My build machine' }] }));
  await act(async () => root.render(<RemoteHostIndicator registry={registry} hostId="b" compactName />));
  expect(container.querySelector('[data-remote-host]')?.textContent).toBe('My build machine');
});

test('remote icon hover shows the machine name in a real tooltip', async () => {
  const registry = new HostRuntimeRegistry('hub', { transportIdentity: 'transport', isCurrent: () => true, fetch: vi.fn(), sdk: () => { throw new Error('Unused'); }, service: () => { throw new Error('Unused'); } });
  registry.applyCatalog(catalog);
  await act(async () => root.render(<TooltipProvider delay={0}><RemoteHostIndicator registry={registry} hostId="a" nameOnlyTip /></TooltipProvider>));
  const icon = container.querySelector('[data-remote-host="a"]')!;
  await act(async () => {
    icon.dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'mouse' }));
    icon.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    icon.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    icon.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
  });
  await flush(); await flush();
  expect(document.querySelector('[data-slot="tooltip-content"]')?.textContent).toBe('Machine A');
});
