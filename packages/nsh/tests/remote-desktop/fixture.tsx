import { cleanup, host, mount, safeArea, signal, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { NativeRemoteDesktopPage } from '../../remote-desktop';
import { native } from '../../runtime';
import { language } from '../../i18n';

language.set('en');
function DesktopFixture() {
  const active = signal(true), scope = signal('fixture:host:1'), closed = signal(false), snapshot = signal('');
  const uikit = host.params.remoteDesktopUIKitFixture === true;
  let reopen: ReturnType<typeof setTimeout> | undefined;
  const stopCounters = host.on('fixture.desktop.counters', value => snapshot.set(JSON.stringify(value)));
  cleanup(() => { stopCounters(); clearTimeout(reopen); });
  const counters = (path: string, method = 'GET') => {
    void native('runtime.request', { path, method }).then(value => snapshot.set(JSON.stringify(value)), error => snapshot.set(JSON.stringify({ fixtureError: String(error instanceof Error ? error.message : error) })));
  };
  return <View class="flex-1 bg-background" style={{ paddingTop: uikit ? safeArea().top : 0, paddingBottom: uikit ? safeArea().bottom : 0 }}>
    <View class="flex-row flex-wrap gap-2 px-2">
      <Button testID="fixture-hide" onPress={() => active.set(false)}><Text>Hide</Text></Button>
      <Button testID="fixture-show" onPress={() => active.set(true)}><Text>Show</Text></Button>
      <Button testID="fixture-host" onPress={() => scope.set('fixture:host:2')}><Text>Change Host</Text></Button>
      <Button testID="fixture-inspect" onPress={() => counters('/api/fixture/desktop')}><Text>Inspect</Text></Button>
    </View>
    <If when={uikit}><View class="flex-row gap-2 px-2">
      <Button testID="fixture-fail-input" onPress={() => counters('/api/fixture/desktop/fail-next-input', 'POST')}><Text>Fail next input</Text></Button>
      <Button testID="fixture-reopen" onPress={() => { closed.set(true); clearTimeout(reopen); reopen = setTimeout(() => closed.set(false), 50); }}><Text>Reopen page</Text></Button>
    </View></If>
    <Text testID="fixture-snapshot" accessibilityLabel={snapshot() || 'No fixture counters yet'} class="px-2 text-foreground" style={{ fontSize: 10 }}>{snapshot()}</Text>
    <If when={uikit}><Text testID="fixture-source-state" accessibilityLabel={`fixture active=${active()} closed=${closed()} scope=${scope()}`} class="px-2 text-muted-foreground" style={{ fontSize: 10 }}>{`fixture active=${active()} closed=${closed()} scope=${scope()}`}</Text></If>
    <If when={!closed()} else={<Text>Source page retained</Text>}><NativeRemoteDesktopPage scopeKey={scope()} active={active()} onClose={() => closed.set(true)} /></If>
  </View>;
}
mount(DesktopFixture);
