import { host, mount, signal, Text, View } from 'nsh';
import { Input } from 'nsh/base';
import { SettingsUsage } from './settings-usage';
import { DesktopSettingsPublisher } from './desktop-settings-publisher';
import { createDesktopSettingsContentProtection } from './desktop-settings-content-core';
import { usageFixtureResult, usageResult, usageWindow } from './settings-usage-fixture-data';
import { language } from './i18n';
import type { ProviderResult } from '../ui/src/types/quota';
import { nativeAppearance } from './appearance';
import { appearanceFromSettings } from './appearance-core';
import dark from '../ui/src/lib/theme/themes/yuri-2-dark.json';

const active = signal(true), current = signal(true), input = signal(''), mounted = signal(true);
const audit = (event: string, value?: unknown) => host.post('desktop.usage.test', { event, value });
let settings: Record<string, unknown> = { usageSelectedModels: { google: [], claude: [] }, usageDisplayMode: 'usage', usageAutoRefresh: false };
let failure = false, ack = false, large = false;
let delayed: (() => void) | undefined;
let delayNext = false;
const fakeResult = (): ProviderResult => {
  const result = usageFixtureResult();
  if (large) {
    result.usage!.accounts![0].windows = Object.fromEntries(Array.from({ length: 1000 }, (_, index) => [`window-${index}`, usageWindow({ usedPercent: 30, remainingPercent: 70, label: `Window ${index}` })]));
    result.usage!.models = Object.fromEntries(Array.from({ length: 2000 }, (_, index) => [`other/model-${index}`, { windows: { daily: usageWindow({ usedPercent: 10, remainingPercent: 90 }) } }]));
  }
  const usage = result.usage!, models = usage.models;
  Object.defineProperty(usage, 'models', { enumerable: true, get() { audit('model-catalog'); return models; } });
  return result;
};
const dependencies = {
  current: () => current(), providers: ['google', 'claude'] as const,
  async send(path: string, method = 'GET', body?: unknown) {
    audit('request', { path, method });
    if (path === '/api/config/settings') {
      if (method === 'PUT') {
        settings = { ...settings, ...body as object }; audit('write', body);
        if (delayNext) { delayNext = false; await new Promise<void>(resolve => { delayed = resolve; }); }
        if (ack) throw new Error('Synthetic lost receipt');
        return { success: true };
      }
      if (failure) throw new Error('Synthetic settings failure');
      return settings;
    }
    if (path === '/api/quota/google') { if (failure) throw new Error('Synthetic provider failure'); return fakeResult(); }
    if (path === '/api/quota/claude') return usageResult({ providerId: 'claude', providerName: 'Claude', configured: false, usage: null });
    if (path === '/api/quota/magpie?refresh=1') return { sources: [{ id: 'fixture', identified: true, results: Array.from({ length: large ? 2000 : 1 }, (_, index) => usageResult({ providerId: large ? `magpie:fixture-${index}` : 'magpie:fixture', providerName: large ? `Fixture dynamic ${index}` : 'Fixture dynamic', source: 'magpie', sourceId: 'fixture', usage: { windows: { balance: usageWindow({ valueLabel: '$5', disablePace: true }) } } })) }], incomplete: false };
    throw new Error('Unexpected synthetic Usage request');
  },
};
const protection = createDesktopSettingsContentProtection({ page: 'usage', active, changed: () => {}, unavailable: async () => { audit('unavailable'); } });
host.on<Record<string, unknown>>('desktop.usage.control', event => {
  if (event.action === 'active') active.set(event.value === true);
  else if (event.action === 'current') current.set(event.value === true);
  else if (event.action === 'failure') failure = event.value === true;
  else if (event.action === 'ack') ack = event.value === true;
  else if (event.action === 'large') large = event.value === true;
  else if (event.action === 'delay') delayNext = true;
  else if (event.action === 'resolve') { delayed?.(); delayed = undefined; }
  else if (event.action === 'mounted') mounted.set(event.value === true);
  else if (event.action === 'language') language.set(String(event.value));
  else if (event.action === 'protection') { const snapshot = protection.snapshot(); audit('protection', { status: snapshot.status, dirty: snapshot.dirty, pending: snapshot.pending }); }
  else throw new Error('Unknown Usage fixture control');
});
language.set('en');
void appearanceFromSettings({ themeVariant: 'dark', darkThemeId: dark.metadata.id }, async () => ({ themes: [dark] })).then(value => nativeAppearance.current.set({ ...value, uiFontFamily: value.fonts.ui, monoFontFamily: value.fonts.mono, assistantFontFamilies: { light: value.fonts.assistantLight, dark: value.fonts.assistantDark }, unsupportedFonts: [] }));
mount(() => <View class="flex-1 bg-background">
  <Input testID="usage-fixture-unrelated-input" value={input()} onChange={event => input.set(event.value)} />
  <Text>{input()}</Text>
  <If when={mounted()}><DesktopSettingsPublisher.Provider value={protection}><SettingsUsage page="usage" active={active()} dependencies={dependencies} onOpen={route => audit('route', route)} onBack={() => audit('back')} onConnect={() => audit('connect')} /></DesktopSettingsPublisher.Provider></If>
</View>);
