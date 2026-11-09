import { describe, expect, test, vi } from 'vitest';
import { createDesktopAssistantReadMarker, type DesktopAssistantReadMarkerOperation, type DesktopAssistantReadMarkerFrame, type DesktopAssistantReadMarkerMeasurement } from './desktop-assistant-read-marker';
import type { AssistantReadPosition } from '../ui/src/queries/assistantDTO';

const position: AssistantReadPosition = { generation: 3, ordinal: 7, messageID: 'message-7' };
const frame: DesktopAssistantReadMarkerFrame = { offset: { x: 0, y: 700 }, contentSize: { width: 400, height: 1000 }, size: { width: 400, height: 300 } };
const geometry: DesktopAssistantReadMarkerMeasurement = { marker: { x: 20, y: 399, width: 1, height: 1 }, viewport: { x: 10, y: 100, width: 400, height: 300 } };
const response = (value = position) => ({ assistantID: 'a/b', changed: true, unreadCount: 0, revision: 8, readWatermark: value, readTip: value });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(finish => { resolve = finish; });
  return { promise, resolve };
}

function fixture() {
  let active = true, now = 1000, currentPosition: AssistantReadPosition | null = { ...position };
  let measured: DesktopAssistantReadMarkerMeasurement | null = structuredClone(geometry);
  const request = vi.fn<DesktopAssistantReadMarkerOperation['request']>().mockResolvedValue(response());
  function lane() { return { current: () => active, request }; }
  let operation: DesktopAssistantReadMarkerOperation | null = lane();
  const measure = vi.fn(async () => measured);
  const controller = createDesktopAssistantReadMarker({ assistantID: 'a/b', current: () => active,
    position: () => currentPosition, operation: () => operation, measure, now: () => now });
  return { controller, request, measure, lane,
    get position() { return currentPosition; }, set position(value) { currentPosition = value; },
    get operation() { return operation; }, set operation(value) { operation = value; },
    set geometry(value: DesktopAssistantReadMarkerMeasurement | null) { measured = value; },
    set active(value: boolean) { active = value; }, set now(value: number) { now = value; },
  };
}

describe('desktop Assistant contact read marker controller', () => {
  test('no frame means zero geometry work and zero POST for 50 explicit checks', async () => {
    const f = fixture();
    for (let index = 0; index < 50; index++) expect(await f.controller.check()).toBe(false);
    expect(f.measure).not.toHaveBeenCalled();
    expect(f.request).not.toHaveBeenCalled();
  });

  test('a real physical bottom frame and fully visible marker send the exact position once', async () => {
    const f = fixture();
    f.controller.scroll(frame);
    expect(await f.controller.check()).toBe(true);
    expect(f.request).toHaveBeenCalledExactlyOnceWith('/api/yuri/assistants/a%2Fb/contact/read', 'POST', position);
    expect(await f.controller.check()).toBe(false);
    expect(f.request).toHaveBeenCalledTimes(1);
  });

  test('a valid unchanged ACK is done for equal position values, without mutating the authoritative response', async () => {
    const f = fixture(), ack = Object.freeze({ ...response(), changed: false, unreadCount: 4 });
    f.request.mockResolvedValueOnce(ack);
    f.controller.scroll(frame);
    expect(await f.controller.check()).toBe(true);
    f.position = { ...position };
    for (let index = 0; index < 50; index++) expect(await f.controller.check()).toBe(false);
    expect(f.measure).toHaveBeenCalledTimes(1);
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(ack.unreadCount).toBe(4);
  });

  test.each([
    ['missing marker', null],
    ['zero marker height', { ...geometry, marker: { ...geometry.marker, height: 0 } }],
    ['zero marker width', { ...geometry, marker: { ...geometry.marker, width: 0 } }],
    ['zero viewport', { ...geometry, viewport: { ...geometry.viewport, height: 0 } }],
    ['NaN marker', { ...geometry, marker: { ...geometry.marker, y: NaN } }],
    ['infinite viewport', { ...geometry, viewport: { ...geometry.viewport, width: Infinity } }],
    ['above viewport', { ...geometry, marker: { ...geometry.marker, y: 99.9 } }],
    ['partly below viewport', { ...geometry, marker: { ...geometry.marker, y: 399.5 } }],
    ['left edge only', { ...geometry, marker: { ...geometry.marker, x: 9 } }],
    ['right edge only', { ...geometry, marker: { ...geometry.marker, x: 410 } }],
    ['horizontally clipped pixel', { ...geometry, marker: { ...geometry.marker, x: 9.5 } }],
  ] satisfies Array<[string, DesktopAssistantReadMarkerMeasurement | null]>)('%s never POSTs', async (_, value) => {
    const f = fixture();
    f.geometry = value;
    f.controller.scroll(frame);
    expect(await f.controller.check()).toBe(false);
    expect(f.request).not.toHaveBeenCalled();
  });

  test.each([
    ['away from latest', { ...frame, offset: { x: 0, y: 697.99 } }],
    ['beyond bottom overscroll tolerance', { ...frame, offset: { x: 0, y: 702.01 } }],
    ['top overscroll', { ...frame, offset: { x: 0, y: -10 } }],
    ['zero viewport height', { ...frame, size: { width: 400, height: 0 } }],
    ['zero viewport width', { ...frame, size: { width: 0, height: 300 } }],
    ['zero content', { ...frame, contentSize: { width: 400, height: 0 } }],
    ['NaN offset', { ...frame, offset: { x: 0, y: NaN } }],
    ['infinite content', { ...frame, contentSize: { width: 400, height: Infinity } }],
  ])('%s does zero measurement work even for 50 checks', async (_, value) => {
    const f = fixture();
    f.controller.scroll(value);
    for (let index = 0; index < 50; index++) expect(await f.controller.check()).toBe(false);
    expect(f.measure).not.toHaveBeenCalled();
    expect(f.request).not.toHaveBeenCalled();
  });

  test.each([698, 702])('physical offset %i is within the inclusive two-point latest boundary', async y => {
    const f = fixture();
    f.controller.scroll({ ...frame, offset: { x: 0, y } });
    expect(await f.controller.check()).toBe(true);
    expect(f.request).toHaveBeenCalledTimes(1);
  });

  test('50 ineligible active/position/lane checks perform no measurement or POST', async () => {
    for (const reason of ['inactive', 'gap', 'invalid-position', 'no-operation', 'stale-operation'] as const) {
      const f = fixture();
      if (reason === 'inactive') f.active = false;
      if (reason === 'gap') f.position = null;
      if (reason === 'invalid-position') f.position = { ...position, ordinal: NaN };
      if (reason === 'no-operation') f.operation = null;
      if (reason === 'stale-operation') f.operation = { current: () => false, request: f.request };
      f.controller.scroll(frame);
      for (let index = 0; index < 50; index++) expect(await f.controller.check()).toBe(false);
      expect(f.measure).not.toHaveBeenCalled();
      expect(f.request).not.toHaveBeenCalled();
    }
  });

  test.each(['generation', 'ordinal', 'messageID', 'op', 'Host', 'modal', 'gap', 'dispose'] as const)('%s changing during measure rejects the old view', async change => {
    const f = fixture(), pending = deferred<DesktopAssistantReadMarkerMeasurement | null>();
    f.measure.mockReturnValueOnce(pending.promise);
    f.controller.scroll(frame);
    const result = f.controller.check();
    await Promise.resolve();
    if (change === 'generation') f.position = { ...position, generation: 4 };
    if (change === 'ordinal') f.position = { ...position, ordinal: 8 };
    if (change === 'messageID') f.position = { ...position, messageID: 'replacement' };
    if (change === 'op') f.operation = f.lane();
    if (change === 'Host' || change === 'modal') f.active = false;
    if (change === 'gap') f.position = null;
    if (change === 'dispose') f.controller.dispose();
    pending.resolve(geometry);
    expect(await result).toBe(false);
    expect(f.request).not.toHaveBeenCalled();
  });

  test('concurrent explicit checks coalesce, while an intervening scroll invalidates and remeasures the latest frame', async () => {
    const f = fixture(), pending = deferred<DesktopAssistantReadMarkerMeasurement | null>();
    f.measure.mockReturnValueOnce(pending.promise);
    f.controller.scroll(frame);
    const first = f.controller.check();
    expect(f.controller.check()).toBe(first);
    await Promise.resolve();
    expect(f.measure).toHaveBeenCalledTimes(1);
    f.controller.scroll({ ...frame, offset: { x: 0, y: 699 } });
    expect(f.controller.check()).toBe(first);
    pending.resolve(geometry);
    expect(await first).toBe(true);
    expect(f.measure).toHaveBeenCalledTimes(2);
    expect(f.request).toHaveBeenCalledTimes(1);
  });

  test('a new layout check during measure invalidates old visible geometry, without losing the current check', async () => {
    const f = fixture(), pending = deferred<DesktopAssistantReadMarkerMeasurement | null>();
    f.measure.mockReturnValueOnce(pending.promise);
    f.controller.scroll(frame);
    const first = f.controller.check();
    await Promise.resolve();
    f.geometry = null;
    expect(f.controller.check()).toBe(first);
    pending.resolve(geometry);
    expect(await first).toBe(false);
    expect(f.measure).toHaveBeenCalledTimes(2);
    expect(f.request).not.toHaveBeenCalled();
  });

  test('a scroll away from latest during a pending measure revokes visible old geometry with no replacement work', async () => {
    const f = fixture(), pending = deferred<DesktopAssistantReadMarkerMeasurement | null>();
    f.measure.mockReturnValueOnce(pending.promise);
    f.controller.scroll(frame);
    const first = f.controller.check();
    await Promise.resolve();
    f.controller.scroll({ ...frame, offset: { x: 0, y: 600 } });
    pending.resolve(geometry);
    expect(await first).toBe(false);
    expect(f.measure).toHaveBeenCalledTimes(1);
    expect(f.request).not.toHaveBeenCalled();
  });

  test('invalidating a frame revokes a pending visible measure and requires a new real frame', async () => {
    const f = fixture(), pending = deferred<DesktopAssistantReadMarkerMeasurement | null>();
    f.measure.mockReturnValueOnce(pending.promise);
    f.controller.scroll(frame);
    const first = f.controller.check();
    await Promise.resolve();
    f.controller.invalidateFrame();
    pending.resolve(geometry);
    expect(await first).toBe(false);
    for (let index = 0; index < 50; index++) expect(await f.controller.check()).toBe(false);
    expect(f.measure).toHaveBeenCalledTimes(1);
    expect(f.request).not.toHaveBeenCalled();
    f.controller.scroll(frame);
    expect(await f.controller.check()).toBe(true);
    expect(f.measure).toHaveBeenCalledTimes(2);
    expect(f.request).toHaveBeenCalledTimes(1);
  });

  test('a temporary modal open/close invalidates pending geometry even when the exact operation survives', async () => {
    const f = fixture(), pending = deferred<DesktopAssistantReadMarkerMeasurement | null>();
    f.measure.mockReturnValueOnce(pending.promise);
    f.controller.scroll(frame);
    const first = f.controller.check();
    await Promise.resolve();
    f.active = false;
    f.controller.check();
    f.active = true;
    f.geometry = null;
    f.controller.check();
    pending.resolve(geometry);
    expect(await first).toBe(false);
    expect(f.measure).toHaveBeenCalledTimes(2);
    expect(f.request).not.toHaveBeenCalled();
  });

  test('measurement failure preserves failure and cooldown instead of pretending an empty successful read', async () => {
    const f = fixture();
    f.measure.mockRejectedValueOnce(new Error('measurement unavailable'));
    f.controller.scroll(frame);
    expect(await f.controller.check()).toBe(false);
    expect(await f.controller.check()).toBe(false);
    expect(f.measure).toHaveBeenCalledTimes(1);
    expect(f.request).not.toHaveBeenCalled();
    f.now = 16_000;
    expect(await f.controller.check()).toBe(true);
    expect(f.measure).toHaveBeenCalledTimes(2);
    expect(f.request).toHaveBeenCalledTimes(1);
  });

  test('the physical short-content frame, not a guessed inset or row mount, proves latest', async () => {
    const f = fixture();
    f.controller.scroll({ offset: { x: 0, y: 0 }, contentSize: { width: 400, height: 300 }, size: { width: 400, height: 300 } });
    expect(await f.controller.check()).toBe(true);
    expect(f.request).toHaveBeenCalledTimes(1);
  });

  test('a new same-owner lane can use the original real frame only after a fresh exact-lane measurement', async () => {
    const f = fixture();
    f.geometry = null;
    f.controller.scroll(frame);
    expect(await f.controller.check()).toBe(false);
    f.measure.mockClear();
    f.geometry = geometry;
    f.operation = f.lane();
    expect(await f.controller.check()).toBe(true);
    expect(f.measure).toHaveBeenCalledTimes(1);
    expect(f.request).toHaveBeenCalledTimes(1);
  });

  test('a real initial scroll before lane readiness is retained, but does no work until an explicit ready check', async () => {
    const f = fixture();
    f.operation = null;
    f.controller.scroll(frame);
    expect(await f.controller.check()).toBe(false);
    expect(f.measure).not.toHaveBeenCalled();
    f.operation = f.lane();
    expect(await f.controller.check()).toBe(true);
    expect(f.measure).toHaveBeenCalledTimes(1);
    expect(f.request).toHaveBeenCalledTimes(1);
  });

  test('the caller-owned frame and position objects cannot change captured dispatch data', async () => {
    const f = fixture(), pending = deferred<DesktopAssistantReadMarkerMeasurement | null>();
    const callerFrame = structuredClone(frame), callerPosition = { ...position };
    f.position = callerPosition;
    f.measure.mockReturnValueOnce(pending.promise);
    f.controller.scroll(callerFrame);
    const first = f.controller.check();
    await Promise.resolve();
    callerFrame.offset.y = 0;
    callerPosition.ordinal = 8;
    pending.resolve(geometry);
    expect(await first).toBe(false);
    expect(f.request).not.toHaveBeenCalled();
    f.position = { ...position };
    expect(await f.controller.check()).toBe(true);
    expect(f.request).toHaveBeenCalledExactlyOnceWith('/api/yuri/assistants/a%2Fb/contact/read', 'POST', position);
  });

  test.each(['generation', 'ordinal', 'messageID', 'operation', 'modal'] as const)('late ACK after %s changes does not mark the new target done', async change => {
    const f = fixture(), pending = deferred<unknown>();
    f.request.mockReturnValueOnce(pending.promise);
    f.controller.scroll(frame);
    const first = f.controller.check();
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledTimes(1));
    if (change === 'generation') f.position = { ...position, generation: 4 };
    if (change === 'ordinal') f.position = { ...position, ordinal: 8 };
    if (change === 'messageID') f.position = { ...position, messageID: 'replacement' };
    if (change === 'operation') f.operation = f.lane();
    if (change === 'modal') f.active = false;
    pending.resolve(response());
    expect(await first).toBe(false);
    if (change === 'modal') f.active = true;
    if (change === 'operation') f.controller.scroll(frame);
    expect(await f.controller.check()).toBe(true);
    expect(f.request).toHaveBeenCalledTimes(2);
    expect(f.request.mock.calls[1][2]).toEqual(f.position);
  });

  test('a position event during POST is retained behind one flight and sends only after fresh measurement', async () => {
    const f = fixture(), pending = deferred<unknown>();
    let concurrent = 0, maximum = 0;
    f.request.mockImplementationOnce(async () => {
      maximum = Math.max(maximum, ++concurrent);
      const value = await pending.promise;
      concurrent--;
      return value;
    }).mockImplementationOnce(async () => {
      maximum = Math.max(maximum, ++concurrent);
      concurrent--;
      return response({ ...position, ordinal: 8, messageID: 'message-8' });
    });
    f.controller.scroll(frame);
    const first = f.controller.check();
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledTimes(1));
    f.position = { ...position, ordinal: 8, messageID: 'message-8' };
    expect(f.controller.check()).toBe(first);
    pending.resolve(response());
    expect(await first).toBe(true);
    expect(maximum).toBe(1);
    expect(f.measure).toHaveBeenCalledTimes(2);
    expect(f.request).toHaveBeenCalledTimes(2);
    expect(f.request.mock.calls[1][2]).toEqual({ generation: 3, ordinal: 8, messageID: 'message-8' });
    expect(await f.controller.check()).toBe(false);
  });

  test('an explicit position check in the ACK-settlement microtask cannot fall between flight completion and release', async () => {
    const f = fixture(), pending = deferred<unknown>();
    f.request.mockReturnValueOnce(pending.promise);
    f.controller.scroll(frame);
    const first = f.controller.check();
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledTimes(1));
    let second!: Promise<boolean>;
    pending.resolve(response());
    queueMicrotask(() => {
      f.position = { ...position, ordinal: 8, messageID: 'message-8' };
      second = f.controller.check();
    });
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(f.request).toHaveBeenCalledTimes(2);
    expect(f.request.mock.calls[1][2]).toEqual({ generation: 3, ordinal: 8, messageID: 'message-8' });
  });

  test.each(['failure', 'malformed', 'wrong-assistant'] as const)('%s cools down for 15 seconds and only retries on a new explicit event', async kind => {
    const f = fixture();
    if (kind === 'failure') f.request.mockRejectedValueOnce(new Error('unavailable'));
    if (kind === 'malformed') f.request.mockResolvedValueOnce({ assistantID: 'a/b' });
    if (kind === 'wrong-assistant') f.request.mockResolvedValueOnce({ ...response(), assistantID: 'someone-else' });
    f.controller.scroll(frame);
    expect(await f.controller.check()).toBe(false);
    expect(f.request).toHaveBeenCalledTimes(1);
    f.now = 15_999;
    for (let index = 0; index < 50; index++) expect(await f.controller.check()).toBe(false);
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.measure).toHaveBeenCalledTimes(1);
    f.now = 16_000;
    await Promise.resolve();
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(await f.controller.check()).toBe(true);
    expect(f.request).toHaveBeenCalledTimes(2);
    expect(await f.controller.check()).toBe(false);
  });

  test('a failed target neither delays a different real position nor accumulates a historical done cache', async () => {
    const f = fixture();
    f.request.mockRejectedValueOnce(new Error('failed'));
    f.controller.scroll(frame);
    expect(await f.controller.check()).toBe(false);
    f.position = { ...position, ordinal: 8, messageID: 'message-8' };
    expect(await f.controller.check()).toBe(true);
    f.position = { ...position, generation: 4, ordinal: 0, messageID: 'new-generation' };
    expect(await f.controller.check()).toBe(true);
    f.position = { ...position, ordinal: 8, messageID: 'message-8' };
    expect(await f.controller.check()).toBe(true);
    expect(f.request).toHaveBeenCalledTimes(4);
  });

  test('native sticky unknown remains locked: explicit cooldown checks never bypass or replace the original writer', async () => {
    const f = fixture();
    let unknown = false, dispatches = 0;
    const originalRequest = vi.fn(async () => {
      if (unknown) throw new Error('desktop_writer_required');
      dispatches++;
      unknown = true;
      throw new Error('native_response_unknown');
    });
    f.operation = { current: () => !unknown, request: originalRequest };
    f.controller.scroll(frame);
    expect(await f.controller.check()).toBe(false);
    f.now = 100_000;
    for (let index = 0; index < 50; index++) expect(await f.controller.check()).toBe(false);
    f.position = { ...position, ordinal: 8, messageID: 'message-8' };
    f.controller.scroll(frame);
    expect(await f.controller.check()).toBe(false);
    expect(unknown).toBe(true);
    expect(originalRequest).toHaveBeenCalledTimes(1);
    expect(dispatches).toBe(1);
    expect(f.request).not.toHaveBeenCalled();
  });

  test('a PageOperation whose display stays current still enforces its same sticky-unknown writer at request time', async () => {
    const f = fixture();
    let writerUnknown = false, nativePosts = 0;
    const protectedRequest = vi.fn(async () => {
      if (writerUnknown) throw new Error('desktop_writer_required');
      nativePosts++;
      writerUnknown = true;
      throw new Error('native_response_unknown');
    });
    f.operation = { current: () => true, request: protectedRequest };
    f.controller.scroll(frame);
    expect(await f.controller.check()).toBe(false);
    f.now = 16_000;
    expect(await f.controller.check()).toBe(false);
    expect(protectedRequest).toHaveBeenCalledTimes(2);
    expect(nativePosts).toBe(1);
    expect(writerUnknown).toBe(true);
    expect(f.request).not.toHaveBeenCalled();
  });

  test('has no timers or polling, including after a failed write', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      f.request.mockRejectedValueOnce(new Error('unavailable'));
      f.controller.scroll(frame);
      expect(await f.controller.check()).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      f.now = 100_000;
      await vi.advanceTimersByTimeAsync(100_000);
      expect(f.request).toHaveBeenCalledTimes(1);
      expect(f.measure).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  test.each(['retire', 'dispose'] as const)('%s is permanent and blocks all future geometry/dispatch', async action => {
    const f = fixture();
    f.controller[action]();
    f.controller[action]();
    for (let index = 0; index < 50; index++) {
      f.controller.scroll(frame);
      expect(await f.controller.check()).toBe(false);
    }
    expect(f.measure).not.toHaveBeenCalled();
    expect(f.request).not.toHaveBeenCalled();
  });

  test('dispose during POST ignores the ACK and cannot dispatch a pending position event', async () => {
    const f = fixture(), pending = deferred<unknown>();
    f.request.mockReturnValueOnce(pending.promise);
    f.controller.scroll(frame);
    const first = f.controller.check();
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledTimes(1));
    f.position = { ...position, ordinal: 8 };
    f.controller.check();
    f.controller.dispose();
    pending.resolve(response());
    expect(await first).toBe(false);
    expect(await f.controller.check()).toBe(false);
    expect(f.request).toHaveBeenCalledTimes(1);
  });
});
