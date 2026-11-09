import { cleanup, effect, host, lifecycle, mount, signal, Text, untracked, View, windowSize } from 'nsh';
import { Button, Input } from 'nsh/base';
import { language } from './i18n';
import { createDesktopHeaderServices, type DesktopHeaderInstance, type DesktopHeaderServiceOperation, type DesktopHeaderServicesSnapshot, type DesktopHeaderServicesTab, type DesktopHeaderUpdateProjection } from './desktop-header-services';
import { NativeDesktopHeaderInstance, NativeDesktopHeaderMcp } from './desktop-header-services-view';

const tab = signal<DesktopHeaderServicesTab | null>(null), active = signal(true), authority = signal(true), laneID = signal(1), draft = signal('Keep draft');
const snapshot = signal<DesktopHeaderServicesSnapshot | null>(null);
let fail = '', deferred = false, empty = false, unknown = false, gate = false, connected = true;
const pending: (() => void)[] = [];
const audit = (event: string, extra: Record<string, unknown> = {}) => host.post('desktop.header.services.test', { event, ...extra });
const wait = () => deferred ? new Promise<void>(resolve => pending.push(resolve)) : Promise.resolve();
let savedID = 0, savedLane: DesktopHeaderServiceOperation | null = null;
function operation() {
  const id = laneID(); if (!id) return null;
  if (savedID === id) return savedLane;
  savedID = id;
  savedLane = { current: () => authority() && laneID() === id, request: async (path, method = 'GET') => {
    audit('request', { path, method }); await wait();
    if (fail && path.includes(fail)) throw new Error('Synthetic failure');
    if (method === 'POST') { if (unknown) throw new Error('Synthetic lost ACK'); connected = !path.includes('/disconnect'); return true; }
    if (path.startsWith('/api/config')) return empty ? [] : [{ name: 'Alpha' }, { name: 'Config only' }];
    return { data: empty ? [] : [{ name: 'Alpha', status: { status: connected ? 'connected' : 'disabled' } }, { name: 'Auth', integrationID: 'mcp-auth', status: { status: 'needs_auth' } }, { name: 'Registration', status: { status: 'needs_client_registration', error: 'Synthetic registration required' } }] };
  } };
  return savedLane;
}
const instances: readonly DesktopHeaderInstance[] = [
  { id: 'a', label: 'Committed Host', transport: 'lan', isDefault: false, display: { isActive: true, isSsh: false, runtimeIsConnected: true, runtimeConnectionPhase: 'connected', currentTransportIsRelay: true, probe: { status: 'ok', latencyMs: 99 }, sshPhase: undefined } },
  { id: 'ssh', label: 'SSH Host', transport: 'ssh', isDefault: false, display: { isActive: false, isSsh: true, runtimeIsConnected: false, runtimeConnectionPhase: '', currentTransportIsRelay: false, probe: null, sshPhase: 'idle' } },
];
const update: DesktopHeaderUpdateProjection = { hostUpdate: { status: 'ready', refreshing: false, value: { supported: true, currentVersion: '1.2.3', available: true, availableVersion: '1.2.4', operation: null, checkFailed: false, serverId: 'synthetic', channel: 'stable', plan: { version: '1.2.4', kind: 'cli-package', planId: 'synthetic-plan', rollback: false, restartRequired: true, releaseNotes: null } } }, updateBusy: false, updateFailed: false, updateUncertain: false, updateConfirm: null };
const owner = createDesktopHeaderServices({ directory: '/synthetic/project', current: authority, operation,
  changed: value => snapshot.set(value),
  instances: { read: async intent => { audit('instance-read'); await wait(); if (!intent.current() || fail === 'instance') throw new Error('Synthetic'); return instances; }, available: action => !['default', 'new-window'].includes(action), run: async (action, id, intent) => { audit('instance-start', { action, id }); await wait(); if (!intent.current()) return { status: 'stale' }; audit('instance-commit', { action, id }); return { status: 'accepted' }; } },
  update: { read: async intent => { audit('update-read'); await wait(); if (!intent.current() || fail === 'update') throw new Error('Synthetic'); return update; }, nativeGate: () => gate, available: () => true, run: async () => { audit('update-write'); return { status: 'accepted' }; } },
});
snapshot.set(owner.snapshot());
host.on<{ action: string; value?: unknown }>('desktop.header.services.control', event => {
  switch (event.action) {
    case 'tab': tab.set(event.value as DesktopHeaderServicesTab | null); break;
    case 'active': active.set(event.value === true); break;
    case 'authority': authority.set(event.value === true); break;
    case 'lane': laneID.set(Number(event.value)); break;
    case 'fail': fail = String(event.value || ''); break;
    case 'empty': empty = event.value === true; break;
    case 'unknown': unknown = event.value === true; break;
    case 'defer': deferred = event.value === true; break;
    case 'release': pending.splice(0).forEach(resolve => resolve()); break;
    case 'gate': gate = event.value === true; break;
    case 'language': language.set(String(event.value)); break;
    default: throw new Error('Unknown synthetic control');
  }
});
function Fixture() {
  audit('mount');
  effect(() => { const value = { tab: tab(), active: active() && lifecycle() === 'active' }; operation(); authority(); untracked(() => owner.update(value)); });
  cleanup(() => { owner.dispose(); audit('unmount'); });
  return <View class="flex-1 gap-2">
    <View class="flex-row gap-2"><Button testID="services-show-instance" onPress={() => tab.set('instance')}><Text>Instance</Text></Button><Button testID="services-show-mcp" onPress={() => tab.set('mcp')}><Text>MCP</Text></Button><Button testID="services-hide" onPress={() => tab.set(null)}><Text>Close</Text></Button></View>
    <If when={tab() === 'instance' || tab() === 'mcp'}><View testID="desktop-header-services-fixture-surface" class="bg-popover rounded-xl min-h-0" style={{ width: Math.min(432, windowSize().width - 24), maxHeight: windowSize().height * .75 }}>
      <If when={tab() === 'instance'}><NativeDesktopHeaderInstance owner={owner} snapshot={snapshot()!} /></If>
      <If when={tab() === 'mcp'}><NativeDesktopHeaderMcp owner={owner} snapshot={snapshot()!} directory="/synthetic/project" /></If>
    </View></If>
    <Input testID="services-composer" value={draft()} onChange={event => draft.set(event.value)} />
  </View>;
}
language.set('en'); mount(Fixture);
