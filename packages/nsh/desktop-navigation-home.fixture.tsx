import { host, mount, signal, Storage, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { attachDesktopNavigationApplication } from './desktop-navigation-application';
import { desktopNavigationStorageKey } from './desktop-navigation-state-core';
import { captureHostOperation, loadConnections } from './state';

/** One production adapter, with only synthetic nsh/test GET handlers. */
function Fixture() {
  const applied = signal('none'), count = signal(0), disk = signal('unread');
  const held = signal(false);
  let holdSnapshot = host.params.holdSnapshot === true, release: (() => void) | undefined;
  const navigation = attachDesktopNavigationApplication({ captureOperation: () => {
    const operation = captureHostOperation();
    return { ...operation, request: async path => {
      const response = await operation.request(path);
      if (holdSnapshot) { held.set(true); await new Promise<void>(resolve => { release = resolve; }); }
      return response;
    } };
  }, rawApply: (resource, context) => {
    if (!context.current() || resource.kind !== 'home') return false;
    count.set(count() + 1); applied.set(resource.section); return true;
  } });
  void loadConnections();
  return <View><Text>{`restore:${navigation.state().restore}`}</Text><Text>{`applied:${applied()}`}</Text><Text>{`applies:${count()}`}</Text><Text>{`slot:${navigation.pendingResolvedCount()}`}</Text><Text>{`disk:${disk()}`}</Text><Text>{held() ? 'snapshot:held' : 'snapshot:free'}</Text>
    <Button testID="home-read-retry" onPress={() => { void navigation.retryRestore(); }}><Text>Retry read</Text></Button>
    <Button testID="home-user-schedules" onPress={() => {
      navigation.userNavigated(); const authority = navigation.captureAuthority(); applied.set('user-schedules');
      if (authority) navigation.save({ kind: 'home', section: 'schedules' }, authority);
    }}><Text>Choose schedules</Text></Button>
    <Button testID="home-release-snapshot" onPress={() => { holdSnapshot = false; release?.(); held.set(false); }}><Text>Release captured snapshot</Text></Button>
    <Button testID="home-inspect" onPress={() => { void navigation.flush().then(() => Storage.getItem(desktopNavigationStorageKey)).then(raw => disk.set(raw ?? 'empty')); }}><Text>Inspect public metadata</Text></Button>
  </View>;
}
mount(Fixture);
