import { mount, signal, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { language } from './i18n';
import { SettingsUsage } from './settings-usage';
import { usageFixtureResult } from './settings-usage-fixture-data';
import type { Row } from './model';
import { nativeAppearance } from './appearance';
import { appearanceFromSettings } from './appearance-core';
import dark from '../ui/src/lib/theme/themes/yuri-2-dark.json';

/** Future opt-in engine fixture. Production component, in-memory synthetic transport only. */
function Fixture() {
  language.set('en');
  // A canonical synthetic Host appearance snapshot, not a production fallback palette.
  void appearanceFromSettings({ themeVariant: 'dark', darkThemeId: dark.metadata.id }, async () => ({ themes: [dark] })).then(value => nativeAppearance.current.set({ ...value, uiFontFamily: value.fonts.ui, monoFontFamily: value.fonts.mono, assistantFontFamilies: { light: value.fonts.assistantLight, dark: value.fonts.assistantDark }, unsupportedFonts: [] }));
  const active = signal(true), writes = signal(0), reads = signal(0), failedRead = signal(false), failedAck = signal(false);
  let settings: Row = { usageSelectedModels: { google: ['gemini/z-model', 'gemini/a-model'] }, usageDisplayMode: 'usage' };
  const dependencies = {
    current: () => true,
    providers: ['google'] as const,
    async send(path: string, method = 'GET', body?: unknown) {
      if (path === '/api/config/settings') {
        if (method === 'PUT') { writes.set(writes() + 1); settings = { ...settings, ...body as Row }; if (failedAck()) throw new Error('Synthetic ACK lost'); return { success: true }; }
        reads.set(reads() + 1); if (failedRead()) throw new Error('Synthetic settings read failure'); return settings;
      }
      if (path === '/api/quota/google') return usageFixtureResult();
      if (path === '/api/quota/magpie?refresh=1') return { sources: [], incomplete: false };
      throw new Error('Unexpected synthetic Usage request');
    },
  };
  return <View class="flex-1 bg-background">
    <SettingsUsage page="usage" entity="google" active={active()} dependencies={dependencies} onOpen={() => undefined} onBack={() => undefined} onConnect={() => undefined} />
    <View class="gap-1"><Text testID="usage-fixture-counts">{`reads=${reads()}, writes=${writes()}`}</Text>
      <Button testID="usage-fixture-active" onPress={() => active.set(!active())}><Text>Toggle synthetic route activity</Text></Button>
      <Button testID="usage-fixture-read-failure" onPress={() => failedRead.set(!failedRead())}><Text>Toggle synthetic read failure</Text></Button>
      <Button testID="usage-fixture-ack-failure" onPress={() => failedAck.set(!failedAck())}><Text>Toggle synthetic ACK failure</Text></Button>
    </View>
  </View>;
}
mount(Fixture);
