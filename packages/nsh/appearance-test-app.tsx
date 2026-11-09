import { mount, Text, View } from 'nsh';
import { NativeAppearanceSync, nativeAppearance, nativeChatSurfaceStyle, nativeChatTextStyle } from './appearance';
import { loadConnections } from './state';
import { NativeAppearanceFeedback } from './appearance-feedback';
import { language } from './i18n';

// CLI-only fixture entrypoint; never imported by App.tsx or the iOS Host.
void loadConnections().catch(error => { console.error('Appearance fixture admission failed', error); });
language.set('en');
function AppearanceFixture() {
  return <View>
    <NativeAppearanceSync />
    <NativeAppearanceFeedback />
    <Text testID="appearance-ready">{() => nativeAppearance.current()?.mode ?? (nativeAppearance.error() ? 'failed' : 'loading')}</Text>
    <View style={nativeChatSurfaceStyle('user')}>
      <Text testID="appearance-user" style={nativeChatTextStyle('user')}>Native user body</Text>
    </View>
    <Text testID="appearance-code" style={nativeChatTextStyle('code')}>Native code body</Text>
  </View>;
}
mount(AppearanceFixture);
