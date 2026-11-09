import { mount, signal, Text } from 'nsh';
import { createNavStack, NavPage, NavStack } from 'nsh/base';
import { language } from './i18n';
import { SettingsHome, SettingsPage, type SettingsRoute } from './settings';
import { admitSettingsFixture } from './settings-raw-fixture-bootstrap';

language.set('en');
function SettingsTestApp() {
  const ready = signal(false), error = signal('');
  void admitSettingsFixture().then(() => ready.set(true), () => error.set('Synthetic admission failed'));
  const nav = createNavStack<SettingsRoute | { page: 'home' }>([{ page: 'home' }]);
  const callbacks = { onOpen: (route: SettingsRoute) => nav.push(route), onBack: () => nav.pop(), onConnect: () => undefined };
  return <><Text>{error()}</Text><If when={ready()}><NavStack state={nav} class="flex-1">{route => route.page === 'home' ? <NavPage title="Settings fixture" class="flex-1"><SettingsHome {...callbacks} /></NavPage> : <SettingsPage {...callbacks} {...route} directory="/native/project" />}</NavStack></If></>;
}
mount(SettingsTestApp);
