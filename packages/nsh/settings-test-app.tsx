import { mount } from 'nsh';
import { createNavStack, NavPage, NavStack } from 'nsh/base';
import { language } from './i18n';
import { SettingsHome, SettingsPage, type SettingsRoute } from './settings';

language.set('en');
function SettingsTestApp() {
  const nav = createNavStack<SettingsRoute | { page: 'home' }>([{ page: 'home' }]);
  const callbacks = { onOpen: (route: SettingsRoute) => nav.push(route), onBack: () => nav.pop(), onConnect: () => undefined };
  return <NavStack state={nav} class="flex-1">{route => route.page === 'home' ? <NavPage title="Settings fixture" class="flex-1"><SettingsHome {...callbacks} /></NavPage> : <SettingsPage {...callbacks} {...route} directory="/native/project" />}</NavStack>;
}
mount(SettingsTestApp);
