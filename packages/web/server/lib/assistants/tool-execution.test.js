import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONTACT_TOOL_TIMEOUT_MS, createContactToolLimiter } from './tool-execution.js';

afterEach(() => vi.useRealTimers());

describe('contact tool deadlines', () => {
  it('preserves successful values, schemas and tool identity without leaving a timer', async () => {
    vi.useFakeTimers();
    const result = { content: [{ type: 'text', text: 'done' }], details: { saved: true } };
    const tool = { name: 'save', parameters: { type: 'object' }, execute: vi.fn(async () => result) };
    const limiter = createContactToolLimiter();
    const limited = limiter.wrap(tool);
    expect(limiter.wrap(tool)).toBe(limited);
    expect(limited.parameters).toBe(tool.parameters);
    expect(await limited.execute('call', {})).toBe(result);
    expect(limiter.timedOut).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['read', 'write', 'edit', 'bash', 'read_session', 'assign_session', 'register_project', 'schedule_task', 'message_assistant', 'load_tools'])('bounds a hanging %s and blocks further operations in that turn', async (name) => {
    vi.useFakeTimers();
    let signal;
    const execute = vi.fn((_id, _params, currentSignal) => {
      signal = currentSignal;
      return new Promise(() => {});
    });
    const limiter = createContactToolLimiter();
    const pending = limiter.wrap({ name, execute }).execute('call', {});
    await vi.advanceTimersByTimeAsync(CONTACT_TOOL_TIMEOUT_MS - 1);
    expect(signal.aborted).toBe(false);
    expect(limiter.timedOut).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ isError: true, terminate: true, details: { error: 'tool_timeout', tool: name, timeoutMs: 300_000 } });
    expect(signal.aborted).toBe(true);
    expect(limiter.timedOut).toBe(true);
    const later = vi.fn();
    expect(await limiter.wrap({ name: 'later', execute: later }).execute('later', {})).toMatchObject({ isError: true, terminate: true });
    expect(later).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('propagates user cancellation without waiting for an uncooperative tool', async () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    let signal;
    const limiter = createContactToolLimiter();
    const pending = limiter.wrap({ name: 'blocked', execute: (_id, _params, currentSignal) => {
      signal = currentSignal;
      return new Promise(() => {});
    } }).execute('call', {}, parent.signal);
    await vi.advanceTimersByTimeAsync(0);
    const cancelled = new Error('user stopped');
    const rejected = expect(pending).rejects.toBe(cancelled);
    parent.abort(cancelled);
    await rejected;
    expect(signal.aborted).toBe(true);
    expect(limiter.timedOut).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores late output and completion after a timeout without replaying the operation', async () => {
    vi.useFakeTimers();
    let finish;
    let publish;
    const onUpdate = vi.fn();
    const limiter = createContactToolLimiter();
    const execute = vi.fn((_id, _params, _signal, update) => {
      publish = update;
      return new Promise((resolve) => { finish = resolve; });
    });
    const pending = limiter.wrap({ name: 'save', execute }).execute('call', {}, undefined, onUpdate);
    await vi.advanceTimersByTimeAsync(CONTACT_TOOL_TIMEOUT_MS);
    const result = await pending;
    publish('late success');
    finish({ content: [{ type: 'text', text: 'saved late' }] });
    await vi.advanceTimersByTimeAsync(0);
    expect(onUpdate).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain('operation outcome is unknown');
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
