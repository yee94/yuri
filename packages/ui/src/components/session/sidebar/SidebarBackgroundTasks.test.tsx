import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { SidebarBackgroundTasks } from './SidebarBackgroundTasks';
import { useUpdateStore } from '@/stores/useUpdateStore';
import { historyImportMessages } from '@/lib/i18n/messages/history-import';

const fixture = vi.hoisted(() => ({ transport: 'host-one', generation: 1, local: true, fetch: vi.fn(), refresh: vi.fn(), move: vi.fn(), open: vi.fn(),
  listeners: new Set<() => void>(), renders: vi.fn() }));
vi.mock('@/lib/runtime-switch', () => ({
  getRuntimeGeneration: () => fixture.generation, getRuntimeTransportIdentity: () => fixture.transport, getRuntimeKey: () => fixture.transport,
  subscribeRuntimeEndpointChanged: (listener: () => void) => { fixture.listeners.add(listener); return () => fixture.listeners.delete(listener); },
}));
vi.mock('@/lib/runtime-fetch', () => ({ runtimeFetch: (...args: unknown[]) => fixture.fetch(...args) }));
vi.mock('@/lib/queryRuntime', () => ({ get queryClient() { return client; }, queryKeys: {} }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => { fixture.renders(); return { locale: 'en', t: (key: string, params: Record<string, string> = {}) => {
  const message = key === 'backgroundTasks.downloaded' || key === 'backgroundTasks.downloadedUnknownTotal' ? historyImportMessages.en[key] : key;
  return message.replace(/\{(\w+)\}/g, (_, name) => params[name] ?? `{${name}}`);
} }; } }));
vi.mock('@/lib/desktop', () => ({ isDesktopLocalOriginActive: () => fixture.local }));
vi.mock('@/stores/useUpdateStore', async () => {
  const { create } = await import('zustand');
  return { useUpdateStore: create(() => ({ downloading: false, downloadError: null, downloadVersion: null, progress: null, downloadUpdate: vi.fn(async () => {}) })) };
});
vi.mock('@/queries/projectOrderQueries', () => ({ refreshProjectOrderSnapshot: (...args: unknown[]) => fixture.refresh(...args) }));
vi.mock('@/stores/useSetupTourStore', () => ({ useSetupTourStore: { getState: () => ({ move: fixture.move, open: fixture.open }) } }));

let root: Root; let host: HTMLDivElement; let client: QueryClient;
const job = (overrides = {}) => ({ id: 'import-job', state: 'running', total: 20, completed: 5, created: 1, results: [], resumable: true, ...overrides });
const index = (overrides = {}) => ({ phase: 'indexing', total: 100, completed: 60, failed: 0, messages: 2000, ...overrides });
const jobKey = () => [fixture.transport, 'history-import', 'jobs'];
const indexKey = () => [fixture.transport, 'contentSearchStatus', fixture.generation];
const hostUpdate = (operation: object | null = null) => ({ serverId: 'server', host: 'electron', supported: true, operation });
const response = (url: string, importJob: object | null = job(), contentIndex = index(), operation: object | null = null) =>
  Response.json(url.endsWith('/jobs') ? (importJob ? [importJob] : []) : url.endsWith('/content-search') ? { index: contentIndex } : hostUpdate(operation));
const tick = async (time = 20) => { await act(async () => vi.advanceTimersByTimeAsync(time)); };
const render = async () => {
  await act(async () => root.render(<QueryClientProvider client={client}><SidebarBackgroundTasks /></QueryClientProvider>)); await tick();
};
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); vi.useFakeTimers();
  fixture.transport = 'host-one'; fixture.generation = 1; fixture.local = true; fixture.listeners.clear();
  fixture.refresh.mockReset().mockResolvedValue({ projects: [] }); fixture.move.mockReset(); fixture.open.mockReset(); fixture.renders.mockReset();
  useUpdateStore.setState({ downloading: false, downloadError: null, downloadVersion: null, progress: null });
  vi.mocked(useUpdateStore.getState().downloadUpdate).mockReset().mockResolvedValue(undefined);
  fixture.fetch.mockReset().mockImplementation(async (url: string) => response(url));
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); host.remove(); vi.useRealTimers(); });

test('multiple tasks show only adjacent rings in a right-aligned fit-width group; clicking opens details', async () => {
  await render();
  const rows = [...host.querySelectorAll('[role="progressbar"]')];
  expect(rows.map((row) => row.textContent)).toEqual(['', '']);
  expect(rows.map((row) => row.getAttribute('aria-valuenow'))).toEqual(['25', '60']);
  expect(host.querySelector('[data-sidebar-background-tasks]')?.className).toContain('text-muted-foreground/60');
  expect(host.querySelector('[data-sidebar-background-tasks]')?.className).toContain('w-fit');
  expect(host.querySelector('[data-sidebar-background-tasks]')?.className).toContain('ml-auto');
  expect(host.querySelector('[data-sidebar-background-tasks]')?.className).not.toContain('flex-1');
  expect(host.querySelector('[role="tooltip"], [title]')).toBeNull();
  await act(async () => host.querySelector('button')!.click());
  await tick();
  const dialog = document.querySelector('[role="dialog"]');
  expect(dialog?.textContent).toContain('backgroundTasks.title');
  expect(dialog?.textContent).toContain('historyImport.phase.importing');
  expect(dialog?.textContent).toContain('backgroundTasks.indexing');
  expect(dialog?.querySelector('[aria-label="backgroundTasks.processed"]')).not.toBeNull();
  expect(dialog?.textContent).not.toContain('%');
  expect(dialog?.className).toContain('yuri-mobile-overlay-surface yuri-popup-surface');
  expect(dialog?.className).toContain('rounded-2xl');
  expect(dialog?.getAttribute('data-align')).toBe('center');
  expect(dialog?.querySelector('[data-background-task-details]')?.className).toContain('max-h-64');
  expect(document.querySelector('[data-slot="dialog-overlay"]')).toBeNull();
  expect(fixture.move).not.toHaveBeenCalled();
});

test('task details dismiss with Escape and return focus to the compact trigger', async () => {
  await render(); const trigger = host.querySelector('button')!;
  await act(async () => { trigger.focus(); trigger.click(); }); await tick();
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  expect(document.activeElement).toBe(trigger);
  await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  await tick(200);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

test('a single task keeps just its ring and short label, with no visible percent', async () => {
  fixture.fetch.mockImplementation(async (url: string) => response(url, job(), index({ phase: 'ready' })));
  await render();
  expect(host.textContent).toBe('backgroundTasks.import');
  expect(host.querySelectorAll('[role="progressbar"]')).toHaveLength(1);
  expect(host.textContent).not.toContain('%');
});

test('import, index, client and Host details share one progress-bar design independent of task type', async () => {
  fixture.fetch.mockImplementation(async (url: string) => response(url, job(), index(),
    { id: 'host-download', status: 'downloading', version: '2.0.1', progress: 42 }));
  useUpdateStore.setState({ downloading: true, downloadVersion: '2.0.0', progress: { downloaded: 30_000_000, total: 100_000_000 } });
  await render(); await act(async () => host.querySelector('button')!.click()); await tick();
  const bars = [...document.querySelectorAll('[data-background-task] div[role="progressbar"]')];
  expect(bars).toHaveLength(4);
  expect(bars.map(bar => bar.getAttribute('aria-valuenow'))).toEqual(['25', '60', '30', '42']);
  expect(new Set(bars.map(bar => bar.className)).size).toBe(1);
  expect(new Set(bars.map(bar => bar.firstElementChild?.className)).size).toBe(1);
  expect(bars[0].className).toContain('h-1 overflow-hidden rounded-full bg-[var(--surface-subtle)]');
  expect(bars[0].firstElementChild?.className).toContain('bg-[var(--primary-base)]');
  expect(bars[0].firstElementChild?.className).toContain('motion-safe:duration-300');
  expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain('%');
});

test('all unknown task totals share indeterminate styling and failures share the same error token', async () => {
  fixture.fetch.mockImplementation(async (url: string) => response(url,
    job({ progress: { phase: 'scanning', total: 0, completed: 0 } }), index({ total: 0 }),
    { id: 'host-download', status: 'downloading', version: '2.0.1' }));
  useUpdateStore.setState({ downloading: true, progress: { downloaded: 1_000_000, total: 0 } });
  await render(); await act(async () => host.querySelector('button')!.click()); await tick();
  const bars = [...document.querySelectorAll('[data-background-task] div[role="progressbar"]')];
  expect(bars).toHaveLength(4);
  expect(bars.every(bar => !bar.hasAttribute('aria-valuenow'))).toBe(true);
  expect(new Set(bars.map(bar => bar.firstElementChild?.className)).size).toBe(1);
  expect(bars[0].firstElementChild?.className).toContain('motion-safe:animate-pulse');
  await act(async () => {
    client.setQueryData(jobKey(), [job({ state: 'interrupted', total: 0 })]);
    client.setQueryData(indexKey(), index({ phase: 'error', total: 0 }));
    client.setQueryData([fixture.transport, 'host-update', fixture.generation, 'current'], hostUpdate({ id: 'host-download', status: 'failed', version: '2.0.1' }));
    useUpdateStore.setState({ downloading: false, downloadError: 'interrupted' });
  }); await tick();
  expect(new Set(bars.map(bar => bar.firstElementChild?.className)).size).toBe(1);
  expect(bars[0].firstElementChild?.className).toContain('bg-[var(--status-error)]');
  expect(bars[0].firstElementChild?.className).not.toContain('animate-pulse');
});

test('a partially completed import is finished, not a persistent Continue task', async () => {
  fixture.fetch.mockImplementation(async (url: string) => response(url,
    job({ state: 'partial', total: 358, completed: 358, failures: 33 }), index({ phase: 'ready' })));
  await render();
  expect(host.querySelector('[data-sidebar-background-tasks]')).toBeNull();
  expect(fixture.fetch.mock.calls.some(([url]) => url.endsWith('/resume'))).toBe(false);
});

test('running import becoming partial disappears and refreshes projects once, retaining unrelated index work', async () => {
  await render(); await act(async () => host.querySelector('button')!.click()); await tick();
  await act(async () => client.setQueryData(jobKey(), [job({ state: 'partial', completed: 20, failures: 3 })]));
  await tick();
  expect(document.querySelector('[data-background-task="import-job"]')).toBeNull();
  expect(document.querySelector('[data-background-task="content-index"]')).not.toBeNull();
  expect(fixture.refresh).toHaveBeenCalledExactlyOnceWith('host-one');
});

test('interrupted import, partial index and failed update remain visible with red rings and Continue actions', async () => {
  fixture.fetch.mockImplementation(async (url: string) => response(url,
    job({ state: 'interrupted', total: 357, completed: 79, failures: 79 }), index({ phase: 'partial', failed: 9 }),
    { id: 'failed-download', status: 'failed', version: '2.0.0', progress: 42, error: 'download_failed' }));
  await render();
  expect(host.querySelectorAll('[role="progressbar"]')).toHaveLength(3);
  for (const ring of host.querySelectorAll('[role="progressbar"]')) expect(ring.className).toContain('text-[var(--status-error)]');
  expect(host.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('22');
  await act(async () => host.querySelector('button')!.click()); await tick();
  const details = document.querySelector('[data-background-task-details]')!;
  expect([...details.querySelectorAll('button')].filter((button) => button.textContent === 'backgroundTasks.resume')).toHaveLength(3);
  expect(details.textContent).toContain('historyImport.state.interrupted');
  const row = details.querySelector('[data-background-task="import-job"]')!;
  expect(row.className).toContain('grid-cols-[1rem_minmax(0,1fr)_auto]');
  expect(row.querySelector(':scope > button')?.textContent).toBe('backgroundTasks.resume');
  expect(row.querySelector('[data-background-task-meta]')?.textContent).toContain('79 / 357');
  expect(row.querySelectorAll('[data-background-task-meta] > span')).toHaveLength(2);
  expect(details.className).toContain('divide-y-[length:var(--yuri-popup-divider-width)]');
  expect(details.className).toContain('divide-[var(--yuri-popup-divider)]');
  expect(details.className).not.toContain('space-y-2');
});

test('older failed imports stay alongside newer jobs; Continue resumes the same job and prevents repeated submission', async () => {
  fixture.fetch.mockImplementation(async (url: string) => url.endsWith('/jobs')
    ? Response.json([job({ state: 'interrupted' }), job({ id: 'newer' })]) : response(url, null, index({ phase: 'ready' })));
  await render();
  expect(host.querySelectorAll('[role="progressbar"]')).toHaveLength(2);
  await act(async () => host.querySelector('button')!.click()); await tick();
  let resolve!: (response: Response) => void;
  fixture.fetch.mockImplementation(() => new Promise<Response>((done) => { resolve = done; }));
  const button = document.querySelector('[data-background-task="import-job"] button') as HTMLButtonElement;
  await act(async () => { button.click(); button.click(); }); await tick();
  expect(fixture.fetch.mock.calls.filter(([url]) => url.endsWith('/resume'))).toHaveLength(1);
  expect(button.disabled).toBe(true);
  expect(JSON.parse(fixture.fetch.mock.calls.at(-1)![1].body)).toEqual({ id: 'import-job', confirm: true });
  await act(async () => resolve(Response.json(job()))); await tick();
  expect(client.getQueryData<object[]>(jobKey())).toHaveLength(2);
  expect(document.querySelector('[data-background-task="import-job"] button')).toBeNull();
  expect(host.querySelector('[role="progressbar"]')?.className).not.toContain('text-[var(--status-error)]');
});

test('Continue never asks for sources; missing legacy intent stays visible as an explicit recovery failure', async () => {
  fixture.fetch.mockImplementation(async (url: string) => response(url, job({ state: 'interrupted', resumable: false }), index({ phase: 'ready' })));
  await render(); await act(async () => host.querySelector('button')!.click()); await tick();
  const button = document.querySelector('[data-background-task="import-job"] button') as HTMLButtonElement;
  fixture.fetch.mockResolvedValueOnce(Response.json({ code: 'resume_request_missing' }, { status: 400 }));
  await act(async () => button.click()); await tick();
  expect(document.querySelector('[role="checkbox"], input')).toBeNull();
  expect(JSON.parse(fixture.fetch.mock.calls.at(-1)![1].body)).toEqual({ id: 'import-job', confirm: true });
  expect(document.querySelector('[role="alert"]')?.textContent).toBe('backgroundTasks.originalSelectionMissing');
  expect(host.querySelector('[role="progressbar"]')?.className).toContain('text-[var(--status-error)]');
  expect(button.textContent).toBe('backgroundTasks.dismiss');
  expect(fixture.fetch.mock.calls.some(([url]) => url.endsWith('/dismiss'))).toBe(false);
  fixture.fetch.mockRejectedValueOnce(new Error('offline'));
  await act(async () => button.click()); await tick();
  expect(document.querySelector('[role="alert"]')?.textContent).toBe('backgroundTasks.dismissFailed');
  expect(button.textContent).toBe('backgroundTasks.dismiss');
  expect(host.querySelector('[role="progressbar"]')).not.toBeNull();
  fixture.fetch.mockResolvedValueOnce(Response.json({ id: 'import-job' }));
  await act(async () => button.click()); await tick();
  expect(fixture.fetch.mock.calls.at(-1)![0]).toBe('/api/yuri/history-import/dismiss');
  expect(host.querySelector('[data-sidebar-background-tasks]')).toBeNull();
  expect(client.getQueryData(jobKey())).toEqual([]);
});

test('index retry failure retains the red task and successful retry transitions to active progress', async () => {
  fixture.fetch.mockImplementation(async (url: string) => response(url, null, index({ phase: 'partial', failed: 9 })));
  await render(); await act(async () => host.querySelector('button')!.click()); await tick();
  fixture.fetch.mockRejectedValueOnce(new Error('offline'));
  const button = document.querySelector('[data-background-task="content-index"] button') as HTMLButtonElement;
  await act(async () => button.click()); await tick();
  expect(document.querySelector('[role="alert"]')?.textContent).toBe('backgroundTasks.resumeFailed');
  expect(host.querySelector('[role="progressbar"]')?.className).toContain('text-[var(--status-error)]');
  fixture.fetch.mockResolvedValueOnce(Response.json({ index: index({ phase: 'indexing' }) }));
  await act(async () => button.click()); await tick();
  expect(host.querySelector('[role="progressbar"]')?.className).not.toContain('text-[var(--status-error)]');
  expect(client.getQueryData(indexKey())).toMatchObject({ phase: 'indexing' });
});

test('only download failures create a client task and retry delegates to the updater without applying it', async () => {
  fixture.fetch.mockImplementation(async (url: string) => response(url, null, index({ phase: 'ready' })));
  useUpdateStore.setState({ error: 'check failed' });
  await render(); expect(host.childElementCount).toBe(0);
  await act(async () => useUpdateStore.setState({ downloadError: 'interrupted' })); await tick();
  expect(host.querySelector('[role="progressbar"]')?.className).toContain('text-[var(--status-error)]');
  await act(async () => host.querySelector('button')!.click()); await tick();
  vi.mocked(useUpdateStore.getState().downloadUpdate).mockImplementation(async () => { useUpdateStore.setState({ downloading: true, downloadError: null }); });
  await act(async () => (document.querySelector('[data-background-task="client-update"] button') as HTMLButtonElement).click()); await tick();
  expect(useUpdateStore.getState().downloadUpdate).toHaveBeenCalledOnce();
  expect(host.querySelector('[role="progressbar"]')?.className).not.toContain('text-[var(--status-error)]');
});

test('a successful remote retry clears only the remote task, keeping an independent same-version client download untouched', async () => {
  fixture.local = false;
  const operation = { id: 'remote-update', planId: 'remote-plan', version: '2.0.0', channel: 'beta', kind: 'cli-package',
    status: 'failed', progress: 42, error: 'update_interrupted' };
  fixture.fetch.mockImplementation(async (url: string) => response(url, null, index({ phase: 'ready' }), operation));
  useUpdateStore.setState({ downloading: true, downloadVersion: operation.version, progress: { downloaded: 40, total: 100 } });
  const clientUpdate = useUpdateStore.getState();
  await render();
  expect(host.querySelectorAll('[role="progressbar"]')).toHaveLength(2);
  await act(async () => host.querySelector('button')!.click()); await tick();
  fixture.fetch.mockResolvedValueOnce(Response.json({ ...hostUpdate(), currentVersion: operation.version, channel: 'beta', update: null,
    operation: { ...operation, status: 'succeeded', progress: 100, error: null } }));

  await act(async () => (document.querySelector('[data-background-task="remote-update"] button') as HTMLButtonElement).click()); await tick();

  expect(document.querySelector('[data-background-task="remote-update"]')).toBeNull();
  expect(document.querySelector('[role="alert"]')).toBeNull();
  expect(document.querySelector('[data-background-task="client-update"]')).not.toBeNull();
  expect(host.querySelectorAll('[role="progressbar"]')).toHaveLength(1);
  expect(useUpdateStore.getState()).toBe(clientUpdate);
  expect(useUpdateStore.getState().downloadUpdate).not.toHaveBeenCalled();
  expect(fixture.fetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
});

test('phase progress owns its denominator; unknown totals never display fabricated percentages', async () => {
  fixture.fetch.mockImplementation(async (url: string) => response(url,
    job({ progress: { phase: 'scanning', total: 0, completed: 0 } }), index({ total: 0, completed: 0 })));
  await render();
  expect(host.textContent).toBe('');
  expect(host.querySelector('[aria-valuenow]')).toBeNull();
  await act(async () => client.setQueryData(jobKey(), [job({ progress: { phase: 'validating', completed: 7, total: 10 } })]));
  await tick(); expect(host.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('70');
  await act(async () => client.setQueryData(jobKey(), [job({ completed: 20 })]));
  await tick(); expect(host.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('99');
});

test('completion refreshes the project catalog once and idle tasks disappear', async () => {
  await render();
  await act(async () => {
    client.setQueryData(jobKey(), []);
    client.setQueryData(indexKey(), index({ phase: 'ready' }));
  }); await tick();
  expect(host.childElementCount).toBe(0); expect(fixture.refresh).toHaveBeenCalledExactlyOnceWith('host-one');
  for (let count = 0; count < 50; count++) await render();
  expect(fixture.refresh).toHaveBeenCalledOnce();
});

test('failed refresh retains both last-known snapshots and retries rather than reporting empty success', async () => {
  await render(); fixture.fetch.mockRejectedValue(new Error('offline'));
  await act(async () => { await Promise.allSettled([client.refetchQueries({ queryKey: jobKey() }), client.refetchQueries({ queryKey: indexKey() })]); });
  await tick();
  expect(host.querySelectorAll('[role="progressbar"]')).toHaveLength(2);
  expect(host.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('25');
  await act(async () => host.querySelector('button')!.click()); await tick();
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('backgroundTasks.progressUnavailable');
  expect(fixture.refresh).not.toHaveBeenCalled();
  fixture.fetch.mockImplementation(async (url: string) => response(url, job({ completed: 10 }), index({ completed: 75 })));
  await tick(3100);
  expect([...host.querySelectorAll('[role="progressbar"]')].map((row) => row.getAttribute('aria-valuenow'))).toEqual(['50', '75']);
  expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain('backgroundTasks.progressUnavailable');
});

test('unsupported Hosts stop recurring requests for both capabilities', async () => {
  fixture.fetch.mockResolvedValue(Response.json({ code: 'history_import_unsupported' }, { status: 501 }));
  await render(); expect(host.childElementCount).toBe(0);
  expect(fixture.fetch).toHaveBeenCalledTimes(3);
  await tick(60_000); expect(fixture.fetch).toHaveBeenCalledTimes(3);
});

test('unrelated parent renders do no leaf work and runtime changes reset subscriptions and task identity', async () => {
  await render(); const renders = fixture.renders.mock.calls.length;
  for (let count = 0; count < 50; count++) await act(async () => root.render(<QueryClientProvider client={client}><SidebarBackgroundTasks /></QueryClientProvider>));
  expect(fixture.renders).toHaveBeenCalledTimes(renders); expect(fixture.listeners.size).toBe(1);
  fixture.fetch.mockImplementation(async (url: string) => response(url, null, index({ phase: 'ready' })));
  await act(async () => { fixture.transport = 'host-two'; fixture.generation++; fixture.listeners.forEach((listener) => listener()); });
  await tick(); expect(host.childElementCount).toBe(0);
  expect(fixture.refresh).not.toHaveBeenCalled();
  expect(client.getQueryData(['host-two', 'history-import', 'jobs'])).toEqual([]);
  await act(async () => client.setQueryData(['host-one', 'history-import', 'jobs'], []));
  await tick(); expect(fixture.refresh).not.toHaveBeenCalled();
});

test('client downloads join the group without another request; local Host mirror does not duplicate them', async () => {
  fixture.fetch.mockImplementation(async (url: string) => response(url, null, index({ phase: 'ready' }), { id: 'host-download', status: 'downloading', version: '2.0.0', progress: 40 }));
  useUpdateStore.setState({ downloading: true, downloadVersion: '2.0.0', progress: { downloaded: 40, total: 100 } });
  await render();
  expect(host.textContent).toBe('backgroundTasks.download');
  expect(host.querySelectorAll('[role="progressbar"]')).toHaveLength(1);
  expect(host.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('40');
  await act(async () => useUpdateStore.setState({ progress: { downloaded: 60, total: 100 } })); await tick();
  expect(host.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('60');
  await act(async () => host.querySelector('button')!.click()); await tick();
  expect(document.querySelector('[data-background-task="client-update"] [role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('60');
});

test('download details use a live progress bar and compact decimal MB, not bytes or visible percentages', async () => {
  fixture.fetch.mockImplementation(async (url: string) => response(url, null, index({ phase: 'ready' })));
  useUpdateStore.setState({ downloading: true, progress: { downloaded: 256_293_440, total: 270_552_805 } });
  await render(); await act(async () => host.querySelector('button')!.click()); await tick();
  const row = document.querySelector('[data-background-task="client-update"]')!;
  const bar = row.querySelector('div[role="progressbar"]')!;
  expect(row.textContent).toContain('Downloaded 256.3 / 270.6 MB');
  expect(row.textContent).not.toMatch(/bytes|256,293,440|%/);
  expect(Number(bar.getAttribute('aria-valuenow'))).toBeCloseTo(94.7, 1);
  expect((bar.firstElementChild as HTMLElement).style.width).toMatch(/^94\.7/);
  expect(host.querySelector('svg')).not.toBeNull();
  await act(async () => useUpdateStore.setState({ progress: { downloaded: 270_552_805, total: 270_552_805 } })); await tick();
  expect(row.textContent).toContain('Downloaded 270.6 / 270.6 MB');
  expect(bar.getAttribute('aria-valuenow')).toBe('100');
  expect((bar.firstElementChild as HTMLElement).style.width).toBe('100%');
  expect(host.textContent).not.toContain('%');
});

test('unknown download totals keep downloaded MB without fabricating totals or progress; failures stop animation', async () => {
  fixture.fetch.mockImplementation(async (url: string) => response(url, null, index({ phase: 'ready' })));
  useUpdateStore.setState({ downloading: true, progress: { downloaded: 12_500_000, total: 0 } });
  await render(); await act(async () => host.querySelector('button')!.click()); await tick();
  const row = document.querySelector('[data-background-task="client-update"]')!;
  const bar = row.querySelector('div[role="progressbar"]')!;
  expect(row.textContent).toContain('Downloaded 12.5 MB');
  expect(row.textContent).not.toMatch(/\/|%/);
  expect(bar.hasAttribute('aria-valuenow')).toBe(false);
  expect(bar.firstElementChild?.className).toContain('motion-safe:animate-pulse');
  await act(async () => useUpdateStore.setState({ downloading: false, downloadError: 'interrupted' })); await tick();
  expect(bar.firstElementChild?.className).not.toContain('animate-pulse');
  expect(bar.firstElementChild?.className).toContain('bg-[var(--status-error)]');
  expect(row.textContent).toContain('Downloaded 12.5 MB');
});

test('Host-owned background downloads are visible without a foreground store operation', async () => {
  fixture.fetch.mockImplementation(async (url: string) => response(url, job(), index(), { id: 'auto-download', status: 'downloading', version: '2.0.0', progress: 42 }));
  await render();
  expect(host.querySelectorAll('[role="progressbar"]')).toHaveLength(3);
  expect(host.textContent).toBe('');
  await act(async () => host.querySelector('button')!.click()); await tick();
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('2.0.0');
  const download = document.querySelector('[data-background-task="auto-download"]')!;
  expect(download.querySelector('div[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('42');
  expect(download.textContent).not.toMatch(/MB|%/);
  await act(async () => {
    client.setQueryData(jobKey(), []);
    client.setQueryData(indexKey(), index({ phase: 'ready' }));
    client.setQueryData([fixture.transport, 'host-update', fixture.generation, 'current'], hostUpdate({ id: 'auto-download', status: 'succeeded' }));
  }); await tick();
  expect(host.querySelector('[data-sidebar-background-tasks]')).toBeNull();
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('backgroundTasks.empty');
});
