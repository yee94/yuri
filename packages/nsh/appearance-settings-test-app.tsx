import { mount, signal, Storage, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { NativeAppearanceSync, nativeAppearance, refreshNativeAppearance } from './appearance';
import { NativeAppearanceFeedback } from './appearance-feedback';
import { SettingsBasics } from './settings-basics';
import { settingsEngineFixtureBoot } from './settings-engine-fixture-boot';
import { language } from './i18n';
import { captureHostOperation } from './state';

// The obsolete local light preference deliberately conflicts with the canonical dark Host fixture.
void Storage.setItem('appearance', 'light');
language.set('en');
function AppearanceSettingsFixture() {
  const boot = settingsEngineFixtureBoot();
  const audit = signal('');
  return <If when={boot.mounted()}><View class="flex-1">
    <NativeAppearanceSync /><NativeAppearanceFeedback />
    <Text testID="appearance-authority">{() => nativeAppearance.current()?.mode ?? 'loading'}</Text>
    <Button testID="appearance-authority-refresh" onPress={() => { void refreshNativeAppearance(); }}><Text>Refresh authority</Text></Button>
    <Button testID="appearance-audit" onPress={() => { const operation = captureHostOperation(); if (operation.current()) void operation.request('/fixture/appearance/audit').then(value => { if (operation.current()) audit.set(JSON.stringify(value)); }); }}><Text>Inspect synthetic appearance writes</Text></Button>
    <Text>{audit()}</Text>
    <SettingsBasics page="appearance" active={boot.active()} onOpen={() => {}} onBack={() => {}} onConnect={() => {}} />
  </View></If>;
}
mount(AppearanceSettingsFixture);
