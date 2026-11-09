import { cleanup, effect, host, mount, Scroll, signal, Text, untracked, View } from 'nsh';
import { AlertDialog, Button, Input } from 'nsh/base';
import { app } from './state';
import { createDesktopHeaderInstancesRoot } from './desktop-header-instances-root';
import { createNativeDesktopRemoteConnectionsRoot } from './desktop-remote-connections-root';
import { createDesktopHeaderServices, type DesktopHeaderServiceOperation, type DesktopHeaderServicesSnapshot } from './desktop-header-services';
import { NativeDesktopHeaderInstance } from './desktop-header-services-view';
import { createDesktopSettingsContentProtection } from './desktop-settings-content-core';
import { DesktopSettingsPublisher } from './desktop-settings-publisher';
import { language } from './i18n';
import type { Connection } from './model';

const a: Connection = { id: 'fixture-connection', label: 'Local SSH Relay', url: 'http://127.0.0.1:3210', authorizationID: 'synthetic-public-a', lastUsedAt: 0 };
const b: Connection = { id: 'same-url', label: 'Same URL', url: a.url, authorizationID: 'synthetic-public-b', lastUsedAt: 0 };
const auditEvents = signal<Record<string, unknown>[]>([]);
const audit = (event: string, extra: Record<string, unknown> = {}) => auditEvents.set([...auditEvents(), { event, ...extra }]);
function Fixture() {
  language.set('en'); app.connections.set([a, b]); app.connection.set(a); app.online.set(true);
  const live = signal(true), visible = signal(false), settings = signal(false), draft = signal('Keep draft'), hold = signal(false), control = signal('none'), calls = signal<string[]>([]), revision = signal(0);
  const makeLane = (): DesktopHeaderServiceOperation => ({ current: () => live(), request: async () => { throw new Error('Instance must not request HTTP'); } });
  const lane = signal(makeLane());
  let release: (() => void) | undefined;
  let protection: ReturnType<typeof createDesktopSettingsContentProtection> | undefined;
  const remote = createNativeDesktopRemoteConnectionsRoot({ current: live, runtimeReady: live,
    connectFromHeader: async (_target, intent, commit) => {
      audit('connect-confirm');
      const answer = await AlertDialog.show({ title: 'Connect', actions: [{ id: 'cancel', label: 'Cancel', role: 'cancel' }, { id: 'connect', label: 'Connect' }] });
      if (answer.action !== 'connect' || !intent.current()) return { status: 'unsupported' };
      return commit();
    },
  });
  cleanup(remote.dispose);
  const root = createDesktopHeaderInstancesRoot({ current: live, remote: remote.header,
    switch: { available: () => true, run: async (target, intent) => {
      audit('switch-guard', { id: target.id });
      if (hold()) await new Promise<void>(resolve => { release = resolve; });
      if (!intent.current()) { audit('switch-stale'); return { status: 'stale' }; }
      const selected = app.connections().find(row => row.id === target.id && row.url === target.url && row.authorizationID === target.authorizationID);
      if (!selected) return { status: 'stale' };
      app.connection.set(selected); lane.set(makeLane()); audit('switch-commit', { id: selected.id }); return { status: 'accepted' };
    } },
    add: { available: () => true, run: async intent => { if (!intent.current()) return { status: 'stale' }; audit('add-commit'); return { status: 'accepted' }; } },
  });
  const snapshot = signal<DesktopHeaderServicesSnapshot | null>(null);
  const services = createDesktopHeaderServices({ current: live, operation: lane, instances: root, changed: value => snapshot.set(value) });
  snapshot.set(services.snapshot()); cleanup(services.dispose);
  cleanup(remote.header.subscribe(() => revision.set(revision() + 1)));
  effect(() => { const value = { tab: visible() ? 'instance' as const : null, active: !settings() && live() }; lane(); untracked(() => services.update(value)); });
  cleanup(host.on<string[]>('fixture.instances.calls', value => calls.set(value)));
  async function nativeControl(name: string) { await host.call('fixture.instances.control', { name }); control.set(name); }
  cleanup(host.on<{ action: string; value?: unknown }>('fixture.instances.control-event', event => {
    switch (event.action) {
      case 'hold': hold.set(event.value === true); break;
      case 'release': release?.(); release = undefined; break;
      case 'auth': app.connections.set(app.connections().map(row => row.id === 'same-url' ? { ...row, authorizationID: 'new-public-auth' } : row)); break;
      case 'invalid': app.connection.set(event.value ? { ...a, id: 'uncommitted' } : a); break;
      case 'rename': app.connections.set(app.connections().map(row => row.id === a.id ? { ...row, label: String(event.value) } : row)); break;
      case 'retire': live.set(false); break;
      default: throw new Error('Unknown fixture event');
    }
  }));
  function Settings() {
    const rev = signal(0);
    const guard = createDesktopSettingsContentProtection({ page: 'remote-instances', active: () => settings(), changed: () => rev.set(rev() + 1), unavailable: async () => {} });
    protection = guard; cleanup(() => { if (protection === guard) protection = undefined; });
    return <View testID="instances-original-settings" class="gap-2">
      <Text>{`guard=${rev() >= 0 ? guard.snapshot().status : ''};dirty=${guard.snapshot().dirty};pending=${guard.snapshot().pending}`}</Text>
      <DesktopSettingsPublisher.Provider value={guard}>{remote.slot({ active: true })}</DesktopSettingsPublisher.Provider>
    </View>;
  }
  return <View class="flex-1 gap-2">
    <View class="flex-row gap-2"><Button testID="instances-header-open" onPress={() => visible.set(true)}><Text>Open</Text></Button><Button testID="instances-header-close" onPress={() => visible.set(false)}><Text>Close</Text></Button>
      <Button testID="instances-settings-open" onPress={() => settings.set(true)}><Text>Settings</Text></Button><Button testID="instances-settings-close" onPress={async () => { if (!protection || await protection.requestLeave()) settings.set(false); }}><Text>Close Settings</Text></Button></View>
    <View class="flex-row gap-2"><Button testID="instances-native-bound" onPress={() => { void nativeControl('bound'); }}><Text>Bind synthetic</Text></Button><Button testID="instances-native-lose-start" onPress={() => { void nativeControl('lose-start'); }}><Text>Lose synthetic ACK</Text></Button></View>
    <Text testID="instances-native-calls">{JSON.stringify(calls())}</Text><Text>{`control=${control()}`}</Text>
    <Text testID="instances-audit">{`audit=${JSON.stringify(auditEvents())}`}</Text>
    <Text testID="instances-root-state">{`owner=${revision() >= 0 && !!remote.header.projection().owner};unknown=${!!remote.header.projection().state?.unknown};busy=${!!remote.header.projection().state?.busy}`}</Text>
    <Scroll class="flex-1"><If when={settings()} else={<If when={visible()}><View style={{ width: 432 }}><NativeDesktopHeaderInstance owner={services} snapshot={snapshot()!} /></View></If>}><Settings /></If></Scroll>
    <Input testID="instances-composer" value={draft()} onChange={event => draft.set(event.value)} />
  </View>;
}
mount(Fixture);
