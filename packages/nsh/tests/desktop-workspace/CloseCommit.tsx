import { cleanup, mount, signal, Text, View } from 'nsh';
import { Button, Input } from 'nsh/base';
import { createDesktopWindowCloseOwner } from '../../desktop-window-close-core';

function App() {
  const locked = signal(false), text = signal('retained settings draft'), error = signal('');
  let reject: ((reason: Error) => void) | undefined, generation = 0;
  const close = createDesktopWindowCloseOwner({ scope: () => 'fixture-authority', requestFiles: async () => true, requestSettings: async () => true,
    canCloseFiles: () => true, onCommitting: value => locked.set(value), onError: value => error.set(String(value)),
    decide: async () => new Promise((_resolve, rejectDecision) => { reject = rejectDecision; }),
  });
  cleanup(close.dispose);
  return <View class="flex-1">
    <View testID="fixture-window-boundary" class="flex-1" disabled={locked()}>
      <Input testID="fixture-settings-input" value={text()} onChange={event => text.set(event.value)} />
      <Button testID="fixture-close" onPress={() => { generation++; void close.request({ windowID: 'fixture-window', ticket: `fixture:${generation}`, generation, reason: 'close' }); }}><Text>close</Text></Button>
    </View>
    <Text>{locked() ? 'commit-locked' : 'editable'}</Text><Text>{error()}</Text>
    <Button testID="fixture-native-reject" onPress={() => { reject?.(new Error('native ticket expired')); }}><Text>native rejection</Text></Button>
  </View>;
}
mount(App);
