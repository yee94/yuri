import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ directory: '/workspace', generation: 0, providers: [] as Array<{ id: string }>, fetch: vi.fn(), refresh: vi.fn(), select: vi.fn(), list: vi.fn(), integrations: vi.fn() }));
vi.mock('@/lib/opencode/client', () => ({ opencodeClient: { getDirectory: () => state.directory,
  getSdkClient: () => ({ provider: { list: state.list }, integration: { list: state.integrations } }) } }));
vi.mock('@/lib/runtime-switch', () => ({ getRuntimeGeneration: () => state.generation, getRuntimeTransportIdentity: () => `runtime-${state.generation}` }));
vi.mock('@/lib/runtime-fetch', () => ({ runtimeFetch: state.fetch }));
vi.mock('@/stores/useAgentsStore', () => ({ refreshOpenCodeConfiguration: state.refresh }));
vi.mock('@/stores/useConfigStore', () => ({ useConfigStore: { getState: () => ({ providers: state.providers, setSelectedProvider: state.select }) } }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string, params?: Record<string, unknown>) => params?.url ? `${key}: ${params.url}` : key }) }));
vi.mock('@/lib/device', () => ({ useDeviceInfo: () => ({ isMobile: false }) }));
vi.mock('@/components/icon/Icon', () => ({ Icon: ({ name }: { name: string }) => <svg data-icon={name} /> }));
vi.mock('@/components/ui/ScrollableOverlay', () => ({ ScrollableOverlay: ({ children }: React.PropsWithChildren) => <div>{children}</div> }));
vi.mock('@/components/ui/select', () => {
  const Context = React.createContext({ value: '', onValueChange: (_value: string) => {} });
  return {
    Select: ({ value, onValueChange, children, disabled }: React.PropsWithChildren<{ value: string; onValueChange: (value: string) => void; disabled?: boolean }>) => <Context.Provider value={{ value, onValueChange }}><fieldset disabled={disabled}>{children}</fieldset></Context.Provider>,
    SelectTrigger: () => null, SelectValue: () => null,
    SelectContent: ({ children }: React.PropsWithChildren) => { const ctx = React.useContext(Context); return <select aria-label="protocol" value={ctx.value} onChange={(event) => ctx.onValueChange(event.target.value)}>{children}</select>; },
    SelectItem: ({ value, children }: React.PropsWithChildren<{ value: string }>) => <option value={value}>{children}</option>,
  };
});
import { CustomProviderForm } from './CustomProviderForm';

let root: Root;
let host: HTMLDivElement;
let cache: QueryClient;
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
async function mount() {
  await act(async () => root.render(<QueryClientProvider client={cache}><CustomProviderForm /></QueryClientProvider>));
}
async function fill(label: string, value: string) {
  const input = document.body.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  expect(input).toBeTruthy();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function choose(value: string) {
  const select = host.querySelector('select')!;
  await act(async () => { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })); });
}
async function submit() { await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); }
async function clickButton(label: string, scope: ParentNode = document.body) {
  const button = scope.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
    ?? [...scope.querySelectorAll('button')].find((entry) => entry.textContent === label)!;
  expect(button).toBeTruthy();
  await act(async () => button.click());
}
async function saveModel() {
  const form = document.querySelector('[role="dialog"] form');
  expect(form).not.toBeNull();
  await act(async () => form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
}
async function addModel(id: string) {
  await clickButton('settings.providers.custom.addModel');
  await fill('settings.providers.custom.modelId', id);
  await saveModel();
}
async function settle() {
  await act(async () => { await vi.advanceTimersByTimeAsync(650); });
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); vi.useFakeTimers(); vi.clearAllMocks();
  state.directory = '/workspace'; state.generation = 0; state.providers = [];
  state.refresh.mockResolvedValue(undefined); state.list.mockResolvedValue({ data: [] }); state.integrations.mockResolvedValue({ data: [] });
  state.fetch.mockImplementation(async (url: string, options: RequestInit) => {
    if (url.endsWith('/models')) return json({ models: [{ id: 'coder', name: 'Coder' }] });
    const body = JSON.parse(options.body as string);
    const providerId = body.config.name.trim().toLowerCase().replace(/\s+/g, '-');
    state.providers = [{ id: providerId }];
    state.list.mockResolvedValue({ data: [{ id: providerId }] });
    return json({ providerId });
  });
  cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); cache.clear(); host.remove(); vi.useRealTimers(); });

describe('custom provider form', () => {
  it('keeps connection fields in equal columns and toggles the inset key without submitting or losing the draft', async () => {
    await mount();
    await fill('settings.providers.custom.name', 'Gateway');
    await fill('settings.providers.custom.baseURL', 'https://api.example.com');
    await fill('settings.providers.page.auth.apiKeyLabel', 'fixture-key');
    const input = host.querySelector<HTMLInputElement>('input[type="password"]')!;
    const wrapper = input.closest('[data-slot="input-wrapper"]')!;
    const toggle = wrapper.querySelector<HTMLButtonElement>('button')!;
    const card = input.closest('.yuri-settings-equal-controls')!;
    expect(card.querySelectorAll('.yuri-settings-split-row')).toHaveLength(4);
    expect(card.querySelector('.yuri-settings-split-row-stacked')).toBeNull();
    expect(toggle.closest('[data-slot="input-end-adornment"]')).not.toBeNull();
    expect(toggle.type).toBe('button');
    for (const visible of [true, false]) {
      await act(async () => toggle.click());
      expect(input.type).toBe(visible ? 'text' : 'password');
      expect(input.value).toBe('fixture-key');
      expect(toggle.getAttribute('aria-pressed')).toBe(String(visible));
      expect(state.fetch).not.toHaveBeenCalled();
      expect(host.querySelector('[role="alert"]')).toBeNull();
    }
    await addModel('coder');
    let finish!: (value: Response) => void;
    state.fetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }));
    await submit();
    expect(input.disabled).toBe(true);
    expect(toggle.disabled).toBe(true);
    await act(async () => toggle.click());
    expect(input.type).toBe('password');
    await act(async () => finish(new Response('{}', { status: 500 })));
    expect(input.disabled).toBe(false);
    expect(toggle.disabled).toBe(false);
    expect(input.value).toBe('fixture-key');
  });

  it('matches logos for discovered and added models and supports undoing removal', async () => {
    state.fetch.mockResolvedValue(json({ models: [{ id: 'claude-sonnet-4', name: 'Claude' }, { id: 'gpt-4.1', name: 'GPT' }, { id: 'unknown-local', name: 'Local' }] }));
    await mount(); await fill('settings.providers.custom.baseURL', 'https://api.example.com');
    await fill('settings.providers.page.auth.apiKeyLabel', 'fixture-secret'); await settle();
    const claude = host.querySelector('[data-provider-model="claude-sonnet-4"]')!;
    const gpt = host.querySelector('[data-provider-model="gpt-4.1"]')!;
    expect(claude.querySelector('img')?.getAttribute('src')).toBeTruthy();
    expect(claude.querySelector('img')?.getAttribute('src')).not.toBe(gpt.querySelector('img')?.getAttribute('src'));
    expect(host.querySelector('[data-provider-model="unknown-local"] [data-icon="stack"]')).not.toBeNull();
    await act(async () => claude.querySelector<HTMLButtonElement>('button')!.click());
    expect(host.querySelector('[data-provider-model="claude-sonnet-4"]')?.getAttribute('data-added')).toBe('true');
    await clickButton('settings.providers.custom.removeModel');
    await clickButton('settings.providers.models.undo');
    expect(host.querySelector('[data-provider-model="claude-sonnet-4"]')?.getAttribute('data-added')).toBe('true');
  });
  it('uses Select for the protocol and updates final URL previews as the URL and protocol change', async () => {
    await mount(); expect(host.querySelector('select')).not.toBeNull();
    expect(host.querySelector('[data-slot="settings-row-footer"]')).toBeNull();
    await fill('settings.providers.custom.baseURL', 'https://api.example.com/');
    const preview = host.querySelector('[data-slot="settings-row-footer"]')!;
    expect(preview.parentElement).toBe(host.querySelector('input[type="url"]')!.closest('.yuri-settings-split-row'));
    expect(preview.closest('[data-settings-value]')).toBeNull();
    expect(preview.textContent).toContain('settings.providers.custom.urlExact: https://api.example.com/v1/chat/completions');
    expect(host.querySelector('details')).toBeNull();
    expect(host.textContent).not.toContain('settings.providers.custom.urlRules');
    expect(host.textContent).not.toContain('settings.providers.custom.urlAuto');
    expect(host.textContent).toContain('https://api.example.com/v1/chat/completions');
    await choose('1'); expect(host.textContent).toContain('https://api.example.com/v1/responses');
    await fill('settings.providers.custom.baseURL', 'https://api.example.com/gateway#');
    expect(host.textContent).toContain('https://api.example.com/gateway/responses');
    expect(host.textContent).not.toContain('gateway/v1');
    await choose('3');
    await fill('settings.providers.custom.baseURL', 'https://api.example.com');
    await addModel('gemini');
    expect(host.textContent).toContain('https://api.example.com/v1beta/models/gemini:streamGenerateContent?alt=sse');
  });
  it('does not request on every keystroke, then automatically fetches models without putting credentials in query keys', async () => {
    await mount();
    for (let i = 0; i < 50; i++) await fill('settings.providers.custom.baseURL', `https://api.example.com/${i}`);
    await fill('settings.providers.page.auth.apiKeyLabel', 'fixture-key');
    expect(state.fetch).not.toHaveBeenCalled();
    await settle(); expect(state.fetch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(cache.getQueryCache().getAll().map((query) => query.queryKey))).not.toContain('fixture-key');
    expect(JSON.parse(state.fetch.mock.calls[0][1].body)).toMatchObject({ baseURL: 'https://api.example.com/49/v1', apiKey: 'fixture-key' });
    const candidate = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Coder'))!;
    await act(async () => candidate.click());
    expect(host.querySelector('input[aria-label="settings.providers.custom.modelId"]')).toBeNull();
    await act(async () => candidate.click());
    expect(document.querySelector<HTMLInputElement>('[role="dialog"] input[aria-label="settings.providers.custom.modelId"]')!.value).toBe('coder');
    expect(document.querySelector<HTMLInputElement>('[role="dialog"] input[aria-label="settings.providers.custom.modelName"]')!.value).toBe('Coder');
  });
  it('saves native V2 package/settings/models, then selects the new provider and clears the transient key', async () => {
    await mount(); await choose('2');
    await fill('settings.providers.custom.name', 'Gateway');
    await fill('settings.providers.custom.baseURL', 'https://api.example.com');
    await fill('settings.providers.page.auth.apiKeyLabel', 'fixture-key');
    await addModel('claude');
    await submit();
    const request = JSON.parse(state.fetch.mock.calls[0][1].body);
    expect(request).toMatchObject({ directory: '/workspace', apiKey: 'fixture-key', config: {
      name: 'Gateway', package: '@opencode/ai/providers/anthropic-compatible', settings: { baseURL: 'https://api.example.com/v1' },
      models: { claude: { capabilities: { tools: true, input: ['text'], output: ['text'] } } },
    } });
    expect(request.config.provider).toBeUndefined(); expect(request.config.npm).toBeUndefined();
    expect(request.config.settings.apiKey).toBeUndefined();
    expect(request.providerId).toBeUndefined();
    expect(state.select).toHaveBeenCalledWith('gateway');
    expect(host.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe('');
    expect(state.refresh).toHaveBeenCalledWith(expect.objectContaining({ queryDirectory: '/workspace', transportIdentity: 'runtime-0' }));
  });
  it('keeps the draft on failed save and allows a retry', async () => {
    state.fetch.mockResolvedValue(new Response('{}', { status: 500 }));
    await mount(); await fill('settings.providers.custom.name', 'Keep me'); await fill('settings.providers.custom.baseURL', 'https://api.example.com');
    await addModel('coder'); await submit();
    expect(host.querySelector('[role="alert"]')!.textContent).toBe('settings.providers.custom.saveFailed');
    expect(host.querySelector<HTMLInputElement>('input[aria-label="settings.providers.custom.name"]')!.value).toBe('Keep me');
    expect(state.refresh).not.toHaveBeenCalled(); expect(state.select).not.toHaveBeenCalled();
  });
  it('creates separate providers on successive visits, preserving each Provider Name even with the same protocol, address and model', async () => {
    for (const name of ['Gateway One', 'Gateway Two']) {
      await mount();
      expect(host.querySelector<HTMLInputElement>('input[aria-label="settings.providers.custom.name"]')!.value).toBe('');
      expect(host.querySelectorAll('button[aria-label="settings.providers.custom.removeModel"]')).toHaveLength(0);
      await fill('settings.providers.custom.name', `  ${name}  `);
      await fill('settings.providers.custom.baseURL', 'https://api.example.com');
      await addModel('shared-model');
      await submit();
      await act(async () => root.render(null));
    }
    const requests = state.fetch.mock.calls
      .filter(([url]) => url.endsWith('/custom'))
      .map(([, options]) => JSON.parse(options.body as string));
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.providerId === undefined)).toBe(true);
    expect(requests.map((request) => request.config.name)).toEqual(['Gateway One', 'Gateway Two']);
    expect(requests[0].config.models).toEqual(requests[1].config.models);
    expect(state.select.mock.calls.map(([id]) => id)).toEqual(['gateway-one', 'gateway-two']);
  });
  it('uses the server-assigned ID and switches after saving even while connection metadata lags behind', async () => {
    state.fetch.mockResolvedValueOnce(json({ providerId: 'my-gateway-2' }));
    state.providers = [{ id: 'my-gateway-2' }];
    state.list.mockResolvedValue({ data: [] });
    await mount(); await fill('settings.providers.custom.name', 'My Gateway');
    await fill('settings.providers.custom.baseURL', 'https://api.example.com');
    await addModel('coder'); await submit();
    expect(state.select).toHaveBeenCalledExactlyOnceWith('my-gateway-2');
    expect(state.list).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).not.toContain('settings.providers.custom.refreshFailed');
  });
  it('waits briefly for the saved model catalog, then opens the actual new provider without another write', async () => {
    state.fetch.mockResolvedValueOnce(json({ providerId: 'gateway' }));
    state.refresh.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => { state.providers = [{ id: 'gateway' }]; });
    await mount(); await fill('settings.providers.custom.name', 'Gateway');
    await fill('settings.providers.custom.baseURL', 'https://api.example.com');
    await addModel('coder'); await submit();
    expect(state.select).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(state.select).toHaveBeenCalledExactlyOnceWith('gateway');
    expect(state.fetch).toHaveBeenCalledTimes(1);
    expect(state.refresh).toHaveBeenCalledTimes(2);
  });
  it('bounds watcher waiting and keeps a neutral saved status with a write-free retry', async () => {
    state.fetch.mockResolvedValueOnce(json({ providerId: 'gateway' }));
    await mount(); await fill('settings.providers.custom.name', 'Gateway');
    await fill('settings.providers.custom.baseURL', 'https://api.example.com');
    await addModel('coder'); await submit();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(state.refresh).toHaveBeenCalledTimes(5);
    expect(state.select).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).toContain('settings.providers.custom.refreshFailed');
    state.providers = [{ id: 'gateway' }];
    await submit();
    expect(state.select).toHaveBeenCalledExactlyOnceWith('gateway');
    expect(state.fetch).toHaveBeenCalledTimes(1);
  });
  it.each(['runtime', 'directory', 'unmount'] as const)('stops catalog waiting after %s changes', async (change) => {
    state.fetch.mockResolvedValueOnce(json({ providerId: 'gateway' }));
    await mount(); await fill('settings.providers.custom.name', 'Gateway');
    await fill('settings.providers.custom.baseURL', 'https://api.example.com');
    await addModel('coder'); await submit();
    if (change === 'runtime') state.generation++;
    else if (change === 'directory') state.directory = '/other';
    else await act(async () => root.render(null));
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(state.refresh).toHaveBeenCalledTimes(1);
    expect(state.select).not.toHaveBeenCalled();
  });
  it('does not repeat config or credential writes when refreshing a successfully saved provider fails', async () => {
    state.refresh.mockRejectedValueOnce(new Error('refresh failed'));
    await mount(); await fill('settings.providers.custom.name', 'Gateway'); await fill('settings.providers.custom.baseURL', 'https://api.example.com');
    await addModel('coder'); await submit();
    expect(host.textContent).toContain('settings.providers.custom.refreshFailed');
    expect(host.querySelector('[role="alert"]')).toBeNull();
    await submit(); expect(state.fetch).toHaveBeenCalledTimes(1); expect(state.select).toHaveBeenCalledTimes(1);
  });
  it('aborts obsolete model requests and ignores late results after address/key changes', async () => {
    let finish!: (value: Response) => void;
    state.fetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }));
    await mount(); await fill('settings.providers.custom.baseURL', 'https://first.example.com'); await settle();
    const signal = state.fetch.mock.calls[0][1].signal as AbortSignal;
    await fill('settings.providers.custom.baseURL', 'https://second.example.com');
    expect(signal.aborted).toBe(true);
    await act(async () => finish(json({ models: [{ id: 'stale', name: 'Stale' }] })));
    expect(host.textContent).not.toContain('Stale');
  });
  it('bounds discovered model DOM while allowing search across 2000 models', async () => {
    state.fetch.mockResolvedValue(json({ models: Array.from({ length: 2000 }, (_, index) => ({ id: `model-${index}`, name: `Model ${index}` })) }));
    await mount(); await fill('settings.providers.custom.baseURL', 'https://api.example.com'); await settle();
    expect(host.querySelector('input[aria-label="settings.providers.page.models.filterPlaceholder"]')?.getAttribute('data-bordered')).toBe('true');
    expect([...host.querySelectorAll('button')].filter((button) => button.textContent?.includes('Model '))).toHaveLength(100);
    await fill('settings.providers.page.models.filterPlaceholder', 'model-1999');
    expect(host.textContent).toContain('Model 1999'); expect(state.fetch).toHaveBeenCalledTimes(1);
  });
  it.each(['runtime', 'directory', 'unmount'] as const)('ignores late saves after %s changes', async (change) => {
    let finish!: (value: Response) => void;
    state.fetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }));
    await mount(); await fill('settings.providers.custom.name', 'Gateway'); await fill('settings.providers.custom.baseURL', 'https://api.example.com');
    await addModel('coder'); await submit();
    if (change === 'runtime') state.generation++;
    else if (change === 'directory') state.directory = '/other';
    else await act(async () => root.render(null));
    await act(async () => finish(json({ providerId: 'custom-stale' })));
    expect(state.refresh).not.toHaveBeenCalled(); expect(state.select).not.toHaveBeenCalled();
  });
  it('opens the add form from the sync toolbar, cancels without adding, and never saves the provider from the dialog', async () => {
    await mount();
    expect(host.textContent).not.toContain('settings.providers.custom.modelsEmpty');
    expect(host.textContent).not.toContain('settings.providers.custom.discoveryHint');
    expect(host.textContent).not.toContain('settings.providers.custom.discoveryEmpty');
    expect(host.querySelector('input[aria-label="settings.providers.custom.modelId"]')).toBeNull();
    const add = host.querySelector('button[aria-label="settings.providers.custom.addModel"]')!;
    expect(add.parentElement?.textContent).toContain('settings.providers.custom.fetchModels');
    await clickButton('settings.providers.custom.addModel');
    await fill('settings.providers.custom.modelId', 'discard');
    await clickButton('settings.common.actions.cancel', document.querySelector('[role="dialog"]')!);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await addModel('manual');
    expect(host.textContent).toContain('manual');
    expect(state.fetch).not.toHaveBeenCalled();
    expect(state.select).not.toHaveBeenCalled();
  });
  it('shows actual empty discovery and failure feedback without repeating model toolbar instructions', async () => {
    state.fetch.mockResolvedValueOnce(json({ models: [] }));
    await mount();
    await fill('settings.providers.custom.baseURL', 'https://api.example.com');
    await settle();
    expect(host.textContent).toContain('settings.providers.custom.discoveryEmpty');
    expect(host.textContent).not.toContain('settings.providers.custom.modelsEmpty');
    state.fetch.mockResolvedValueOnce(new Response('{}', { status: 502 }));
    await clickButton('settings.providers.custom.fetchModels');
    await settle();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('settings.providers.custom.discoveryFailed');
    expect(host.textContent).not.toContain('settings.providers.custom.discoveryEmpty');
  });
  it('uses the solid Settings dialog and shows capabilities with explicit edit/remove actions instead of a checkmark', async () => {
    await mount(); await addModel('configured-model');
    const edit = host.querySelector<HTMLButtonElement>('button[aria-label="settings.providers.custom.editModel"]')!;
    expect(edit.querySelector('[data-icon="settings-3"]')).not.toBeNull();
    expect(host.querySelector('[data-icon="check"]')).toBeNull();
    expect(host.querySelector('[role="img"][aria-label="settings.providers.custom.tools"]')).not.toBeNull();
    expect(host.querySelector('[role="img"][aria-label="settings.providers.custom.vision"]')).toBeNull();
    expect(host.querySelector('button[aria-label="settings.providers.custom.removeModel"] [data-icon="subtract"]')).not.toBeNull();
    await act(async () => edit.click());
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.dataset.presentation).toBe('default');
    expect(dialog.classList.contains('yuri-settings-workspace')).toBe(true);
    expect(dialog.classList.contains('yuri-settings-workspace-desktop')).toBe(true);
    expect(dialog.querySelector('button[type="submit"]')?.className).toContain('bg-[var(--surface-muted)]');
    expect(dialog.querySelector('details')?.open).toBe(false);
    await act(async () => dialog.querySelector('summary')!.click());
    expect(dialog.querySelector('details')?.open).toBe(true);
    await act(async () => dialog.querySelector<HTMLElement>('[role="radiogroup"][aria-label="settings.providers.custom.vision"] button[aria-checked="false"]')!.click());
    await saveModel();
    expect(host.querySelector('[role="img"][aria-label="settings.providers.custom.vision"] [data-icon="eye"]')).not.toBeNull();
    expect(host.querySelector('[data-icon="check"]')).toBeNull();
    await clickButton('settings.providers.custom.removeModel');
    expect(host.textContent).not.toContain('configured-model');
  });
  it('adds every discovered model beyond the visible 100 and current search, preserving manual configuration and deduplicating', async () => {
    const inventory = Array.from({ length: 2000 }, (_, index) => ({ id: `model-${index}`, name: `Model ${index}` }));
    state.fetch.mockImplementation(async (url: string) => {
      if (url.endsWith('/models')) return json({ models: inventory });
      state.providers = [{ id: 'bulk' }];
      state.list.mockResolvedValue({ data: [{ id: 'bulk' }] });
      return json({ providerId: 'bulk' });
    });
    await mount(); await fill('settings.providers.custom.name', 'Bulk');
    await addModel('model-0');
    const first = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('model-0'))!;
    await act(async () => first.click());
    await fill('settings.providers.custom.modelName', 'My settings');
    await fill('settings.providers.custom.context', '65536'); await fill('settings.providers.custom.output', '8192');
    await saveModel();
    await fill('settings.providers.custom.baseURL', 'https://api.example.com'); await settle();
    await fill('settings.providers.page.models.filterPlaceholder', 'model-1999');
    await clickButton('settings.providers.custom.addAllModels');
    expect(host.querySelector('button[aria-label="settings.providers.custom.addModel"]')).not.toBeNull();
    expect(host.querySelector('input[aria-label="settings.providers.custom.modelId"]')).toBeNull();
    expect([...host.querySelectorAll('button')].filter((button) => button.textContent?.includes('Model '))).toHaveLength(1);
    await fill('settings.providers.page.models.filterPlaceholder', '');
    expect(host.querySelectorAll('button[aria-label="settings.providers.custom.removeModel"]')).toHaveLength(100);
    const all = [...host.querySelectorAll('button')].find((button) => button.textContent === 'settings.providers.custom.addAllModels')!;
    expect(all.disabled).toBe(true);
    await submit();
    const saved = JSON.parse(state.fetch.mock.calls.find(([url]) => url.endsWith('/custom'))![1].body).config;
    expect(Object.keys(saved.models)).toHaveLength(2000);
    expect(saved.models['model-0']).toMatchObject({ name: 'My settings', limit: { context: 65536, output: 8192 } });
    expect(saved.models['model-1999'].name).toBe('Model 1999');
  });
  it('validates dialog edits, preserves cancelled changes and allows removing the last model', async () => {
    await mount(); await addModel('first'); await addModel('second');
    const first = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('first'))!;
    await act(async () => first.click());
    await fill('settings.providers.custom.modelId', 'second'); await saveModel();
    expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toBe('settings.providers.custom.invalidModels');
    await fill('settings.providers.custom.modelId', 'invalid id'); await saveModel();
    expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toBe('settings.providers.custom.invalidModel');
    await clickButton('settings.common.actions.cancel', document.querySelector('[role="dialog"]')!);
    for (const button of [...host.querySelectorAll<HTMLButtonElement>('button[aria-label="settings.providers.custom.removeModel"]')]) {
      await act(async () => button.click());
    }
    await submit();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('settings.providers.custom.modelsEmpty');
    expect(state.fetch).not.toHaveBeenCalled();
  });
  it('removes all draft models beyond the search and render limit, preserving the discovery snapshot', async () => {
    const inventory = Array.from({ length: 2000 }, (_, index) => ({ id: `model-${index}`, name: `Model ${index}` }));
    state.fetch.mockResolvedValue(json({ models: inventory }));
    await mount(); await addModel('manual'); await fill('settings.providers.custom.baseURL', 'https://api.example.com'); await settle();
    await clickButton('settings.providers.custom.addAllModels');
    await fill('settings.providers.page.models.filterPlaceholder', 'model-1999');
    await clickButton('settings.providers.models.removeAll');
    await fill('settings.providers.page.models.filterPlaceholder', '');
    expect(host.querySelectorAll('[data-added="true"]')).toHaveLength(0);
    expect(host.querySelectorAll('[data-provider-model]')).toHaveLength(100);
    await submit();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('settings.providers.custom.modelsEmpty');
    expect(state.fetch).toHaveBeenCalledTimes(1);
  });
});
