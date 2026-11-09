import { cleanup, host, lifecycle, mount, signal, Text, View } from 'nsh';
import { Button, Input } from 'nsh/base';
import { app } from './state';
import { createPageOperations } from './page-operations';
import { admitSettingsFixture } from './settings-raw-fixture-bootstrap';
import { createNativeDesktopHeaderGitHubRoot } from './desktop-header-github-root';
import { createNativeDesktopSettingsRoot } from './desktop-settings-root';
import { DesktopHeaderGitHub } from './desktop-header-github-view';
import { language } from './i18n';

function Fixture() {
  language.set('en');
  const ready = signal(false);
  void admitSettingsFixture().then(() => ready.set(true));
  return <If when={ready()}><Ready /></If>;
}
function Ready() {
  const directory = signal('/fixture/a'), input = signal(''), audit = signal('');
  let settings: ReturnType<typeof createNativeDesktopSettingsRoot> | undefined, mounts = 0, serial = 0;
  const operations = createPageOperations(() => !settings?.isOpen());
  const github = createNativeDesktopHeaderGitHubRoot({
    committed: () => { const scope = app.runtimeScope(), connection = app.connection(); return scope && connection ? { host: scope, authorityKey: JSON.stringify([connection.id, connection.url, connection.authorizationID]), directory: directory() } : null; },
    current: operations.displayCurrent, operation: operations.operation,
    active: () => lifecycle() === 'active' && !settings?.isOpen(),
    interactive: () => lifecycle() === 'active' && !settings?.isOpen(), open: async () => false,
  });
  settings = createNativeDesktopSettingsRoot({ callbacks: { onConnect() {} }, retention: () => undefined, onError() {},
    desktopGitHub: host.params.shared === false ? undefined : context => { mounts++; return github.settings(context); },
  });
  const root = settings;
  cleanup(host.on('desktop-github-root.control', payload => {
    const event = payload as { action: string; value?: string };
    if (event.action === 'directory') { directory.set(event.value ?? '/fixture/a'); github.reconcile(); }
    if (event.action === 'audit') audit.set(JSON.stringify({ serial: ++serial, mounts, open: root.isOpen(), canClose: github.canClose(), login: github.state().projection?.login, pending: github.state().pending, issue: github.state().issue }));
  }));
  return <View class="flex-1 bg-background gap-2">
    <Text testID="github-root-ready">Ready</Text>
    <Input testID="github-root-input" value={input()} onChange={event => input.set(event.value)} />
    <Button testID="github-root-ensure" onPress={() => { void github.header.ensure(); }}><Text>Ensure</Text></Button>
    <Button testID="github-root-refresh" onPress={() => { void github.header.refresh(); }}><Text>Refresh</Text></Button>
    <Button testID="github-root-settings" onPress={() => { void root.open({ page: 'git', directory: directory() }); }}><Text>Settings</Text></Button>
    <Button testID="github-root-close" onPress={() => { void root.close(); }}><Text>Close</Text></Button>
    <Text>{'github-root-audit:' + audit()}</Text>
    <DesktopHeaderGitHub port={github.header} />
    <root.Root />
  </View>;
}
mount(Fixture);
