import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Node's promise timers capture native timers before Vitest's fake clock installs.
vi.mock('node:timers/promises', () => ({
  setTimeout: (ms, value, { signal }) => new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new Error('cancelled')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(value); }, ms);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  }),
}));
import { createWeixinTyping } from './typing.js';

let typing;
beforeEach(() => vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }));
afterEach(async () => { await typing?.close(); typing = null; vi.useRealTimers(); });
const turn = (assistantID, turnID, phase = 'start') => ({
  type: `yuri:contact-turn-${phase}`, properties: { assistantID, turnID },
});
const flush = async () => { await vi.advanceTimersByTimeAsync(0); };
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const fixture = () => {
  const bindings = new Map(['a', 'b'].map((id) => [id, {
    assistant_id: id, epoch: `epoch-${id}`, peer_id: `owner-${id}`, context_token: `context-${id}`, status: 'connected',
  }]));
  const api = {
    getConfig: vi.fn(async (binding) => ({ ret: 0, typing_ticket: `ticket-${binding.assistant_id}` })),
    sendTyping: vi.fn(async () => ({})),
  };
  const current = (binding) => bindings.get(binding.assistant_id)?.epoch === binding.epoch;
  typing = createWeixinTyping({ api, getBinding: (id) => bindings.get(id), isCurrent: current, canCancel: current });
  return { api, bindings };
};

describe('live WeChat typing lifecycle', () => {
  it('stays idle without a live start and coalesces duplicate starts and streaming deltas', async () => {
    const { api } = fixture();
    for (let index = 0; index < 50; index++) {
      typing.onTurnEvent({ type: 'yuri:contact-bubble-delta', properties: { assistantID: 'a', turnID: 'old', delta: 'text' } });
      typing.onTurnEvent(turn('a', 'old', 'end'));
    }
    await flush();
    expect(api.getConfig).not.toHaveBeenCalled();
    typing.onTurnEvent(turn('a', 'one'));
    await flush();
    for (let index = 0; index < 50; index++) typing.onTurnEvent(turn('a', 'one'));
    await flush();
    expect(api.getConfig).toHaveBeenCalledTimes(1);
    expect(api.sendTyping.mock.calls.map((call) => call[2])).toEqual([1]);
    typing.onTurnEvent(turn('a', 'one', 'end'));
    await flush();
    expect(api.sendTyping.mock.calls.map((call) => call[2])).toEqual([1, 2]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.sendTyping).toHaveBeenCalledTimes(2);
  });

  it('refreshes at a bounded cadence, keeps overlapping turns active, and reuses an idle ticket', async () => {
    const { api } = fixture();
    typing.onTurnEvent(turn('a', 'one'));
    typing.onTurnEvent(turn('a', 'two'));
    await flush();
    await vi.advanceTimersByTimeAsync(7999);
    expect(api.sendTyping).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.sendTyping).toHaveBeenCalledTimes(2);
    typing.onTurnEvent(turn('a', 'one', 'end'));
    await flush();
    expect(api.sendTyping.mock.calls.map((call) => call[2])).toEqual([1, 1]);
    typing.onTurnEvent(turn('a', 'two', 'end'));
    await flush();
    typing.onTurnEvent(turn('a', 'three'));
    await flush();
    expect(api.sendTyping.mock.calls.map((call) => call[2])).toEqual([1, 1, 2, 1]);
    expect(api.getConfig).toHaveBeenCalledTimes(1);
  });

  it('never starts typing from a ticket that arrives after completion or disconnect', async () => {
    const { api } = fixture();
    const ticket = deferred();
    api.getConfig.mockImplementation(() => ticket.promise);
    typing.onTurnEvent(turn('a', 'one'));
    typing.onTurnEvent(turn('a', 'one', 'end'));
    ticket.resolve({ ret: 0, typing_ticket: 'late' });
    await flush();
    expect(api.sendTyping).not.toHaveBeenCalled();

    const other = deferred();
    api.getConfig.mockImplementation(() => other.promise);
    typing.onTurnEvent(turn('b', 'two'));
    const disconnected = typing.forget('b');
    other.resolve({ ret: 0, typing_ticket: 'late-b' });
    await disconnected;
    expect(api.sendTyping).not.toHaveBeenCalled();
  });

  it('serializes late start completion, cancellation and the next live turn', async () => {
    const { api } = fixture();
    const start = deferred();
    api.sendTyping.mockImplementationOnce(() => start.promise);
    typing.onTurnEvent(turn('a', 'one'));
    await flush();
    typing.onTurnEvent(turn('a', 'one', 'end'));
    typing.onTurnEvent(turn('a', 'two'));
    await flush();
    expect(api.sendTyping).toHaveBeenCalledTimes(1);
    start.resolve({});
    await flush();
    expect(api.sendTyping.mock.calls.map((call) => call[2])).toEqual([1, 2, 1]);
  });

  it('isolates accounts and backs off missing/failed tickets without aborting other typing', async () => {
    const { api } = fixture();
    api.getConfig.mockImplementation(async (binding) => binding.assistant_id === 'a'
      ? { ret: 0 } : { ret: 0, typing_ticket: 'ticket-b' });
    typing.onTurnEvent(turn('a', 'one'));
    typing.onTurnEvent(turn('b', 'two'));
    await flush();
    expect(api.sendTyping.mock.calls.map((call) => [call[0].assistant_id, call[2]])).toEqual([['b', 1]]);
    await vi.advanceTimersByTimeAsync(1999);
    expect(api.getConfig).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.getConfig).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(4000);
    expect(api.getConfig).toHaveBeenCalledTimes(4);
    typing.onTurnEvent(turn('a', 'one', 'end'));
    await flush();
    expect(api.sendTyping).toHaveBeenCalledTimes(1);
  });

  it('cancels on forget/shutdown with a fresh signal and drops the per-binding ticket cache', async () => {
    const { api, bindings } = fixture();
    typing.onTurnEvent(turn('a', 'one'));
    await flush();
    const signal = api.sendTyping.mock.calls[0][3];
    await typing.forget('a');
    expect(signal.aborted).toBe(true);
    expect(api.sendTyping.mock.calls.at(-1).slice(1, 3)).toEqual(['ticket-a', 2]);
    expect(api.sendTyping.mock.calls.at(-1)[3]).toBeUndefined();
    bindings.set('a', { ...bindings.get('a'), epoch: 'new-epoch' });
    typing.onTurnEvent(turn('a', 'two'));
    await flush();
    expect(api.getConfig).toHaveBeenCalledTimes(2);
    await typing.close();
    expect(api.sendTyping.mock.calls.map((call) => call[2])).toEqual([1, 2, 1, 2]);
  });

  it('fences a ticket completion after lease/epoch changes without cancelling another owner', async () => {
    const { api, bindings } = fixture();
    const ticket = deferred();
    api.getConfig.mockImplementationOnce(() => ticket.promise);
    typing.onTurnEvent(turn('a', 'one'));
    bindings.set('a', { ...bindings.get('a'), epoch: 'rebound' });
    ticket.resolve({ ret: 0, typing_ticket: 'old-ticket' });
    await flush();
    expect(api.sendTyping).not.toHaveBeenCalled();
  });

  it('refreshes an expired ticket using the latest conversation context', async () => {
    const { api, bindings } = fixture();
    typing.onTurnEvent(turn('a', 'one'));
    await flush();
    typing.onTurnEvent(turn('a', 'one', 'end'));
    await flush();
    vi.setSystemTime(Date.now() + 24 * 60 * 60 * 1000);
    bindings.set('a', { ...bindings.get('a'), context_token: 'new-context' });
    typing.onTurnEvent(turn('a', 'two'));
    await flush();
    expect(api.getConfig).toHaveBeenCalledTimes(2);
    expect(api.getConfig.mock.calls[1][0].context_token).toBe('new-context');
  });

  it('stops refreshing on ownership loss and does not cancel the replacement owner', async () => {
    const { api, bindings } = fixture();
    typing.onTurnEvent(turn('a', 'one'));
    await flush();
    bindings.set('a', { ...bindings.get('a'), epoch: 'replacement-owner' });
    await vi.advanceTimersByTimeAsync(8000);
    await typing.clear();
    expect(api.sendTyping.mock.calls.map((call) => call[2])).toEqual([1]);
  });
});
