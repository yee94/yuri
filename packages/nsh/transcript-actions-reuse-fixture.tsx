/** Engine-only fixture: production List/actions/header, no history writes or model calls. */
import { List, mount, signal, Text, View, type ListRef } from 'nsh';
import { Button } from 'nsh/base';
import { createChat, loadConnections } from './state';
import { messageFrom, type Message } from './model';
import { createNativeTranscriptHistory, NativeMessageActions } from './transcript-actions';
import { NativeTurnHeader } from './transcript-tools-turn';

const ready = signal(false);
void loadConnections().then(() => ready.set(true));
function row(id: string, role: string, content: string): Message {
  return messageFrom({ id, type: role, text: content, finish: 'stop', model: { id: 'gpt-6.1-sol', variant: 'high' }, agent: 'build' })!;
}
function Scene() {
  const target = { kind: 'session' as const, id: 'ses_1', directory: '/workspace/project', title: 'Role reuse fixture' };
  const chat = createChat(target);
  const history = createNativeTranscriptHistory({ chat, target, current: () => true, key: 'fixture-reuse', storageKey: 'fixture-reuse', onOpenChat: () => {} });
  const rows = signal([row('u', 'user', 'USER BODY'), row('a', 'assistant', 'ASSISTANT BODY')]);
  let ref: ListRef | undefined;
  return <View class="flex-1">
    <View class="flex-row">
      <Button testID="reuse" onPress={() => rows.set(rows().map(value => row(value.id, value.role === 'user' ? 'assistant' : 'user', `UPDATED ${value.id}`)))}><Text>Reuse</Text></Button>
      <Button testID="reverse" onPress={() => rows.set([...rows()].reverse())}><Text>Reverse</Text></Button>
      <Button testID="grow" onPress={() => rows.set([...Array.from({ length: 40 }, (_, i) => row(`filler-${i}`, i % 2 ? 'assistant' : 'user', `FILLER ${i}`)), ...rows()])}><Text>Grow</Text></Button>
      <Button testID="tail" onPress={() => ref?.scrollToEnd({ animated: false })}><Text>Tail</Text></Button>
      <Button testID="start" onPress={() => ref?.scrollToIndex({ index: 0, animated: false })}><Text>Start</Text></Button>
    </View>
    <List testID="role-list" class="flex-1" each={rows()} keyExtractor={message => message.id} ref={node => { ref = node; }}>
      {item => <View testID={`row-${item().id}-${item().role}`} style={{ minHeight: 140 }}>
        <If when={item().role !== 'user'}><NativeTurnHeader message={item()} modelName={`MODEL ${item().id}`} /></If>
        <Text testID={`body-${item().id}-${item().role}`}>{item().text}</Text>
        <NativeMessageActions history={history} message={item} />
      </View>}
    </List>
  </View>;
}
export default function App() { return <View class="flex-1"><If when={ready()}><Scene /></If></View>; }
mount(App);
