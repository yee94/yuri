import { cleanup, lifecycle, mount, signal, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { createDesktopShortcutPreferences, type NativeShortcutCapture } from './desktop-shortcuts-core';
import { installNativeDesktopShortcuts } from './desktop-shortcuts';
import { DesktopShortcutsSettings } from './desktop-shortcuts-settings';

function Fixture() {
  const capture = signal<NativeShortcutCapture | null>(null), fail = signal(false), stored = signal('{}'), calls = signal(0), status = signal('loading');
  const preferences = createDesktopShortcutPreferences({ getItem: async () => null, setItem: async (_key, value) => { if (fail()) throw new Error('disk'); stored.set(value); } });
  const unsubscribe = preferences.subscribe(value => { if (value.ready) status.set('ready'); });
  cleanup(() => { unsubscribe(); preferences.dispose(); });
  const actions = () => ({ open_command_palette: { run: () => calls.set(calls() + 1) }, focus_input: { run: () => calls.set(calls() + 1) } });
  installNativeDesktopShortcuts({ actions, preferences, capture, enabled: () => lifecycle() === 'active', settingsOpen: () => true });
  return <View class="flex-1">
    <Text>{status()}</Text><Text>{`stored:${stored()}`}</Text><Text>{`calls:${calls()}`}</Text>
    <Button testID="failure" onPress={() => fail.set(!fail())}><Text>Failure</Text></Button>
    <DesktopShortcutsSettings preferences={preferences} actions={actions} capture={capture} onCaptureChange={value => capture.set(value)} />
  </View>;
}
mount(Fixture);
