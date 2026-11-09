import { computed, List, mount, signal, Text, View, windowSize, type ViewRef } from 'nsh';
import { Button } from 'nsh/base';
import { createNativeHistoryRows } from './history-rows';
import { messageFrom } from './model';

const page = (start: number) => Array.from({ length: 20 }, (_, i) => messageFrom({ id: `step-${start + i}`, type: 'assistant', text: `Step ${start + i}` })!);

// One group crosses page boundaries: its key survives, but its row object changes.
mount(() => {
  const messages = signal(page(200)), loading = signal(false), adopted = signal(0), drift = signal(0), measured = signal(0);
  const project = createNativeHistoryRows();
  const bodyRows = computed(() => project(messages()));
  const bodyRowKeys = computed(() => bodyRows().map(row => row.key));
  const bodyRowsByKey = computed(() => new Map(bodyRows().map(row => [row.key, row])));
  const refs = new Map<string, ViewRef>();
  let first = 200;
  async function loadOlder() {
    if (loading() || first <= 40) return;
    loading.set(true);
    const frames = await Promise.all([...refs].map(async ([id, ref]) => ({ id, frame: await ref.measure() })));
    const anchor = frames.find(cell => cell.frame && cell.frame.pagePosition.y > 120 && cell.frame.pagePosition.y < windowSize().height - 200);
    if (!anchor?.frame) throw new Error('No visible grouped reading anchor');
    const baseline = anchor.frame.pagePosition.y;
    first -= 20;
    messages.set([...page(first), ...messages()]);
    for (let frame = 0; frame < 30; frame++) {
      await new Promise<void>(done => setTimeout(done, 16));
      const after = await refs.get(anchor.id)?.measure();
      if (!after) throw new Error('Grouped reading anchor disappeared');
      drift.set(Math.max(drift(), Math.abs(after.pagePosition.y - baseline)));
      measured.set(measured() + 1);
    }
    adopted.set(adopted() + 1); loading.set(false);
  }
  return <View class="flex-1 bg-background">
    <View style={{ height: 100 }}><Text>{`adoptions:${adopted()}`}</Text><Text>{`drift:${drift()}`}</Text><Text>{`measurements:${measured()}`}</Text></View>
    <List testID="grouped-list" class="flex-1" inverted each={bodyRowKeys()} keyExtractor={key => key} onLoadMoreAtStart={() => {}}>
      {key => <If when={bodyRowsByKey().get(key())}>{row => <View><Each of={row().messages} key={message => message.id}>{message =>
        <View ref={ref => refs.set(message().id, ref)} style={{ height: 70 + Number(message().id.slice(5)) % 4 * 15 }}><Text>{message().text}</Text></View>
      }</Each></View>}</If>}
    </List>
    <View style={{ height: 100 }}>
      <Button testID="grouped-load-older" disabled={loading()} onPress={() => { void loadOlder(); }}><Text>Load older group</Text></Button>
      <Button testID="grouped-load-eight" disabled={loading() || adopted() > 0} onPress={async () => { for (let page = 0; page < 8; page++) await loadOlder(); }}><Text>Load eight grouped pages</Text></Button>
    </View>
  </View>;
});
