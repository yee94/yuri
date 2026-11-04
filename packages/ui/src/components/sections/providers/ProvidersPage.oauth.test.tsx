import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  selected: 'openai', directory: '/workspace', generation: 0, listeners: new Set<() => void>(),
  providers: [{ id: 'openai', name: 'OpenAI', models: [] as Array<{ id: string }> }],
  list: vi.fn(), integrations: vi.fn(), connect: vi.fn(), status: vi.fn(), complete: vi.fn(), cancel: vi.fn(),
  key: vi.fn(), getIntegration: vi.fn(), removeCredential: vi.fn(),
  reload: vi.fn(), success: vi.fn(), error: vi.fn(), open: vi.fn(), select: vi.fn(),
  hiddenModels: [] as Array<{ providerID: string; modelID: string }>, toggleModel: vi.fn(), showAll: vi.fn(), hideAll: vi.fn(), metadata: vi.fn(),
  fetch: vi.fn(),
}));
vi.mock('@/lib/opencode/client', () => ({ opencodeClient: { getSdkClient: () => ({
  provider: { list: state.list }, credential: { remove: state.removeCredential }, integration: { list: state.integrations, get: state.getIntegration, connect: { key: state.key }, oauth: {
    connect: state.connect, status: state.status, complete: state.complete, cancel: state.cancel,
  } },
}), getDirectory: () => state.directory } }));
vi.mock('@/lib/runtime-switch', () => ({
  getRuntimeGeneration: () => state.generation, getRuntimeTransportIdentity: () => `runtime-${state.generation}`,
  subscribeRuntimeEndpointChanged: (fn: () => void) => { state.listeners.add(fn); return () => state.listeners.delete(fn); },
}));
vi.mock('@/stores/useConfigStore', () => ({ useConfigStore: (select: (s: unknown) => unknown) => select({
  providers: state.providers, selectedProviderId: state.selected,
  setSelectedProvider: state.select, getModelMetadata: state.metadata,
}) }));
vi.mock('@/stores/useUIStore', () => ({ useUIStore: (select: (s: unknown) => unknown) => select({ hiddenModels: state.hiddenModels, toggleHiddenModel: state.toggleModel, showAllModels: state.showAll, hideAllModels: state.hideAll }) }));
vi.mock('@/stores/useDirectoryStore', () => ({ useDirectoryStore: (select: (s: unknown) => unknown) => select({ currentDirectory: state.directory }) }));
vi.mock('@/stores/useProjectsStore', () => ({ useProjectsStore: (select: (s: unknown) => unknown) => select({ activeProjectId: 'project' }) }));
vi.mock('@/stores/useAgentsStore', () => ({ refreshOpenCodeConfiguration: state.reload }));
vi.mock('@/lib/runtime-fetch', () => ({ runtimeFetch: state.fetch }));
vi.mock('@/lib/device', () => ({ useDeviceInfo: () => ({ isMobile: false }) }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: translate }), getCurrentIntlLocale: () => 'en' }));
function translate(key: string) { return key; }
vi.mock('@/lib/url', () => ({ openExternalUrl: state.open }));
vi.mock('@/lib/clipboard', () => ({ copyTextToClipboard: vi.fn() }));
vi.mock('@/components/ui', () => ({ toast: { success: state.success, error: state.error, message: vi.fn() } }));
vi.mock('@/components/ui/ProviderLogo', () => ({ ProviderLogo: () => null }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('./QuotaCredentials', () => ({ QuotaCredentials: () => null }));
vi.mock('./CustomProviderForm', () => ({ CustomProviderForm: ({ onCancel }: { onCancel: () => void }) => (
  <div data-custom-provider-form><button onClick={onCancel}>settings.providers.page.connect.selectProviderTitle</button></div>
) }));
vi.mock('@/components/ui/ScrollableOverlay', () => ({ ScrollableOverlay: Box }));
vi.mock('@/components/sections/shared/SettingsGroup', () => ({
  SettingsGroup: ({ children, label, actions }: React.PropsWithChildren<{ label?: React.ReactNode; actions?: React.ReactNode }>) => <div>{label}{actions}{children}</div>,
  SettingsRow: ({ children, label }: React.PropsWithChildren<{ label?: React.ReactNode }>) => <div>{label}{children}</div>,
  SettingsToggleRow: ({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) => <label>{label}<input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /></label>,
}));
vi.mock('@/components/ui/dropdown-menu', () => ({ DropdownMenu: Box, DropdownMenuContent: Box, DropdownMenuTrigger: Box,
  DropdownMenuItem: ({ children, onSelect }: React.PropsWithChildren<{ onSelect: () => void }>) => <button onClick={onSelect}>{children}</button>,
}));
function Box({ children }: React.PropsWithChildren) { return <div>{children}</div>; }
import { ProvidersPage } from './ProvidersPage';
import { ProvidersSidebar } from './ProvidersSidebar';

let root: Root;
let host: HTMLDivElement;
let cache: QueryClient;
async function click(label: string) {
  const button = [...host.querySelectorAll('button')].find((el) => el.textContent === label || el.getAttribute('aria-label') === label);
  expect(button, label).toBeTruthy();
  await act(async () => button!.click());
}
async function deleteProvider() {
  await click('settings.common.actions.delete');
  const confirm = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((button) => button.textContent === 'settings.common.actions.delete')!;
  expect(confirm).toBeTruthy();
  await act(async () => confirm.click());
}
async function mount(withSidebar = false) {
  await act(async () => root.render(<QueryClientProvider client={cache}>{withSidebar && <ProvidersSidebar />}<ProvidersPage /></QueryClientProvider>));
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
}
async function start() {
  await mount();
  await click('settings.providers.page.actions.reconnect');
  await click('settings.providers.page.actions.connect');
}
async function fill(selector: string, value: string) {
  if (selector === 'input[type="password"]' && !host.querySelector(selector)) await click('settings.providers.page.auth.apiKeyLabel');
  const input = host.querySelector<HTMLInputElement>(selector)!;
  expect(input).toBeTruthy();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function saveKey() {
  await mount(); await click('settings.providers.page.actions.reconnect');
  await fill('input[type="password"]', 'fixture-key');
  await click('settings.providers.page.actions.saveKey');
}
async function changeScope(scope: 'directory' | 'runtime' | 'unmount') {
  if (scope === 'unmount') { await act(async () => root.render(null)); return; }
  if (scope === 'directory') state.directory = '/second-workspace';
  else state.generation++;
  await mount();
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
   vi.useFakeTimers(); vi.resetAllMocks();
  state.selected = 'openai'; state.generation = 0; state.directory = '/workspace';
  state.providers = [{ id: 'openai', name: 'OpenAI', models: [] }];
  state.hiddenModels = []; state.metadata.mockReturnValue(undefined);
  state.fetch.mockImplementation(async (_url: string, options?: RequestInit) => {
    if (options?.method === 'DELETE') state.list.mockResolvedValue({ data: [] });
    return new Response(options?.method === 'DELETE' ? '{"success":true,"removed":true}' : '{}');
  });
  state.toggleModel.mockImplementation((providerID: string, modelID: string) => {
    const exists = state.hiddenModels.some((entry) => entry.providerID === providerID && entry.modelID === modelID);
    state.hiddenModels = exists ? state.hiddenModels.filter((entry) => entry.providerID !== providerID || entry.modelID !== modelID) : [...state.hiddenModels, { providerID, modelID }];
  });
  state.showAll.mockImplementation((providerID: string) => { state.hiddenModels = state.hiddenModels.filter((entry) => entry.providerID !== providerID); });
  state.key.mockResolvedValue(undefined); state.removeCredential.mockResolvedValue(undefined);
  state.getIntegration.mockResolvedValue({ data: { connections: [{ type: 'credential', id: 'credential-1' }] } });
  state.list.mockResolvedValue({ data: [{ id: 'openai', integrationID: 'openai' }] });
  state.integrations.mockResolvedValue({ data: [
    { id: 'openai', name: 'OpenAI', connections: [{ type: 'credential', id: 'c1' }], methods: [{ id: 'browser', type: 'oauth', label: 'Browser OAuth' }, { type: 'key' }] },
    { id: 'anthropic', name: 'Anthropic', connections: [], methods: [] },
    { id: 'mcp_remote', name: 'MCP remote', connections: [], methods: [] },
  ] });
  state.connect.mockResolvedValue({ data: { attemptID: 'attempt-1', mode: 'auto', url: 'https://example.com/authorize', instructions: 'Authorize in browser' } });
  state.status.mockResolvedValue({ data: { status: 'pending' } });
  state.cancel.mockResolvedValue(undefined); state.complete.mockResolvedValue(undefined);
  state.reload.mockResolvedValue(undefined);
  cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});

describe('provider credential mutation scope regressions', () => {
  it('keeps the existing-provider visibility toggle inside the key field and disables both while saving', async () => {
    await mount(); await click('settings.providers.page.actions.reconnect');
    await fill('input[type="password"]', 'fixture-key');
    const input = host.querySelector<HTMLInputElement>('input[type="password"]')!;
    const toggle = input.closest('[data-slot="input-wrapper"]')!.querySelector<HTMLButtonElement>('button')!;
    expect(toggle.type).toBe('button');
    for (const visible of [true, false]) {
      await act(async () => toggle.click());
      expect(input.type).toBe(visible ? 'text' : 'password');
      expect(input.value).toBe('fixture-key');
      expect(toggle.getAttribute('aria-pressed')).toBe(String(visible));
      expect(state.key).not.toHaveBeenCalled();
    }
    let finish!: () => void;
    state.key.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    await click('settings.providers.page.actions.saveKey');
    expect(input.disabled).toBe(true);
    expect(toggle.disabled).toBe(true);
    await act(async () => finish());
  });

  it('deletes keyless custom configuration even when there is no integration', async () => {
    state.selected = 'custom'; state.providers = [{ id: 'custom', name: 'Custom', models: [] }];
    state.list.mockResolvedValue({ data: [{ id: 'custom' }] }); state.integrations.mockResolvedValue({ data: [] });
    state.fetch.mockImplementation(async (_url: string, options?: RequestInit) => {
      if (options?.method === 'DELETE') { state.list.mockResolvedValue({ data: [] }); return new Response('{"removed":true}'); }
      return new Response(JSON.stringify({ custom: { origin: 'config', files: [{ path: '/config/opencode.jsonc', scope: 'user' }], auth: { exists: false }, user: { exists: true }, project: { exists: false }, custom: { exists: false } } }));
    });
    await mount(); await deleteProvider();
    expect(state.getIntegration).not.toHaveBeenCalled(); expect(state.removeCredential).not.toHaveBeenCalled();
    expect(state.fetch).toHaveBeenCalledWith('/api/provider/custom/auth', expect.objectContaining({ method: 'DELETE' }));
    expect(state.success).toHaveBeenCalledWith('settings.providers.delete.success');
  });
  it('disables deletion of a runtime-only provider and explains source management and hiding models', async () => {
    state.selected = 'injected'; state.providers = [{ id: 'injected', name: 'Injected', models: [] }];
    state.list.mockResolvedValue({ data: [{ id: 'injected' }] }); state.integrations.mockResolvedValue({ data: [] });
    state.fetch.mockImplementation(async (_url: string, options?: RequestInit) => new Response(options?.method === 'DELETE' ? '{"removed":false}' : '{}'));
    await mount(); await click('settings.common.actions.delete');
    const button = host.querySelector<HTMLButtonElement>('button[aria-label="settings.common.actions.delete"]')!;
    expect(button.disabled).toBe(true);
    expect(host.textContent).not.toContain('settings.providers.delete.runtimeHint');
    expect(button.parentElement!.classList.contains('cursor-not-allowed')).toBe(true);
    await act(async () => {
      button.parentElement!.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }));
      button.parentElement!.dispatchEvent(new MouseEvent('mouseenter'));
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(document.querySelector('[data-slot="tooltip-content"][data-open]')?.textContent).toContain('settings.providers.delete.runtimeHint');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(state.fetch.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
    expect(state.success).not.toHaveBeenCalled(); expect(state.select).not.toHaveBeenCalled();
    expect(state.removeCredential).not.toHaveBeenCalled();
  });
  it('disables deletion when environment authentication remains, even with removable credentials', async () => {
    state.integrations.mockResolvedValue({ data: [{ id: 'openai', methods: [{ type: 'key' }], connections: [
      { type: 'env' }, { type: 'credential', id: 'saved-key', method: 'key' },
    ] }] });
    await mount(); await click('settings.common.actions.delete');
    expect(host.querySelector<HTMLButtonElement>('button[aria-label="settings.common.actions.delete"]')!.disabled).toBe(true);
    expect(host.textContent).not.toContain('settings.providers.delete.environmentHint');
    const trigger = host.querySelector<HTMLButtonElement>('button[aria-label="settings.common.actions.delete"]')!.parentElement!;
    await act(async () => {
      trigger.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }));
      trigger.dispatchEvent(new MouseEvent('mouseenter'));
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(document.querySelector('[data-slot="tooltip-content"][data-open]')?.textContent).toContain('settings.providers.delete.environmentHint');
    expect(state.removeCredential).not.toHaveBeenCalled();
    expect(state.fetch.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
    expect([...host.querySelectorAll('button')].some((button) => button.textContent === 'settings.providers.models.removeAll')).toBe(true);
  });
  it('rechecks environment connections before deleting any configuration or credentials', async () => {
    state.getIntegration.mockResolvedValue({ data: { connections: [{ type: 'env' }, { type: 'credential', id: 'saved-key' }] } });
    await mount(); await deleteProvider();
    expect(state.error).toHaveBeenCalledWith('settings.providers.delete.unavailable');
    expect(state.removeCredential).not.toHaveBeenCalled();
    expect(state.fetch.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
  });
  it('keeps deletion disabled when provenance cannot be read', async () => {
    state.fetch.mockRejectedValue(new Error('offline'));
    await mount(); await click('settings.common.actions.delete');
    expect(host.querySelector<HTMLButtonElement>('button[aria-label="settings.common.actions.delete"]')!.disabled).toBe(true);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(state.getIntegration).not.toHaveBeenCalled();
  });
  it('keeps credentials when configuration removal fails and permits retry', async () => {
    await mount();
    state.fetch.mockImplementation(async (_url: string, options?: RequestInit) => options?.method === 'DELETE' ? new Response('{}', { status: 500 }) : new Response('{}'));
    await deleteProvider();
    expect(state.removeCredential).not.toHaveBeenCalled(); expect(state.success).not.toHaveBeenCalled();
    expect(state.error).toHaveBeenCalledWith('settings.providers.delete.failed');
    state.fetch.mockImplementation(async (_url: string, options?: RequestInit) => {
      if (options?.method === 'DELETE') state.list.mockResolvedValue({ data: [] });
      return new Response(options?.method === 'DELETE' ? '{"removed":true}' : '{}');
    });
    const confirm = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((button) => button.textContent === 'settings.common.actions.delete')!;
    await act(async () => confirm.click());
    expect(state.removeCredential).toHaveBeenCalledTimes(1); expect(state.success).toHaveBeenCalled();
  });
  it('shares one source request across sidebar and detail and retains provenance after failed refresh', async () => {
    state.fetch.mockResolvedValue(new Response(JSON.stringify({ openai: { origin: 'runtime', files: [], auth: { exists: false }, project: { exists: false }, user: { exists: false }, custom: { exists: false } } })));
    await mount(true);
    expect(state.fetch).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('settings.providers.source.runtime');
    expect(host.textContent).not.toContain('settings.providers.page.connectionDetails.noActiveSource');
    state.fetch.mockRejectedValue(new Error('offline'));
    await act(async () => { await cache.invalidateQueries({ queryKey: ['runtime-0', 0, 'provider-sources', '/workspace'] }); await vi.advanceTimersByTimeAsync(0); });
    expect(host.textContent).toContain('settings.providers.source.runtime');
    expect(host.textContent).toContain('settings.providers.page.toast.providerSourcesLoadFailed');
  });
  it('does not claim success when an injected provider remains after removing its configuration override', async () => {
    state.fetch.mockImplementation(async (_url: string, options?: RequestInit) => new Response(options?.method === 'DELETE' ? '{"removed":true}' : '{}'));
    await mount(); await deleteProvider();
    expect(state.success).not.toHaveBeenCalled(); expect(state.select).not.toHaveBeenCalled();
    expect(state.error).toHaveBeenCalledWith('settings.providers.delete.failed');
  });
  it('removes the complete 2,000-model catalog while search displays only one model', async () => {
    state.providers[0].models = Array.from({ length: 2000 }, (_, index) => ({ id: `model-${index}` }));
    await mount(); await fill('input[aria-label="settings.providers.page.models.filterPlaceholder"]', 'model-1999');
    await click('settings.providers.models.removeAll');
    expect(state.hideAll).toHaveBeenCalledExactlyOnceWith('openai', state.providers[0].models.map((model) => model.id));
  });
  it('shows image modality and reasoning, but does not mistake PDF attachment support for image input', async () => {
    state.providers[0].models = [{ id: 'vision' }, { id: 'pdf' }];
    state.metadata.mockImplementation((_provider: string, model: string) => model === 'vision'
      ? { modalities: { input: ['image'] }, reasoning: true } : { attachment: true, modalities: { input: ['pdf'] }, reasoning: false });
    await mount();
    const vision = host.querySelector('[data-provider-model="vision"]')!;
    const pdf = host.querySelector('[data-provider-model="pdf"]')!;
    expect(vision.querySelector('[aria-label="settings.providers.page.models.capability.imageInput"]')).not.toBeNull();
    expect(vision.querySelector('[aria-label="settings.providers.page.models.capability.reasoning"]')).not.toBeNull();
    expect(pdf.querySelector('[role="img"]')).toBeNull();
  });
  it('passes directory to key connect, refreshes only the current catalog, and selects the actual provider ID', async () => {
    state.directory = '/key-project'; state.selected = '__add_provider__';
    state.list.mockResolvedValue({ data: [] });
    state.integrations.mockResolvedValue({ data: [{ id: 'openai-int', name: 'OpenAI integration', connections: [], methods: [{ type: 'key' }] }] });
    const unrelated = ['runtime-0', 0, 'provider-connections', '/other-project'];
    cache.setQueryData(unrelated, { providers: [], integrations: [] });
    await mount(); await click('OpenAI integration');
    await fill('input[type="password"]', 'fixture-key');
    state.list.mockResolvedValue({ data: [{ id: 'openai-activated', integrationID: 'openai-int' }] });
    state.integrations.mockResolvedValue({ data: [{ id: 'openai-int', name: 'OpenAI integration', connections: [{ type: 'credential', id: 'new' }], methods: [] }] });
    await click('settings.providers.page.actions.saveKey');
    expect(state.key).toHaveBeenCalledWith(expect.objectContaining({ integrationID: 'openai-int', location: { directory: '/key-project' } }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(state.select).toHaveBeenCalledWith('openai-activated');
    expect(state.integrations).toHaveBeenCalledTimes(2);
    expect(cache.getQueryData(['runtime-0', 0, 'provider-connections', '/key-project'])).toEqual(expect.objectContaining({ providers: [{ id: 'openai-activated', integrationID: 'openai-int' }] }));
    expect(cache.getQueryState(unrelated)?.isInvalidated).toBe(false);
    expect(state.reload).toHaveBeenCalledWith(expect.objectContaining({ queryDirectory: '/key-project', transportIdentity: 'runtime-0' }));
  });
  it('gets credential IDs in the captured directory and removes them through the global credential API, then refreshes the connection cache', async () => {
    state.directory = '/disconnect-project'; await mount();
    state.getIntegration.mockResolvedValue({ data: { connections: [{ type: 'credential', id: 'one' }, { type: 'credential', id: 'two' }] } });
    state.integrations.mockResolvedValue({ data: [{ id: 'openai', name: 'OpenAI', connections: [], methods: [] }] });
    await deleteProvider();
    expect(state.getIntegration).toHaveBeenCalledWith(expect.objectContaining({ location: { directory: '/disconnect-project' } }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(state.removeCredential).toHaveBeenCalledTimes(2);
    expect(state.removeCredential.mock.calls.map(([input]) => input)).toEqual([{ credentialID: 'one' }, { credentialID: 'two' }]);
    for (const [, options] of state.removeCredential.mock.calls) expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(state.integrations).toHaveBeenCalledTimes(2);
    expect(cache.getQueryData(['runtime-0', 0, 'provider-connections', '/disconnect-project'])).toEqual(expect.objectContaining({ integrations: [{ id: 'openai', name: 'OpenAI', connections: [], methods: [] }] }));
    expect(state.success).toHaveBeenCalledWith('settings.providers.delete.success');
    expect(state.fetch).toHaveBeenCalledWith('/api/provider/openai/auth', expect.objectContaining({ method: 'DELETE', query: { scope: 'config', directory: '/disconnect-project' } }));
  });
  it.each(['directory', 'runtime', 'unmount'] as const)('discards a late key success after %s changes', async (scope) => {
    let resolve!: () => void;
    state.key.mockImplementation(() => new Promise<void>((done) => { resolve = done; }));
    await saveKey(); await changeScope(scope);
    const catalogReads = state.integrations.mock.calls.length;
    await act(async () => resolve());
    expect(state.reload).not.toHaveBeenCalled(); expect(state.success).not.toHaveBeenCalled(); expect(state.select).not.toHaveBeenCalled();
    expect(state.integrations).toHaveBeenCalledTimes(catalogReads);
    expect(state.key.mock.calls[0][1].signal.aborted).toBe(true);
  });
  it.each(['directory', 'runtime', 'unmount'] as const)('discards a late credential removal after %s changes', async (scope) => {
    let resolve!: () => void;
    state.removeCredential.mockImplementation(() => new Promise<void>((done) => { resolve = done; }));
    await mount(); await deleteProvider(); await changeScope(scope);
    const catalogReads = state.integrations.mock.calls.length;
    await act(async () => resolve());
    expect(state.reload).not.toHaveBeenCalled(); expect(state.success).not.toHaveBeenCalled();
    expect(state.integrations).toHaveBeenCalledTimes(catalogReads);
    expect(state.removeCredential.mock.calls[0][1].signal.aborted).toBe(true);
  });
  it('stops disconnect before credential removal when integration.get finishes in another runtime', async () => {
    let resolve!: (data: unknown) => void;
    state.getIntegration.mockImplementation(() => new Promise((done) => { resolve = done; }));
    await mount(); await deleteProvider(); await changeScope('runtime');
    await act(async () => resolve({ data: { connections: [{ type: 'credential', id: 'old' }] } }));
    expect(state.removeCredential).not.toHaveBeenCalled(); expect(state.reload).not.toHaveBeenCalled();
  });
  it.each(['key', 'disconnect'] as const)('stops the %s completion chain when scope changes during configuration reload', async (kind) => {
    let resolve!: () => void;
    state.reload.mockImplementation(() => new Promise<void>((done) => { resolve = done; }));
    if (kind === 'key') await saveKey();
    else { await mount(); await deleteProvider(); }
    await changeScope('directory');
    const catalogReads = state.integrations.mock.calls.length;
    await act(async () => resolve());
    expect(state.success).not.toHaveBeenCalled(); expect(state.select).not.toHaveBeenCalled();
    expect(state.integrations).toHaveBeenCalledTimes(catalogReads);
  });
  it.each(['key', 'disconnect'] as const)('discards %s success after switching runtime during connection Query refresh', async (kind) => {
    await mount();
    let resolve!: (data: unknown) => void;
    state.integrations.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    if (kind === 'key') {
      await click('settings.providers.page.actions.reconnect');
      await fill('input[type="password"]', 'fixture-key');
      await click('settings.providers.page.actions.saveKey');
    } else await deleteProvider();
    expect(state.reload).toHaveBeenCalledTimes(1);
    await changeScope('runtime');
    await act(async () => resolve({ data: [] }));
    expect(state.success).not.toHaveBeenCalled(); expect(state.select).not.toHaveBeenCalled(); expect(state.error).not.toHaveBeenCalled();
  });
  it.each(['key', 'disconnect'] as const)('ignores a late %s failure in another directory', async (kind) => {
    let reject!: (error: Error) => void;
    const mutation = kind === 'key' ? state.key : state.removeCredential;
    mutation.mockImplementation(() => new Promise((_, fail) => { reject = fail; }));
    if (kind === 'key') await saveKey();
    else { await mount(); await deleteProvider(); }
    await changeScope('directory');
    await act(async () => reject(new Error('late failure')));
    expect(state.error).not.toHaveBeenCalled(); expect(state.reload).not.toHaveBeenCalled();
  });
});

describe('provider directory propagation', () => {
  it('queries each directory separately and sends OAuth connect/status/cancel to the captured directory', async () => {
    state.directory = '/oauth-project'; await start();
    for (const method of [state.list, state.integrations, state.connect, state.status]) {
      expect(method.mock.calls[0][0].location).toEqual({ directory: '/oauth-project' });
    }
    await changeScope('directory');
    expect(state.cancel).toHaveBeenCalledWith(expect.objectContaining({ location: { directory: '/oauth-project' } }));
    expect(state.integrations.mock.calls.at(-1)![0].location).toEqual({ directory: '/second-workspace' });
    expect(cache.getQueryData(['runtime-0', 0, 'provider-connections', '/second-workspace'])).toBeDefined();
  });
  it('passes the captured directory to code completion', async () => {
    state.directory = '/code-project';
    state.connect.mockResolvedValue({ data: { attemptID: 'code-attempt', mode: 'code', url: '', instructions: '' } });
    await start(); await fill('input[placeholder="settings.providers.page.auth.pasteAuthorizationCodePlaceholder"]', 'fixture-code');
    await click('settings.providers.page.actions.complete');
    expect(state.complete.mock.calls[0][0].location).toEqual({ directory: '/code-project' });
  });
  it('discards OAuth status when the directory changes before the React cleanup runs', async () => {
    let resolve!: (value: unknown) => void;
    state.status.mockImplementation(() => new Promise((done) => { resolve = done; }));
    await start();
    state.directory = '/second-workspace';
    await act(async () => resolve({ data: { status: 'complete' } }));
    expect(state.reload).not.toHaveBeenCalled(); expect(state.success).not.toHaveBeenCalled();
  });
});
afterEach(async () => { await act(async () => root.unmount()); cache.clear(); host.remove(); vi.useRealTimers(); });

describe('provider connection regressions', () => {
  it('does not offer invented API-key authentication for an OAuth-only integration', async () => {
    state.integrations.mockResolvedValue({ data: [{ id: 'openai', connections: [{ type: 'credential', method: 'oauth' }], methods: [{ id: 'browser', type: 'oauth' }] }] });
    await mount(); await click('settings.providers.page.actions.reconnect');
    expect(host.querySelector('input[type="password"]')).toBeNull();
    expect([...host.querySelectorAll('button')].some((button) => button.textContent === 'settings.providers.page.auth.apiKeyLabel')).toBe(false);
  });
  it.each(['directory', 'runtime', 'unmount'] as const)('discards saved-model completion after %s changes', async (scope) => {
    state.providers[0].models = [{ id: 'coder' }];
    await mount(); await click('settings.providers.custom.editModel');
    let resolve!: (value: Response) => void;
    state.fetch.mockImplementation((_url: string, init?: RequestInit) => init?.method === 'PUT'
      ? new Promise<Response>((done) => { resolve = done; }) : Promise.resolve(new Response('{}')));
    const save = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((node) => node.textContent === 'settings.common.actions.saveChanges')!;
    await act(async () => save.click());
    await changeScope(scope);
    await act(async () => resolve(new Response('{}')));
    expect(state.reload).not.toHaveBeenCalled();
    expect(state.fetch.mock.calls.find(([, init]) => init?.method === 'PUT')![1].signal.aborted).toBe(true);
  });
  it('edits saved models with a fixed ID, cancels without writing, and retries a failed save', async () => {
    state.providers[0].models = [{ id: 'coder' }];
    state.metadata.mockReturnValue({ tool_call: true, limit: { context: 32000, output: 4000 }, modalities: { input: ['text', 'image'] } });
    await mount(); await click('settings.providers.custom.editModel');
    const id = document.querySelector<HTMLInputElement>('input[aria-label="settings.providers.custom.modelId"]')!;
    expect(id.readOnly).toBe(true);
    const dialogButton = (key: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((node) => node.textContent === key)!;
    await act(async () => dialogButton('settings.common.actions.cancel').click());
    expect(state.fetch.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
    await click('settings.providers.custom.editModel');
    const name = document.querySelector<HTMLInputElement>('input[aria-label="settings.providers.custom.modelName"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, 'New coder');
      name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    state.fetch.mockImplementation(async () => new Response('{}', { status: 500 }));
    await act(async () => dialogButton('settings.common.actions.saveChanges').click());
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('settings.providers.custom.saveFailed');
    state.fetch.mockImplementation(async () => new Response('{}'));
    await act(async () => dialogButton('settings.common.actions.saveChanges').click());
    const write = state.fetch.mock.calls.filter(([, init]) => init?.method === 'PUT').at(-1)!;
    expect(write[0]).toBe('/api/config/providers/model');
    expect(JSON.parse(write[1].body)).toMatchObject({ providerId: 'openai', modelId: 'coder', name: 'New coder', context: 32000, output: 4000, inputModalities: ['text', 'image'], directory: '/workspace' });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(state.reload).toHaveBeenCalledTimes(1);
  });
  it('uses add/remove selection with undo, searches the full catalog and bulk-adds outside the visible subset', async () => {
    state.providers = [{ id: 'openai', name: 'OpenAI', models: Array.from({ length: 2000 }, (_, i) => ({ id: `gpt-model-${i}` })) }];
    state.hiddenModels = state.providers[0].models.map((model) => ({ providerID: 'openai', modelID: model.id }));
    await mount();
    expect(host.querySelectorAll('[data-provider-model]')).toHaveLength(100);
    expect(host.querySelector('input[aria-label="settings.providers.page.models.filterPlaceholder"]')?.getAttribute('data-bordered')).toBe('true');
    expect(host.querySelectorAll('[data-provider-model] img')).toHaveLength(100);
    await fill('input[aria-label="settings.providers.page.models.filterPlaceholder"]', 'gpt-model-1999');
    expect(host.querySelectorAll('[data-provider-model]')).toHaveLength(1);
    await click('settings.providers.custom.addAllModels'); await mount();
    expect(state.showAll).toHaveBeenCalledWith('openai');
    expect(state.hiddenModels).toHaveLength(0);
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="settings.providers.custom.removeModel"]')!.click());
    await mount();
    expect(state.hiddenModels).toEqual([{ providerID: 'openai', modelID: 'gpt-model-1999' }]);
    await click('settings.providers.models.undo'); await mount();
    expect(state.hiddenModels).toHaveLength(0);
    expect(host.textContent).not.toContain('settings.providers.page.actions.hideAll');
    expect(host.querySelector('button[aria-label="settings.providers.page.models.actions.hideModel"]')).toBeNull();
  });
  it('cancels browser authorization when changing to the API key method', async () => {
    await start();
    expect(host.querySelector('[role="status"]')?.textContent).toBe('settings.providers.page.auth.waiting');
    await click('settings.providers.page.auth.apiKeyLabel');
    expect(state.cancel).toHaveBeenCalledTimes(1);
    expect(host.querySelector('input[type="password"]')).not.toBeNull();
    expect(host.querySelector('input[readonly]')).toBeNull();
  });
  it('lists multiple custom providers by their saved Provider Name and keeps Custom available for further additions', async () => {
    state.providers = [
      { id: 'custom-first', name: 'Gateway One', models: [{ id: 'shared-model' }] },
      { id: 'custom-second', name: 'Gateway Two', models: [{ id: 'shared-model' }] },
    ];
    state.selected = 'custom-first';
    await mount(true);
    const rows = [...host.querySelectorAll('button')].map((button) => button.textContent);
    expect(rows.some((text) => text?.startsWith('Gateway One'))).toBe(true);
    expect(rows.some((text) => text?.startsWith('Gateway Two'))).toBe(true);
    expect(host.querySelector('h2')?.textContent).toBe('Gateway One');
    await act(async () => [...host.querySelectorAll('button')].find((button) => button.textContent?.startsWith('Gateway Two'))!.click());
    expect(state.select).toHaveBeenLastCalledWith('custom-second');
    state.selected = 'custom-second'; await mount(true);
    expect(host.querySelector('h2')?.textContent).toBe('Gateway Two');
    await click('settings.providers.custom.title');
    expect(state.select).toHaveBeenLastCalledWith('__custom_provider__');
    state.selected = '__custom_provider__'; await mount(true);
    expect(host.querySelector('[data-custom-provider-form]')).not.toBeNull();
    await click('settings.providers.page.connect.selectProviderTitle');
    expect(host.textContent).toContain('Gateway One');
    expect(host.textContent).toContain('Gateway Two');
  });
  it('opens the provider grid with Custom first and enters the form explicitly', async () => {
    state.selected = '__add_provider__'; await mount();
    expect(host.querySelector('[data-custom-provider-form]')).toBeNull();
    const choices = [...host.querySelectorAll('button')].map((button) => button.getAttribute('aria-label') || button.textContent);
    expect(choices.indexOf('settings.providers.custom.title')).toBeLessThan(choices.indexOf('Anthropic'));
    await click('settings.providers.custom.title');
    expect(host.querySelector('[data-custom-provider-form]')).not.toBeNull();
  });
  it('offers disconnected integrations absent from active provider.list, excluding MCP and connected integrations', async () => {
    state.selected = '__add_provider__'; await mount();
    expect(host.textContent).toContain('Anthropic');
    expect(host.textContent).not.toContain('MCP remote');
    expect([...host.querySelectorAll('button')].some((button) => button.textContent?.startsWith('OpenAI'))).toBe(false);
  });
  it('polls auto attempts and refreshes only after authoritative completion', async () => {
    await start();
    expect(state.complete).not.toHaveBeenCalled(); expect(state.reload).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(state.status).toHaveBeenCalled(); expect(state.reload).not.toHaveBeenCalled();
    state.status.mockResolvedValue({ data: { status: 'complete' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(state.reload).toHaveBeenCalledTimes(1); expect(state.success).toHaveBeenCalledTimes(1);
  });
  it('cancels an attempt and ignores an in-flight completion', async () => {
    let resolve!: (value: unknown) => void;
    state.status.mockImplementation(() => new Promise((done) => { resolve = done; }));
    await start();
    await click('settings.common.actions.cancel');
    await act(async () => resolve({ data: { status: 'complete' } }));
    expect(state.cancel).toHaveBeenCalledTimes(1);
    expect(state.reload).not.toHaveBeenCalled();
    expect(host.querySelector('input[readonly]')).toBeNull();
  });
  it('aborts polling and cancels upstream when unmounted', async () => {
    await start();
    const signal = state.status.mock.calls[0][1].signal as AbortSignal;
    await act(async () => root.render(null));
    expect(signal.aborted).toBe(true);
    expect(state.cancel).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(6000);
    expect(state.status).toHaveBeenCalledTimes(1);
  });
  it('retires old-runtime work without sending its attempt to the new runtime', async () => {
    let resolve!: (value: unknown) => void;
    state.status.mockImplementation(() => new Promise((done) => { resolve = done; }));
    await start();
    await act(async () => { state.generation++; state.listeners.forEach((fn) => fn()); });
    await act(async () => resolve({ data: { status: 'complete' } }));
    expect(state.cancel).not.toHaveBeenCalled(); expect(state.reload).not.toHaveBeenCalled();
    expect(state.success).not.toHaveBeenCalled();
  });
  it.each(['failed', 'expired'])('clears %s attempts and allows retry', async (status) => {
    state.status.mockResolvedValue({ data: { status, message: 'https://example.com/?token=private' } });
    await start();
    expect(state.error).toHaveBeenCalledWith('settings.providers.page.toast.oauthCompleteFailed');
    expect(state.reload).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain('private');
    expect(host.querySelector('input[readonly]')).toBeNull();
    expect([...host.querySelectorAll('button')].find((el) => el.textContent === 'settings.providers.page.actions.connect')?.disabled).toBe(false);
  });
  it('bounds waiting by server expiry and cancels a hung status request', async () => {
    state.connect.mockResolvedValue({ data: { attemptID: 'attempt-1', mode: 'auto', url: '', instructions: '', time: { created: Date.now(), expires: Date.now() + 2000 } } });
    state.status.mockImplementation(() => new Promise(() => undefined));
    await start();
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(state.error).toHaveBeenCalledTimes(1); expect(state.cancel).toHaveBeenCalledTimes(1);
    expect(state.status.mock.calls[0][1].signal.aborted).toBe(true);
  });
  it('cleans up a connect response arriving after cancellation on unmount', async () => {
    let resolve!: (value: unknown) => void;
    state.connect.mockImplementation(() => new Promise((done) => { resolve = done; }));
    await start();
    await act(async () => root.render(null));
    await act(async () => resolve({ data: { attemptID: 'late', mode: 'auto', url: '', instructions: '' } }));
    expect(state.cancel).toHaveBeenCalledWith(expect.objectContaining({ attemptID: 'late' }));
    expect(state.open).not.toHaveBeenCalled(); expect(state.status).not.toHaveBeenCalled();
  });
  it('submits complete only for a non-empty code attempt', async () => {
    state.connect.mockResolvedValue({ data: { attemptID: 'code-attempt', mode: 'code', url: '', instructions: 'Paste code' } });
    await start();
    expect(state.status).not.toHaveBeenCalled();
    await click('settings.providers.page.actions.complete');
    expect(state.complete).not.toHaveBeenCalled();
    const input = host.querySelector<HTMLInputElement>('input[placeholder="settings.providers.page.auth.pasteAuthorizationCodePlaceholder"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, ' test-code ');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click('settings.providers.page.actions.complete');
    expect(state.complete).toHaveBeenCalledWith(expect.objectContaining({ code: 'test-code', attemptID: 'code-attempt' }), expect.anything());
    expect(state.reload).toHaveBeenCalledTimes(1);
  });
  it('surfaces transport failure and clears waiting state', async () => {
    state.status.mockRejectedValue(new Error('https://example.com/?token=private'));
    await start();
    expect(state.error).toHaveBeenCalledTimes(1); expect(state.reload).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain('private');
  });
  it('cancels when switching providers and ignores delayed status', async () => {
    let resolve!: (value: unknown) => void;
    state.status.mockImplementation(() => new Promise((done) => { resolve = done; }));
    await start(); state.selected = '__add_provider__'; await mount();
    await act(async () => resolve({ data: { status: 'complete' } }));
    expect(state.cancel).toHaveBeenCalledTimes(1); expect(state.reload).not.toHaveBeenCalled();
  });
  it('bounds a stalled connect request and supports restarting', async () => {
    state.connect.mockImplementation(() => new Promise(() => undefined));
    await start();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(state.error).toHaveBeenCalledWith('settings.providers.page.toast.oauthStartFailed');
    expect(state.connect.mock.calls[0][1].signal.aborted).toBe(true);
  });
  it('keeps the available snapshot when a refresh fails', async () => {
    state.selected = '__add_provider__'; await mount();
    expect(host.textContent).toContain('Anthropic');
    state.integrations.mockRejectedValue(new Error('offline'));
    await act(async () => { await cache.invalidateQueries(); await vi.advanceTimersByTimeAsync(0); });
    expect(host.textContent).toContain('Anthropic');
    expect(host.textContent).toContain('settings.providers.page.state.unableToLoadProviderList');
  });
  it('reports refresh failure after completion without claiming successful refresh', async () => {
    state.status.mockResolvedValue({ data: { status: 'complete' } });
    state.reload.mockRejectedValue(new Error('offline'));
    await start();
    expect(state.error).toHaveBeenCalledTimes(1); expect(state.success).not.toHaveBeenCalled();
    expect(state.cancel).not.toHaveBeenCalled();
  });
  it('selects the activated provider ID after connecting an integration from add mode', async () => {
    state.selected = '__add_provider__';
    state.list.mockResolvedValue({ data: [] });
    state.integrations.mockResolvedValue({ data: [{ id: 'openai-int', name: 'OpenAI integration', connections: [], methods: [{ id: 'browser', type: 'oauth' }] }] });
    await mount(); await click('OpenAI integration'); await click('settings.providers.page.actions.connect');
    state.list.mockResolvedValue({ data: [{ id: 'openai-activated', integrationID: 'openai-int' }] });
    state.integrations.mockResolvedValue({ data: [{ id: 'openai-int', name: 'OpenAI integration', connections: [{ type: 'credential', id: 'new' }], methods: [] }] });
    state.status.mockResolvedValue({ data: { status: 'complete' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(state.select).toHaveBeenCalledWith('openai-activated');
    expect(state.success).toHaveBeenCalledTimes(1);
  });
  it('signs OpenCode Go in through the Console integration and keeps key connect on Go', async () => {
    state.selected = 'opencode-go';
    state.providers = [{ id: 'opencode-go', name: 'OpenCode Go', models: [] }];
    state.list.mockResolvedValue({ data: [{ id: 'opencode-go', integrationID: 'opencode-go' }] });
    state.integrations.mockResolvedValue({ data: [
      { id: 'opencode', name: 'OpenCode Console', connections: [], methods: [{ id: 'device', type: 'oauth', label: 'OpenCode Console account' }] },
      { id: 'opencode-go', name: 'OpenCode Go', connections: [], methods: [{ id: 'go-key', type: 'key', label: 'Service account' }] },
    ] });
    await mount();
    await click('settings.providers.page.actions.reconnect');
    await click('settings.providers.page.actions.connect');
    expect(state.connect).toHaveBeenCalledWith(
      expect.objectContaining({ integrationID: 'opencode', methodID: 'device' }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(state.connect.mock.calls.some(([input]) => input.integrationID === 'opencode-go')).toBe(false);
    await fill('input[type="password"]', 'service-account-key');
    await click('settings.providers.page.actions.saveKey');
    expect(state.key).toHaveBeenCalledWith(
      expect.objectContaining({ integrationID: 'opencode-go', key: 'service-account-key' }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});
