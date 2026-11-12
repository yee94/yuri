import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { HostRuntimeRegistry, type HostRuntimeDependencies } from '@/lib/remote-projects/registry';
import type { RemoteHost } from '@/lib/remote-projects/types';
import { RemoteDirectoryExplorerDialog } from './RemoteDirectoryExplorerDialog';

const events = vi.hoisted(() => ({ listeners: new Set<(event: unknown) => void>() }));
const registration = vi.hoisted(() => ({ upsertRemoteProject: vi.fn(), setActiveProjectIdOnly: vi.fn(), openRemoteSession: vi.fn(), registered: vi.fn(), close: vi.fn() }));
vi.mock('@/lib/yuriEvents', () => ({ subscribeYuriEvents: (listener: (event: unknown) => void) => {
  events.listeners.add(listener);
  return () => events.listeners.delete(listener);
} }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/device', () => ({ useDeviceInfo: () => ({ isMobile: false }) }));
// Keep store persistence outside the real query/registration lifecycle under test.
vi.mock('@/stores/useProjectsStore', () => ({ useProjectsStore: { getState: () => registration } }));
vi.mock('@/stores/useSessionNavigationStore', () => ({ useSessionNavigationStore: { getState: () => registration } }));
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => open ? children : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <header>{children}</header>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <footer>{children}</footer>,
}));
vi.mock('@/components/ui/ScrollableOverlay', () => ({ ScrollableOverlay: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

// Exact first three host-status payloads from candidate-ui-native's interactive.json
// controlFile sibling ui-network-console.jsonl, SHA256:
// 73c52736c0a22dd05622415670b061a4ac58d094ca39f9c4cfb26407151bdad8.
// New DTO contract projection: add one stable scopeGeneration to the initial catalog
// and archived statuses. The archive did not contain this field; wire/state/order
// remain unchanged. Production runtime ingests each projected DTO.
const hubId = '80719ca5-7cf0-4547-8bd9-855894029f0d';
const hostId = 'candidate-remote';
const captured = [
  { epochMs: 1794430332626, generation: '1cc78600-aa43-4be3-bf15-0a3f8478361a' },
  { epochMs: 1794430332631, generation: '046c7ada-c99b-4e57-8e78-f3bd6c36f2f6' },
  { epochMs: 1794430332636, generation: '619e0cf2-6c8c-4800-a719-34535b8d9421' },
] as const;
const scopeGeneration = '6ec581e6-b96b-4479-9e99-42cb8844df03';
const host: RemoteHost = { id: hostId, name: 'Diagnostic Remote', source: 'direct', available: true, state: 'offline', scopeGeneration };
type Request = { path: string; signal: AbortSignal | undefined; respond(payload: unknown): void; settled: boolean };
let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
let requests: Request[];
let registries: HostRuntimeRegistry[];
let registry: HostRuntimeRegistry;

const makeRegistry = (transport = 'transport', current = () => true, initialHost = host) => {
  const fetch: HostRuntimeDependencies['fetch'] = (path, init) => new Promise((resolve, reject) => {
    const signal = init?.signal ?? undefined;
    const request: Request = { path, signal, settled: false, respond(payload) {
      if (request.settled) return;
      request.settled = true;
      signal?.removeEventListener('abort', abort);
      resolve(Response.json(payload));
    } };
    const abort = () => { request.settled = true; reject(new DOMException('Aborted', 'AbortError')); };
    requests.push(request);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
  const result = new HostRuntimeRegistry(hubId, { transportIdentity: transport, isCurrent: current, fetch,
    sdk: () => { throw new Error('Picker must not use a local SDK'); } });
   result.applyCatalog({ supported: true, hubId, hosts: [initialHost, { ...initialHost, id: 'other-host' }], projects: [] });
  registries.push(result);
  return result;
};
const render = async (owner = registry, selectedHost = hostId) => {
  await act(async () => root.render(<QueryClientProvider client={client}>
    <RemoteDirectoryExplorerDialog open registry={owner} hostId={selectedHost} machinePicker={null}
      onOpenChange={registration.close} onRegistered={registration.registered} />
  </QueryClientProvider>));
};
const flush = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); }); };
const matching = (resource: string) => requests.filter(request => request.path.endsWith(`/api/fs/${resource}`));
const emit = async (generation: string, state: RemoteHost['state'] = 'connecting', scope: string | undefined = scopeGeneration) => {
  await act(async () => {
    for (const listener of events.listeners) listener({ type: 'remote-host-status', envelope: {
      type: 'yuri:host-status', properties: { hubId, hostId, host: { ...host, state, generation, scopeGeneration: scope } },
    } });
  });
};

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  requests = []; registries = [];
  for (const spy of Object.values(registration)) spy.mockReset();
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  // No retries: request amplification must come from the real observer/entry boundary.
  client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  registry = makeRegistry();
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  for (const owner of registries) owner.dispose();
  container.remove();
  expect(events.listeners.size).toBe(0);
  expect(requests.filter(request => !request.settled)).toHaveLength(0);
  vi.restoreAllMocks();
});

test('cold home survives its own recorded connecting notification without a replacement request', async () => {
  await render();
  const first = matching('home')[0];
  expect(first).toBeDefined();
  expect(events.listeners.size).toBe(1);
  // Replay the complete bounded prefix in archive order, including when no request
  // is replaced. No polling, synthetic helper query, or unbounded server.
  for (const frame of captured) {
    await emit(frame.generation);
  }
  expect({ homeRequests: matching('home').length, canceledBootstrap: first.signal?.aborted },
    'self-established transport must not restart bootstrap').toEqual({ homeRequests: 1, canceledBootstrap: false });
  await act(async () => first.respond({ home: '/workspace' }));
  await flush();
  expect(container.querySelector('input')?.value).toBe('/workspace');
  expect(matching('list')).toHaveLength(1);
  await act(async () => matching('list')[0].respond({ entries: [] }));
  await flush();
  const add = [...container.querySelectorAll('button')].find(button => button.textContent === 'directoryExplorerDialog.actions.addProject');
  expect(add?.disabled).toBe(false);
  expect(registry.getHost(hostId)?.state).toBe('connecting');
});

test('directory listing does not restart home and list when its short request establishes transport', async () => {
  await render();
  await act(async () => matching('home')[0].respond({ home: '/workspace' }));
  await flush();
  await act(async () => matching('list')[0].respond({ entries: [{ name: 'Code', path: '/workspace/Code', isDirectory: true }] }));
  await flush();
  const child = [...container.querySelectorAll('button')].find(button => button.textContent === 'Code')!;
  await act(async () => child.click());
  const firstList = matching('list')[1];
  expect(firstList).toBeDefined();
  // Recorded status at the first real listing: 1794430333907.
  await emit('62482244-73f4-421c-ab2f-fa92f667e7ed');
  expect({ homeRequests: matching('home').length, listRequests: matching('list').length, canceledListing: firstList.signal?.aborted })
    .toEqual({ homeRequests: 1, listRequests: 2, canceledListing: false });
  await act(async () => firstList.respond({ entries: [{ name: 'Code', path: '/workspace/Code', isDirectory: true }] }));
  await flush();
  expect(container.textContent).toContain('Code');
});

test('stable owner resolves home and list without extra connection/control requests', async () => {
  await render();
  await act(async () => matching('home')[0].respond({ home: '/workspace' }));
  await flush();
  await act(async () => matching('list')[0].respond({ entries: [] }));
  await flush();
  expect(requests.map(request => request.path)).toEqual([
    `/api/hosts/${hostId}/api/fs/home`, `/api/hosts/${hostId}/api/fs/list`,
  ]);
  expect(container.querySelector('input')?.value).toBe('/workspace');
});

const ready = async () => {
  await render();
  await act(async () => matching('home')[0].respond({ home: '/workspace' }));
  await flush();
  await act(async () => matching('list')[0].respond({ entries: [] }));
  await flush();
};
const action = (key: string) => [...container.querySelectorAll('button')].find(button => button.textContent === `directoryExplorerDialog.actions.${key}`)!;
const writes = () => requests.filter(request => request.path.endsWith('/projects'));
const projectPayload = () => ({ project: { id: 'reference', remoteProjectId: 'remote', hostId, path: '/workspace', remoteState: 'ok' } });

test('registration deduplicates same-tick clicks and navigates once after authoritative success', async () => {
  await ready();
  const add = action('addProject');
  await act(async () => { add.click(); add.click(); });
  expect(writes()).toHaveLength(1);
  expect(registration.openRemoteSession).not.toHaveBeenCalled();
  await act(async () => writes()[0].respond(projectPayload()));
  await flush();
  expect(registration.upsertRemoteProject).toHaveBeenCalledTimes(1);
  expect(registration.openRemoteSession).toHaveBeenCalledWith(expect.objectContaining({ id: 'reference' }), { hubId, hostId, directory: '/workspace' }, null);
  expect(registration.close).toHaveBeenCalledExactlyOnceWith(false);
});

test('late registration after picker departure cannot select a project or navigate', async () => {
  await ready();
  await act(async () => action('addProject').click());
  await act(async () => root.render(null));
  await act(async () => writes()[0].respond(projectPayload()));
  await flush();
  expect(registration.upsertRemoteProject).not.toHaveBeenCalled();
  expect(registration.openRemoteSession).not.toHaveBeenCalled();
  expect(registration.close).not.toHaveBeenCalled();
});

test('authorization replacement during mkdir cannot begin project registration', async () => {
  await ready();
  await act(async () => action('createAndAdd').click());
  await emit('new-wire', 'connected', 'new-auth');
  await act(async () => matching('mkdir')[0].respond({ success: true }));
  await flush();
  expect(writes()).toHaveLength(0);
  expect(registration.openRemoteSession).not.toHaveBeenCalled();
  expect(matching('home')).toHaveLength(2);
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

test('failed registration after mkdir preserves the path and allows add-only retry', async () => {
  await ready();
  await act(async () => action('createAndAdd').click());
  await act(async () => matching('mkdir')[0].respond({ success: true }));
  await act(async () => writes()[0].respond({ error: 'Registration failed' }));
  await flush();
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
  expect(container.querySelector('input')?.value).toBe('/workspace');
  expect(registration.openRemoteSession).not.toHaveBeenCalled();
  await act(async () => action('addProject').click());
  expect(matching('mkdir')).toHaveLength(1);
  expect(writes()).toHaveLength(2);
  await act(async () => writes()[1].respond(projectPayload()));
  await flush();
  expect(registration.openRemoteSession).toHaveBeenCalledTimes(1);
});

test.each(['host', 'transport'] as const)('real %s owner replacement cancels pending bootstrap', async (replacement) => {
  await render();
  const previous = matching('home')[0];
  if (replacement === 'host') await render(registry, 'other-host');
  else await render(makeRegistry('new-transport'));
  expect(previous.signal?.aborted).toBe(true);
  expect(matching('home')).toHaveLength(2);
  expect(matching('home')[1].signal?.aborted).toBe(false);
});

test('genuine authorization scope replacement still fences the old entry response', async () => {
  // Set the initial authoritative Host before resolving this request owner.
  registry.ingest({ type: 'yuri:host-status', properties: { hubId, hostId,
    host: { ...host, state: 'connected', generation: captured[0].generation } } });
  const old = registry.resolve({ hubId, hostId, directory: '/' });
  const response = old.fetch('/api/fs/home');
  const rejected = expect(response).rejects.toThrow('Remote Host connection changed during request');
  registry.ingest({ type: 'yuri:host-status', properties: { hubId, hostId,
    host: { ...host, state: 'connected', generation: captured[0].generation, scopeGeneration: 'new-authorization-scope' } } });
  matching('home')[0].respond({ home: '/stale' });
  await rejected;
});

test('legacy missing-scope statuses conservatively cancel pending bootstrap', async () => {
  registry = makeRegistry('legacy', () => true, { ...host, scopeGeneration: undefined });
  await render();
  const previous = matching('home')[0];
  // Pass undefined explicitly through a DTO, not the scoped emit default.
  await act(async () => registry.ingest({ type: 'yuri:host-status', properties: { hubId, hostId,
    host: { ...host, scopeGeneration: undefined, state: 'connecting', generation: captured[0].generation } } }));
  expect(previous.signal?.aborted).toBe(true);
  expect(matching('home')).toHaveLength(2);
});

test.each(['home', 'list'] as const)('new scope cancels pending %s and refuses late old payload', async resource => {
  await render();
  if (resource === 'list') {
    await act(async () => matching('home')[0].respond({ home: '/workspace' }));
    await flush();
  }
  const previous = matching(resource)[0];
  const oldKey = client.getQueryCache().getAll().find(query => query.queryKey.includes(resource))!.queryKey;
  await emit('replacement-wire', 'connecting', 'new-authorization-scope');
  expect(previous.signal?.aborted).toBe(true);
  await act(async () => previous.respond(resource === 'home' ? { home: '/stale' } : { entries: [{ name: 'STALE', path: '/stale', isDirectory: true }] }));
  await flush();
  expect(client.getQueryData(oldKey)).toBeUndefined();
  expect(container.textContent).not.toContain('STALE');
  expect(container.querySelector('input')?.value).not.toBe('/stale');
  expect(matching('home')).toHaveLength(2);
});

test.each([
  ['home', 'scope'], ['list', 'scope'], ['home', 'hub'], ['list', 'hub'],
] as const)('%s JSON completion after %s revocation rejects the production queryFn', async (resource, revocation) => {
  let current = true;
  registry = makeRegistry('body-owner', () => current);
  await render();
  if (resource === 'list') {
    await act(async () => matching('home')[0].respond({ home: '/workspace' }));
    await flush();
  }
  const query = client.getQueryCache().getAll().find(candidate => candidate.queryKey.includes(resource))!;
  const queryFn = query.options.queryFn;
  if (typeof queryFn !== 'function') throw new Error('Missing production queryFn');
  let release!: (payload: unknown) => void;
  const body = new Promise<unknown>(resolve => { release = resolve; });
  const json = vi.spyOn(Response.prototype, 'json').mockImplementationOnce(() => body);
  // Execute the mounted production callback independently of observer cancellation:
  // otherwise Query cancellation alone can hide a stale successful queryFn return.
  const result = queryFn({ client, queryKey: query.queryKey, signal: new AbortController().signal, meta: undefined });
  const outcome = Promise.resolve(result).then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
  matching(resource).at(-1)!.respond({});
  await flush();
  expect(json).toHaveBeenCalledTimes(1);
  if (revocation === 'scope') await emit('replacement-wire', 'connecting', 'new-authorization-scope');
  else {
    current = false;
    await render(makeRegistry('replacement-hub-transport'));
  }
  release(resource === 'home' ? { home: '/stale' } : { entries: [{ name: 'STALE', path: '/stale', isDirectory: true }] });
  const settled = await outcome;
  expect(settled.error).toEqual(new Error(revocation === 'scope' ? 'Remote Host connection changed during request' : 'Inactive Hub registry'));
  expect(settled.value).toBeUndefined();
});
