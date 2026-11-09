import { host, mount, signal, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { NativeDesktopTerminalDock } from './desktop-terminal';
import { language } from './i18n';

/** Synthetic carrier only: no application, credentials, network or PTY. */
function Fixture() {
  language.set('en');
  const scope = signal({ hostID: 'synthetic-a', lease: 'lease-a' }), active = signal(true), expanded = signal(false), closed = signal(0), calls = signal<string[]>([]);
  host.on('desktop-terminal-fixture.calls', value => { if (Array.isArray(value) && value.every(item => typeof item === 'string')) calls.set(value as string[]); });
  return <View class="flex-1 bg-background">
    <View style={{ height: 300 }}><NativeDesktopTerminalDock scope={scope()} directory="/synthetic" current={() => true} active={active()} expanded={expanded()} onToggleExpanded={() => expanded.set(!expanded())} onClose={() => { closed.set(closed() + 1); active.set(false); }} /></View>
    <Text>{`terminal-fixture:${JSON.stringify({ expanded: expanded(), closed: closed(), calls: calls() })}`}</Text>
    <Button testID="terminal-fixture-active" onPress={() => active.set(!active())}><Text>fixture active</Text></Button>
    <Button testID="terminal-fixture-scope" onPress={() => scope.set({ hostID: 'synthetic-b', lease: 'lease-b' })}><Text>fixture scope</Text></Button>
  </View>;
}
mount(Fixture);
