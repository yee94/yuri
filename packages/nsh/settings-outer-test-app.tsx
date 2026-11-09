import { mount, signal, Text } from 'nsh';
import { Button, createNavStack, NavPage, NavStack } from 'nsh/base';
import { language } from './i18n';
import { SettingsHome, SettingsPage, type SettingsRoute } from './settings';
import { admitSettingsFixture } from './settings-raw-fixture-bootstrap';
import { request } from './runtime';

language.set('en');
function SettingsOuterTestApp() {
  const ready = signal(false), error = signal('');
  void admitSettingsFixture().then(() => ready.set(true), () => error.set('Synthetic Host admission failed'));
  const audit = signal('');
  const nav = createNavStack<SettingsRoute | { page: 'home' }>([{ page: 'home' }]);
  const callbacks = { onOpen: (route: SettingsRoute) => nav.push(route), onBack: () => nav.pop(), onConnect: () => undefined };
  return <><If when={!!error()}><Text>{error()}</Text></If><If when={ready()}><NavStack state={nav} class="flex-1">{route => route.page === 'home'
    ? <NavPage title="Outer settings fixture" headerBackTitle="" class="flex-1"><Button testID="settings-outer-audit" onPress={() => { void request('/fixture/notifications/audit').then(value => audit.set(JSON.stringify(value))); }}><Text>Inspect synthetic notification audit</Text></Button><Text testID="settings-outer-audit-result">{audit()}</Text><SettingsHome {...callbacks} /></NavPage>
    : <SettingsPage {...callbacks} {...route} directory="/fixture/project" />}</NavStack></If></>;
}
mount(SettingsOuterTestApp);
