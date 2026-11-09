import { expect, test, vi } from 'vitest';
import { createDesktopWriterDeparture, type DesktopWriterDepartureGuard } from './desktop-writer-departure';
import { createDesktopPageDeparture } from './desktop-page-departure';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// These are business guards, not fake native clients, claims or opaque grants.
function business() {
  let mounted = true, paused = false, released = false, unknown = false;
  const draft = 'retained original draft';
  const guard: DesktopWriterDepartureGuard = {
    current: vi.fn(() => mounted),
    prepare: vi.fn(async () => { paused = true; return !unknown; }),
    canClose: vi.fn(() => paused && !released && !unknown),
    cancel: vi.fn(() => { paused = false; }),
    release: vi.fn(async () => { released = true; return true; }),
  };
  return { guard, draft, paused: () => paused, released: () => released,
    unknown: (value: boolean) => { unknown = value; }, mounted: (value: boolean) => { mounted = value; } };
}

function fixture() {
  let scope: unknown = {};
  const registry = createDesktopWriterDeparture<object>({ scope: () => scope });
  return { registry, scope: (next: unknown) => { scope = next; } };
}

test('capture only delegates the exact selected mounted handles; hidden owners join all-owner close', async () => {
  const f = fixture(), visible = business(), hidden = business(), retained = business();
  const route = {}, hiddenRoute = {}, overlay = {};
  f.registry.register(route, visible.guard); f.registry.register(hiddenRoute, hidden.guard); f.registry.register(overlay, retained.guard);
  const departure = f.registry.capture({ select: tag => tag === route })!;
  expect(await departure.prepare()).toBe(true); expect(await departure.release()).toBe(true);
  expect(departure.canCommit()).toBe(true); expect(departure.finish()).toBe(true);
  expect(hidden.guard.prepare).not.toHaveBeenCalled(); expect(retained.guard.prepare).not.toHaveBeenCalled();
  // In the actual app the committed route is now unmounted; this test removes its registration explicitly.
  f.registry.dispose();
  const close = fixture(); close.registry.register(hiddenRoute, hidden.guard); close.registry.register(overlay, retained.guard);
  const ticket = close.registry.capture()!;
  expect(await ticket.prepare()).toBe(true); expect(ticket.canClose()).toBe(true);
  expect(hidden.guard.prepare).toHaveBeenCalledTimes(1); expect(retained.guard.prepare).toHaveBeenCalledTimes(1);
  expect(hidden.guard.release).not.toHaveBeenCalled(); expect(retained.guard.release).not.toHaveBeenCalled();
});

test.each(['false', 'throw'] as const)('prepare %s cancels every attempted owner and preserves unknown and drafts', async outcome => {
  const f = fixture(), first = business(), unknown = business(); unknown.unknown(true);
  if (outcome === 'throw') vi.mocked(unknown.guard.prepare).mockRejectedValue(new Error('synthetic flush failure'));
  f.registry.register({}, first.guard); f.registry.register({}, unknown.guard);
  const ticket = f.registry.capture()!;
  expect(await ticket.prepare()).toBe(false);
  expect(first.guard.cancel).toHaveBeenCalledTimes(1); expect(unknown.guard.cancel).toHaveBeenCalledTimes(1);
  expect(first.paused()).toBe(false); expect(first.draft).toBe('retained original draft');
  expect(unknown.guard.canClose()).toBe(false); expect(ticket.canCommit()).toBe(false);
  expect(first.guard.release).not.toHaveBeenCalled(); expect(unknown.guard.release).not.toHaveBeenCalled();
  expect(f.registry.capture()).not.toBeNull();
});

test.each(['scope', 'registry', 'intent', 'owner'] as const)('prepare final revalidation rejects %s changes during flush without taking over', async reason => {
  const f = fixture(), a = business(), added = business(), flush = deferred<boolean>(); let current = true;
  vi.mocked(a.guard.prepare).mockImplementation(async () => { await flush.promise; return true; });
  f.registry.register({}, a.guard);
  const ticket = f.registry.capture({ current: () => current })!, pending = ticket.prepare();
  await Promise.resolve();
  if (reason === 'scope') f.scope({});
  else if (reason === 'registry') f.registry.register({}, added.guard);
  else if (reason === 'intent') current = false;
  else a.mounted(false);
  flush.resolve(true);
  expect(await pending).toBe(false); expect(ticket.status().failure).toBe('stale');
  expect(a.guard.cancel).toHaveBeenCalledTimes(1); expect(a.guard.release).not.toHaveBeenCalled();
  expect(added.guard.prepare).not.toHaveBeenCalled();
});

test('cancelled old ticket waits for its exact flush and can never cancel the next ticket', async () => {
  const f = fixture(), a = business(), flush = deferred<boolean>();
  f.registry.register({}, a.guard);
  vi.mocked(a.guard.prepare).mockImplementationOnce(() => flush.promise);
  const old = f.registry.capture()!, pending = old.prepare(); await Promise.resolve();
  expect(old.cancel()).toBe(true); expect(f.registry.capture()).toBeNull();
  flush.resolve(true); expect(await pending).toBe(false);
  const next = f.registry.capture()!; expect(await next.prepare()).toBe(true);
  expect(old.cancel()).toBe(false); expect(a.guard.cancel).toHaveBeenCalledTimes(1);
  expect(next.canClose()).toBe(true); expect(next.cancel()).toBe(true);
  expect(f.registry.capture()).not.toBeNull();
});

test('close preparation never releases; late root veto cancels and restores the same draft', async () => {
  const f = fixture(), a = business(); f.registry.register({}, a.guard);
  const ticket = f.registry.capture()!;
  expect(await ticket.prepare()).toBe(true); expect(a.paused()).toBe(true);
  expect(ticket.canClose()).toBe(true); expect(a.guard.release).not.toHaveBeenCalled();
  a.unknown(true); expect(ticket.canClose()).toBe(false);
  expect(ticket.cancel()).toBe(true); expect(a.paused()).toBe(false);
  expect(a.draft).toBe('retained original draft'); expect(a.guard.release).not.toHaveBeenCalled();
  expect(await f.registry.capture()!.prepare()).toBe(false);
});

test('confirmed final native close only finishes coordination; cleanup sends no release or cancel', async () => {
  const f = fixture(), a = business(); f.registry.register({}, a.guard);
  const ticket = f.registry.capture()!; expect(await ticket.prepare()).toBe(true);
  expect(ticket.finish({ closed: true })).toBe(true); f.registry.dispose();
  expect(a.guard.release).not.toHaveBeenCalled(); expect(a.guard.cancel).not.toHaveBeenCalled();
});

test('empty captures still obey scope and exact intent; successful no-owner navigation needs no I/O', async () => {
  const f = fixture(), ticket = f.registry.capture()!;
  expect(await ticket.prepare()).toBe(true); expect(await ticket.release()).toBe(true);
  expect(ticket.canCommit()).toBe(true); expect(ticket.status().released).toBe(0); ticket.finish();
  const stale = f.registry.capture()!; expect(await stale.prepare()).toBe(true);
  f.scope({}); expect(await stale.release()).toBe(false); expect(stale.canCommit()).toBe(false);
});

test('an acquire-in-flight wrapper cannot disappear as an empty registry', async () => {
  const f = fixture(), a = business(), mountedHandle = deferred<boolean>();
  vi.mocked(a.guard.prepare).mockImplementation(() => mountedHandle.promise);
  f.registry.register({}, a.guard);
  const ticket = f.registry.capture()!, pending = ticket.prepare(); await Promise.resolve();
  expect(ticket.status().owners).toBe(1); expect(ticket.canClose()).toBe(false);
  expect(a.guard.release).not.toHaveBeenCalled();
  mountedHandle.resolve(false); expect(await pending).toBe(false);
});

test.each(['false', 'throw'] as const)('partial release %s is explicit fail closed, never a fake rollback or reacquire', async outcome => {
  const f = fixture(), a = business(), b = business(), untouched = business();
  f.registry.register({}, a.guard); f.registry.register({}, b.guard); f.registry.register({}, untouched.guard);
  if (outcome === 'throw') vi.mocked(b.guard.release).mockRejectedValue(new Error('synthetic ACK loss'));
  else vi.mocked(b.guard.release).mockResolvedValue(false);
  const ticket = f.registry.capture()!; expect(await ticket.prepare()).toBe(true);
  expect(await ticket.release()).toBe(false);
  expect(ticket.status()).toMatchObject({ phase: 'blocked', failure: 'release', owners: 3, released: 1, failClosed: true });
  expect(ticket.canCommit()).toBe(false); expect(ticket.cancel()).toBe(false); expect(f.registry.capture()).toBeNull();
  expect(a.released()).toBe(true); expect(a.paused()).toBe(true); expect(b.paused()).toBe(true); expect(untouched.paused()).toBe(false);
  for (const owner of [a, b]) expect(owner.guard.cancel).not.toHaveBeenCalled();
  expect(untouched.guard.cancel).toHaveBeenCalledTimes(1);
  expect(untouched.guard.release).not.toHaveBeenCalled();
  expect(await ticket.release()).toBe(false); expect(b.guard.release).toHaveBeenCalledTimes(1);
});

test.each(['scope', 'registration', 'intent'] as const)('late release ACK after %s change cannot admit route commit', async reason => {
  const f = fixture(), a = business(), ack = deferred<boolean>(); let current = true;
  vi.mocked(a.guard.release).mockImplementation(() => ack.promise); f.registry.register({}, a.guard);
  const ticket = f.registry.capture({ current: () => current })!; expect(await ticket.prepare()).toBe(true);
  const pending = ticket.release(); await Promise.resolve();
  expect(ticket.cancel()).toBe(false);
  if (reason === 'scope') f.scope({});
  else if (reason === 'registration') f.registry.register({}, business().guard);
  else current = false;
  ack.resolve(true); expect(await pending).toBe(false);
  expect(ticket.status()).toMatchObject({ released: 1, failure: 'stale', failClosed: true });
  expect(ticket.canCommit()).toBe(false); expect(a.guard.cancel).not.toHaveBeenCalled();
});

test('exact unregister does not delete a new registration with the same opaque route tag', async () => {
  const f = fixture(), a = business(), b = business(), tag = {};
  const unbind = f.registry.register(tag, a.guard); unbind();
  f.registry.register(tag, b.guard); unbind();
  const ticket = f.registry.capture()!; expect(await ticket.prepare()).toBe(true);
  expect(a.guard.prepare).not.toHaveBeenCalled(); expect(b.guard.prepare).toHaveBeenCalledTimes(1);
});

test('50 input/resize/unrelated reads do zero prepare/release/cancel I/O and do not invalidate admission', async () => {
  const f = fixture(), a = business(); f.registry.register({}, a.guard);
  const ticket = f.registry.capture()!;
  for (let update = 0; update < 50; update++) { ticket.status(); ticket.current(); ticket.canClose(); }
  expect(a.guard.prepare).not.toHaveBeenCalled(); expect(a.guard.release).not.toHaveBeenCalled(); expect(a.guard.cancel).not.toHaveBeenCalled();
  expect(await ticket.prepare()).toBe(true);
  for (let update = 0; update < 50; update++) expect(ticket.canClose()).toBe(true);
  expect(a.guard.prepare).toHaveBeenCalledTimes(1); expect(a.guard.release).not.toHaveBeenCalled();
});

test('async editor leave keeps the editor mounted until original guard and writer release ACK both finish', async () => {
  const f = fixture(), a = business(), releaseAck = deferred<boolean>(), editorGuard = deferred<void>();
  vi.mocked(a.guard.release).mockImplementation(() => releaseAck.promise); f.registry.register({}, a.guard);
  const ticket = f.registry.capture()!; expect(await ticket.prepare()).toBe(true);
  let mounted = true;
  const editorRelease = vi.fn(() => { mounted = false; }), commit = vi.fn();
  const page = createDesktopPageDeparture({ scope: () => 'original-host', onIntent: vi.fn(), onError: vi.fn() });
  page.bind({ current: () => mounted, requestLeave: async done => { done(); await editorGuard.promise; },
    release: editorRelease, requestClose: async () => true, canClose: () => true });
  const pending = page.request(commit, () => ticket.current() && (ticket.canClose() || ticket.canCommit()), ticket.release);
  await Promise.resolve(); await Promise.resolve();
  expect(mounted).toBe(true); expect(commit).not.toHaveBeenCalled();
  releaseAck.resolve(true); await Promise.resolve(); await Promise.resolve();
  expect(mounted).toBe(true); expect(commit).not.toHaveBeenCalled();
  editorGuard.resolve(); expect(await pending).toBe(true);
  expect(editorRelease).toHaveBeenCalledTimes(1); expect(commit).toHaveBeenCalledTimes(1); expect(ticket.finish()).toBe(true);
});

test('partial writer release failure leaves original editor/UI mounted without a route commit', async () => {
  const f = fixture(), a = business(), b = business(); f.registry.register({}, a.guard); f.registry.register({}, b.guard);
  vi.mocked(b.guard.release).mockResolvedValue(false);
  const ticket = f.registry.capture()!; expect(await ticket.prepare()).toBe(true);
  const editorRelease = vi.fn(), commit = vi.fn();
  const page = createDesktopPageDeparture({ scope: () => 'host', onIntent: vi.fn(), onError: vi.fn() });
  page.bind({ current: () => true, requestLeave: async done => { done(); }, release: editorRelease, requestClose: async () => true, canClose: () => true });
  expect(await page.request(commit, () => ticket.current() && (ticket.canClose() || ticket.canCommit()), ticket.release)).toBe(false);
  expect(editorRelease).not.toHaveBeenCalled(); expect(commit).not.toHaveBeenCalled();
  expect(ticket.status()).toMatchObject({ released: 1, failClosed: true }); expect(a.guard.cancel).not.toHaveBeenCalled();
});

test('push/Context/Timeline retention prepares every mounted owner but releases none, then restores original handles', async () => {
  const f = fixture(), foreground = business(), hidden = business();
  f.registry.register({}, foreground.guard); f.registry.register({}, hidden.guard);
  const ticket = f.registry.capture({ release: () => false })!;
  expect(await ticket.prepare()).toBe(true);
  expect(foreground.guard.prepare).toHaveBeenCalledTimes(1); expect(hidden.guard.prepare).toHaveBeenCalledTimes(1);
  expect(await ticket.release()).toBe(true); expect(ticket.canCommit()).toBe(true);
  expect(foreground.paused()).toBe(true); expect(hidden.paused()).toBe(true);
  expect(ticket.finish()).toBe(true);
  for (const owner of [foreground, hidden]) {
    expect(owner.guard.release).not.toHaveBeenCalled(); expect(owner.guard.cancel).toHaveBeenCalledTimes(1);
    expect(owner.paused()).toBe(false); expect(owner.released()).toBe(false);
    expect(owner.draft).toBe('retained original draft');
  }
  const returning = f.registry.capture({ release: () => false })!;
  expect(await returning.prepare()).toBe(true); expect(returning.cancel()).toBe(true);
});

test('retained hidden pending/unknown owner vetoes navigation without releasing the removed route', async () => {
  const f = fixture(), visible = business(), hidden = business(), removed = {}; hidden.unknown(true);
  f.registry.register(removed, visible.guard); f.registry.register({}, hidden.guard);
  const ticket = f.registry.capture({ release: tag => tag === removed })!;
  expect(await ticket.prepare()).toBe(false);
  expect(visible.guard.prepare).toHaveBeenCalledTimes(1); expect(hidden.guard.prepare).toHaveBeenCalledTimes(1);
  expect(visible.guard.release).not.toHaveBeenCalled(); expect(hidden.guard.release).not.toHaveBeenCalled();
  expect(visible.guard.cancel).toHaveBeenCalledTimes(1); expect(hidden.guard.canClose()).toBe(false);
});

test('remove releases only the frozen destruction subset; successful finish restores retained owners without reacquire', async () => {
  const f = fixture(), removed = business(), retained = business(), removedTag = {}, retainedTag = {};
  const removedTags = new Set([removedTag]);
  f.registry.register(removedTag, removed.guard); f.registry.register(retainedTag, retained.guard);
  const ticket = f.registry.capture({ release: tag => removedTags.has(tag) })!;
  removedTags.clear(); removedTags.add(retainedTag);
  expect(await ticket.prepare()).toBe(true); expect(await ticket.release()).toBe(true);
  expect(removed.guard.release).toHaveBeenCalledTimes(1); expect(retained.guard.release).not.toHaveBeenCalled();
  expect(ticket.canCommit()).toBe(true); expect(ticket.finish()).toBe(true);
  expect(removed.guard.cancel).not.toHaveBeenCalled(); expect(retained.guard.cancel).toHaveBeenCalledTimes(1);
  expect(retained.paused()).toBe(false); expect(retained.draft).toBe('retained original draft');
});

test('subset release failure restores retained and not-dispatched owners, but never confirmed or unknown releases', async () => {
  const f = fixture(), confirmed = business(), unknown = business(), later = business(), retained = business();
  const tags = [{}, {}, {}, {}];
  [confirmed, unknown, later, retained].forEach((owner, index) => f.registry.register(tags[index], owner.guard));
  vi.mocked(unknown.guard.release).mockResolvedValue(false);
  const ticket = f.registry.capture({ release: tag => tag !== tags[3] })!;
  expect(await ticket.prepare()).toBe(true); expect(await ticket.release()).toBe(false);
  expect(ticket.status()).toMatchObject({ released: 1, failClosed: true, failure: 'release' });
  for (const owner of [confirmed, unknown]) { expect(owner.guard.cancel).not.toHaveBeenCalled(); expect(owner.paused()).toBe(true); }
  for (const owner of [later, retained]) {
    expect(owner.guard.release).not.toHaveBeenCalled(); expect(owner.guard.cancel).toHaveBeenCalledTimes(1); expect(owner.paused()).toBe(false);
  }
  expect(ticket.cancel()).toBe(false); expect(ticket.canCommit()).toBe(false); expect(ticket.finish()).toBe(false);
});

test('early release during flush cannot abandon the pending ticket or let another prepare share its handle', async () => {
  const f = fixture(), a = business(), flush = deferred<boolean>(); f.registry.register({}, a.guard);
  const prepare = vi.mocked(a.guard.prepare).getMockImplementation()!;
  vi.mocked(a.guard.prepare).mockImplementation(async () => { await flush.promise; return prepare(); });
  const ticket = f.registry.capture()!, pending = ticket.prepare(); await Promise.resolve();
  expect(await ticket.release()).toBe(false); expect(f.registry.capture()).toBeNull();
  flush.resolve(true); expect(await pending).toBe(true); expect(ticket.cancel()).toBe(true);
});

test('a final editor veto after release ACK restores only retained owners, keeping native-released owners fail closed', async () => {
  const f = fixture(), removed = business(), retained = business(), tag = {};
  f.registry.register(tag, removed.guard); f.registry.register({}, retained.guard);
  const ticket = f.registry.capture({ release: route => route === tag })!;
  expect(await ticket.prepare()).toBe(true); expect(await ticket.release()).toBe(true);
  expect(ticket.cancel()).toBe(false); expect(ticket.canCommit()).toBe(false);
  expect(ticket.status()).toMatchObject({ phase: 'blocked', released: 1, failClosed: true });
  expect(removed.guard.cancel).not.toHaveBeenCalled(); expect(retained.guard.cancel).toHaveBeenCalledTimes(1);
  expect(retained.paused()).toBe(false);
});

test('veto during release waits for that ACK, cancels only undispatched owners and never dispatches another release', async () => {
  const f = fixture(), first = business(), next = business(), ack = deferred<boolean>();
  f.registry.register({}, first.guard); f.registry.register({}, next.guard);
  vi.mocked(first.guard.release).mockImplementation(() => ack.promise);
  const ticket = f.registry.capture()!; expect(await ticket.prepare()).toBe(true);
  const pending = ticket.release(); await Promise.resolve();
  expect(ticket.cancel()).toBe(false); expect(first.guard.cancel).not.toHaveBeenCalled();
  expect(next.guard.cancel).toHaveBeenCalledTimes(1); expect(f.registry.capture()).toBeNull();
  ack.resolve(true); expect(await pending).toBe(false); expect(next.guard.release).not.toHaveBeenCalled();
  expect(ticket.status()).toMatchObject({ released: 1, failClosed: true });
});
