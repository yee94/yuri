import { mount, signal, Text, View } from 'nsh';
import { Button, Input } from 'nsh/base';
import { NativeComposerSelection } from './chat-composer-selection';
import { loadConnections } from './state';
import { request } from './runtime';

function SelectionFixture() {
  const ready = signal(false);
  void loadConnections().then(() => ready.set(true));
  const open = signal<'model' | 'agent' | null>(null), active = signal(true), draft = signal(''), blurs = signal(0);
  return <View class="flex-1 p-4 gap-3">
    <Input testID="fixture-composer" value={draft()} onChange={event => draft.set(event.value)} onBlur={() => blurs.set(blurs() + 1)} />
    <Text>{`Input blur count: ${blurs()}`}</Text>
    <Button testID="fixture-hide" onPress={() => active.set(false)}><Text>Hide page</Text></Button>
    <Button testID="fixture-show" onPress={() => active.set(true)}><Text>Show page</Text></Button>
    <Button testID="fixture-host-change" onPress={() => { void loadConnections({ forceReconnect: true }); }}><Text>Change Host fixture</Text></Button>
    <Button testID="fixture-release" onPress={() => { void request('/fixture/release'); }}><Text>Release deferred write</Text></Button>
    <If when={ready()}><NativeComposerSelection target={{ kind: 'session', id: 'selection-session', title: 'Selection fixture', directory: '/fixture/project' }} active={active()} open={open()} onOpenChange={value => open.set(value)} onAssistantEdit={() => {}} /></If>
  </View>;
}
mount(SelectionFixture);
