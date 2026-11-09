import { expect, it, vi } from 'vitest';
import { createNativeHistoryFooterController } from './history-footer-controller';
import type { NativeHistoryPresentation } from './history-presentation';

const initial: NativeHistoryPresentation = { authority: 'successful-history', scope: { hostID: 'host', generation: 1, owner: 1, historyGeneration: 0, targetKind: 'session', targetID: 'session', directory: '/fixture' },
  more: true, historyError: '', boundaryMissing: false, repairPending: false, hasGap: false, readError: '', resolved: true };
const event = (height: number) => ({ bounds: { size: { height } } });
const offset = (y: number) => ({ offset: { y } });
function setup(enabled = true) {
  let active = true;
  const changed = vi.fn(), controller = createNativeHistoryFooterController({ current: () => active, changed });
  controller.setEnabled(enabled); controller.beforeHistoryPresentationFlush(initial);
  const natural = controller.captureNatural(), node = { measure: vi.fn(async () => event(37.25)) };
  natural.ref(node); natural.onLayout(event(37.25));
  const events = controller.captureEvents(); events.onScroll(offset(0));
  return { controller, natural, events, node, changed, active: (value: boolean) => { active = value; controller.syncActivity(); } };
}
it('binds immutable natural event closures; same-node ref ABA requires a new capture and never adopts a delayed old height', () => {
  const { controller, natural, node } = setup();
  natural.ref(null); natural.ref(node);
  expect(natural.onLayout(event(99))).toBe(false);
  expect(controller.snapshot().measuredHeight).toBe(0);
  const next = controller.captureNatural(); next.ref(node); next.onLayout(event(41));
  natural.ref(null); natural.onLayout(event(100));
  expect(controller.snapshot().measuredHeight).toBe(41);
  next.ref({ measure: async () => event(90) });
  expect(controller.snapshot().measuredHeight).toBe(0);
});
it('same-scope active round trips retire old natural and List callbacks without accepting inactive layouts as first mount', () => {
  const { controller, natural, events, active, node } = setup();
  active(false);
  const hidden = controller.captureNatural(); hidden.ref(node);
  expect(hidden.onLayout(event(88))).toBe(false);
  active(true);
  expect(hidden.onLayout(event(88))).toBe(false);
  natural.onLayout(event(99)); events.onScrollDragStart(offset(0)); events.onScroll(offset(0));
  controller.beforeHistoryPresentationFlush({ ...initial, more: false });
  expect(controller.snapshot()).toMatchObject({ minHeight: 0, measuredHeight: 0, offsetY: null, gesture: false });
});
it('permits the initial inactive mounted source through first activation, but does not infer an offset', () => {
  let active = false;
  const controller = createNativeHistoryFooterController({ current: () => active });
  controller.beforeHistoryPresentationFlush(initial);
  const source = controller.captureNatural(), node = { measure: async () => event(31) };
  source.ref(node); expect(source.onLayout(event(31))).toBe(true);
  active = true; controller.syncActivity(); controller.setEnabled(true);
  expect(source.onLayout(event(32))).toBe(true);
  controller.beforeHistoryPresentationFlush({ ...initial, more: false });
  expect(controller.snapshot()).toMatchObject({ measuredHeight: 32, minHeight: 0, offsetY: null });
});
it('keeps a retained footprint until real user rest; a replacement event source cannot replay an old gesture', () => {
  const { controller, events } = setup();
  controller.beforeHistoryPresentationFlush({ ...initial, more: false });
  expect(controller.snapshot().minHeight).toBe(37.25);
  controller.setEnabled(false);
  expect(controller.snapshot()).toMatchObject({ enabled: true, minHeight: 37.25 });
  events.onScrollDragStart(offset(0)); events.onLatest();
  const next = controller.captureEvents();
  events.onScrollEnd(offset(100)); next.onScrollEnd(offset(100));
  expect(controller.snapshot().minHeight).toBe(37.25);
  next.onScrollDragStart(offset(0)); next.onScrollEnd(offset(100));
  expect(controller.snapshot()).toMatchObject({ minHeight: 0, releases: 1 });
});
it('does not make presentation/error-clear/failure a successful hidden transition; defaults OFF', () => {
  for (const authority of ['presentation', 'failure', 'reset'] as const) {
    const { controller } = setup(); controller.beforeHistoryPresentationFlush({ ...initial, more: false, authority });
    expect(controller.snapshot().minHeight).toBe(0);
  }
  const { controller } = setup(false); controller.beforeHistoryPresentationFlush({ ...initial, more: false });
  expect(controller.snapshot()).toMatchObject({ enabled: false, minHeight: 0 });
});
it('content/Host/history reset invalidate pending refs and old events; ref failure is explicit and retryable without blocking commits', async () => {
  const { controller, natural, events } = setup();
  controller.setContentKey('different-language/font/width/loading');
  expect(natural.onLayout(event(100))).toBe(false);
  expect(controller.snapshot().measuredHeight).toBe(0);
  const source = controller.captureNatural(); source.ref({ measure: async () => { throw new Error('private transport detail'); } });
  expect(await source.confirm()).toBe('failed');
  expect(controller.snapshot()).toMatchObject({ measuring: false, measurementError: 'natural-measurement-failed' });
  source.onLayout(event(40));
  expect(controller.snapshot().measurementError).toBe('');
  controller.beforeHistoryPresentationFlush({ ...initial, authority: 'reset', scope: { ...initial.scope, historyGeneration: 1 } });
  events.onScroll(offset(99)); source.onLayout(event(99));
  expect(controller.snapshot()).toMatchObject({ minHeight: 0, measuredHeight: 0, offsetY: null });
});
it('1000 scroll events do not publish UI; reset/dispose and superseded captures reject all old callbacks', () => {
  const { controller, events, natural, changed } = setup(); const count = changed.mock.calls.length;
  for (let i = 0; i < 1000; i++) events.onScroll(offset(i));
  expect(changed).toHaveBeenCalledTimes(count);
  controller.reset(); natural.onLayout(event(99)); events.onScroll(offset(99));
  expect(controller.snapshot()).toMatchObject({ scope: null, measuredHeight: 0, offsetY: null });
  controller.dispose(); controller.beforeHistoryPresentationFlush(initial); controller.setEnabled(true);
  expect(controller.snapshot().scope).toBe(null);
});

it('rejects actual page-hidden layout before the lifecycle effect has run', () => {
  let active = true;
  const controller = createNativeHistoryFooterController({ current: () => active });
  controller.beforeHistoryPresentationFlush(initial);
  const natural = controller.captureNatural(); natural.ref({ measure: async () => event(37) }); natural.onLayout(event(37));
  active = false;
  expect(natural.onLayout(event(99))).toBe(false);
  expect(controller.snapshot()).toMatchObject({ active: false, measuredHeight: 0, offsetY: null });
  active = true; controller.syncActivity();
  expect(natural.onLayout(event(99))).toBe(false);
});

it('a newer real layout supersedes an async confirmation; retired ref results cannot overwrite the next source', async () => {
  const { controller } = setup();
  let resolve!: (frame: ReturnType<typeof event>) => void;
  const source = controller.captureNatural(); source.ref({ measure: () => new Promise(done => { resolve = done; }) });
  const first = source.confirm(); source.onLayout(event(38)); resolve(event(99));
  expect(await first).toBe('confirmed'); expect(controller.snapshot().measuredHeight).toBe(38);
  const second = source.confirm();
  source.retire(); const next = controller.captureNatural(); next.ref({ measure: async () => event(41) });
  expect(await next.confirm()).toBe('confirmed'); resolve(event(100));
  expect(await second).toBe('stale'); expect(controller.snapshot()).toMatchObject({ measuredHeight: 41, measuring: false });
});
