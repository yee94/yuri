import { mount, signal, Storage, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { attachDesktopNavigationPersistence } from './desktop-navigation-state';
import {
  createDesktopNavigationPersistence, desktopNavigationStorageKey,
  type DesktopNavigationAuthority, type DesktopNavigationRestoreDecision, type DesktopNavigationTarget,
} from './desktop-navigation-state-core';

// Synthetic headless entry only. No production root, Host bridge, remote sessions or models.
const host = (id = 'A', origin = `https://${id.toLowerCase()}.example`, lease = 'lease-1'): DesktopNavigationAuthority => ({
  connection: { id, url: origin, authorizationID: 'auth-1' }, runtimeScope: { hostID: id, lease }, confirmed: true,
});
const target = (sessionID: string): DesktopNavigationTarget => ({ kind: 'session', sessionID, directory: '/project' });
function Fixture() {
  const generation = signal(0), mounted = signal(true), authority = signal<DesktopNavigationAuthority>({ ...host(), confirmed: false });
  const mode = signal<'ready' | 'hold' | 'fail'>('ready'), failRead = signal(false), failWrite = signal(false);
  const applied = signal('none'), disk = signal('unread'), calls = signal(0), writes = signal(0), close = signal('untried'), seeding = signal(false);
  let release: ((value: DesktopNavigationRestoreDecision) => void) | undefined;
  async function inspect() {
    const raw = await Storage.getItem(desktopNavigationStorageKey);
    if (!raw) { disk.set('empty'); return; }
    const row = JSON.parse(raw) as { entries: { partition: { connectionID: string; origin: string }; target: { sessionID?: string } }[] };
    disk.set(row.entries.map(entry => `${entry.partition.connectionID}@${entry.partition.origin}=${entry.target.sessionID}`).join('|'));
  }
  async function seed(empty = false) {
    seeding.set(true);
    await Storage.removeItem(desktopNavigationStorageKey);
    if (!empty) {
      // Seed through the actual core writer, not a second on-disk schema implementation.
      let selected = host();
      const writer = createDesktopNavigationPersistence({ storage: Storage, authority: () => selected,
        requestRestore: async route => ({ status: 'ready', target: route }), onRestore: () => false });
      writer.save(target('saved-A'), selected); selected = host('B'); writer.save(target('saved-B'), selected);
      await writer.flush(); await writer.dispose();
    }
    seeding.set(false); authority.set(host());
  }
  function Owner(props: { direct: boolean }) {
    const navigation = attachDesktopNavigationPersistence({ authority,
      ...(props.direct ? {} : { storage: {
        getItem: async (key: string) => { if (failRead()) throw new Error('synthetic read failure'); return Storage.getItem(key); },
        setItem: async (key: string, raw: string) => { writes.update(value => value + 1); if (failWrite()) throw new Error('synthetic write failure'); return Storage.setItem(key, raw); },
      } }),
      requestRestore: async (route, current) => {
        calls.update(value => value + 1);
        if (mode() === 'hold') return new Promise<DesktopNavigationRestoreDecision>(resolve => { release = resolve; });
        if (mode() === 'fail') throw Object.assign(new Error('synthetic GET failed'), { status: 503 });
        if (!current.current()) return { status: 'blocked' };
        return { status: 'ready', target: route };
      },
      onRestore: (route, current) => {
        if (!current.current()) return false;
        applied.set(route.kind === 'session' ? route.sessionID : route.kind); return true;
      },
    });
    return <View class="gap-1">
      <Text>{`restore:${navigation.state().restore}`}</Text><Text>{`write:${navigation.state().write}`}</Text>
      <Button testID="nav-user" onPress={() => { navigation.userNavigated(); applied.set('user'); navigation.save(target('user'), authority()); }}><Text>User navigation</Text></Button>
      <Button testID="nav-retry-restore" onPress={() => { mode.set('ready'); failRead.set(false); void navigation.retryRestore(); }}><Text>Retry restore read only</Text></Button>
      <Button testID="nav-close" onPress={() => { void navigation.close().then(result => close.set(String(result))); }}><Text>Close after flush</Text></Button>
      <Button testID="nav-flush" onPress={() => { void navigation.flush().then(() => inspect()); }}><Text>Flush and inspect</Text></Button>
    </View>;
  }
  return <View class="p-2 gap-1">
    <Text>navigation fixture ready</Text><Text>{`applied:${applied()}`}</Text><Text>{`calls:${calls()}`}</Text>
    <Text>{`writes:${writes()}`}</Text><Text>{`disk:${disk()}`}</Text><Text>{`close:${close()}`}</Text><Text>{`seeding:${seeding()}`}</Text>
    <If when={mounted()}><Each of={[generation()]} key={value => value}>{value => <Owner direct={value() > 0} />}</Each></If>
    <Button testID="nav-seed" onPress={() => { void seed(); }}><Text>Seed and adopt native Host</Text></Button>
    <Button testID="nav-empty" onPress={() => { void seed(true); }}><Text>Successful fresh empty</Text></Button>
    <Button testID="nav-hold" onPress={() => mode.set('hold')}><Text>Hold validation</Text></Button>
    <Button testID="nav-release" onPress={() => { mode.set('ready'); release?.({ status: 'ready', target: target('saved-A') }); release = undefined; }}><Text>Release old validation</Text></Button>
    <Button testID="nav-release-missing" onPress={() => { mode.set('ready'); release?.({ status: 'missing' }); release = undefined; }}><Text>Release stale missing</Text></Button>
    <Button testID="nav-fail-read" onPress={() => failRead.set(true)}><Text>Fail Storage read</Text></Button>
    <Button testID="nav-fail-lookup" onPress={() => mode.set('fail')}><Text>Fail lookup</Text></Button>
    <Button testID="nav-fail-write" onPress={() => failWrite.set(true)}><Text>Fail write</Text></Button>
    <Button testID="nav-recover-write" onPress={() => failWrite.set(false)}><Text>Recover write</Text></Button>
    <Button testID="nav-new-origin" onPress={() => authority.set(host('A', 'https://new.example'))}><Text>Same ID new origin</Text></Button>
    <Button testID="nav-unconfirmed" onPress={() => authority.set({ ...host(), runtimeScope: null })}><Text>Unconfirmed runtime scope</Text></Button>
    <Button testID="nav-churn" onPress={() => { for (let index = 0; index < 100; index++) authority.set(host(`host-${index}`)); authority.set(host('B')); }}><Text>Bounded Host churn to B</Text></Button>
    <Button testID="nav-inspect" onPress={() => { void inspect(); }}><Text>Inspect public metadata</Text></Button>
    <Button testID="nav-restart" onPress={() => { applied.set('none'); generation.update(value => value + 1); }}><Text>Reattach default NSH Storage</Text></Button>
  </View>;
}
mount(Fixture);
