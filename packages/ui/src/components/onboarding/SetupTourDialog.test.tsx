import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { dict as en } from '@/lib/i18n/messages/en';
import { speechDefaults } from '@/lib/voice/speechSettings';
import type { PluginEntry } from '@/stores/usePluginsStore';
import { useSetupTourStore } from '@/stores/useSetupTourStore';
import { SetupTourDialog } from './SetupTourDialog';
import type { useSpeechSettingsForm } from '@/components/sections/yuri/useSpeechSettingsForm';

const fixture = vi.hoisted(() => ({
  runtime: 'tour-host', generation: 1, client: null as QueryClient | null,
  entries: [] as PluginEntry[], metadata: {} as Record<string, unknown>,
  install: vi.fn(), catalog: vi.fn(), save: vi.fn(), close: vi.fn(),
}));
vi.mock('@/lib/runtime-switch', () => ({
  getRuntimeKey: () => fixture.runtime, getRuntimeGeneration: () => fixture.generation,
  getRuntimeTransportIdentity: () => fixture.runtime, getRuntimeApiBaseUrl: () => '',
  isRuntimeInstanceChange: () => false, subscribeRuntimeEndpointChanged: () => () => {},
}));
vi.mock('@/lib/desktop', () => ({ isDesktopShell: () => false, isDesktopLocalOriginActive: () => false }));
vi.mock('@/lib/queryRuntime', () => ({ queryClient: { fetchQuery: (options: Parameters<QueryClient['fetchQuery']>[0]) => fixture.client!.fetchQuery(options) } }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: keyof typeof en, params?: Record<string, string>) => {
  let text: string = en[key] ?? key;
  for (const [name, value] of Object.entries(params ?? {})) text = text.replaceAll(`{${name}}`, value);
  return text;
} }) }));
vi.mock('@/stores/useConfigStore', () => ({ useConfigStore: { getState: () => ({ providers: [], loadProviders: async () => {}, setSelectedProvider: vi.fn() }) } }));
vi.mock('@/queries/pluginQueries', async () => {
  const { useQuery } = await import('@tanstack/react-query');
  return {
    usePluginConfigDirectory: () => '/workspace',
    usePluginsQuery: () => useQuery({ queryKey: ['plugins'], queryFn: async () => ({ entries: fixture.entries, files: [] }) }),
    pluginRegistryQueryOptions: () => ({ queryKey: ['metadata'], queryFn: async () => fixture.metadata }),
  };
});
vi.mock('@/queries/configCatalogQueries', () => ({ providerCatalogQueryOptions: () => ({ queryKey: ['catalog'], queryFn: () => fixture.catalog() }) }));
vi.mock('@/queries/speechSettingsQueries', async () => {
  const { speechDefaults } = await import('@/lib/voice/speechSettings');
  return {
    speechSettingsQueryOptions: () => ({ queryKey: ['speech'], queryFn: async () => ({ ...speechDefaults }) }),
    saveSpeechSettings: (...args: unknown[]) => fixture.save(...args),
  };
});
vi.mock('@/components/sections/providers/ProvidersPage', () => ({ ProvidersPage: () => <p>Existing provider editor</p> }));
vi.mock('@/components/chat/MarkdownRenderer', () => ({ SimpleMarkdownRenderer: ({ content }: { content: string }) => <article>{content}</article> }));
vi.mock('@/components/sections/yuri/VolcengineSpeechSettings', () => ({
  VolcengineSpeechSettings: ({ mode, form, showCredentials = true }: { mode: string; form: ReturnType<typeof useSpeechSettingsForm>; showCredentials?: boolean }) => <div data-speech-mode={mode}>
    {showCredentials && <input aria-label="Speech API key" value={form.draft.apiKey ?? ''} onChange={(event) => form.edit({ apiKey: event.target.value })} />}
  </div>,
}));
vi.mock('./tourPlugins', () => ({
  tourPlugins: [{ name: 'Magpie', spec: 'opencode-magpie-plugin' }, { name: 'Eficy', spec: '@eficy/opencode2-plugin' }, { name: 'yee-profile', spec: '@yee94/opencode-profile' }],
  hasTourPlugin: (entries: PluginEntry[], spec: string) => entries.some((entry) => entry.spec === spec),
  installRecommendedPlugins: (...args: unknown[]) => fixture.install(...args),
}));

let root: Root;
let container: HTMLDivElement;
const tick = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(10); }); };
const click = async (text: string) => {
  const button = [...document.querySelectorAll('button')].find((node) => node.textContent?.trim() === text);
  expect(button, text).toBeDefined();
  await act(async () => button!.click()); await tick();
};
const render = async () => {
  await act(async () => { root.render(<QueryClientProvider client={fixture.client!}><SetupTourDialog runtime={fixture.runtime} onClose={fixture.close} /></QueryClientProvider>); });
  await tick();
};
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); vi.useFakeTimers();
  fixture.generation = 1; fixture.entries = []; fixture.close.mockReset();
  fixture.install.mockReset().mockResolvedValue({ failed: [], pending: [] });
  fixture.catalog.mockReset().mockResolvedValue({ providers: [{ id: 'gateway', models: { model: { id: 'model' } } }], partial: false });
  fixture.save.mockReset().mockResolvedValue({ ...speechDefaults, configured: true });
  fixture.metadata = Object.fromEntries(['opencode-magpie-plugin', '@eficy/opencode2-plugin', '@yee94/opencode-profile'].map((spec) => [spec, {
    kind: 'npm-ok', spec, name: spec, latestVersion: '1.2.3', description: `Developer description for ${spec}`,
    readme: `# Original README for ${spec}`, icon: 'data:image/svg+xml,%3Csvg/%3E',
  }]));
  fixture.client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  useSetupTourStore.setState({ progress: { [fixture.runtime]: { step: 0, dismissed: false } }, openedRuntime: fixture.runtime });
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); fixture.client!.clear(); container.remove(); vi.useRealTimers(); });

test('renders built-in Magpie guidance and developer metadata for tools; Magpie is applied only in step one', async () => {
  await render();
  expect(document.body.textContent).toContain(en['tour.magpieDescription']);
  expect(document.body.textContent).toContain(en['tour.recommended']);
  expect(document.body.textContent).not.toContain('opencode-magpie-plugin');
  expect(document.querySelector('img[alt="Magpie"]')).not.toBeNull();
  await click('Apply and continue');
  expect(fixture.install.mock.calls[0][0]).toEqual(['opencode-magpie-plugin']);
  expect(useSetupTourStore.getState().progress[fixture.runtime].step).toBe(1);
  expect(document.body.textContent).toContain('Developer description for @eficy/opencode2-plugin');
  expect(document.querySelector('[data-plugin-icon-mask]')).not.toBeNull();
  await click('README');
  expect(document.body.textContent).toContain('# Original README for @eficy/opencode2-plugin');
  await click('Back');
  expect(document.querySelector('[aria-label="Magpie"]')).toBeNull();
  await click('Apply and continue');
  expect(fixture.install.mock.calls[1][0]).toEqual(['@eficy/opencode2-plugin', '@yee94/opencode-profile']);
  expect(useSetupTourStore.getState().progress[fixture.runtime].step).toBe(2);
});

test('saved-but-not-active plugins do not advance and retry never pretends failure is success', async () => {
  fixture.install.mockResolvedValueOnce({ failed: [], pending: ['opencode-magpie-plugin'] });
  await render(); await click('Apply and continue');
  expect(useSetupTourStore.getState().progress[fixture.runtime].step).toBe(0);
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('not yet active');
  await click('Apply and continue');
  expect(useSetupTourStore.getState().progress[fixture.runtime].step).toBe(1);
});

test('no-model and network errors preserve the model step instead of claiming a working connection', async () => {
  fixture.catalog.mockResolvedValueOnce({ providers: [], partial: false }).mockRejectedValueOnce(new Error('offline'));
  await render(); await click('Apply and continue');
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('no models');
  await click('Apply and continue');
  expect(useSetupTourStore.getState().progress[fixture.runtime].step).toBe(0);
  expect(fixture.close).not.toHaveBeenCalled();
});

test('all three steps can be postponed without installing plugins or saving credentials', async () => {
  await render(); await click('Set up later'); await click('Set up later'); await click('Set up later');
  expect(fixture.close).toHaveBeenCalledOnce();
  expect(fixture.install).not.toHaveBeenCalled();
  expect(fixture.save).not.toHaveBeenCalled();
});

test('configured tools keep whole-card toggles and README does not change selection', async () => {
  fixture.entries = [{ id: 'eficy', spec: '@eficy/opencode2-plugin', scope: 'user', kind: 'config', parsedKind: 'npm' }];
  useSetupTourStore.getState().move(fixture.runtime, 1);
  await render();
  const toggle = () => document.querySelector<HTMLButtonElement>('button[aria-label="Eficy"]')!;
  expect(toggle().getAttribute('aria-pressed')).toBe('true');
  await act(async () => toggle().click());
  expect(toggle().getAttribute('aria-pressed')).toBe('false');
  expect(document.body.textContent).toContain('Configured');
  await click('README');
  await click('Back');
  expect(toggle().getAttribute('aria-pressed')).toBe('false');
  await click('Apply and continue');
  expect(fixture.install.mock.calls[0][0]).toEqual(['@yee94/opencode-profile']);
});

test('Magpie whole-card selection can be toggled off and back on', async () => {
  await render();
  const toggle = document.querySelector<HTMLButtonElement>('button[aria-label="Magpie"]')!;
  expect(toggle.getAttribute('aria-pressed')).toBe('true');
  await act(async () => toggle.click());
  expect(toggle.getAttribute('aria-pressed')).toBe('false');
  await act(async () => toggle.click());
  expect(toggle.getAttribute('aria-pressed')).toBe('true');
  expect(fixture.install).not.toHaveBeenCalled();
});

test('uses the shared speech form to save both providers, preserves failed drafts, and closes only after success', async () => {
  useSetupTourStore.getState().move(fixture.runtime, 2);
  fixture.save.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ ...speechDefaults, configured: true });
  await render(); await click('Set up Doubao voice');
  expect(document.querySelectorAll('[data-speech-mode]')).toHaveLength(2);
  const input = document.querySelector('input[aria-label="Speech API key"]') as HTMLInputElement;
  expect(input).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'test-only-key');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const form = document.getElementById('yuri-tour-voice')!;
  await act(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  await tick();
  expect(fixture.close).not.toHaveBeenCalled();
  expect(input.value).toBe('test-only-key');
  await act(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  await tick();
  expect(fixture.save.mock.calls[1][0]).toMatchObject({ apiKey: 'test-only-key', voiceProvider: 'volcengine', sttProvider: 'volcengine', dictationEnabled: true, showMessageTTSButtons: true });
  expect(fixture.close).toHaveBeenCalledOnce();
});

test('late completion after a runtime switch cannot advance the new runtime', async () => {
  let release!: (value: unknown) => void;
  fixture.install.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
  await render(); await click('Apply and continue');
  fixture.generation++;
  await act(async () => release({ failed: [], pending: [] }));
  await tick();
  expect(useSetupTourStore.getState().progress[fixture.runtime].step).toBe(0);
  expect(fixture.catalog).not.toHaveBeenCalled();
});
