import { cleanup, computed, effect, lifecycle, List, mount, safeArea, signal, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { createNativeHistoryRows } from './history-rows';
import { createNativeHistoryScroll } from './history-scroll';
import { createHistoryUIKitScenario, fixtureCounters, marker, ordinalOf, rowHeight, TOTAL_PAGES } from './tests/history-uikit/scenario';

// Test instrumentation, not product UI. No application/state/appearance/Host imports.
mount(() => {
  const scenario = createHistoryUIKitScenario(value => snapshot.set(value));
  const snapshot = signal(scenario.snapshot());
  const armed = signal(false), drags = signal(0), heldPrepends = signal(0);
  const project = createNativeHistoryRows();
  const rows = computed(() => project(snapshot().messages));
  const current = () => lifecycle() === 'active';
  const historyScroll = createNativeHistoryScroll({
    current, loading: () => snapshot().loading,
    more: () => snapshot().page < TOTAL_PAGES, error: () => snapshot().error,
    loadOlder: scenario.loadOlder, loadLatest: scenario.loadLatest,
  });
  effect(() => { if (!current()) historyScroll.reset(); });
  cleanup(() => { historyScroll.reset(); scenario.dispose(); });
  const counters = computed(() => JSON.stringify({ ...fixtureCounters(snapshot()), drags: drags(), armed: armed(), heldPrepends: heldPrepends() }));
  effect(() => { console.info(`HISTORY_UIKIT ${counters()}`); });
  const action = 'min-h-9 px-2 py-1 bg-secondary rounded-lg items-center justify-center disabled:opacity-40';
  return <View class="flex-1 bg-background" style={{ paddingTop: safeArea().top, paddingBottom: safeArea().bottom }}>
    <View class="px-3 py-2 gap-1" style={{ height: 144 }}>
      <Text class="text-foreground">UIKit 历史专项 · 仅合成数据</Text>
      <Text testID="history-uikit-counters" accessibilityLabel={counters()} class="text-foreground" style={{ fontSize: 10 }}>{counters()}</Text>
    </View>
    <List
      testID="transcript"
      class="flex-1"
      contentClass="px-3 pt-[26px] pb-4 gap-5"
      inverted
      onScrollDragStart={event => {
        drags.set(drags() + 1);
        if (armed() && !snapshot().loading && current()) {
          armed.set(false); heldPrepends.set(heldPrepends() + 1);
          // The production owner sees this flight and cannot spend a second page budget.
          void scenario.loadOlder();
        }
        historyScroll.onScrollDragStart(event);
      }}
      onScroll={historyScroll.onScroll}
      onScrollEnd={historyScroll.onScrollEnd}
      onLoadMore={historyScroll.onLoadMore}
      loadMoreThreshold={0.5}
      onLoadMoreAtStart={historyScroll.onLoadMoreAtStart}
      footer={() => <View class="gap-2">
        <If when={snapshot().page < TOTAL_PAGES}><Button testID="history-load-older" class={action} disabled={snapshot().loading} onPress={() => { void scenario.loadOlder(); }}><Text class="text-foreground">{snapshot().loading ? '载入中' : snapshot().error ? '手动重试' : '载入较早记录'}</Text></Button></If>
        <If when={snapshot().error}><Text testID="history-page-error" class="text-destructive">{snapshot().error}</Text></If>
      </View>}
      each={rows()}
      keyExtractor={row => row.key}
      keyboardDismissMode="interactive"
    >
      {row => <View class="gap-2" style={{ height: rowHeight(row().head) + (snapshot().grown.includes(row().head.id) ? 160 : 0) }}>
        <Text testID={marker(ordinalOf(row().head))} accessibilityLabel={marker(ordinalOf(row().head))} class="text-muted-foreground" style={{ fontSize: 12 }}>{marker(ordinalOf(row().head))}</Text>
        <Text class="text-foreground">{row().head.text}</Text>
        <If when={snapshot().grown.includes(row().head.id)}><Text class="text-muted-foreground">迟到内容 · 此行增加 160pt，marker 身份不变</Text></If>
      </View>}
    </List>
    <View class="px-3 py-2 gap-1" style={{ height: 152 }}>
      <View class="flex-row gap-2">
        <Button testID="fixture-older" class={action} disabled={snapshot().loading || snapshot().page === TOTAL_PAGES} onPress={() => { void scenario.loadOlder(); }}><Text class="text-foreground">{snapshot().error ? '手动重试' : '手动前插'}</Text></Button>
        <Button testID="fixture-fail" class={action} onPress={scenario.failNext}><Text class="text-foreground">{snapshot().failNext ? '已设下页失败' : '下页失败'}</Text></Button>
        <Button testID="fixture-delay" class={action} onPress={scenario.toggleDelay}><Text class="text-foreground">{`延迟 ${snapshot().delayMs}ms`}</Text></Button>
      </View>
      <View class="flex-row gap-2">
        <Button testID="fixture-grow" class={action} onPress={scenario.growLater}><Text class="text-foreground">迟到增高</Text></Button>
        <Button testID="fixture-tail" class={action} onPress={scenario.appendTail}><Text class="text-foreground">新增尾部</Text></Button>
        <Button testID="fixture-held-prepend" class={action} disabled={snapshot().loading || snapshot().page === TOTAL_PAGES} onPress={() => armed.set(!armed())}><Text class="text-foreground">{armed() ? '已等待拖动' : '拖动期间前插'}</Text></Button>
      </View>
      <Text class="text-muted-foreground" style={{ fontSize: 11 }}>开启前插后，下一次真实拖动开始请求；按住超过延迟再松手。</Text>
    </View>
  </View>;
});
