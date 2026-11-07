import { mount, Storage, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { NativeAppearanceSync, nativeAppearance, refreshNativeAppearance } from './appearance';
import { NativeAppearanceFeedback } from './appearance-feedback';
import { SettingsBasics } from './settings-basics';
import { app } from './state';
import { language } from './i18n';

// The obsolete local light preference deliberately conflicts with the canonical dark Host fixture.
void Storage.setItem('appearance', 'light');
language.set('en');
app.connection.set({ id: 'fixture', url: 'https://host.example', label: 'Fixture', lastUsedAt: 0 });
app.runtimeScope.set({ hostID: 'fixture', lease: '00000000-0000-4000-8000-000000000001' });
function AppearanceSettingsFixture() {
  return <View class="flex-1">
    <NativeAppearanceSync /><NativeAppearanceFeedback />
    <Text testID="appearance-authority">{() => nativeAppearance.current()?.mode ?? 'loading'}</Text>
    <Button testID="appearance-authority-refresh" onPress={() => { void refreshNativeAppearance(); }}><Text>Refresh authority</Text></Button>
    <SettingsBasics page="appearance" onOpen={() => {}} onBack={() => {}} onConnect={() => {}} />
  </View>;
}
mount(AppearanceSettingsFixture);
