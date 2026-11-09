import { mount, signal, Text, View } from 'nsh';
import { Button, createNavStack, NavPage, NavStack } from 'nsh/base';
import { language } from './i18n';
import { SettingsHome, SettingsPage, type SettingsRoute } from './settings';
import { settingsEngineFixtureBoot } from './settings-engine-fixture-boot';
import { captureHostOperation } from './state';
import { deviceAppearance } from './device-appearance';

language.set('en');
function SettingsTestApp() {
  const boot = settingsEngineFixtureBoot();
  const attempts = signal<number | null>(null);
  const preferenceAudit = signal('');
  const nav = createNavStack<SettingsRoute | { page: 'home' }>([{ page: 'home' }]);
  const callbacks = { onOpen: (route: SettingsRoute) => nav.push(route), onBack: () => nav.pop(), onConnect: () => undefined };
  return <If when={boot.mounted()}><View class="flex-1"><Text testID="settings-device-code-size">{`Device code size: ${deviceAppearance()?.codeFontSize ?? 'unknown'}`}</Text><Button testID="settings-preferences-audit" onPress={() => {
    const operation = captureHostOperation();
    if (operation.current()) void operation.request('/fixture/preferences/audit').then(value => { if (operation.current()) preferenceAudit.set(JSON.stringify(value)); });
  }}><Text>Inspect synthetic preference writes</Text></Button><Text testID="settings-preferences-audit-result">{preferenceAudit()}</Text><Button testID="settings-command-audit" onPress={() => {
    const operation = captureHostOperation();
    if (operation.current()) void operation.request('/fixture/commands/audit').then(value => {
      if (operation.current()) attempts.set((value as { attempts: number }).attempts);
    });
  }}><Text>Inspect synthetic command writes</Text></Button><If when={attempts() !== null}><Text>{`Read-back save attempts: ${attempts()}`}</Text></If><NavStack state={nav} class="flex-1">{route => route.page === 'home' ? <NavPage title="Settings fixture" class="flex-1"><SettingsHome {...callbacks} /></NavPage> : <SettingsPage {...callbacks} {...route} active={boot.active() && nav.routes().at(-1) === route} directory="/native/project" />}</NavStack></View></If>;
}
mount(SettingsTestApp);
