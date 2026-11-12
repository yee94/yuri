import { afterEach, describe, expect, it, vi } from 'vitest';
import { getEventListeners } from 'node:events';
import { execFileSync } from 'node:child_process';
import { remoteDeadlineSignal } from './deadline.js';

afterEach(() => vi.useRealTimers());
describe('remote deadline lifecycle', () => {
  it('keeps the full deadline and TimeoutError after response headers could have arrived', () => {
    vi.useFakeTimers();
    const signal = remoteDeadlineSignal(15000);
    vi.advanceTimersByTime(14999); expect(signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(signal.reason).toBeInstanceOf(DOMException);
    expect(signal.reason.name).toBe('TimeoutError');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does no timer work for an already cancelled parent and preserves its reason', () => {
    vi.useFakeTimers(); const reason = new Error('closed');
    const signal = remoteDeadlineSignal(15000, [AbortSignal.abort(reason)]);
    expect(signal.reason).toBe(reason); expect(vi.getTimerCount()).toBe(0);
  });
  it('clears all 300 child deadlines immediately when the connection closes', () => {
    vi.useFakeTimers(); const parent = new AbortController();
    const signals = Array.from({ length: 300 }, () => remoteDeadlineSignal(15000, [parent.signal]));
    expect(vi.getTimerCount()).toBe(300);
    expect(getEventListeners(parent.signal, 'abort')).toHaveLength(0);
    parent.abort(); expect(vi.getTimerCount()).toBe(0);
    expect(signals.every(signal => signal.aborted && signal.reason === parent.signal.reason)).toBe(true);
  });
  it('request cancellation disposes its deadline without cancelling another request', () => {
    vi.useFakeTimers(); const connection = new AbortController(); const request = new AbortController();
    const a = remoteDeadlineSignal(300000, [connection.signal, request.signal]);
    const b = remoteDeadlineSignal(15000, [connection.signal]);
    request.abort(new Error('request cancelled'));
    expect(a.reason).toBe(request.signal.reason); expect(b.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
    connection.abort(); expect(vi.getTimerCount()).toBe(0);
  });
  it('does not replace the first abort reason or fire later after cancellation', () => {
    vi.useFakeTimers(); const parent = new AbortController(); const reason = new Error('first');
    const signal = remoteDeadlineSignal(5000, [parent.signal]); const notify = vi.fn();
    signal.addEventListener('abort', notify); parent.abort(reason); vi.advanceTimersByTime(10000);
    expect(signal.reason).toBe(reason); expect(notify).toHaveBeenCalledTimes(1);
  });
  it('uses an unref deadline, matching the standalone timeout process-lifetime behavior', () => {
    const timeout = vi.spyOn(globalThis, 'setTimeout'); const parent = new AbortController();
    try {
      remoteDeadlineSignal(15000, [parent.signal]);
      expect(timeout.mock.results[0].value.hasRef()).toBe(false);
    } finally { parent.abort(); timeout.mockRestore(); }
  });
  it('keeps a live signal deadline functional across collection of unrelated objects', () => {
    // This checks WeakRef ownership, not a memory or latency budget.
    execFileSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { remoteDeadlineSignal } from ${JSON.stringify(new URL('./deadline.js', import.meta.url).href)};
      const signal = AbortSignal.any([remoteDeadlineSignal(200), new AbortController().signal]);
      for (let i = 0; i < 4; i++) { await new Promise(resolve => setTimeout(resolve, 5)); global.gc(); }
      await new Promise(resolve => setTimeout(resolve, 300));
      assert.equal(signal.aborted, true);
      assert.equal(signal.reason.name, 'TimeoutError');
    `], { timeout: 10000 });
  });
});
