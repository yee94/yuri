/** Synthetic messages only; production body/tools and real NSH List, no model or history calls. */
import { computed, List, mount, signal, Text, View, type ListRef } from 'nsh';
import { Button } from 'nsh/base';
import { messageFrom, type Row } from './model';
import { nativeBodyRows } from './transcript-body-model';
import { NativeTranscriptBody } from './transcript-body';

function messages(status = 'completed', suffix = '') {
  const part = (id: string, value: string): Row => ({ id, type: 'text', text: value + suffix });
  return [
    messageFrom({ id: 'step', type: 'assistant', finish: 'tool-calls', content: [part('one', 'FIRST TEXT'), part('two', 'SECOND TEXT'), { id: 'call', type: 'tool', name: 'bash', state: { status, input: { command: `printf INPUT${suffix}` }, output: `OUTPUT${suffix}`, time: { start: 1000, end: 12400 }, ...(status === 'error' ? { error: `FAILURE${suffix}` } : {}) } }] })!,
    messageFrom({ id: 'final', type: 'assistant', finish: 'stop', content: [part('last', 'FINAL TEXT')] })!,
  ];
}
function App() {
  const source = signal(messages()), rows = computed(() => nativeBodyRows(source()));
  const collapse = signal(true), bodyHeight = signal(0);
  let list: ListRef | undefined;
  return <View class="flex-1">
    <View class="flex-row flex-wrap">
      <Button testID="replace" onPress={() => source.set(messages('completed', ' UPDATED'))}><Text>Replace</Text></Button>
      <Button testID="pending" onPress={() => source.set(messages('pending'))}><Text>Pending</Text></Button>
      <Button testID="error" onPress={() => source.set(messages('error'))}><Text>Error</Text></Button>
      <Button testID="grow" onPress={() => source.set([...Array.from({ length: 40 }, (_, index) => messageFrom({ id: `filler-${index}`, type: index % 2 ? 'assistant' : 'user', text: `ROW ${index}` })!), ...messages()])}><Text>Grow</Text></Button>
      <Button testID="tail" onPress={() => list?.scrollToEnd({ animated: false })}><Text>Tail</Text></Button>
      <Button testID="start" onPress={() => list?.scrollToIndex({ index: 0, animated: false })}><Text>Start</Text></Button>
      <Button testID="user-long" onPress={() => source.set([messageFrom({ id: 'long-user', type: 'user', content: [{ id: 'long-text', type: 'text', text: Array.from({ length: 16 }, (_, index) => `Original line ${index + 1} with full source retained.`).join('\n\n') }, { id: 'file', type: 'file', filename: 'retained.txt', mime: 'text/plain' }] })!])}><Text>Long user</Text></Button>
      <Button testID="user-short" onPress={() => source.set([messageFrom({ id: 'short-user', type: 'user', content: [{ id: 'short-text', type: 'text', text: 'Short original' }] })!])}><Text>Short user</Text></Button>
      <Button testID="user-replace" onPress={() => source.set([messageFrom({ id: 'long-user', type: 'user', content: [{ id: 'replacement-text', type: 'text', text: 'Replacement short original' }, { id: 'file', type: 'file', filename: 'replacement.txt', mime: 'text/plain' }] })!])}><Text>Replace user</Text></Button>
      <Button testID="preference" onPress={() => collapse.set(!collapse())}><Text>Preference</Text></Button>
      <Button testID="numbered" onPress={() => source.set([messageFrom({ id: 'numbered', type: 'assistant', content: [{ id: 'numbered-text', type: 'text', text: Array.from({ length: 8 }, (_, index) => `${index + 9}. Integer ${index + 9}`).join('\n') }] })!])}><Text>Numbered</Text></Button>
    </View>
    <Text testID="body-measure">{`BODY_HEIGHT:${bodyHeight().toFixed(1)}`}</Text>
    <List class="flex-1" testID="body-list" each={rows()} keyExtractor={row => row.key} ref={node => { list = node; }}>
      {row => <View onLayout={event => bodyHeight.set(event.bounds.size.height)}><NativeTranscriptBody row={row()} collapsibleUserMessages={collapse()} target={{ kind: 'session', id: 'fixture', directory: '/workspace/project', title: 'Fixture' }} current={() => true} renderCard={card => <Text>{String(card.id)}</Text>} /></View>}
    </List>
  </View>;
}
mount(App);
