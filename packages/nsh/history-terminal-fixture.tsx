import { batch, cleanup, computed, effect, host, lifecycle, List, mount, safeArea, signal, Text, untracked, View, type ViewRef } from 'nsh';
import { Button, TextView } from 'nsh/base';
import { createNativeHistoryRows } from './history-rows';
import { createNativeHistoryScroll } from './history-scroll';
import { createNativeHistoryFooter } from './history-footer';
import { authority, createHistoryTerminalScenario, marker, TOTAL_PAGES, type Journal, type Probe, type TerminalSnapshot } from './tests/history-terminal/scenario';
import { createNaturalFooterReader } from './tests/history-terminal/footer-natural';
import { releaseFooterSynchronously } from './tests/history-terminal/footer-release';

// Debug-only UI. Body is a real, naturally sized TextView, NOT NativeTranscriptBody.
// The production body imports state/appearance/runtime; this fixture deliberately does not.
mount(() => {
  const project = createNativeHistoryRows();
  const status = signal('READY'), captures = signal(0), drags = signal(0);
  const footerExperiment = signal(false);
  const releaseMode = signal<'sync' | 'diagnostic'>('sync');
  const footerMeasuring = signal(false);
  const footer = createNativeHistoryFooter(value => footerState.set(value));
  const footerState = signal(footer.snapshot());
  const footerScope = 'terminal-fixture/mounted-generation';
  const natural = createNaturalFooterReader((scope, height, key) => footer.onLayout(scope, height, key));
  const contentKey = (value: TerminalSnapshot) => `${value.more}/${value.footerEnabled && value.loading}`;
  function updateFooter(value: TerminalSnapshot, successful = false) {
    const context = { scope: footerScope, active: current(), visible: value.more, contentKey: contentKey(value) };
    footer.update({ ...context, enabled: footerExperiment(), readError: false }, successful ? 'successful-history' : 'presentation');
    natural.update(context);
  }
  const cells = new Set<{ ref: ViewRef | null; id: () => string }>();
  let alive = true, flight = false, gestureGeneration = 0, footerMeasurementGeneration = 0, releaseSequence = 0;
  let sawActive = false, footerNeedsActiveRead = true;
  let footerRef: ViewRef | null = null;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const emit = (event: Journal) => {
    const payload = { ...event, releaseMode: releaseMode(), footerExperiment: footerExperiment(), footerHold: footer.snapshot(), state: authority(event.state, project(event.state.messages).map(row => row.key)) };
    console.info(`HISTORY_TERMINAL ${JSON.stringify(payload)}`);
    // Local UIKit observation bridge only; no network/credentials/business handlers.
    if (host.available()) void host.call('terminal.record', payload).catch(error => status.set(String(error)));
  };
  const scenario = createHistoryTerminalScenario(value => batch(() => {
    // Decide the footprint in the same state commit, before a hidden footer can lay out.
    updateFooter(value, snapshot().pending !== null && value.pending === null && !value.loading);
    snapshot.set(value);
  }), emit);
  const snapshot = signal(scenario.snapshot());
  const rows = computed(() => project(snapshot().messages));
  const current = () => alive && lifecycle() === 'active';
  updateFooter(snapshot());
  function recordFooter(phase: string, details: Record<string, unknown> = {}) {
    const payload = { phase, jsMonotonicMs: performance.now(), releaseMode: releaseMode(), footerExperiment: footerExperiment(), footerHold: footer.snapshot(),
      revision: snapshot().revision, state: authority(snapshot(), rows().map(row => row.key)), ...details };
    console.info(`HISTORY_TERMINAL_FOOTER ${JSON.stringify(payload)}`);
    if (host.available()) void host.call('terminal.record', payload).catch(error => status.set(String(error)));
  }
  async function confirmFooterHeight(phase: string) {
    if (!current() || !snapshot().more || !footerRef || footerMeasuring()) return false;
    const node = footerRef, scope = footerScope, generation = ++footerMeasurementGeneration;
    footerMeasuring.set(true);
    try {
      const admitted = await natural.measure();
      if (!current() || !snapshot().more || scope !== footer.snapshot().scope || node !== footerRef || generation !== footerMeasurementGeneration) return false;
      const height = admitted ? footer.snapshot().measuredHeight : undefined;
      // Height only. Reading offset still comes exclusively from real List events, never core pagePosition.
      recordFooter(phase, { measurement: { source: 'ref.measure.bounds.size.height', scope, height: height ?? null, admitted } });
      if (!admitted) return false;
      footerNeedsActiveRead = false;
      if (status() === 'Error: footer has no confirmed natural height') status.set('READY');
      return true;
    } catch (error) {
      if (current() && node === footerRef && scope === footer.snapshot().scope && generation === footerMeasurementGeneration) status.set(String(error));
      return false;
    }
    finally { if (alive && generation === footerMeasurementGeneration) footerMeasuring.set(false); }
  }
  async function toggleHold() {
    if (!current() || flight || snapshot().loading || !snapshot().more || footerMeasuring() || footer.snapshot().minHeight > 0) return;
    if (!footerExperiment() && (footerNeedsActiveRead || footer.snapshot().measuredHeight <= 0) && !await confirmFooterHeight('footer-enable-ref-height')) return;
    if (!current() || snapshot().loading || !snapshot().more) return;
    batch(() => { footerExperiment.set(!footerExperiment()); updateFooter(snapshot()); });
    recordFooter('footer-experiment-toggle');
  }
  const wait = (ms: number) => new Promise<void>(resolve => {
    const timer = setTimeout(() => { timers.delete(timer); resolve(); }, ms); timers.add(timer);
  });
  async function measure(label: string) {
    const started = performance.now(), revision = snapshot()!.revision;
    const measurements = await Promise.all([...cells].map(async cell => ({ id: cell.id(), frame: await cell.ref?.measure() })));
    if (!alive) return;
    // Core measure is recorded separately: only Swift's UIView frames are native geometry.
    const payload = { label, jsMonotonicMs: performance.now(), started, revision, drags: drags(),
      coreMeasurements: measurements.filter(item => item.frame), releaseMode: releaseMode(), footerExperiment: footerExperiment(), footerHold: footer.snapshot(), authority: authority(snapshot()!, rows().map(row => row.key)) };
    console.info(`HISTORY_TERMINAL_MEASURE ${JSON.stringify(payload)}`);
    if (host.available()) await host.call('terminal.capture', payload);
    captures.set(captures() + 1);
  }
  async function run(probe: Probe, trigger: string) {
    if (flight || footerMeasuring() || !current()) return;
    flight = true;
    try {
      await measure('before-request');
      if (!current() || !scenario.begin(probe, trigger)) return;
      await measure('loading');
      // Manual commit remains available: main can hold the loading state until reading settles.
      if (trigger !== 'manual-arm') {
        await wait(snapshot()!.delayMs);
        if (!current() || !snapshot()!.pending) return;
        if (footerExperiment() && (footerNeedsActiveRead || footer.snapshot().measuredHeight <= 0) && !await confirmFooterHeight('footer-before-commit-ref-height')) return;
        await measure('before-js-commit'); scenario.commit();
        await measure('after-js-commit');
      }
    } catch (error) { status.set(String(error)); }
    finally { flight = false; }
  }
  async function commit() {
    if (flight || !snapshot()!.pending || !current()) return;
    flight = true;
    try {
      if (footerExperiment() && (footerNeedsActiveRead || footer.snapshot().measuredHeight <= 0) && !await confirmFooterHeight('footer-before-commit-ref-height')) return;
      await measure('before-js-commit'); scenario.commit(); await measure('after-js-commit');
    }
    catch (error) { status.set(String(error)); }
    finally { flight = false; }
  }
  const historyScroll = createNativeHistoryScroll({ current, loading: () => snapshot()!.loading,
    more: () => snapshot()!.more, error: () => '', loadOlder: async automatic => run('page', automatic ? 'native-older' : 'manual-page'),
    loadLatest: async () => { footer.onLatest(); scenario.latest(); } });
  effect(() => {
    const active = current();
    updateFooter(snapshot());
    if (!active) {
      if (sawActive) footerNeedsActiveRead = true;
      footerMeasurementGeneration += 1; footerMeasuring.set(false);
      historyScroll.reset();
    } else {
      sawActive = true;
      if (footerNeedsActiveRead) void untracked(() => confirmFooterHeight('footer-first-active-ref-height')).catch(error => status.set(String(error)));
    }
  });
  cleanup(() => { alive = false; footerMeasurementGeneration += 1; footerRef = null; natural.invalidate(); footer.reset(); historyScroll.reset(); scenario.dispose(); for (const timer of timers) clearTimeout(timer); cells.clear(); });
  const counters = computed(() => {
    const published = footerState();
    return JSON.stringify({ ...authority(snapshot()!, rows().map(row => row.key)), captures: captures(), drags: drags(), status: status(),
       releaseMode: releaseMode(), footerExperiment: footerExperiment(), footerMeasuring: footerMeasuring(), footerHold: footer.snapshot(),
      footerPublishedOffsetY: published.offsetY, footerOffsetPolicy: 'last-List-event cache; refreshed here only on other UI commits, not every scroll' });
  });
  const compact = computed(() => `r${snapshot()!.revision} p${snapshot()!.page}/${TOTAL_PAGES} n${snapshot()!.messages.length} req${snapshot()!.requests} adopt${snapshot()!.adopted}\nmore:${snapshot()!.more} loading:${snapshot()!.loading} pending:${snapshot()!.pending ?? '-'}\nfooter:${snapshot()!.footerEnabled} metadata:${snapshot()!.metadataEnabled} samples:${captures()} drag:${drags()} ${status()}\nHold:${footerExperiment() ? 'ON' : 'OFF'} measured:${footerState().measuredHeight} min:${footerState().minHeight} release:${releaseMode()}`);
  const action = 'min-h-9 px-2 py-1 bg-secondary rounded-lg items-center justify-center disabled:opacity-40';
  return <View class="flex-1 bg-background" style={{ paddingTop: safeArea().top, paddingBottom: safeArea().bottom }}>
    <View testID="terminal-top" class="px-3 py-2 gap-1" style={{ height: 144, flexShrink: 0 }}>
      <Text class="text-foreground">UIKit 终页诊断 · 合成 TextView</Text>
      <Text testID="terminal-counters" accessibilityLabel={counters()} class="text-foreground" style={{ fontSize: 10 }}>{compact()}</Text>
      <View class="flex-row gap-2">
        <Button testID="terminal-toggle-footer" class={action} disabled={snapshot()!.loading} onPress={() => scenario.configure('footerEnabled')}><Text>{`Footer ${snapshot()!.footerEnabled ? 'ON' : 'OFF'}`}</Text></Button>
        <Button testID="terminal-toggle-metadata" class={action} disabled={snapshot()!.loading} onPress={() => scenario.configure('metadataEnabled')}><Text>{`Metadata ${snapshot()!.metadataEnabled ? 'ON' : 'OFF'}`}</Text></Button>
        <Button testID="terminal-toggle-hold" class={action} disabled={snapshot()!.loading || !snapshot()!.more || footerState().minHeight > 0 || footerMeasuring()} onPress={() => { void toggleHold(); }}><Text>{`Hold ${footerExperiment() ? 'ON' : 'OFF'}`}</Text></Button>
      </View>
    </View>
    <List testID="terminal-transcript" class="flex-1" contentClass="px-3 pt-[26px] pb-4 gap-5" inverted
      onScrollDragStart={event => {
        gestureGeneration += 1;
        footer.onScrollDragStart(event.offset.y); drags.set(drags() + 1);
        if (footer.snapshot().minHeight > 0) recordFooter('footer-release-drag-start');
        historyScroll.onScrollDragStart(event);
      }}
      onScroll={event => { footer.onScroll(event.offset.y); historyScroll.onScroll(event); }}
      onScrollEnd={event => {
        historyScroll.onScrollEnd();
        if (releaseMode() === 'sync') {
          const releaseID = ++releaseSequence;
          const timeline = releaseFooterSynchronously(footer, event.offset.y, (before, eventAt) => {
            recordFooter('footer-sync-before-release', { releaseID, eventAt, eventOffsetY: event.offset.y,
              footerHold: before, prePolicy: 'existing-native-display-link-ring-only' });
          });
          recordFooter('footer-sync-after-release', { releaseID, timeline });
          if (timeline.released) void measure('after-footer-sync-release').catch(error => status.set(String(error)));
          return;
        }
        const before = footer.snapshot(), generation = gestureGeneration;
        if (!before.minHeight || !before.gesture || event.offset.y < before.minHeight) { footer.onScrollEnd(event.offset.y); return; }
        // Diagnostic-only pre-release native capture. No timer and no scroll write.
        // A newer real gesture cancels this attempt rather than overwriting its rest state.
        void (async () => {
          recordFooter('footer-before-user-rest');
          await measure('before-footer-release');
          if (!current() || generation !== gestureGeneration || !footer.snapshot().minHeight) return;
          footer.onScrollEnd(event.offset.y);
          if (footer.snapshot().minHeight === 0) {
            recordFooter('footer-released-at-user-rest');
            await measure('after-footer-release');
          }
        })().catch(error => status.set(String(error)));
      }} onLoadMore={historyScroll.onLoadMore}
      loadMoreThreshold={0.5} onLoadMoreAtStart={historyScroll.onLoadMoreAtStart}
      footer={() => { let naturalRef: ViewRef | null = null; const key = contentKey(snapshot()); return <View testID="terminal-footer" style={{ minHeight: footerState().minHeight || undefined }}>
        <View testID="terminal-footer-natural" class="gap-2" style={{ flexShrink: 0 }} ref={ref => {
          naturalRef = ref; footerRef = ref; natural.attach(ref);
          if (footerNeedsActiveRead) void confirmFooterHeight('footer-attached-active-ref-height').catch(error => status.set(String(error)));
        }}
        onLayout={event => {
          const height = event.bounds.size.height, admitted = natural.layout(naturalRef, footerScope, key, height);
          recordFooter('footer-layout', { measurement: { source: 'natural.onLayout', scope: footerScope, contentKey: key, height, admitted } });
        }}>
        <If when={snapshot()!.more}><Button testID="history-load-older" class={action} disabled={snapshot()!.footerEnabled && snapshot()!.loading} onPress={() => { void run('page', 'footer-button'); }}><Text class="text-muted-foreground">{snapshot()!.footerEnabled && snapshot()!.loading ? '加载中…' : '载入较早记录'}</Text></Button></If>
        </View></View>; }}
      each={rows()} keyExtractor={row => row.key} keyboardDismissMode="interactive">
      {row => {
        const cell: { ref: ViewRef | null; id: () => string } = { ref: null, id: () => marker(row().key) };
        cleanup(() => cells.delete(cell));
        return <View testID={`terminal-row-${row().key}`} class="gap-2">
          <View ref={ref => { cell.ref = ref; cells.add(cell); }} testID={marker(row().key)} accessibilityLabel={marker(row().key)}>
            <Text class="text-muted-foreground" style={{ fontSize: 12 }}>{marker(row().key)}</Text>
          </View>
          <If when={row().head.role === 'assistant'}><Text testID={`terminal-metadata-${row().key}`} class="text-muted-foreground" style={{ fontSize: 12 }}>{snapshot()!.metadataIDs.includes(row().head.id) ? '用时 29m 31s' : '已处理'}</Text></If>
          <TextView testID={`terminal-body-${row().key}`} markdown={row().messages.map(message => message.text).join('\n\n')} selectable links="open" options={{ streaming: true }} class="text-foreground" styles={{ root: { fontSize: 15, lineHeight: 22 } }} codeBlockActions={[{ id: 'copy' }]} />
        </View>;
      }}
    </List>
    <View testID="terminal-bottom" class="px-3 py-2 gap-1" style={{ height: 152, flexShrink: 0 }}>
      <View class="flex-row gap-2">
        <Button testID="terminal-next" class={action} disabled={snapshot()!.loading || snapshot()!.page === TOTAL_PAGES} onPress={() => { void run('page', 'manual-page'); }}><Text>下一页</Text></Button>
        <Button testID="terminal-arm-page" class={action} disabled={snapshot()!.loading || snapshot()!.page === TOTAL_PAGES} onPress={() => { void run('page', 'manual-arm'); }}><Text>挂起分页</Text></Button>
        <Button testID="terminal-commit" class={action} disabled={!snapshot()!.pending} onPress={() => { void commit(); }}><Text>提交</Text></Button>
      </View>
      <View class="flex-row gap-2">
        <Button testID="terminal-probe" class={action} disabled={snapshot()!.loading} onPress={() => { void run('controls', 'manual-arm'); }}><Text>仅控制项</Text></Button>
        <Button testID="terminal-capture" class={action} onPress={() => { void measure('manual').catch(error => status.set(String(error))); }}><Text>读取几何</Text></Button>
        <Button testID="terminal-toggle-release-mode" class={action} disabled={snapshot().loading || flight || footerMeasuring() || footerState().minHeight > 0} onPress={() => {
          releaseMode.set(releaseMode() === 'sync' ? 'diagnostic' : 'sync'); recordFooter('footer-release-mode');
        }}><Text>{releaseMode() === 'sync' ? '同步释放' : '诊断等待'}</Text></Button>
      </View>
      <Text class="text-muted-foreground" style={{ fontSize: 10 }}>默认 Footer/Metadata ON，Hold OFF；暂留只取实测值，释放仍需原生验收。</Text>
    </View>
  </View>;
});
