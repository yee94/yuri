import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { createNativeHistoryRows } from '../../history-rows';
import { createNativeHistoryScroll } from '../../history-scroll';
import { createHistoryUIKitScenario, fixturePage, marker, ordinalOf, TOTAL_MESSAGES, TOTAL_PAGES } from './scenario';

afterEach(() => { vi.useRealTimers(); });

it('defines 400 deterministic neutral messages in exactly 20 chronological pages with stable production row keys', () => {
  const messages = Array.from({ length: TOTAL_PAGES }, (_, i) => fixturePage(TOTAL_PAGES - i)).flat();
  expect(messages).toHaveLength(TOTAL_MESSAGES);
  expect(new Set(messages.map(item => item.id)).size).toBe(400);
  expect(messages.map(ordinalOf)).toEqual(Array.from({ length: 400 }, (_, i) => i + 1));
  expect(fixturePage(1)).toEqual(fixturePage(1));
  const project = createNativeHistoryRows(), latest = project(fixturePage(1));
  const extended = project([...fixturePage(2), ...fixturePage(1)]);
  expect(extended.slice(0, 20).map(row => row.key)).toEqual(latest.map(row => row.key));
  expect(marker(ordinalOf(extended[0]!.head))).toBe('history-marker-0400');
});

it('uses the production intent gate: one delayed request per actual older-directed gesture, not layout callbacks', async () => {
  vi.useFakeTimers();
  const source = createHistoryUIKitScenario();
  const scroll = createNativeHistoryScroll({ current: () => true, loading: () => source.snapshot().loading,
    more: () => source.snapshot().page < TOTAL_PAGES, error: () => source.snapshot().error,
    loadOlder: source.loadOlder, loadLatest: source.loadLatest });
  const frame = (y: number) => ({ offset: { x: 0, y }, size: { width: 390, height: 600 }, contentSize: { width: 390, height: 4000 } });
  scroll.onLoadMore(); scroll.onScroll(frame(10));
  expect(source.snapshot().requests).toBe(0);
  scroll.onScrollDragStart(frame(400)); scroll.onScroll(frame(200));
  for (let i = 0; i < 50; i++) { scroll.onLoadMore(); scroll.onScroll(frame(100 - i)); }
  expect(source.snapshot()).toMatchObject({ requests: 1, automaticRequests: 1, page: 1, loading: true });
  await vi.advanceTimersByTimeAsync(900);
  scroll.onLoadMore(); scroll.onScroll(frame(0));
  expect(source.snapshot()).toMatchObject({ requests: 1, page: 2, adopted: 1, loading: false });
  scroll.onScrollEnd(); source.dispose();
});

it('keeps failed pages and their rows, blocks automatic retry, and counts the explicit retry', async () => {
  vi.useFakeTimers();
  const source = createHistoryUIKitScenario(), original = source.snapshot().messages;
  source.failNext(); const failed = source.loadOlder(true);
  await vi.advanceTimersByTimeAsync(900); await failed;
  expect(source.snapshot().messages).toBe(original);
  expect(source.snapshot()).toMatchObject({ page: 1, failures: 1, requests: 1 });
  expect(source.snapshot().error).not.toBe('');
  await source.loadOlder(true);
  expect(source.snapshot().requests).toBe(1);
  const retry = source.loadOlder();
  await vi.advanceTimersByTimeAsync(900); await retry;
  expect(source.snapshot()).toMatchObject({ page: 2, retries: 1, manualRequests: 1, requests: 2, error: '', adopted: 1 });
  source.dispose();
});

it('a held-drag manual injection is already in flight when production intent starts, so it cannot fetch a second page', async () => {
  vi.useFakeTimers();
  const source = createHistoryUIKitScenario();
  const scroll = createNativeHistoryScroll({ current: () => true, loading: () => source.snapshot().loading,
    more: () => source.snapshot().page < TOTAL_PAGES, error: () => source.snapshot().error,
    loadOlder: source.loadOlder, loadLatest: source.loadLatest });
  const frame = (y: number) => ({ offset: { x: 0, y }, size: { width: 390, height: 600 }, contentSize: { width: 390, height: 4000 } });
  const flight = source.loadOlder();
  scroll.onScrollDragStart(frame(400)); scroll.onScroll(frame(200));
  await vi.advanceTimersByTimeAsync(900); await flight;
  for (let i = 0; i < 50; i++) { scroll.onScroll(frame(100 - i)); scroll.onLoadMore(); }
  expect(source.snapshot()).toMatchObject({ requests: 1, manualRequests: 1, automaticRequests: 0, adopted: 1 });
  source.dispose();
});

it('drains all 20 pages without overfetch, retaining tails and delayed growth identities', async () => {
  vi.useFakeTimers();
  const source = createHistoryUIKitScenario();
  source.growLater(); source.appendTail();
  for (let page = 2; page <= TOTAL_PAGES; page++) {
    const request = source.loadOlder();
    void source.loadOlder();
    await vi.advanceTimersByTimeAsync(900); await request;
    expect(source.snapshot().page).toBe(page);
  }
  await source.loadOlder();
  expect(source.snapshot()).toMatchObject({ requests: 19, adopted: 19, page: 20, growths: 1, growthMarker: 'history-marker-0381', appended: 1 });
  expect(source.snapshot().messages).toHaveLength(401);
  expect(new Set(source.snapshot().messages.map(item => item.id)).size).toBe(401);
  expect(source.snapshot().grown).toEqual(['fixture-0381']);
  source.dispose();
});

it('cancels delayed writes on disposal and deduplicates latest notifications', async () => {
  vi.useFakeTimers();
  const changed = vi.fn(), source = createHistoryUIKitScenario(changed);
  await source.loadLatest(); await source.loadLatest();
  expect(source.snapshot().latestRequests).toBe(1);
  source.growLater(); const flight = source.loadOlder();
  const before = changed.mock.calls.length;
  source.dispose(); await flight; await vi.advanceTimersByTimeAsync(5000);
  expect(changed).toHaveBeenCalledTimes(before);
  expect(source.snapshot().page).toBe(1);
});

it('isolates the fixture Host and preserves current production List wiring with no second scroll writer', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const fixture = readFileSync(path.join(root, 'history-uikit-fixture.tsx'), 'utf8');
  const production = readFileSync(path.join(root, 'application.tsx'), 'utf8');
  for (const event of ['onScroll', 'onScrollEnd', 'onLoadMore', 'onLoadMoreAtStart']) {
    const wiring = `${event}={historyScroll.${event}}`;
    expect(fixture).toContain(wiring); expect(production).toContain(wiring);
  }
  expect(fixture).toContain('historyScroll.onScrollDragStart(event)');
  expect(production).toContain('onScrollDragStart={historyScroll.onScrollDragStart}');
  for (const source of [fixture, production]) {
    expect(source).toMatch(/\binverted\s/);
    expect(source).toContain('loadMoreThreshold={0.5}');
    expect(source).toContain('keyboardDismissMode="interactive"');
    expect(source).toContain('contentClass="px-3 pt-[26px] pb-4 gap-5"');
  }
  expect(fixture).not.toMatch(/scrollTo|scrollValue|maintainVisibleContentPosition|\.measure\(/);
  expect(fixture).not.toMatch(/from ['"].*(?:state|application|runtime|speech|appearance)['"]/);
  const swift = readFileSync(path.join(root, 'tests/history-uikit/main.swift'), 'utf8');
  expect(swift).toContain('surface.loadBundle(at: url)');
  expect(swift).not.toMatch(/RuntimeBridge|ConnectionStore|Keychain|\.handle\(/);
  const build = readFileSync(path.join(root, 'scripts/build-history-uikit.mjs'), 'utf8');
  expect(build).toContain('com.yee94.yuri.nsh.history-fixture');
  expect(build).not.toMatch(/NSH_SIGN_IDENTITY|NSH_PROVISIONING_PROFILE|simctl|App\.tsx.*--release.*\.nsh\/bundle/);
});
