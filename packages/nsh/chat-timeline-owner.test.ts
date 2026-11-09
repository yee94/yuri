import { describe, expect, it, vi } from 'vitest';
import { createNativeTimelineOwner } from './chat-timeline-owner';

function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture() {
  const changed = vi.fn(), owner = createNativeTimelineOwner(changed), authority = { current: () => true };
  owner.replaceAuthority(authority); owner.request(true); owner.opened(owner.snapshot().generation);
  return { owner, changed, authority };
}
describe('Timeline presentation/action lifetime', () => {
  it('blocks duplicate actions and all close paths through deferred work and waits for real completion before navigation', async () => {
    const { owner } = fixture(), flight = deferred<void>(), navigate = vi.fn(), dismiss = vi.fn(), duplicate = vi.fn();
    const pending = owner.run('fork', 'user', async () => { await flight.promise; return navigate; }, dismiss);
    expect(owner.close()).toBe(false); owner.request(false);
    expect(owner.snapshot().phase).toBe('open');
    expect(await owner.run('revert', 'other', duplicate, dismiss)).toBe(false); expect(duplicate).not.toHaveBeenCalled();
    flight.resolve(); await pending;
    expect(dismiss).toHaveBeenCalledOnce(); expect(navigate).not.toHaveBeenCalled();
    expect(owner.snapshot().phase).toBe('closing');
    owner.closed(owner.snapshot().generation);
    expect(navigate).toHaveBeenCalledOnce(); expect(owner.snapshot().phase).toBe('closed');
  });
  it('preserves failures for explicit retry and does not close on unsuccessful focus', async () => {
    const { owner } = fixture(), dismiss = vi.fn(), error = new Error('older unavailable');
    await owner.run('older', null, async () => { throw error; }, dismiss);
    expect(owner.snapshot()).toMatchObject({ phase: 'open', pending: null, error });
    await owner.run('goto', 'user', async () => false, dismiss);
    expect(dismiss).not.toHaveBeenCalled();
    await owner.run('older', null, async () => {}, dismiss);
    expect(owner.snapshot()).toMatchObject({ phase: 'open', pending: null, error: null });
  });
  it('queues reopen, fences old completion and cannot release a new pending action', async () => {
    const { owner } = fixture(), old = deferred<void>(), dismiss = vi.fn();
    const pending = owner.run('revert', 'old', () => old.promise, dismiss);
    const first = owner.snapshot().generation;
    owner.replaceAuthority({ current: () => true }); owner.request(true);
    expect(owner.snapshot().phase).toBe('closing'); owner.closed(first);
    const second = owner.snapshot().generation; expect(second).toBeGreaterThan(first); owner.opened(second);
    const next = deferred<void>(); const newer = owner.run('fork', 'new', () => next.promise, dismiss);
    old.resolve(); await pending; owner.closed(first);
    expect(owner.snapshot()).toMatchObject({ generation: second, phase: 'open', pending: 'fork', messageID: 'new' });
    expect(dismiss).not.toHaveBeenCalled(); next.resolve(); await newer;
  });
  it('revokes async write fence and deferred navigation on page/Host/operation retirement and disposal', async () => {
    const { owner } = fixture(), flight = deferred<void>(), navigation = vi.fn(), dismiss = vi.fn();
    let fence!: () => boolean;
    const run = owner.run('fork', 'user', async valid => { fence = valid; await flight.promise; return navigation; }, dismiss);
    expect(fence()).toBe(true); owner.replaceAuthority(null); expect(fence()).toBe(false);
    flight.resolve(); await run; owner.closed(owner.snapshot().generation);
    expect(navigation).not.toHaveBeenCalled(); expect(dismiss).not.toHaveBeenCalled(); owner.dispose(); owner.request(true);
    expect(owner.snapshot().phase).toBe('closed');
  });
  it('does not admit work before presentation or after authority becomes stale', async () => {
    const owner = createNativeTimelineOwner(() => {}), execute = vi.fn(), dismiss = vi.fn();
    let active = true; owner.replaceAuthority({ current: () => active }); owner.request(true);
    await owner.run('older', null, execute, dismiss); expect(execute).not.toHaveBeenCalled();
    owner.opened(owner.snapshot().generation); active = false;
    await owner.run('latest', null, execute, dismiss); expect(execute).not.toHaveBeenCalled();
  });
});
