import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { dict as en } from '@/lib/i18n/messages/en';
import { historyImportMessages } from '@/lib/i18n/messages/history-import';
import { HistoryImportStep } from './HistoryImportStep';

const fixture = vi.hoisted(() => ({ transport: 'host-one', generation: 1, client: null as QueryClient | null, fetch: vi.fn(), busy: vi.fn(), complete: vi.fn(), sources: 2 }));
vi.mock('@/lib/runtime-switch', () => ({ getRuntimeTransportIdentity: () => fixture.transport, getRuntimeGeneration: () => fixture.generation }));
vi.mock('@/lib/runtime-fetch', () => ({ runtimeFetch: (...args: unknown[]) => fixture.fetch(...args) }));
vi.mock('@/lib/queryRuntime', () => ({ queryClient: { setQueryData: (...args: Parameters<QueryClient['setQueryData']>) => fixture.client!.setQueryData(...args) } }));
vi.mock('@/queries/projectOrderQueries', () => ({ refreshProjectOrderSnapshot: async () => ({ projects: [] }) }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ locale: 'en', t: (key: keyof typeof en, params?: Record<string, string | number>) => {
  let text: string = en[key] ?? key;
  for (const [name, value] of Object.entries(params ?? {})) text = text.replaceAll(`{${name}}`, String(value));
  return text;
} }) }));

let root: Root; let container: HTMLDivElement;
const tick = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(20); }); };
const click = async (text: string) => {
  const button = [...container.querySelectorAll('button')].find((node) => node.getAttribute('aria-label') === text || node.textContent?.trim() === text);
  expect(button, text).toBeDefined(); await act(async () => button!.click()); await tick();
};
const selectSources = async () => {
  for (const name of ['Claude Code', 'Codex', 'Cursor', 'DeepSeek Harness']) await click(name);
};
function Harness() {
  const [action, setAction] = React.useState<{ disabled: boolean; background?: boolean }>({ disabled: true });
  return <><HistoryImportStep onBusy={fixture.busy} directory="/project" onPrimaryChange={setAction} onComplete={fixture.complete} />
    <button type="submit" form="yuri-tour-import" disabled={action.disabled}>{en[action.background ? 'historyImport.background' : 'historyImport.next']}</button></>;
}
const render = async () => { await act(async () => root.render(<QueryClientProvider client={fixture.client!}><Harness /></QueryClientProvider>)); await tick(); };
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); vi.useFakeTimers();
  fixture.generation = 1; fixture.transport = 'host-one'; fixture.sources = 2;
  fixture.client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  fixture.busy.mockReset(); fixture.complete.mockReset(); fixture.fetch.mockReset().mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/job')) return Response.json(null);
    if (url.endsWith('/imported')) return Response.json({ states: {} });
    if (url.endsWith('/scan')) {
      const input = JSON.parse(String(init?.body ?? '{}'));
      return Response.json({ id: input.limitPerSource ? 'scan' : 'full-scan', sampled: Boolean(input.limitPerSource), errors: [], counts: { claude: { value: Math.ceil(fixture.sources / 2), approximate: fixture.sources > 0 }, codex: { value: Math.floor(fixture.sources / 2), approximate: fixture.sources > 1 }, cursor: { value: 0, approximate: false }, dsh: { value: 0, approximate: false } }, installations: { claude: true, codex: false, cursor: null }, sessions: Array.from({ length: fixture.sources }, (_, index) => ({
      key: `source-${index}`, id: `${index}`, source: index % 2 ? 'codex' : 'claude', title: `Conversation ${index}`, excerpt: `Content preview ${index}`, directory: '/project', messages: index + 2, updated: 1793923200000, warnings: [],
      })).filter((session) => input.sources.includes(session.source)) });
    }
    if (url.endsWith('/preview')) return Response.json({ id: 'plan', merge: false, sessions: [], settings: [{ key: 'setting', source: 'claude', relative: 'CLAUDE.md', target: '.opencode/imported-rules/rule.md', content: 'Fixture rules', status: 'conflict', scoped: false }] });
    if (url.endsWith('/start')) return Response.json({ id: 'job', state: 'running', total: 0, completed: 0, results: [], progress: { phase: 'scanning', completed: 0, total: 0 } });
    return Response.json({});
  });
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); fixture.client!.clear(); container.remove(); vi.useRealTimers(); });

test('opening shows metadata counts beside both labels while history stays read-only and sampled', async () => {
  await render();
  for (const label of ['Claude Code', 'Codex', 'Cursor', 'DeepSeek Harness', 'OpenCode']) expect(container.textContent).toContain(label);
  expect(fixture.fetch.mock.calls.filter(([url]) => url.endsWith('/scan'))).toHaveLength(1);
  expect(container.querySelectorAll('[data-history-source] img')).toHaveLength(5);
  expect(container.querySelector('.yuri-import-subtitle')?.textContent).toBe(en['historyImport.deduplication']);
  expect([...container.querySelectorAll('[data-history-count="claude"]')].map((node) => node.textContent)).toEqual(['≈ 1', '≈ 1']);
  expect(container.querySelector('[data-history-source="cursor"] [data-history-count]')?.textContent).toBe('0');
  expect(container.querySelector('h2')?.textContent).toBe(en['historyImport.heading']);
  expect(container.querySelector('[data-history-source="claude"] [data-installed]')?.getAttribute('aria-label')).toBe(en['historyImport.installed']);
  expect(container.querySelector('[data-history-source="codex"] [data-installed]')?.getAttribute('aria-label')).toBe(en['historyImport.notDetected']);
  expect(container.querySelector('[data-history-source="cursor"] [data-installed]')?.getAttribute('aria-label')).toBe(en['historyImport.installationUnknown']);
  expect(container.querySelectorAll('[data-history-session]')).toHaveLength(2);
  expect(container.querySelector('[data-history-session]')?.tagName).toBe('LI');
  expect(container.querySelector('[data-history-session][aria-pressed], [data-history-session] button, .yuri-import-session-check')).toBeNull();
  expect(container.querySelector('[data-history-session] time')?.getAttribute('datetime')).toBe('2026-11-06T00:00:00.000Z');
  expect(container.querySelectorAll('[role="checkbox"]')).toHaveLength(2);
  expect(container.querySelectorAll('[data-history-source][aria-pressed="true"], [role="checkbox"][aria-checked="true"]')).toHaveLength(0);
  expect(container.textContent).not.toContain('/project');
  expect(container.textContent).not.toContain(en['historyImport.host']);
  expect(container.querySelector('.yuri-import-toolbar')).toBeNull();
  for (const key of ['options', 'losses', 'readOnly'] as const) expect(container.textContent).not.toContain(en[`historyImport.${key}`]);
  for (const key of ['settings', 'merge', 'scan', 'selectAll', 'selectNone'] as const) {
    expect(container.querySelector(`button[aria-label="${en[`historyImport.${key}`]}"]`)).toBeNull();
  }
  expect(fixture.fetch.mock.calls.some(([url]) => url.endsWith('/start') || url.endsWith('/preview'))).toBe(false);
  const scan = fixture.fetch.mock.calls.find(([url]) => url.endsWith('/scan'))!;
  expect(JSON.parse(scan[1].body).limitPerSource).toBe(5);
  expect(container.querySelector('[data-history-session] .yuri-import-session-excerpt')?.textContent).toBe('Content preview 0');
});

test('verified import badges arrive independently of preview and failed checks never claim not imported', async () => {
  const fetch = fixture.fetch.getMockImplementation()!;
  let resolve!: (response: Response) => void;
  fixture.fetch.mockImplementation((url, init) => url.endsWith('/imported') ? new Promise<Response>((done) => { resolve = done; }) : fetch(url, init));
  await render();
  expect(container.querySelectorAll('[data-history-session]')).toHaveLength(2);
  expect(container.querySelector('[data-history-imported]')).toBeNull();
  expect([...container.querySelectorAll('button')].find((button) => button.textContent === 'Next')?.disabled).toBe(false);
  await act(async () => resolve(Response.json({ states: { 'source-0': 'imported', 'source-1': 'unknown' } })));
  await tick();
  expect(container.querySelectorAll('[data-history-imported]')).toHaveLength(1);
  expect(container.querySelector('[data-history-imported]')?.textContent).toBe(en['historyImport.alreadyImported']);
  fixture.fetch.mockImplementation((url, init) => url.endsWith('/imported') ? Promise.resolve(Response.json({ code: 'offline' }, { status: 500 })) : fetch(url, init));
  await act(async () => { await fixture.client!.invalidateQueries({ queryKey: ['host-one', 'history-import', 'imported'] }); });
  await tick();
  expect(container.querySelector('[data-history-imported]')).toBeNull();
  expect(container.querySelectorAll('[data-history-session]')).toHaveLength(2);
});

test('OpenCode uses the same bounded preview, count and synchronized source selection', async () => {
  const fetch = fixture.fetch.getMockImplementation()!;
  fixture.fetch.mockImplementation(async (url, init) => {
    if (url.endsWith('/imported')) return Response.json({ states: { 'native-0': 'imported' } });
    const response = await fetch(url, init);
    if (!url.endsWith('/scan')) return response;
    const scan = await response.json();
    scan.counts.opencode = { value: 60, approximate: false };
    scan.sessions.push(...Array.from({ length: 6 }, (_, index) => ({ key: `native-${index}`, id: `native-${index}`, source: 'opencode', title: 'Native history', excerpt: 'Native answer', directory: '/project', messages: 0, warnings: [] })));
    return Response.json(scan);
  });
  await render(); await tick();
  const group = container.querySelector('section[aria-label="OpenCode"]')!;
  expect(group.querySelectorAll('[data-history-session]')).toHaveLength(5);
  expect([...container.querySelectorAll('[data-history-count="opencode"]')].map((node) => node.textContent)).toEqual(['60', '60']);
  expect(group.querySelector('[role="checkbox"]')?.getAttribute('aria-checked')).toBe('false');
  await click('OpenCode');
  expect(group.querySelector('[role="checkbox"]')?.getAttribute('aria-checked')).toBe('true');
  expect(group.querySelector('[data-history-imported]')).not.toBeNull();
  await click('Next');
  const start = fixture.fetch.mock.calls.find(([url]) => url.endsWith('/start'))!;
  expect(JSON.parse(start[1].body).sources).toEqual(['opencode']);
});

test('all five source groups render their verified already-imported badge, including Codex', async () => {
  const sources = ['claude', 'codex', 'cursor', 'dsh', 'opencode'];
  const fetch = fixture.fetch.getMockImplementation()!;
  fixture.fetch.mockImplementation(async (url, init) => {
    if (url.endsWith('/imported')) return Response.json({ states: Object.fromEntries(sources.map((source) => [source, 'imported'])) });
    const response = await fetch(url, init);
    if (!url.endsWith('/scan')) return response;
    const scan = await response.json();
    scan.sessions = sources.map((source) => ({ key: source, id: source, source, title: 'Imported history', directory: '/project', messages: 1, warnings: [] }));
    return Response.json(scan);
  });
  await render(); await tick();
  expect(container.querySelectorAll('[data-history-imported]')).toHaveLength(5);
  for (const source of sources) expect(container.querySelector(`[data-history-session="${source}"] [data-history-imported]`)?.textContent).toBe(en['historyImport.alreadyImported']);
});

test('Next starts Host-owned scanning immediately, shows progress, and can continue in background', async () => {
  await render(); await selectSources();
  const scroll = vi.spyOn(container.querySelector('h2')!, 'scrollIntoView');
  await click('Next');
  const start = fixture.fetch.mock.calls.find(([url]) => url.endsWith('/start'))!;
  expect(JSON.parse(start[1].body)).toEqual({ sources: ['claude', 'codex', 'cursor', 'dsh'], directory: '/project', confirm: true });
  expect(fixture.fetch.mock.calls.filter(([url]) => url.endsWith('/scan'))).toHaveLength(1);
  expect(fixture.fetch.mock.calls.some(([url]) => url.endsWith('/preview'))).toBe(false);
  expect(fixture.complete).not.toHaveBeenCalled();
  expect(container.querySelector('[role="status"]')?.textContent).toContain(en['historyImport.phase.scanning']);
  expect(container.querySelector('[role="status"]')?.previousElementSibling?.className).toBe('yuri-import-subtitle');
  expect(container.querySelector('[role="status"]')?.nextElementSibling?.className).toBe('yuri-import-source-grid');
  expect(scroll).toHaveBeenCalledExactlyOnceWith({ block: 'start' });
  expect(container.querySelector('progress')?.hasAttribute('value')).toBe(false);
  await click(en['historyImport.background']);
  expect(fixture.complete).toHaveBeenCalledOnce();
  expect(container.textContent).not.toContain('Fixture rules');
  expect(container.textContent).not.toContain(en['historyImport.preview']);
  expect(container.textContent).not.toContain('.opencode/imported-rules');
});

test('5000 source candidates show their count but render at most five read-only examples each without paging', async () => {
  fixture.sources = 5000; await render();
  expect(container.querySelectorAll('[data-history-source]')).toHaveLength(5);
  expect(container.querySelectorAll('[role="checkbox"]')).toHaveLength(2);
  expect(container.querySelectorAll('[data-history-session]')).toHaveLength(10);
  expect(container.querySelector('.yuri-import-pagination')).toBeNull();
  expect([...container.querySelectorAll('[data-history-count="claude"]')].map((node) => node.textContent)).toEqual(['≈ 2,500', '≈ 2,500']);
  expect(container.querySelectorAll('[data-history-session][aria-pressed]')).toHaveLength(0);
  for (let index = 0; index < 50; index++) await render();
  expect(fixture.fetch.mock.calls.filter(([url]) => url.endsWith('/scan'))).toHaveLength(1);
  await click('Codex');
  expect(container.querySelectorAll('[data-history-session]')).toHaveLength(10);
  expect(container.querySelector('section[aria-label="Codex"][data-source-selected="true"]')).not.toBeNull();
});

test('Next delegates all selected sources rather than restricting import to the five examples', async () => {
  fixture.sources = 24; await render(); await selectSources();
  expect(container.querySelectorAll('[data-history-session]')).toHaveLength(10);
  await click('Next');
  const start = fixture.fetch.mock.calls.find(([url]) => url.endsWith('/start'))!;
  expect(JSON.parse(start[1].body)).toEqual({ sources: ['claude', 'codex', 'cursor', 'dsh'], directory: '/project', confirm: true });
});

test('preview heading checkboxes and source cards share one source selection without refetching', async () => {
  await render();
  const checkbox = container.querySelector('section[aria-label="Claude Code"] [role="checkbox"]')!;
  expect(checkbox.getAttribute('aria-checked')).toBe('false');
  await act(async () => (checkbox as HTMLElement).click()); await tick();
  expect(container.querySelector('[data-history-source="claude"]')?.getAttribute('aria-pressed')).toBe('true');
  await click('Claude Code');
  expect(checkbox.getAttribute('aria-checked')).toBe('false');
  expect(fixture.fetch.mock.calls.filter(([url]) => url.endsWith('/scan'))).toHaveLength(1);
});

test('an unavailable metadata count is hidden in both labels, without a placeholder or a false zero', async () => {
  const fetch = fixture.fetch.getMockImplementation()!;
  fixture.fetch.mockImplementation(async (url, init) => {
    const response = await fetch(url, init);
    if (!url.endsWith('/scan')) return response;
    const result = await response.json(); result.counts.claude = { value: null, approximate: false };
    return Response.json(result);
  });
  await render();
  expect(container.querySelectorAll('[data-history-count="claude"]')).toHaveLength(0);
  expect(container.querySelector('[data-history-source="claude"]')?.textContent).not.toContain('—');
  expect(container.querySelector('[data-history-source="claude"]')?.getAttribute('aria-describedby')).not.toContain('history-import-count-claude');
  expect(container.querySelectorAll('[data-history-session]')).toHaveLength(2);
});

test.each([0, 2])('source read failures stay silent with %i readable previews and do not claim empty success', async (readable) => {
  fixture.sources = readable;
  const fetch = fixture.fetch.getMockImplementation()!;
  fixture.fetch.mockImplementation(async (url, init) => {
    const response = await fetch(url, init);
    if (!url.endsWith('/scan')) return response;
    const scan = await response.json();
    scan.errors = Array.from({ length: 9 }, () => ({ source: 'cursor', code: 'source_unreadable' }));
    return Response.json(scan);
  });
  await render();
  expect(container.querySelectorAll('[data-history-session]')).toHaveLength(readable);
  expect(container.querySelector('details, [role="alert"]')).toBeNull();
  expect(container.textContent).not.toContain('source_unreadable');
  expect(container.textContent).not.toContain(en['historyImport.empty']);
  await click('Claude Code'); await click('Next');
  expect(fixture.fetch.mock.calls.some(([url]) => url.endsWith('/start'))).toBe(true);
});

test('validation progress is authoritative and shown before any items are written', async () => {
  await render();
  const scroll = vi.spyOn(container.querySelector('h2')!, 'scrollIntoView');
  await act(async () => fixture.client!.setQueryData(['host-one', 'history-import', 'job'], { id: 'job', state: 'running', total: 0, completed: 0, results: [], progress: { phase: 'validating', completed: 7, total: 10 } }));
  await tick();
  expect(container.querySelector('[role="status"]')?.textContent).toContain(en['historyImport.phase.validating']);
  expect(container.querySelector('progress')?.value).toBe(7);
  expect(container.querySelector('progress')?.max).toBe(10);
  expect(container.querySelector('[role="status"]')?.nextElementSibling?.className).toBe('yuri-import-source-grid');
  expect(scroll).not.toHaveBeenCalled();
  expect(fixture.fetch.mock.calls.some(([url]) => url.endsWith('/preview') || url.endsWith('/start'))).toBe(false);
  expect(fixture.complete).not.toHaveBeenCalled();
});

test('partial import hides its progress and item errors while retaining the failure receipt', async () => {
  await render(); await selectSources(); await click('Next');
  await act(async () => fixture.client!.setQueryData(['host-one', 'history-import', 'job'], {
    id: 'job', state: 'partial', total: 3, completed: 3,
    progress: { phase: 'importing', completed: 3, total: 3 },
    results: [{ key: 'one', status: 'failed', code: 'unsafe_settings_path' }, { key: 'two', status: 'failed', code: 'unsafe_settings_path' }, { key: 'three', status: 'imported' }],
  }));
  await tick();
  expect(container.querySelector('.yuri-import-job, progress, [role="alert"]')).toBeNull();
  expect(container.textContent).not.toContain('unsafe_settings_path');
  expect(fixture.client!.getQueryData(['host-one', 'history-import', 'job'])).toMatchObject({ state: 'partial', results: expect.arrayContaining([expect.objectContaining({ code: 'unsafe_settings_path' })]) });
});

test('a late source response after changing runtime cannot populate the new view', async () => {
  let release!: (value: Response) => void;
  fixture.fetch.mockImplementation((url: string) => url.endsWith('/job') ? Promise.resolve(Response.json(null)) : new Promise((resolve) => { release = resolve; }));
  await render();
  fixture.generation++;
  await act(async () => release(Response.json({ id: 'old', errors: [], sessions: [{ key: 'old', title: 'Must not appear', directory: '/project', source: 'claude', messages: 1 }] })));
  await tick();
  expect(container.textContent).not.toContain('Must not appear');
  expect(fixture.fetch.mock.calls.some(([url]) => url.endsWith('/preview'))).toBe(false);
});

test('source filtering stays local until Next starts a job for just the selected tools', async () => {
  await render(); await selectSources(); await click('Codex'); await click('Next');
  const request = fixture.fetch.mock.calls.find(([url]) => url.endsWith('/start'))!;
  expect(JSON.parse(request[1].body).sources).toEqual(['claude', 'cursor', 'dsh']);
  const scans = fixture.fetch.mock.calls.filter(([url]) => url.endsWith('/scan'));
  expect(scans).toHaveLength(1);
});

test('deselecting every tool skips discovery and writes on Next', async () => {
  await render(); await selectSources();
  for (const name of ['Claude Code', 'Codex', 'Cursor', 'DeepSeek Harness']) await click(name);
  await click('Next');
  expect(fixture.complete).toHaveBeenCalledOnce();
  expect(fixture.fetch.mock.calls.some(([url]) => url.endsWith('/preview') || url.endsWith('/start'))).toBe(false);
  expect(fixture.fetch.mock.calls.filter(([url]) => url.endsWith('/scan'))).toHaveLength(1);
});

test('default empty source selection keeps previews visible and Next advances without starting an import', async () => {
  await render();
  expect(container.querySelectorAll('[data-history-session]')).toHaveLength(2);
  await click('Next');
  expect(fixture.complete).toHaveBeenCalledOnce();
  expect(fixture.fetch.mock.calls.some(([url]) => url.endsWith('/preview') || url.endsWith('/start'))).toBe(false);
  expect(fixture.fetch.mock.calls.filter(([url]) => url.endsWith('/scan'))).toHaveLength(1);
});

test('an empty sample does not claim there is no history; full discovery belongs to the background job', async () => {
  fixture.sources = 0; await render(); await click('Claude Code'); await click('Next');
  expect(fixture.complete).not.toHaveBeenCalled();
  expect(fixture.fetch.mock.calls.some(([url]) => url.endsWith('/start'))).toBe(true);
});

test('an interrupted validation retains retryable error feedback', async () => {
  await render(); await selectSources(); await click('Next');
  await act(async () => fixture.client!.setQueryData(['host-one', 'history-import', 'job'], { id: 'job', state: 'interrupted', total: 0, completed: 0, results: [], progress: { phase: 'validating', total: 0, completed: 0, code: 'source_changed' } }));
  await tick();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('source_changed');
  expect(fixture.complete).not.toHaveBeenCalled();
  expect(fixture.fetch.mock.calls.filter(([url]) => url.endsWith('/start'))).toHaveLength(1);
});

test.each(['completed', 'partial', 'cancelled', 'interrupted'])('previous %s jobs and their errors stay out of the import step', async (state) => {
  const fetch = fixture.fetch.getMockImplementation()!;
  fixture.fetch.mockImplementation((url, init) => url.endsWith('/job') ? Promise.resolve(Response.json({
    id: 'previous', state, total: 357, completed: 79,
    progress: { phase: 'importing', total: 357, completed: 79, code: 'invalid_parent_graph' },
    results: [{ key: 'old', status: 'failed', code: 'unsafe_settings_path' }],
  })) : fetch(url, init));
  await render();
  expect(container.querySelector('.yuri-import-job')).toBeNull();
  expect(container.textContent).not.toContain('invalid_parent_graph');
  expect(container.textContent).not.toContain('unsafe_settings_path');
  expect(container.querySelectorAll('[data-history-session]')).toHaveLength(2);
  await click('Next');
  expect(fixture.complete).toHaveBeenCalledOnce();
  expect(fixture.fetch.mock.calls.some(([url]) => url.endsWith('/start') || url.endsWith('/cancel'))).toBe(false);
});

test('a failed start keeps the selection available for retry without advancing', async () => {
  await render(); await selectSources();
  const fetch = fixture.fetch.getMockImplementation()!;
  fixture.fetch.mockImplementation((url, init) => url.endsWith('/start') ? Promise.resolve(Response.json({ code: 'import_busy' }, { status: 409 })) : fetch(url, init));
  await click('Next');
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('import_busy');
  expect(container.querySelectorAll('[data-history-session]')).toHaveLength(2);
  expect(container.querySelector('button[form="yuri-tour-import"]')?.hasAttribute('disabled')).toBe(false);
  expect(fixture.complete).not.toHaveBeenCalled();
});

test.each(['partial', 'completed'])('an accepted %s job advances without restarting the import', async (state) => {
  await render(); await selectSources(); await click('Next');
  expect(container.querySelector('.yuri-import-job')).not.toBeNull();
  await act(async () => fixture.client!.setQueryData(['host-one', 'history-import', 'job'], { id: 'job', state, total: 1, completed: 1, results: state === 'partial' ? [{ key: 'bad', status: 'failed' }] : [] }));
  await tick();
  expect(container.querySelector('.yuri-import-job, progress')).toBeNull();
  expect(container.textContent).not.toContain(en['historyImport.state.partial']);
  await click('Next');
  expect(fixture.complete).toHaveBeenCalledOnce();
  expect(fixture.fetch.mock.calls.filter(([url]) => url.endsWith('/start'))).toHaveLength(1);
});

test('leaving the import step never cancels accepted Host work', async () => {
  await render(); await selectSources(); await click('Next');
  expect(fixture.fetch.mock.calls.some(([url]) => url.endsWith('/start'))).toBe(true);
  await act(async () => root.render(<div>Voice</div>)); await tick();
  expect(fixture.fetch.mock.calls.some(([url]) => url.endsWith('/cancel'))).toBe(false);
});

test('a late start response after a runtime change cannot update the new cache or advance the tour', async () => {
  await render(); await selectSources();
  const fetch = fixture.fetch.getMockImplementation()!;
  let release!: (value: Response) => void;
  fixture.fetch.mockImplementation((url, init) => url.endsWith('/start') ? new Promise((resolve) => { release = resolve; }) : fetch(url, init));
  await click('Next');
  fixture.generation++;
  await act(async () => release(Response.json({ id: 'old-job', state: 'running' }))); await tick();
  expect(fixture.client!.getQueryData(['host-one', 'history-import', 'job'])).toBeNull();
  expect(fixture.complete).not.toHaveBeenCalled();
});

test('repeated submits while starting only produce one background job', async () => {
  await render(); await selectSources();
  const fetch = fixture.fetch.getMockImplementation()!;
  let release!: (value: Response) => void;
  fixture.fetch.mockImplementation((url, init) => url.endsWith('/start') ? new Promise((resolve) => { release = resolve; }) : fetch(url, init));
  await click('Next');
  await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  await act(async () => release(Response.json({ id: 'job', state: 'running', total: 0, completed: 0, results: [] }))); await tick();
  expect(fixture.fetch.mock.calls.filter(([url]) => url.endsWith('/preview'))).toHaveLength(0);
  expect(fixture.fetch.mock.calls.filter(([url]) => url.endsWith('/start'))).toHaveLength(1);
});

test('failed detection never presents a successful zero count or permits an import', async () => {
  const fetch = fixture.fetch.getMockImplementation()!;
  fixture.fetch.mockImplementation(async (url: string) => url.endsWith('/job') ? Response.json(null) : Response.json({ code: 'source_busy' }, { status: 409 }));
  await render();
  expect(container.querySelector('[data-history-count="claude"]')).toBeNull();
  expect(container.querySelector('button[form="yuri-tour-import"]')?.hasAttribute('disabled')).toBe(true);
  expect(fixture.fetch.mock.calls.some(([url]) => url.endsWith('/preview'))).toBe(false);
  fixture.fetch.mockImplementation(fetch);
  await click(en['settings.plugins.status.retry']);
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.querySelectorAll('[data-history-session]')).toHaveLength(2);
  expect(container.querySelector('button[form="yuri-tour-import"]')?.hasAttribute('disabled')).toBe(false);
});

test('every shipped locale has complete, non-placeholder import translations', () => {
  const expected = Object.keys(historyImportMessages.en).sort();
  for (const [locale, messages] of Object.entries(historyImportMessages)) {
    expect(Object.keys(messages).sort()).toEqual(expected);
    for (const [key, value] of Object.entries(messages)) {
      expect(value.trim()).not.toBe('');
      // These two French nouns have the same spelling as their English forms.
      if (locale !== 'en' && !(locale === 'fr' && ['historyImport.sessions', 'historyImport.sources', 'historyImport.sourceCount'].includes(key))) expect(value).not.toBe(historyImportMessages.en[key as keyof typeof historyImportMessages.en]);
    }
  }
});
