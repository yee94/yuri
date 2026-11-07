import { List, mount, signal, Text, View, windowSize, type ViewRef } from 'nsh';
import { Button } from 'nsh/base';
import { createNativeHistoryRows } from './history-rows';
import { createNativeHistoryScroll } from './history-scroll';
import { messageFrom } from './model';

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const page = (start: number) => Array.from({ length: 20 }, (_, offset) => messageFrom({ id: `row-${start + offset}`, type: (start + offset) % 2 ? 'assistant' : 'user', text: `History ${start + offset}` })!);

mount(() => {
  const messages = signal(page(200)), loading = signal(false), adopted = signal(0), worst = signal(0), measured = signal(0);
  const project = createNativeHistoryRows();
  const cells: { ref: ViewRef; key: () => string }[] = [];
  let first = 200;
  async function loadOlder() {
    if (loading() || first <= 0) return;
    loading.set(true);
    // Finish the user's actual drag before measuring passive adoption drift.
    await wait(900);
    const candidates = await Promise.all(cells.map(async cell => ({ ...cell, identity: cell.key(), frame: await cell.ref.measure() })));
    const anchor = candidates.find(cell => cell.frame && cell.frame.pagePosition.y > 100 && cell.frame.pagePosition.y < windowSize().height - 200);
    if (!anchor?.frame) throw new Error('No visible reading anchor at page adoption');
    const baseline = anchor.frame.pagePosition.y;
    first -= 20;
    messages.set([...page(first), ...messages()]);
    for (let frame = 0; frame < 30; frame++) {
      await wait(16);
      const cell = cells.find(cell => cell.key() === anchor.identity);
      const after = await cell?.ref.measure();
      if (!after) throw new Error('Reading anchor disappeared during adoption');
      worst.set(Math.max(worst(), Math.abs(after.pagePosition.y - baseline)));
      measured.set(measured() + 1);
    }
    adopted.set(adopted() + 1); loading.set(false);
  }
  const intent = createNativeHistoryScroll({ current: () => true, loading, more: () => first > 0, error: () => '', loadOlder, loadLatest: async () => {} });
  return <View class="flex-1 bg-background">
    <View style={{ height: 100 }}><Text>{`adoptions:${adopted()}`}</Text><Text>{`drift:${worst()}`}</Text><Text>{`measurements:${measured()}`}</Text></View>
    <List testID="history-layout-list" class="flex-1" inverted each={project(messages())} keyExtractor={row => row.key} onScrollDragStart={intent.onScrollDragStart} onScroll={intent.onScroll} onScrollEnd={intent.onScrollEnd} onLoadMore={intent.onLoadMore} loadMoreThreshold={.5} onLoadMoreAtStart={intent.onLoadMoreAtStart}>
      {row => <View ref={ref => cells.push({ ref, key: () => row().key })} class="px-3 py-2" style={{ height: 70 + Number(row().head.id.slice(4)) % 4 * 15 }}><Text class="text-foreground">{row().head.text}</Text></View>}
    </List>
    <View style={{ height: 100 }}><Button testID="history-layout-manual" disabled={loading()} onPress={() => { void loadOlder(); }}><Text>Load while reading</Text></Button></View>
  </View>;
});
