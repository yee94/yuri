import { mount, signal, Text, View } from 'nsh';
import { Button, Input } from 'nsh/base';
import { createDesktopLayout, NativeDesktopWorkspace } from '../../desktop-workspace';

function App() {
  const layout = createDesktopLayout(), draft = signal('');
  let mounts = 0;
  function Content() {
    mounts++;
    return <View class="flex-1"><Text>mounts:{mounts}</Text><Input testID="desktop-draft" value={draft()} onChange={event => draft.set(event.value)} /></View>;
  }
  return <NativeDesktopWorkspace layout={layout} titlebar={<View class="flex-row" style={{ height: 48 }}>
    <Button testID="toggle-sidebar" onPress={layout.toggleSidebar}><Text>sidebar</Text></Button>
    <Button testID="toggle-panel" onPress={layout.togglePanel}><Text>panel</Text></Button>
    <Button testID="expand-panel" onPress={() => layout.set({ panelExpanded: !layout.state().panelExpanded })}><Text>expand</Text></Button>
    <Button testID="toggle-terminal" onPress={layout.toggleTerminal}><Text>terminal</Text></Button>
  </View>} sidebar={<Text>sidebar-content</Text>} panel={<Text>panel-content</Text>} terminal={<Text>terminal-content</Text>}>
    <Content />
  </NativeDesktopWorkspace>;
}

mount(App);
