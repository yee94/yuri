import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ScheduledTaskRun } from '@/lib/scheduledTasksApi';

const state = vi.hoisted(() => ({
  fetch: vi.fn(), client: null as QueryClient | null, isMobile: false,
}));
vi.mock('@/lib/runtime-fetch', () => ({ runtimeFetch: state.fetch }));
vi.mock('@/lib/queryRuntime', () => ({
  get queryClient() { return state.client; },
  queryKeys: { runtime: () => ['test'] },
}));
vi.mock('@/lib/yuriEvents', () => ({ subscribeYuriEvents: () => () => {} }));
vi.mock('@/components/ui', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('./ScheduledTaskEditorDialog', () => ({ ScheduledTaskEditorDialog: () => null }));
vi.mock('@/mobile/mobileBackNavigation', () => ({ useMobileBackRoute: vi.fn() }));
vi.mock('@/sync/openSessionWithFeedback', () => ({ openSessionWithFeedback: vi.fn() }));
vi.mock('@/lib/router', () => ({ parseRoute: () => ({ scheduleView: 'history' }), updateBrowserURL: vi.fn() }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }), getCurrentIntlLocale: () => 'en' }));
vi.mock('@/stores/useProjectsStore', () => {
  const store = { projects: [], getActiveProject: () => null };
  return { useProjectsStore: (select: (value: typeof store) => unknown) => select(store) };
});
vi.mock('@/stores/useUIStore', () => {
  const store = { get isMobile() { return state.isMobile; }, setMainTabGuard: vi.fn() };
  return { useUIStore: Object.assign((select: (value: typeof store) => unknown) => select(store), { getState: () => store }) };
});
import { ScheduledTasksWorkspace } from './ScheduledTasksDialog';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class HistoryObserver implements IntersectionObserver {
  static instances: HistoryObserver[] = [];
  readonly root;
  readonly rootMargin;
  readonly thresholds = [0];
  targets = new Set<Element>();
  constructor(private callback: IntersectionObserverCallback, options: IntersectionObserverInit = {}) {
    this.root = options.root ?? null;
    this.rootMargin = options.rootMargin ?? '0px';
    HistoryObserver.instances.push(this);
  }
  observe(target: Element) { this.targets.add(target); }
  unobserve(target: Element) { this.targets.delete(target); }
  disconnect() { this.targets.clear(); }
  takeRecords() { return []; }
  emit(isIntersecting: boolean, targets = [...this.targets]) {
    this.callback(targets.map((target) => ({
      target, isIntersecting, intersectionRatio: isIntersecting ? 1 : 0, time: 0,
      boundingClientRect: target.getBoundingClientRect(),
      intersectionRect: target.getBoundingClientRect(), rootBounds: null,
    })), this);
  }
}

let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); }); };
const page = (offset: number, complete = false) => ({
  runs: Array.from({ length: 20 }, (_, index): ScheduledTaskRun => ({
    id: `run-${offset + index}`, projectId: 'project', taskId: 'task', taskName: `Run ${offset + index}`,
    trigger: 'scheduled', status: 'success', sessionId: null, directory: null, error: null,
    startedAt: 1_000_000 - (offset + index) * 1_000, finishedAt: null, durationMs: 1_000,
  })),
  nextCursor: complete ? null : `cursor-${offset + 20}`, complete,
});
const activeObserver = () => {
  const observer = [...HistoryObserver.instances].reverse().find((instance) => instance.targets.size > 0);
  expect(observer).toBeDefined();
  return observer!;
};
const requests = () => state.fetch.mock.calls.filter(([url]) => url.includes('/scheduled-task-runs'));
const render = async (presentation: 'workspace' | 'mobile-panel' | 'mobile-tab' = 'workspace', open = true) => {
  await act(async () => root.render(
    <QueryClientProvider client={state.client!}>
      <div role="tabpanel"><ScheduledTasksWorkspace presentation={presentation} open={open} /></div>
    </QueryClientProvider>,
  ));
  await flush();
};

beforeEach(() => {
  HistoryObserver.instances = [];
  vi.stubGlobal('IntersectionObserver', HistoryObserver);
  state.isMobile = false;
  state.client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  state.fetch.mockImplementation(async (url: string) => Response.json(url.includes('/scheduled-task-runs')
    ? page(0)
    : { tasks: [], failedProjectIds: [] }));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  expect(HistoryObserver.instances.every((observer) => observer.targets.size === 0)).toBe(true);
  host.remove();
  state.client?.clear();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

test.each(['workspace', 'mobile-panel', 'mobile-tab'] as const)('%s: preloads near the owning scroll boundary without a load-more row', async (presentation) => {
  state.isMobile = presentation !== 'workspace';
  let settle!: (value: Response) => void;
  state.fetch.mockImplementation(async (url: string) => {
    if (!url.includes('/scheduled-task-runs')) return Response.json({ tasks: [], failedProjectIds: [] });
    if (url.includes('before=')) return new Promise<Response>((resolve) => { settle = resolve; });
    return Response.json(page(0));
  });
  await render(presentation);
  expect(host.querySelectorAll('article')).toHaveLength(20);
  expect(host.textContent).not.toContain('sessions.scheduledTasks.history.loadMore');
  expect(requests()).toHaveLength(1);
  const observer = activeObserver();
  expect(observer.rootMargin).toBe('0px 0px 240px 0px');
  expect(observer.root).toBe(presentation === 'mobile-tab'
    ? host.querySelector('[role="tabpanel"]')
    : host.querySelector('.overflow-y-auto'));
  await act(async () => observer.emit(false));
  expect(requests()).toHaveLength(1);
  await act(async () => {
    for (let index = 0; index < 50; index++) observer.emit(true);
  });
  await flush();
  expect(requests()).toHaveLength(2);
  expect(requests()[1][0]).toContain('before=cursor-20');
  expect(host.querySelector('[role="status"]')?.getAttribute('aria-label')).toBe('sessions.scheduledTasks.history.loadingMore');
  expect(observer.targets.size).toBe(0);

  await act(async () => settle(Response.json(page(20))));
  await flush();
  expect(host.querySelectorAll('article')).toHaveLength(40);
  expect(host.querySelector('[role="status"]')).toBeNull();
  const nextObserver = activeObserver();
  await act(async () => nextObserver.emit(true));
  await flush();
  expect(requests()).toHaveLength(3);
  expect(requests()[2][0]).toContain('before=cursor-40');
  await act(async () => settle(Response.json(page(40, true))));
  await flush();
  expect(host.querySelectorAll('article')).toHaveLength(60);
  expect(HistoryObserver.instances.every((instance) => instance.targets.size === 0)).toBe(true);
});

test('pagination failure preserves rows, stops automatic requests, and allows retry', async () => {
  let fail = true;
  state.fetch.mockImplementation(async (url: string) => {
    if (!url.includes('/scheduled-task-runs')) return Response.json({ tasks: [], failedProjectIds: [] });
    if (!url.includes('before=')) return Response.json(page(0));
    if (fail) throw new Error('Offline');
    return Response.json(page(20, true));
  });
  await render();
  await act(async () => activeObserver().emit(true));
  await flush();
  expect(requests()).toHaveLength(2);
  expect(host.querySelectorAll('article')).toHaveLength(20);
  expect(host.textContent).toContain('sessions.scheduledTasks.history.error.more');
  expect(HistoryObserver.instances.every((observer) => observer.targets.size === 0)).toBe(true);
  fail = false;
  await act(async () => [...host.querySelectorAll('button')].find((button) => button.textContent === 'sessions.scheduledTasks.history.retry')!.click());
  await flush();
  expect(requests()).toHaveLength(3);
  expect(host.querySelectorAll('article')).toHaveLength(40);
  expect(host.textContent).not.toContain('sessions.scheduledTasks.history.error.more');
});

test('unrelated renders do not rebind observation and hidden history cannot fetch from a late callback', async () => {
  await render();
  const observer = activeObserver();
  const targets = [...observer.targets];
  const count = HistoryObserver.instances.length;
  for (let index = 0; index < 50; index++) await render();
  expect(HistoryObserver.instances).toHaveLength(count);
  expect(requests()).toHaveLength(1);
  await render('workspace', false);
  await act(async () => observer.emit(true, targets));
  expect(requests()).toHaveLength(1);
  expect(observer.targets.size).toBe(0);
  await render();
  expect(activeObserver()).not.toBe(observer);
});
