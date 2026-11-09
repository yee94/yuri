import { lifecycle, mount, signal, Text, View } from 'nsh';
import { Button, createNavStack, NavPage, NavStack } from 'nsh/base';
import { NativeDesktopCommandPalette } from './desktop-command-palette';
import { installNativeDesktopShortcuts } from './desktop-shortcuts';
import { loadConnections, app } from './state';
import { request } from './runtime';

function Fixture() {
  const open = signal(false), selected = signal('none'), closedFirst = signal(false), selections = signal(0), audit = signal(''), focus = signal<string | undefined>('/workspace/focus');
  const nav = createNavStack([{ kind: 'product' }]);
  const result = (value: string) => { closedFirst.set(!open()); selections.set(selections() + 1); selected.set(value); };
  const commands = [
    ...Array.from({ length: 8 }, (_, index) => ({ id: `c${index}`, title: `Needle command ${index}`, group: 'commands' as const, onSelect: () => result(`command:${index}`) })),
    ...Array.from({ length: 8 }, (_, index) => ({ id: `s${index}`, title: `Needle setting ${index}`, group: 'settings' as const, onSelect: () => result(`setting:${index}`) })),
  ];
  installNativeDesktopShortcuts({ actions: () => ({ open_command_palette: { run: () => open.set(!open()) } }), enabled: () => lifecycle() === 'active',
    settingsOpen: () => false, userOverrides: () => ({}), scope: () => app.connection()?.id });
  return <View class="flex-1">
    <Text>ready</Text><Text>{`selected:${selected()}`}</Text><Text>{`closedFirst:${closedFirst()}`}</Text><Text>{`selections:${selections()}`}</Text><Text>{audit()}</Text>
    <Button testID="palette-audit" onPress={async () => audit.set(JSON.stringify(await request('/api/fixture/palette/audit')))}><Text>Audit</Text></Button>
    <Button testID="palette-focus" onPress={() => focus.set(focus() ? undefined : '/workspace/focus')}><Text>Focus</Text></Button>
    <NavStack state={nav} class="flex-1">{() => <NavPage title="Product route"><Text testID="product-route">Product route retained</Text></NavPage>}</NavStack>
    <NativeDesktopCommandPalette open={open()} onClose={() => open.set(false)} active={lifecycle() === 'active'} scope={app.connection()?.id} commands={commands}
      focusDirectory={focus()} projects={[{ id: 'p1', name: 'Needle project', path: '/project/needle' }]} onOpenProject={project => result(`project:${project.id}`)}
      onOpenChat={(target, options) => result(`chat:${target.id}:${options?.messageID ?? 'title'}`)} onOpenFile={(directory, path) => result(`file:${directory}:${path}`)} />
  </View>;
}
function App() { void loadConnections(); return <If when={!!app.connection()}><Fixture /></If>; }
mount(App);
