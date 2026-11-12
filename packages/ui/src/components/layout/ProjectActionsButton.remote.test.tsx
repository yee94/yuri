import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { TerminalStreamEvent } from '@/lib/terminalApi';
import { HostRuntimeRegistry, type HostRuntimeEntry } from '@/lib/remote-projects/registry';
import { useTerminalStore } from '@/stores/useTerminalStore';
import { useUIStore } from '@/stores/useUIStore';
import { normalizeLocationStateKey } from '@/lib/remote-projects/location';

const fixture = vi.hoisted(() => ({
  local: vi.fn(), loadSsh: vi.fn(), external: vi.fn(), preview: vi.fn(), error: vi.fn(),
  create: vi.fn(), send: vi.fn(), close: vi.fn(), dispose: vi.fn(), disconnect: vi.fn(), stream: vi.fn(),
  registry: undefined as HostRuntimeRegistry | undefined,
  event: undefined as ((event: TerminalStreamEvent) => void) | undefined,
}));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/hooks/useRuntimeAPIs', () => ({ useRuntimeAPIs: () => ({ runtime: { isVSCode: false }, terminal: {
  createSession: fixture.local, sendInput: fixture.local, close: fixture.local,
} }) }));
vi.mock('@/queries/remoteProjectQueries', () => ({ useRemoteProjectRuntime: () => ({ registry: fixture.registry }) }));
vi.mock('@/lib/device', () => ({ useDeviceInfo: () => ({ isMobile: false }) }));
vi.mock('@/lib/desktop', async (original) => ({ ...await original<typeof import('@/lib/desktop')>(), isDesktopShell: () => true }));
vi.mock('@/stores/useDesktopSshStore', () => ({ useDesktopSshStore: (selector: (state: unknown) => unknown) => selector({ instances: [], load: fixture.loadSsh }) }));
vi.mock('@/lib/url', () => ({ openExternalUrl: fixture.external }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => <span /> }));
vi.mock('@/components/ui', () => ({ toast: { error: fixture.error, info: vi.fn(), success: vi.fn() } }));
vi.mock('@/components/ui/tooltip', () => ({ Tooltip: ({ children }: React.PropsWithChildren) => <>{children}</>,
  TooltipTrigger: ({ children }: React.PropsWithChildren) => <>{children}</>, TooltipContent: () => null }));
vi.mock('@/components/ui/dropdown-menu', () => ({ DropdownMenu: ({ children }: React.PropsWithChildren) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: React.PropsWithChildren) => <>{children}</>,
  DropdownMenuContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DropdownMenuSeparator: () => null,
  DropdownMenuItem: ({ children, onClick }: React.PropsWithChildren<{ onClick?: () => void }>) => <button onClick={onClick}>{children}</button>,
}));
vi.mock('@/lib/terminalApi', async (original) => ({
  ...await original<typeof import('@/lib/terminalApi')>(),
  connectTerminalStream: fixture.local,
  createProjectTerminalAPI: (entry: HostRuntimeEntry) => ({
    createTerminalSession: (options: unknown) => fixture.create(entry, options),
    sendTerminalInput: (id: string, input: string) => fixture.send(entry, id, input),
    closeTerminal: (id: string) => fixture.close(entry, id),
    resizeTerminal: vi.fn(), dispose: fixture.dispose,
    connectTerminalStream: (id: string, onEvent: (event: TerminalStreamEvent) => void) => {
      fixture.stream(entry, id); fixture.event = onEvent; return fixture.disconnect;
    },
  }),
}));

import { ProjectActionsButton } from './ProjectActionsButton';

let root: Root;
let host: HTMLDivElement;
let requests: Array<{ host: string; path: string; file?: unknown }>;
let unavailable: boolean;
let manualUrl: string | undefined;
let entryB: HostRuntimeEntry;
let entryC: HostRuntimeEntry;
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  requests = []; unavailable = false; manualUrl = undefined;
  fixture.create.mockResolvedValue({ sessionId: 'same-terminal' });
  fixture.send.mockResolvedValue(undefined);
  fixture.close.mockResolvedValue(undefined);
  fixture.registry = new HostRuntimeRegistry('hub', {
    transportIdentity: 'test', isCurrent: () => true,
    sdk: () => ({} as ReturnType<HostRuntimeEntry['sdk']>),
    fetch: async (path, init) => {
      const file = init?.query instanceof URLSearchParams ? init.query.get('path') : init?.query?.path;
      const host = path.split('/')[3];
      requests.push({ host, path, file });
      if (unavailable) return Response.json({ error: 'Host denied' }, { status: 503 });
      if (path.endsWith('/fs/home')) return Response.json({ home: '/remote-home' });
      if (typeof file === 'string' && file.endsWith('package.json')) return new Response(JSON.stringify({ scripts: { dev: 'vite' }, packageManager: 'bun@1.3.0' }));
      return new Response(JSON.stringify({ projectActions: [{ id: 'serve', name: 'Run custom', command: 'run-project', autoOpenUrl: true, openUrl: manualUrl }] }));
    },
  });
  for (const id of ['b', 'c']) fixture.registry.ingest({ type: 'yuri:host-status', properties: { hubId: 'hub', hostId: id,
    host: { id, name: id, source: 'ssh', available: true, state: 'connected', generation: 'ready-1' } } });
  entryB = fixture.registry.resolve({ hubId: 'hub', hostId: 'b', directory: '/same' });
  entryC = fixture.registry.resolve({ hubId: 'hub', hostId: 'c', directory: '/same' });
  useTerminalStore.setState({ sessions: new Map(), projectActionRuns: {} });
  useUIStore.setState({ openContextPreview: fixture.preview });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

async function render(entry = entryB, supplied = true) {
  await act(async () => root.render(<ProjectActionsButton projectRef={{ id: `ref-${entry.location.hostId}`, path: '/same', hostId: entry.location.hostId, hubId: 'hub' }}
    directory="/same" scope={supplied ? entry : undefined} />));
}
async function click(text: string) {
  const button = Array.from(host.querySelectorAll('button')).find((button) => button.getAttribute('aria-label') === text || button.textContent === text);
  expect(button).toBeDefined(); await act(async () => button!.click());
}

test('mounted Header Run discovers remote scripts/config, streams output, and opens Host Location preview', async () => {
  await render();
  await click('projectActions.actions.runNamedAria');
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });
  expect(fixture.create).toHaveBeenCalledWith(entryB, { cwd: '/same' });
  expect(fixture.send).toHaveBeenCalledWith(entryB, 'same-terminal', 'bun run --shell=bun dev\r');
  expect(fixture.stream).toHaveBeenCalledWith(entryB, 'same-terminal');
  await act(async () => fixture.event?.({ type: 'data', data: 'Local: http://localhost:5173/\n' }));
  expect(fixture.preview).toHaveBeenCalledWith(entryB.key, 'http://localhost:5173');
  expect(useTerminalStore.getState().getDirectoryState('/same')).toBeUndefined();
  expect(useTerminalStore.getState().getDirectoryState(entryB.key)?.tabs.find((tab) => tab.terminalSessionId === 'same-terminal')?.previewUrl).toBe('http://localhost:5173');
  expect(requests.every((request) => request.host === 'b')).toBe(true);
  expect(fixture.local).not.toHaveBeenCalled();
  expect(fixture.loadSsh).not.toHaveBeenCalled();
  expect(fixture.external).not.toHaveBeenCalled();
});

test('saved action manual preview and stop retain the original controls but use captured Host terminal', async () => {
  manualUrl = 'http://127.0.0.1:4567/';
  await render();
  await click('Run custom');
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });
  expect(fixture.send).toHaveBeenCalledWith(entryB, 'same-terminal', 'run-project\r');
  expect(fixture.preview).toHaveBeenCalledWith(entryB.key, manualUrl);
  expect(fixture.external).not.toHaveBeenCalled();
  await click('projectActions.actions.stopNamedAria');
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1050)); });
  expect(fixture.send).toHaveBeenCalledWith(entryB, 'same-terminal', '\x03');
  expect(fixture.close).toHaveBeenCalledWith(entryB, 'same-terminal');
  expect(fixture.local).not.toHaveBeenCalled();
});

test('same-path Host switch cannot consume another Host output or terminal identity', async () => {
  await render(); await click('projectActions.actions.runNamedAria');
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });
  const oldEvent = fixture.event;
  await render(entryC);
  await act(async () => oldEvent?.({ type: 'data', data: 'http://localhost:9999/' }));
  expect(fixture.preview).not.toHaveBeenCalled();
  expect(fixture.dispose).toHaveBeenCalled();
  expect(fixture.disconnect).toHaveBeenCalled();
  await click('projectActions.actions.runNamedAria');
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });
  expect(fixture.send).toHaveBeenLastCalledWith(entryC, 'same-terminal', 'bun run --shell=bun dev\r');
  expect(useTerminalStore.getState().sessions.has(entryB.key)).toBe(true);
  expect(useTerminalStore.getState().sessions.has(entryC.key)).toBe(true);
});

test('complete Header projectRef resolves its Host even outside a provider; unavailable remote never runs Hub', async () => {
  await render(entryB, false);
  unavailable = true;
  await click('projectActions.actions.runNamedAria');
  expect(fixture.create).not.toHaveBeenCalled();
  expect(fixture.local).not.toHaveBeenCalled();
  expect(fixture.error).toHaveBeenCalled();
});

test('50 unrelated parent updates cause no configuration or discovery reload', async () => {
  await render();
  const count = requests.length;
  for (let index = 0; index < 50; index += 1) await render();
  expect(requests).toHaveLength(count);
  expect(fixture.create).not.toHaveBeenCalled();
  expect(fixture.local).not.toHaveBeenCalled();
});

test('Windows cwd stays raw on the API while action/tab state uses the canonical Location key', async () => {
  const directory = 'c:\\Repo\\src';
  const entry = fixture.registry!.resolve({ hubId: 'hub', hostId: 'b', directory });
  await act(async () => root.render(<ProjectActionsButton projectRef={{ id: 'win', path: directory, hostId: 'b', hubId: 'hub' }} directory={directory} scope={entry} />));
  await click('Run custom');
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });
  expect(fixture.create).toHaveBeenCalledWith(entry, { cwd: directory });
  const runs = Object.values(useTerminalStore.getState().projectActionRuns);
  expect(runs).toHaveLength(1);
  expect(runs[0].directory).toBe(normalizeLocationStateKey(entry.key));
  expect(useTerminalStore.getState().sessions.has(normalizeLocationStateKey(entry.key))).toBe(true);
  expect(useTerminalStore.getState().sessions.has(directory)).toBe(false);
});

test('Host connection generation change disposes streaming and fences late output without touching another Host', async () => {
  await render(); await click('projectActions.actions.runNamedAria');
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });
  const oldEvent = fixture.event;
  unavailable = true;
  await act(async () => fixture.registry!.ingest({ type: 'yuri:host-status', properties: { hubId: 'hub', hostId: 'b',
    host: { id: 'b', name: 'b', source: 'ssh', available: true, state: 'offline', generation: 'offline-2' } } }));
  await act(async () => oldEvent?.({ type: 'data', data: 'http://localhost:9999/' }));
  expect(fixture.dispose).toHaveBeenCalled();
  expect(fixture.disconnect).toHaveBeenCalled();
  expect(fixture.preview).not.toHaveBeenCalled();
  expect(fixture.registry!.resolve(entryC.location)).toBe(entryC);
  expect(fixture.local).not.toHaveBeenCalled();
});

test('failed remote stop preserves its running action and terminal identity so retry still targets that Host', async () => {
  await render(); await click('Run custom');
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });
  fixture.close.mockRejectedValueOnce(new Error('remote terminal unavailable'));
  await click('projectActions.actions.stopNamedAria');
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1050)); });
  expect(Object.values(useTerminalStore.getState().projectActionRuns)[0]).toMatchObject({ directory: entryB.key, status: 'running', sessionId: 'same-terminal' });
  expect(fixture.error).toHaveBeenCalledWith('remote terminal unavailable');
  await click('projectActions.actions.stopNamedAria');
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1050)); });
  expect(Object.values(useTerminalStore.getState().projectActionRuns)).toHaveLength(0);
  expect(fixture.close).toHaveBeenLastCalledWith(entryB, 'same-terminal');
  expect(fixture.local).not.toHaveBeenCalled();
});
