import { mount, signal, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { NativeDesktopSettingsWindow } from './desktop-settings';
import { NativeDesktopSettingsContent, type DesktopSettingsContentNavigationState } from './desktop-settings-content';
import { admitSettingsFixture } from './settings-raw-fixture-bootstrap';
import { native } from './runtime';
import { language } from './i18n';
import type { SettingsRoute } from './settings';

function Fixture() {
  language.set('en');
  const ready = signal(false), open = signal(true), error = signal(''), audit = signal('');
  const route = signal<SettingsRoute>({ page: 'skills.catalog', directory: '/fixture/selected' });
  const protection = signal<DesktopSettingsContentNavigationState | null>(null);
  void admitSettingsFixture().then(() => ready.set(true), () => error.set('Synthetic admission failed'));
  const callbacks = { onOpen: (next: SettingsRoute) => route.set({ ...next, directory: next.directory ?? route().directory }), onBack: () => {}, onConnect: () => {} };
  return <View class="flex-1 bg-background">
    <Text>{error()}</Text><Text>{`protection=${protection()?.status};pending=${protection()?.pending};dirty=${protection()?.dirty};picker=${protection()?.nestedPickerOpen}`}</Text>
    <Each of={['hold', 'release', 'install-unknown', 'clients-fail', 'pending-fail', 'transports-fail', 'write-fail', 'pair-unknown']}>{mode => <Button testID={`catalog-remote-${mode()}`} onPress={() => { void native('catalogRemote.fixture.scenario', { mode: mode() }); }}><Text>{mode()}</Text></Button>}</Each>
    <Button testID="catalog-remote-audit" onPress={() => { void native('catalogRemote.fixture.audit').then(value => audit.set(JSON.stringify(value))); }}><Text>Inspect synthetic audit</Text></Button><Text testID="catalog-remote-audit-value">{audit()}</Text>
    <If when={ready()}><NativeDesktopSettingsWindow open={open()} route={route()} visiblePages={['skills.catalog', 'remote-instances']}
      pending={protection()?.pending === true} dirty={protection()?.dirty !== false || protection()?.status !== 'ready'} nestedPickerOpen={protection()?.nestedPickerOpen === true}
      confirmDiscard={() => protection()?.requestLeave() ?? false} onClose={() => open.set(false)} onNavigate={callbacks.onOpen}
      renderPage={context => <NativeDesktopSettingsContent route={context.route} active={context.active} callbacks={callbacks} onNavigationState={next => { if (next.status !== 'retired' || protection()?.owner === next.owner) protection.set(next); }} />} /></If>
  </View>;
}
mount(Fixture);
