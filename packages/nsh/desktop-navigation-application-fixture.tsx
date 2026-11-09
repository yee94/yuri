import { mount, signal, Storage, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { attachDesktopNavigationApplication } from './desktop-navigation-application';
import { desktopNavigationStorageKey } from './desktop-navigation-state-core';
import { loadConnections } from './state';

// Independent headless entry. The only Host comes from nsh/test's synthetic handlers.
function Fixture() {
  const applied = signal('none'), appliedCount = signal(0), failWrite = signal(false), disk = signal('unread');
  const navigation = attachDesktopNavigationApplication({
    storage: { getItem: key => Storage.getItem(key), setItem: (key, raw) => { if (failWrite()) return Promise.reject(new Error('synthetic full Storage')); return Storage.setItem(key, raw); } },
    rawApply: (resource, context) => {
      if (!context.current()) return false;
      appliedCount.set(appliedCount() + 1);
      applied.set(resource.kind === 'session' || resource.kind === 'assistant' ? resource.target.title : resource.kind); return true;
    },
  });
  async function start() {
    await Storage.setItem(desktopNavigationStorageKey, JSON.stringify({ version: 1, entries: [{
      partition: { connectionID: 'A', origin: 'https://a.example', authorizationID: 'auth-A' },
      target: { kind: 'session', sessionID: 'saved', directory: '/project' },
    }] }));
    await loadConnections();
  }
  async function inspect() {
    const raw = await Storage.getItem(desktopNavigationStorageKey);
    const parsed = raw ? JSON.parse(raw) as { entries: Array<{ target: { kind: string } }> } : null;
    disk.set(parsed?.entries.map(entry => entry.target.kind).join(',') || 'empty');
  }
  return <View class="p-2 gap-1">
    <Text>production binder ready</Text><Text>{`restore:${navigation.state().restore}`}</Text><Text>{`write:${navigation.state().write}`}</Text>
    <Text>{`applied:${applied()}`}</Text><Text>{`applies:${appliedCount()}`}</Text><Text>{`slot:${navigation.pendingResolvedCount()}`}</Text><Text>{`disk:${disk()}`}</Text>
    <Button testID="nav-app-start" onPress={() => { void start(); }}><Text>Adopt synthetic native snapshot</Text></Button>
    <Button testID="nav-app-reload" onPress={() => { void loadConnections(); }}><Text>Read synthetic native authority again</Text></Button>
    <Button testID="nav-app-user" onPress={() => {
      navigation.userNavigated(); const captured = navigation.captureAuthority(); applied.set('user');
      if (captured) navigation.saveRoute({ kind: 'root' }, captured, '/chosen');
    }}><Text>User navigation</Text></Button>
    <Button testID="nav-app-retry" onPress={() => { void navigation.retryRestore(); }}><Text>Retry read</Text></Button>
    <Button testID="nav-app-fail-write" onPress={() => failWrite.set(true)}><Text>Fail metadata write</Text></Button>
    <Button testID="nav-app-flush" onPress={() => { failWrite.set(false); void navigation.flush().then(inspect); }}><Text>Retry metadata flush</Text></Button>
    <Button testID="nav-app-inspect" onPress={() => { void inspect(); }}><Text>Inspect public projection only</Text></Button>
  </View>;
}
mount(Fixture);
