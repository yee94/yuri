import { mount, signal, Text, View } from 'nsh';
import { Button, createNavStack, NavPage, NavStack } from 'nsh/base';
import { language } from './i18n';
import { SettingsHome, SettingsPage, type SettingsRoute } from './settings';
import { settingsEngineFixtureBoot } from './settings-engine-fixture-boot';
import { captureHostOperation } from './state';

language.set('en');
function SettingsOuterTestApp() {
  const boot = settingsEngineFixtureBoot();
  const audit = signal('');
  const providerAudit = signal(''), preflightArmed = signal(false);
  const nav = createNavStack<SettingsRoute | { page: 'home' }>([{ page: 'home' }]);
  const callbacks = { onOpen: (route: SettingsRoute) => nav.push(route), onBack: () => nav.pop(), onConnect: () => undefined };
  return <If when={boot.mounted()}><View class="flex-1"><View class="gap-2 p-2">
    <Button testID="settings-provider-fixture-preflight" disabled={!boot.active() || preflightArmed()} onPress={() => {
      const operation = captureHostOperation();
      if (operation.current()) void operation.request('/fixture/providers/preflight', 'PUT', { mode: 'fail-next-settings-read' }).then(() => { if (operation.current()) preflightArmed.set(true); });
    }}><Text>Arm visibility preflight failure</Text></Button>
    <If when={preflightArmed()}><Text>Visibility preflight armed</Text></If>
    <Button testID="settings-provider-fixture-audit" disabled={!boot.active()} onPress={() => {
      const operation = captureHostOperation();
      if (operation.current()) void Promise.all([operation.request('/fixture/providers/audit'), operation.request('/fixture/providers/state')]).then(([counts, state]) => {
        if (operation.current()) providerAudit.set(JSON.stringify({ ...counts as object, ...state as object }));
      });
    }}><Text>Inspect synthetic provider audit</Text></Button><Text testID="settings-provider-fixture-audit-result">{providerAudit()}</Text>
  </View><NavStack state={nav} class="flex-1">{route => route.page === 'home'
    ? <NavPage title="Outer settings fixture" headerBackTitle="" class="flex-1"><Button testID="settings-outer-audit" onPress={() => { const operation = captureHostOperation(); if (operation.current()) void operation.request('/fixture/notifications/audit').then(value => { if (operation.current()) audit.set(JSON.stringify(value)); }); }}><Text>Inspect synthetic notification audit</Text></Button><Text testID="settings-outer-audit-result">{audit()}</Text><SettingsHome {...callbacks} /></NavPage>
    : <SettingsPage {...callbacks} {...route} active={boot.active() && nav.routes().at(-1) === route} directory="/fixture/project" />}</NavStack></View></If>;
}
mount(SettingsOuterTestApp);
