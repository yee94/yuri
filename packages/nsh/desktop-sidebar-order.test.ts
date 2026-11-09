import { describe, expect, it, vi } from 'vitest';
import { createDesktopSidebarOrder, type DesktopSidebarOrderIntent, type DesktopSidebarOrderState } from './desktop-sidebar-order';

const intent: DesktopSidebarOrderIntent = { kind: 'session', scope: '/synthetic', active: 'z', over: 'b' };
function fixture() {
  let authority = ['z', 'a', 'b', 'hidden'], live = true, generation = 'first';
  let state: DesktopSidebarOrderState = { pending: false, failure: null };
  const read = vi.fn(async () => [...authority]);
  const commit = vi.fn(async () => { authority = ['a', 'b', 'z', 'hidden']; });
  const changed = vi.fn((next: DesktopSidebarOrderState) => { state = next; });
  const owner = createDesktopSidebarOrder({ current: () => live, generation: () => generation, read, commit,
    snapshot: () => authority, changed, conflict: () => 'rank changed' });
  return { owner, read, commit, changed, state: () => state, authority: () => authority,
    replace: (rows: string[]) => { authority = rows; }, retire: () => { live = false; }, switchHost: () => { generation = 'other'; } };
}

describe('sidebar controller-backed order transactions', () => {
  it('reads before committing and preserves hidden identities without any optimistic write', async () => {
    const f = fixture();
    let release!: () => void;
    f.commit.mockImplementationOnce(() => new Promise<void>(resolve => { release = () => { f.replace(['a', 'b', 'z', 'hidden']); resolve(); }; }));
    const result = f.owner.run(intent); await Promise.resolve();
    expect(f.state().pending).toBe(true); expect(f.authority()).toEqual(['z', 'a', 'b', 'hidden']);
    expect(f.read).toHaveBeenCalledOnce(); expect(f.commit).toHaveBeenCalledWith(intent);
    release(); expect(await result).toBe(true); expect(f.state()).toEqual({ pending: false, failure: null });
  });
  it('failed write keeps prior and intent, then an explicit retry reads before replay', async () => {
    const f = fixture(); f.commit.mockRejectedValueOnce(new Error('synthetic write failure'));
    expect(await f.owner.run(intent)).toBe(false);
    expect(f.authority()).toEqual(['z', 'a', 'b', 'hidden']);
    expect(f.state().failure).toMatchObject({ intent, before: ['z', 'a', 'b', 'hidden'], expected: ['a', 'b', 'z', 'hidden'], error: 'synthetic write failure' });
    expect(f.commit).toHaveBeenCalledTimes(1);
    expect(await f.owner.retry()).toBe(true); expect(f.read).toHaveBeenCalledTimes(2); expect(f.commit).toHaveBeenCalledTimes(2);
  });
  it('unknown ACK already committed is reconciled, never moved a second time', async () => {
    const f = fixture(); f.commit.mockImplementationOnce(async () => { f.replace(['a', 'b', 'z', 'hidden']); throw new Error('lost ACK'); });
    expect(await f.owner.run(intent)).toBe(false); expect(await f.owner.retry()).toBe(true);
    expect(f.read).toHaveBeenCalledTimes(2); expect(f.commit).toHaveBeenCalledOnce(); expect(f.state().failure).toBeNull();
  });
  it('does not blindly rebase a failed gesture after an external rank change', async () => {
    const f = fixture(); f.commit.mockRejectedValueOnce(new Error('offline'));
    await f.owner.run(intent); f.replace(['b', 'z', 'a', 'hidden']);
    expect(await f.owner.retry()).toBe(false); expect(f.commit).toHaveBeenCalledOnce();
    expect(f.state().failure?.error).toBe('rank changed');
    expect(f.authority()).toEqual(['b', 'z', 'a', 'hidden']);
  });
  it('failed authority read cannot masquerade as empty success or admit a write', async () => {
    const f = fixture(); f.read.mockRejectedValueOnce(new Error('read failed'));
    expect(await f.owner.run(intent)).toBe(false); expect(f.commit).not.toHaveBeenCalled();
    expect(f.state().failure?.error).toBe('read failed');
    expect(await f.owner.retry()).toBe(true);
  });
  it('rejects missing identities and verifies even a swallowed controller write failure', async () => {
    const f = fixture(); f.commit.mockImplementationOnce(async () => {});
    expect(await f.owner.run(intent)).toBe(false); expect(f.state().failure?.error).toBe('rank changed');
    expect(await f.owner.run({ ...intent, active: 'missing' })).toBe(false); expect(f.commit).toHaveBeenCalledOnce();
  });
  it('serializes admission and fences background, generation and cancel after an async read', async () => {
    for (const retire of ['retire', 'switchHost', 'cancel'] as const) {
      const f = fixture(); let release!: (rows: string[]) => void;
      f.read.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
      const result = f.owner.run(intent);
      expect(await f.owner.run(intent)).toBe(false);
      if (retire === 'cancel') f.owner.cancel(); else f[retire]();
      const count = f.changed.mock.calls.length;
      release(['z', 'a', 'b', 'hidden']); expect(await result).toBe(false);
      expect(f.commit).not.toHaveBeenCalled(); expect(f.changed).toHaveBeenCalledTimes(count);
    }
  });
  it('worktree transactions use the same journal, and inactive retries do not read', async () => {
    const f = fixture(); f.commit.mockRejectedValueOnce(new Error('worktree write failed'));
    await f.owner.run({ ...intent, kind: 'worktree' });
    expect(f.state().failure?.intent.kind).toBe('worktree');
    f.retire(); expect(await f.owner.retry()).toBe(false); expect(f.read).toHaveBeenCalledOnce();
  });
  it('background pause retains an unknown write for read-first retry and fences its late completion', async () => {
    const f = fixture(); let release!: () => void;
    f.commit.mockImplementationOnce(() => new Promise<void>(resolve => { release = () => { f.replace(['a', 'b', 'z', 'hidden']); resolve(); }; }));
    const running = f.owner.run(intent); await Promise.resolve();
    f.owner.pause(); expect(f.state().pending).toBe(false); expect(f.state().failure?.expected).toEqual(['a', 'b', 'z', 'hidden']);
    release(); expect(await running).toBe(false);
    expect(await f.owner.retry()).toBe(true); expect(f.commit).toHaveBeenCalledOnce();
  });
});
