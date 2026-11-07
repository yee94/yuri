import { describe, expect, it } from 'vitest';
import { createTerminalWorkspace, terminalDirectory, terminalKeySequence, terminalModifiedText, terminalSize, type TerminalSnapshot } from './terminal-core';

const scope = { hostID: 'test-host', lease: '00000000-0000-4000-8000-000000000007' };
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function deferred<T>() { let resolve!: (value: T) => void, reject!: (value: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture(override?: (name: string, body: Record<string, unknown>) => Promise<unknown> | undefined) {
  const calls: { name: string; body: Record<string, unknown> }[] = [];
  let listener: (value: unknown) => void = () => {}, state!: TerminalSnapshot;
  const controller = createTerminalWorkspace({ scope, subscribe: receive => { listener = receive; return () => { listener = () => {}; }; }, changed: value => { state = value; },
    call: async (name, body) => { calls.push({ name, body }); const result = override?.(name, body); if (result) return result;
      return name === 'terminal.create' ? { sessionId: `pty-${calls.filter(call => call.name === name).length}` } : name === 'terminal.close' ? { closed: true } : true; },
  });
  const selected = () => state.tabs.find(tab => tab.id === state.activeId)!;
  const event = (fields: Record<string, unknown>) => {
    const attached = calls.filter(call => call.name === 'terminal.attach').at(-1)?.body;
    listener({ expectedHost: scope, owner: selected().id, sessionId: selected().sessionId, attachment: attached?.attachment, ...fields });
  };
  const start = async () => { controller.setDirectory('/project/worktree'); controller.setActive(true); controller.resize({ cols: 80, rows: 24 }); await flush(); event({ type: 'connected' }); await flush(); };
  return { controller, calls, selected, event, start, state: () => state };
}

describe('native terminal pure controller — all PTY calls are synthetic', () => {
  it('waits for measured viewport; preserves the exact worktree directory and Host fence on every call', async () => {
    const f = fixture(); f.controller.setDirectory('/project/worktree'); f.controller.setActive(true); await flush(); expect(f.calls).toEqual([]);
    f.controller.resize({ cols: 80, rows: 24 }); await flush();
    expect(f.calls.map(value => value.name)).toEqual(['terminal.create', 'terminal.attach']);
    expect(await f.controller.input('not-bound')).toBe(false);
    f.event({ type: 'connected' }); await flush(); expect(await f.controller.input('中文\r')).toBe(true);
    expect(f.calls.at(-1)?.body.data).toBe('中文\r');
    for (const call of f.calls) expect(call.body).toMatchObject({ expectedHost: scope, directory: '/project/worktree' });
  });
  it('resizes the live PTY without create/rebind and coalesces only pending sizes', async () => {
    const pending = deferred<unknown>(); let delayed = false;
    const f = fixture(name => name === 'terminal.resize' && delayed ? pending.promise : undefined); await f.start(); delayed = true;
    f.controller.resize({ cols: 100, rows: 30 }); f.controller.resize({ cols: 110, rows: 32 }); f.controller.resize({ cols: 120, rows: 40 });
    pending.resolve(true); await flush();
    expect(f.calls.filter(value => value.name === 'terminal.create')).toHaveLength(1);
    expect(f.calls.filter(value => value.name === 'terminal.attach')).toHaveLength(1);
    expect(f.calls.filter(value => value.name === 'terminal.resize').at(-1)?.body).toMatchObject({ cols: 120, rows: 40 });
  });
  it('keeps buffer/cursor and PTY on suspend/reopen; ignores stale attachment and duplicate output', async () => {
    const f = fixture(); await f.start();
    f.event({ type: 'data', id: 1, data: '\x1b[32m中文\x1b[0m' }); f.event({ type: 'data', id: 1, data: 'duplicate' });
    const old = f.calls.find(call => call.name === 'terminal.attach')!.body.attachment;
    f.controller.setActive(false); await flush(); expect(await f.controller.input('hidden')).toBe(false);
    f.controller.setActive(true); await flush(); f.event({ type: 'data', id: 2, data: 'stale', attachment: old });
    expect(f.selected().cursor).toBe(1); expect(f.calls.filter(call => call.name === 'terminal.create')).toHaveLength(1);
    expect(f.calls.filter(call => call.name === 'terminal.close')).toHaveLength(0);
    expect(f.calls.filter(call => call.name === 'terminal.attach').at(-1)?.body.cursor).toBe(1);
    f.event({ type: 'connected' }); f.event({ type: 'data', id: 3, data: 'gap' });
    expect(f.selected().error).toBe('replay_gap'); expect(f.selected().chunks.map(chunk => chunk.data)).toEqual(['\x1b[32m中文\x1b[0m', 'gap']);
  });
  it('isolates directory tabs, switches/reopens without recreating and closes only explicitly', async () => {
    const f = fixture(); await f.start(); const first = f.selected().id;
    f.controller.createTab(); f.controller.resize({ cols: 80, rows: 24 }); await flush(); const second = f.selected().id;
    f.controller.selectTab(first); await flush(); expect(f.selected().sessionId).toBe('pty-1');
    f.controller.setDirectory('/other/tree'); f.controller.resize({ cols: 60, rows: 20 }); await flush();
    f.controller.setDirectory('/project/worktree'); await flush(); expect(f.selected().id).toBe(first);
    expect(await f.controller.closeTab(second)).toBe(true); expect(f.state().tabs).toHaveLength(1);
    expect(f.calls.filter(call => call.name === 'terminal.close')).toHaveLength(1);
  });
  it('requires explicit reconnect, never resends input, and does not revive an exited terminal', async () => {
    const f = fixture(); await f.start(); f.event({ type: 'error', code: 'connection_failed' });
    f.controller.setActive(false); f.controller.setActive(true); await flush(); expect(f.calls.filter(call => call.name === 'terminal.attach')).toHaveLength(1);
    f.controller.retry(); await flush(); expect(f.calls.filter(call => call.name === 'terminal.attach')).toHaveLength(2);
    f.event({ type: 'connected' }); f.event({ type: 'exit', exitCode: 42 }); f.controller.retry(); f.controller.setActive(true); await flush();
    expect(f.selected().exitCode).toBe(42); expect(f.calls.filter(call => call.name === 'terminal.create')).toHaveLength(1);
  });
  it('accepts the native background/resume demand hint if QuickJS missed the background lifecycle', async () => {
    const f = fixture(); await f.start(); f.event({ type: 'paused' }); expect(f.selected().phase).toBe('paused');
    f.event({ type: 'resume' }); await flush(); expect(f.calls.filter(call => call.name === 'terminal.attach')).toHaveLength(2);
    expect(f.calls.filter(call => call.name === 'terminal.create')).toHaveLength(1);
    f.event({ type: 'error', code: 'connection_failed' }); f.event({ type: 'resume' }); await flush();
    expect(f.calls.filter(call => call.name === 'terminal.attach')).toHaveLength(2);
  });
  it('does not repeat uncertain create or hide failed close', async () => {
    const f = fixture(name => name === 'terminal.create' ? Promise.reject(new Error('unknown result')) : name === 'terminal.close' ? Promise.reject(new Error('unknown delete')) : undefined);
    f.controller.setDirectory('/project'); f.controller.setActive(true); f.controller.resize({ cols: 80, rows: 24 }); await flush();
    f.controller.retry(); f.controller.setActive(true); await flush(); expect(f.calls.filter(call => call.name === 'terminal.create')).toHaveLength(1);
    expect(f.selected().createUnknown).toBe(true); expect(await f.controller.closeTab(f.selected().id)).toBe(false);
    expect(f.state().tabs).toHaveLength(1); expect(f.selected().error).toBe('close_unconfirmed');
  });
  it('closes a late successful create without binding it, and closes idle tabs locally', async () => {
    const pending = deferred<unknown>(); const f = fixture(name => name === 'terminal.create' ? pending.promise : undefined);
    f.controller.setDirectory('/project'); f.controller.setActive(true); f.controller.resize({ cols: 80, rows: 24 });
    await flush();
    const close = f.controller.closeTab(f.selected().id); pending.resolve({ sessionId: 'late-pty' }); await close; await flush();
    expect(f.calls.filter(call => call.name === 'terminal.attach')).toHaveLength(0);
    expect(f.calls.find(call => call.name === 'terminal.close')?.body.sessionId).toBe('late-pty');
    const idle = f.selected().id; expect(await f.controller.closeTab(idle)).toBe(true); expect(f.calls.filter(call => call.name === 'terminal.close')).toHaveLength(1);
  });
  it('rejects stale Host generation and old input completion after suspend/reopen', async () => {
    const pending = deferred<unknown>(); const f = fixture(name => name === 'terminal.input' ? pending.promise : undefined); await f.start();
    const input = f.controller.input('once'); f.controller.setActive(false); f.controller.setActive(true); await flush(); f.event({ type: 'connected' });
    pending.reject(new Error('old send failed')); expect(await input).toBe(false); expect(f.selected().phase).toBe('live');
    f.controller.setActive(true, { ...scope, lease: '00000000-0000-4000-8000-000000000008' }); await flush(); const before = f.calls.length;
    f.controller.retry(); f.controller.resize({ cols: 100, rows: 30 }); expect(await f.controller.input('stale')).toBe(false); expect(f.calls).toHaveLength(before); expect(f.state().invalidated).toBe(true);
  });
  it('preserves complete Unicode input, Web quick-key mappings and validates directories/sizes', () => {
    expect(terminalModifiedText('中文👨‍👩‍👧‍👦', 'ctrl')).toBe('中文👨‍👩‍👧‍👦');
    expect(terminalModifiedText('c', 'ctrl')).toBe('\x03'); expect(terminalModifiedText('d', 'cmd')).toBe('\x04');
    expect(terminalKeySequence('arrow-up', 'ctrl')).toBe('\x1b[1;5A'); expect(terminalKeySequence('arrow-left', 'cmd')).toBe('\x1b[1;3D');
    expect(terminalKeySequence('enter')).toBe('\r'); expect(terminalKeySequence('backspace')).toBe('\x7f');
    for (const path of ['', '//x', '/x/..', '/x/./a', '/x//a', '/x\\a', '/x\n']) expect(terminalDirectory(path)).toBe(false);
    expect(terminalDirectory('/workspace/中文 tree')).toBe(true); expect(terminalSize({ cols: 2, rows: 1 })).toBe(true); expect(terminalSize({ cols: 0, rows: 24 })).toBe(false);
  });
  it('admits 20k ASCII and exact UTF-8 boundary, rejects excess without writes and reports backpressure', async () => {
    let waiting: ReturnType<typeof deferred<unknown>> | undefined;
    const f = fixture(name => name === 'terminal.input' ? waiting?.promise : undefined); await f.start();
    expect(await f.controller.inputOutcome('a'.repeat(20_000))).toBe('accepted');
    const unicode = '中😀'.repeat(9362); // 65,534 UTF-8 bytes, no code-point slicing.
    expect(await f.controller.inputOutcome(unicode)).toBe('accepted');
    const before = f.calls.filter(value => value.name === 'terminal.input').length;
    expect(await f.controller.inputOutcome(unicode + '中')).toBe('rejected');
    expect(f.selected().error).toBe('input_too_large');
    expect(f.calls.filter(value => value.name === 'terminal.input')).toHaveLength(before);
    waiting = deferred(); const sending = f.controller.inputOutcome('once');
    expect(await f.controller.inputOutcome('not-admitted')).toBe('rejected'); expect(f.selected().error).toBe('input_backpressure');
    waiting.reject(new Error('may have written')); expect(await sending).toBe('unknown');
    expect(await f.controller.inputOutcome('never-replay')).toBe('rejected');
    expect(f.calls.filter(value => value.name === 'terminal.input')).toHaveLength(before + 1);
  });
});
