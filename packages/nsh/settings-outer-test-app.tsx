import { mount, signal, Text } from 'nsh';
import { Button, createNavStack, NavPage, NavStack } from 'nsh/base';
import { language } from './i18n';
import { SettingsHome, SettingsPage, type SettingsRoute } from './settings';
import { app } from './state';
import { request } from './runtime';

language.set('en');
function SettingsOuterTestApp() {
  app.connection.set({ id: 'outer-settings-fixture', label: 'Synthetic settings Host', url: 'https://settings.example.invalid', lastUsedAt: 0 });
  const audit = signal('');
  const nav = createNavStack<SettingsRoute | { page: 'home' }>([{ page: 'home' }]);
  const callbacks = { onOpen: (route: SettingsRoute) => nav.push(route), onBack: () => nav.pop(), onConnect: () => undefined };
  return <NavStack state={nav} class="flex-1">{route => route.page === 'home'
    ? <NavPage title="Outer settings fixture" headerBackTitle="" class="flex-1"><Button testID="settings-outer-audit" onPress={() => { void request('/fixture/notifications/audit').then(value => audit.set(JSON.stringify(value))); }}><Text>Inspect synthetic notification audit</Text></Button><Text testID="settings-outer-audit-result">{audit()}</Text><SettingsHome {...callbacks} /></NavPage>
    : <SettingsPage {...callbacks} {...route} directory="/fixture/project" />}</NavStack>;
}
mount(SettingsOuterTestApp);
