import { cleanup, host, mount, Scroll, signal, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { loadNativeDesktopRemoteConnections } from './desktop-remote-connections-native';
import type { NativeDesktopRemoteConnectionsPort } from './desktop-remote-connections-native-core';
import { createDesktopConnectionOnlyRemoteConnections } from './desktop-remote-connections';
import { createDesktopSettingsContentProtection } from './desktop-settings-content-core';
import { DesktopSettingsPublisher } from './desktop-settings-publisher';
import { language, t } from './i18n';

/** Real loader, controller and Native slot; only --web-host supplies synthetic metadata. */
function Fixture() {
  language.set('en');
  let live = true, port: NativeDesktopRemoteConnectionsPort | undefined;
  const runtimeReady = signal(true);
  const owner = signal<ReturnType<typeof createDesktopConnectionOnlyRemoteConnections> | null>(null), ready = signal(false), active = signal(true), calls = signal(''), control = signal('none');
  cleanup(host.on('fixture.ssh.calls', value => calls.set(JSON.stringify(value))));
  void loadNativeDesktopRemoteConnections({ current: () => live, runtimeReady }).then(next => {
    if (!live) { next?.dispose(); return; }
    port = next;
    if (next) owner.set(createDesktopConnectionOnlyRemoteConnections(next, { connectionMutation: mutation => mutation.dispatch() }));
    ready.set(true);
  });
  cleanup(() => { live = false; owner()?.dispose(); port?.dispose(); });
  async function command(name: string) { await host.call('fixture.ssh.control', { name }); control.set(name); }
  function Content() {
    const remote = owner()!, revision = signal(0), state = signal(remote.controller.state());
    const protection = createDesktopSettingsContentProtection({ page: 'remote-instances', active, changed: () => revision.set(revision() + 1), unavailable: async () => {} });
    cleanup(remote.controller.subscribe(() => state.set(remote.controller.state())));
    return <View class="flex-1">
      <Text>{`guard=${revision() >= 0 ? protection.snapshot().status : ''};dirty=${protection.snapshot().dirty};pending=${protection.snapshot().pending}`}</Text>
      <Text>{`snapshot=${state().snapshot?.revision};label=${state().snapshot?.instances[0]?.label};busy=${state().busy};unknown=${!!state().unknown}`}</Text>
      <Text>{`current=${remote.controller.current()};runtimeReady=${state().ready && remote.controller.ready()}`}</Text>
      <DesktopSettingsPublisher.Provider value={protection}><Scroll class="flex-1" contentClass="p-5 gap-3">{remote.slot({ get active() { return active(); } })}</Scroll></DesktopSettingsPublisher.Provider>
    </View>;
  }
  return <View class="flex-1 bg-background">
    <Text testID="fixture-native-audit">{calls()}</Text><Text>{`control=${control()}`}</Text>
    <View class="flex-row flex-wrap gap-2">
      <Button testID="fixture-native-active" onPress={() => active.set(!active())}><Text>Toggle fixture active</Text></Button>
      <Button testID="fixture-native-runtime" onPress={() => runtimeReady.set(!runtimeReady())}><Text>Toggle fixture bootstrap</Text></Button>
      <Each of={['lose-save', 'recover-read-failure', 'hold', 'release', 'dispose']}>{name => <Button testID={`fixture-native-${name()}`} onPress={() => { if (name() === 'dispose') { live = false; owner()?.dispose(); port?.dispose(); control.set('dispose'); } else void command(name()); }}><Text>{name()}</Text></Button>}</Each>
    </View>
    <If when={ready() && !owner()}><Text testID="fixture-native-unavailable">{t('settings.view.unavailable.title')}</Text></If>
    <If when={owner()}><Content /></If>
  </View>;
}
mount(Fixture);
