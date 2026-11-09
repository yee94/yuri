import { cleanup, lifecycle, mount, signal, Text, View } from 'nsh';
import { Button, Input } from 'nsh/base';
import { NativeDesktopCommandPaletteAdapter } from './desktop-command-palette';
import { installNativeDesktopShortcuts } from './desktop-shortcuts';

function Fixture() {
  const open = signal(false), scope = signal(0), mounts = signal(0), disposed = signal(0), selected = signal(0), composing = signal(false);
  let stale: (() => void) | undefined;
  installNativeDesktopShortcuts({ actions: () => ({ open_command_palette: { run: () => open.set(!open()) } }), enabled: () => lifecycle() === 'active',
    settingsOpen: () => false, composing, scope, userOverrides: () => ({}) });
  return <View class="flex-1">
    <Text>ready</Text><Text>{`open:${open()}`}</Text><Text>{`mounts:${mounts()}`}</Text><Text>{`disposed:${disposed()}`}</Text><Text>{`selected:${selected()}`}</Text>
    <Button testID="stale" onPress={() => stale?.()}><Text>Stale</Text></Button>
    <NativeDesktopCommandPaletteAdapter open={open()} active={lifecycle() === 'active'} scope={scope()} composing={composing()} onOpenChange={value => open.set(value)} renderSearch={adapter => {
      mounts.set(mounts() + 1);
      cleanup(() => disposed.set(disposed() + 1));
      stale = () => adapter.select(() => selected.set(selected() + 1));
      return <View class="flex-1 gap-3 p-4"><Input testID="search-content-input" autoFocus onCompositionChange={event => composing.set(event.composing)} />
        <Button testID="scope" onPress={() => scope.set(scope() + 1)}><Text>Scope</Text></Button>
        <Button testID="search-content-select" onPress={() => adapter.select(() => selected.set(selected() + 1))}><Text>Choose</Text></Button></View>;
    }} />
  </View>;
}
mount(Fixture);
