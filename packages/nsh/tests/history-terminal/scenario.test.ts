import { expect, it } from 'vitest';
import { createNativeHistoryRows } from '../../history-rows';
import { createNativeHistoryScroll } from '../../history-scroll';
import { authority, createHistoryTerminalScenario, TOTAL_PAGES, type Journal } from './scenario';
import { readingVerdict, type NativeFrame } from './verdict';

it('loads 20 newest records through the final page and records full cursor/response/commit authority', () => {
  let time = 0;
  const events: Journal[] = [], source = createHistoryTerminalScenario(() => {}, event => events.push(event), () => ++time);
  const project = createNativeHistoryRows(), initialKeys = project(source.snapshot().messages).map(row => row.key);
  expect(source.snapshot().messages).toHaveLength(20);
  for (let page = 2; page <= TOTAL_PAGES; page++) {
    const cursor = source.snapshot().cursor;
    expect(source.begin('page', 'unit')).toBe(true);
    expect(source.snapshot()).toMatchObject({ more: true, loading: true });
    expect(source.commit()).toBe(true);
    const current = source.snapshot();
    expect(current.messages).toHaveLength(page * 20);
    expect(project(current.messages).slice(0, 20).map(row => row.key)).toEqual(initialKeys);
    expect(events.at(-1)).toMatchObject({ phase: 'after-js-commit', requestCursor: cursor });
    expect(events.at(-1)!.responseIDs).toHaveLength(20);
  }
  const final = source.snapshot();
  expect(final).toMatchObject({ page: 20, more: false, loading: false, cursor: null, requests: 19, adopted: 19 });
  expect(new Set(final.messages.map(message => message.id)).size).toBe(400);
  expect(source.begin('page', 'overfetch')).toBe(false);
  expect(authority(final, project(final.messages).map(row => row.key)).messageCount).toBe(400);
  expect(events.every((event, index) => index === 0 || event.jsMonotonicMs > events[index - 1]!.jsMonotonicMs)).toBe(true);
});

it.each([[true, false], [false, true], [false, false], [true, true]])('isolates footer=%s and metadata=%s without adopting IDs', (footer, metadata) => {
  const source = createHistoryTerminalScenario();
  if (!footer) source.configure('footerEnabled');
  if (!metadata) source.configure('metadataEnabled');
  const messages = source.snapshot().messages;
  expect(source.begin('controls', 'unit-isolation')).toBe(true);
  expect(source.snapshot()).toMatchObject({ more: true, loading: true });
  source.commit();
  expect(source.snapshot().messages).toBe(messages);
  expect(source.snapshot()).toMatchObject({ more: !footer, loading: false, requests: 0, adopted: 0, controlCommits: 1 });
  expect(source.snapshot().metadataIDs.length).toBe(Number(metadata));
});

it('delegates real pagination intent to the production one-page-per-gesture owner', () => {
  const source = createHistoryTerminalScenario();
  const owner = createNativeHistoryScroll({ current: () => true, more: () => source.snapshot().more, loading: () => source.snapshot().loading,
    error: () => '', loadOlder: async () => { source.begin('page', 'native-older'); }, loadLatest: async () => source.latest() });
  const frame = (y: number) => ({ offset: { x: 0, y }, size: { width: 402, height: 500 }, contentSize: { width: 402, height: 5000 } });
  owner.onLoadMore(); expect(source.snapshot().requests).toBe(0);
  owner.onScrollDragStart(frame(400)); owner.onScroll(frame(200));
  source.commit();
  for (let i = 0; i < 30; i++) { owner.onLoadMore(); owner.onScroll(frame(100 - i)); }
  expect(source.snapshot()).toMatchObject({ requests: 1, adopted: 1 });
  source.dispose(); expect(source.begin('page', 'disposed')).toBe(false);
});

const native = (t: number, dy = 0): NativeFrame => ({ nativeUptimeMs: t, observedCounters: '{}',
  markers: [1, 2, 3].map(index => ({ id: `terminal-marker-${index}`, frame: { x: 12, y: 200 + index * 60 + dy, width: 180, height: 16 } })),
  scrollViews: [{ dragging: false, tracking: false, decelerating: false }] });
it('is red-capable for the observed -53pt shift and never greens missing or held samples', () => {
  expect(readingVerdict(native(1), [native(2, -53)])).toMatchObject({ verdict: 'red', worstPt: 53 });
  expect(readingVerdict(native(1), [])).toMatchObject({ verdict: 'invalid' });
  const held = native(2); held.scrollViews[0]!.tracking = true;
  expect(readingVerdict(native(1), [held])).toMatchObject({ verdict: 'invalid' });
  expect(readingVerdict(native(1), Array.from({ length: 30 }, (_, i) => native(i + 2)))).toMatchObject({ verdict: 'within-sampled-window' });
});
