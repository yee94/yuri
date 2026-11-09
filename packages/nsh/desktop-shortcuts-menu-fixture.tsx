import { cleanup, effect, keymap, mount, signal, Text, View } from 'nsh';
import { Button, Input } from 'nsh/base';
import { installNativeDesktopMenu } from './desktop';
import { installNativeDesktopShortcuts } from './desktop-shortcuts';
import type { NativeShortcutCapture } from './desktop-shortcuts-core';
import { UNASSIGNED_SHORTCUT } from '../ui/src/lib/shortcuts-core';
import { language } from './i18n';

function Fixture() {
  language.set('en');
  const overrides = signal<Record<string, string>>({}), ready = signal(true), claim = signal(false), settings = signal(false);
  const calls = signal(0), fallback = signal(0), source = signal('none'), owned = signal<readonly string[]>([]);
  const fallbackEnabled = signal(true);
  const capture = signal<NativeShortcutCapture | null>(null), captured = signal('none');
  effect(() => { if (fallbackEnabled()) cleanup(keymap.bind('mod+p', () => fallback.update(value => value + 1))); });
  const engine = installNativeDesktopShortcuts({ actions: () => ({ open_command_palette: { run: intent => { calls.update(value => value + 1); source.set(intent?.source ?? 'none'); } }, open_settings: { run: () => settings.set(!settings()) } }),
    enabled: ready, settingsOpen: settings, userOverrides: overrides, menuOwnedKeystrokes: owned, capture,
  });
  const menu = installNativeDesktopMenu(() => ({ search: { run: () => { engine.execute('open_command_palette'); }, disabled: settings() }, settings: { run: () => { engine.execute('open_settings'); } } }),
    { userOverrides: overrides, ready: () => ready() && !capture(), ownsAccelerators: claim });
  effect(() => owned.set(menu.ownedKeystrokes()));
  return <View class="p-3 gap-2">
    <Text>ready</Text><Text>{`calls:${calls()}`}</Text><Text>{`fallback:${fallback()}`}</Text><Text>{`owned:${JSON.stringify(menu.ownedKeystrokes())}`}</Text>
    <Text>{`source:${source()}`}</Text>
    <Text>{`captured:${captured()}`}</Text>
    <Text>{`shortcuts:${JSON.stringify(menu.items().flatMap(group => group.submenu).flatMap(item => 'type' in item || !item.onSelect ? [] : [item.shortcut ?? null]))}`}</Text>
    <Button testID="override" onPress={() => overrides.set({ open_command_palette: 'alt+f8' })}><Text>Override</Text></Button>
    <Button testID="native-override" onPress={() => overrides.set({ open_command_palette: 'mod+shift+k' })}><Text>Native override</Text></Button>
    <Button testID="editing-override" onPress={() => overrides.set({ open_command_palette: 'mod+c' })}><Text>Editing override</Text></Button>
    <Button testID="unassign" onPress={() => overrides.set({ open_command_palette: UNASSIGNED_SHORTCUT })}><Text>Unassign</Text></Button>
    <Button testID="restore" onPress={() => overrides.set({})}><Text>Restore</Text></Button>
    <Button testID="claim" onPress={() => claim.set(!claim())}><Text>Native accelerator ownership</Text></Button>
    <Button testID="physical-menu-mode" onPress={() => fallbackEnabled.set(false)}><Text>Remove headless fallback observer</Text></Button>
    <View class="flex-row gap-2">
      <Button testID="settings" onPress={() => settings.set(!settings())}><Text>Settings</Text></Button>
      <Button testID="capture" onPress={() => {
        settings.set(true);
        capture.set({ actionId: 'open_command_palette', onCapture: combo => { captured.set(combo ?? 'cancelled'); capture.set(null); } });
      }}><Text>Capture</Text></Button>
      <Button testID="menu" onPress={() => { void menu.popupApplication(); }}><Text>Menu</Text></Button>
    </View>
    <Input testID="menu-editor" accessibilityLabel="Menu editor fixture" />
  </View>;
}
mount(Fixture);
