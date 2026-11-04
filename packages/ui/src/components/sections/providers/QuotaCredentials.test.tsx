import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ directory: '/workspace', generation: 0, fetch: vi.fn(), success: vi.fn() }));
vi.mock('@/lib/opencode/client', () => ({ opencodeClient: { getDirectory: () => state.directory } }));
vi.mock('@/lib/runtime-switch', () => ({ getRuntimeGeneration: () => state.generation, getRuntimeTransportIdentity: () => `runtime-${state.generation}` }));
vi.mock('@/lib/runtime-fetch', () => ({ runtimeFetch: state.fetch }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/device', () => ({ useDeviceInfo: () => ({ isMobile: false }) }));
vi.mock('@/components/ui', () => ({ toast: { success: state.success } }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
import { QuotaCredentials } from './QuotaCredentials';
import { quotaCredentialQueryOptions, type QuotaCredentialProvider } from './quotaCredentialQueries';

let root: Root;
let host: HTMLDivElement;
let cache: QueryClient;
const response = (data: unknown) => new Response(JSON.stringify(data));
async function mount(providerId: QuotaCredentialProvider = 'opencode-go') {
  await act(async () => root.render(<QueryClientProvider client={cache}><QuotaCredentials providerId={providerId} providerName={providerId} /></QueryClientProvider>));
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
}
async function click(key: string) {
  const button = [...document.querySelectorAll('button')].find((node) => node.textContent === key);
  expect(button, key).toBeTruthy();
  await act(async () => { button!.click(); await vi.advanceTimersByTimeAsync(0); });
}
async function fill(key: string, value: string) {
  const input = document.querySelector<HTMLInputElement>(`input[aria-label="${key}"]`)!;
  expect(input).toBeTruthy();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function editGo() {
  await mount(); await click('settings.providers.quota.manage');
  await fill('settings.providers.page.openCodeGo.workspaceId', 'wrk_test');
  await fill('settings.providers.page.openCodeGo.authCookie', 'fixture-cookie');
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers(); vi.resetAllMocks();
  state.directory = '/workspace'; state.generation = 0;
  state.fetch.mockImplementation(async () => response({ configured: false }));
  cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); cache.clear(); host.remove(); vi.useRealTimers(); });

describe('provider usage credentials', () => {
  it.each(['opencode-go', 'ollama-cloud', 'cursor'] as const)('keeps %s compact until explicitly opened, with no duplicate account sign-in', async (providerId) => {
    await mount(providerId);
    expect(host.textContent).toContain('settings.providers.quota.optional');
    expect(document.querySelector('input')).toBeNull();
    await click('settings.providers.quota.manage');
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.querySelectorAll('input')).toHaveLength(providerId === 'ollama-cloud' ? 1 : 2);
    expect(document.body.textContent).not.toContain('settings.providers.page.openCodeGo.consoleSignIn');
    expect(state.fetch).toHaveBeenCalledTimes(1);
  });
  it('discards secrets on cancel and saves only on explicit submit', async () => {
    await editGo(); await click('settings.common.actions.cancel');
    expect(state.fetch).toHaveBeenCalledTimes(1);
    await click('settings.providers.quota.manage');
    expect([...document.querySelectorAll('input')].every((input) => input.value === '')).toBe(true);
    await fill('settings.providers.page.openCodeGo.workspaceId', 'wrk_test');
    await fill('settings.providers.page.openCodeGo.authCookie', 'fixture-cookie');
    state.fetch.mockImplementation(async () => response({ configured: true, workspaceId: 'wrk_test', secretMasked: 'excluded' }));
    await click('settings.providers.page.openCodeGo.save');
    const [url, init] = state.fetch.mock.calls.at(-1)!;
    expect(url).toBe('/api/quota/credentials/opencode-go');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ workspaceId: 'wrk_test', authCookie: 'fixture-cookie' });
    expect(cache.getQueryData(quotaCredentialQueryOptions('opencode-go').queryKey)).toEqual({ configured: true, workspaceId: 'wrk_test' });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await click('settings.providers.quota.manage');
    expect(document.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe('');
  });
  it('preserves configured state and the editor after a failed write, permitting retry', async () => {
    state.fetch.mockImplementation(async () => response({ configured: true, workspaceId: 'wrk_old' }));
    await editGo();
    state.fetch.mockImplementation(async () => new Response('{}', { status: 400 }));
    await click('settings.providers.page.openCodeGo.save');
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('settings.providers.quota.failed');
    expect(cache.getQueryData(quotaCredentialQueryOptions('opencode-go').queryKey)).toEqual({ configured: true, workspaceId: 'wrk_old' });
    expect(state.success).not.toHaveBeenCalled();
    state.fetch.mockImplementation(async () => response({ configured: true, workspaceId: 'wrk_test' }));
    await click('settings.providers.page.openCodeGo.save');
    expect(state.success).toHaveBeenCalledTimes(1);
  });
  it('shows failed reads separately from optional credentials and supports retry', async () => {
    state.fetch.mockRejectedValue(new Error('offline'));
    await mount();
    expect(host.textContent).toContain('settings.providers.quota.loadFailed');
    expect(host.textContent).not.toContain('settings.providers.quota.optional');
    state.fetch.mockImplementation(async () => response({ configured: true }));
    await click('settings.providers.quota.retry');
    expect(host.textContent).toContain('settings.providers.quota.configured');
  });
  it('imports Cursor only on request, validates, and requires confirmation before deleting', async () => {
    await mount('cursor'); await click('settings.providers.quota.manage');
    state.fetch.mockImplementation(async () => response({ configured: true }));
    await click('settings.providers.quota.importCursor');
    expect(state.fetch).toHaveBeenLastCalledWith('/api/quota/credentials/cursor/import', expect.objectContaining({ method: 'POST' }));
    await click('settings.providers.quota.manage');
    state.fetch.mockImplementation(async () => response({ valid: true }));
    await click('settings.providers.page.openCodeGo.validate');
    expect(state.success).toHaveBeenLastCalledWith('settings.providers.quota.validated');
    const count = state.fetch.mock.calls.length;
    await click('settings.providers.page.openCodeGo.delete');
    expect(state.fetch).toHaveBeenCalledTimes(count);
    state.fetch.mockImplementation(async () => response({ configured: false }));
    await click('settings.common.actions.delete');
    expect(state.fetch).toHaveBeenLastCalledWith('/api/quota/credentials/cursor', expect.objectContaining({ method: 'DELETE' }));
    expect(cache.getQueryData(quotaCredentialQueryOptions('cursor').queryKey)).toEqual({ configured: false });
  });
  it.each(['directory', 'runtime', 'unmount'] as const)('discards late writes after %s changes', async (scope) => {
    await editGo();
    const key = quotaCredentialQueryOptions('opencode-go').queryKey;
    let resolve!: (value: Response) => void;
    state.fetch.mockImplementation(() => new Promise<Response>((done) => { resolve = done; }));
    await click('settings.providers.page.openCodeGo.save');
    if (scope === 'directory') state.directory = '/other';
    else if (scope === 'runtime') state.generation++;
    else await act(async () => root.render(null));
    await act(async () => resolve(response({ configured: true })));
    expect(state.success).not.toHaveBeenCalled();
    expect(cache.getQueryData(key)).toEqual({ configured: false });
    if (scope === 'unmount') expect(state.fetch.mock.calls.at(-1)![1].signal.aborted).toBe(true);
  });
});
