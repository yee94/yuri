import { describe, expect, test, vi } from 'vitest';
import { createRemoteDesktopSession, remoteDesktopMessageKey, validRemoteDesktopInput, type RemoteDesktopCall, type RemoteDesktopState } from './remote-desktop-core';
import { remoteDesktopLocalPoint, remoteDesktopPageSize, remoteDesktopSafeArea } from './remote-desktop-geometry';

function fixture(callImpl: RemoteDesktopCall = async () => true) {
  let listener: ((event: unknown) => void) | undefined;
  const snapshots: RemoteDesktopState[] = [], call = vi.fn(callImpl), unsubscribe = vi.fn();
  const session = createRemoteDesktopSession({ scopeKey: 'host:1:direct:1', call, changed: value => snapshots.push(value), subscribe: value => { listener = value; return unsubscribe; } });
  const emit = (event: Record<string, unknown>) => listener?.({ owner: owner(), ...event });
  const owner = () => String(call.mock.calls.filter(([name]) => name === 'remoteDesktop.open').at(-1)?.[1].owner);
  const state = () => snapshots.at(-1)!;
  const frame = (id = 1) => emit({ type: 'frame', frame: id, width: 1440, height: 810, source: 'data:image/jpeg;base64,/9j/2Q==' });
  return { session, call, emit, snapshots, state, frame, owner, unsubscribe };
}

describe('native desktop owner and decode lifecycle (no NSH runtime)', () => {
  test('a hidden/constructed page does no transport work; opening uses only named Swift operations', () => {
    const f = fixture();
    expect(f.call).not.toHaveBeenCalled();
    f.session.setActive(true);
    expect(f.call.mock.calls).toEqual([['remoteDesktop.open', { owner: f.owner(), zoomed: false }]]);
    f.session.setActive(true);
    expect(f.call).toHaveBeenCalledTimes(1);
    f.session.dispose();
  });

  test('receiving a frame is not an ACK; ACK is emitted once only after native Image load', async () => {
    const f = fixture(); f.session.setActive(true); f.frame();
    expect(f.state().phase).toBe('connecting');
    expect(f.call.mock.calls.filter(([name]) => name === 'remoteDesktop.ack')).toHaveLength(0);
    await f.session.decoded(f.state().frame!);
    await f.session.decoded(f.state().frame!);
    expect(f.call.mock.calls.filter(([name]) => name === 'remoteDesktop.ack')).toEqual([['remoteDesktop.ack', { owner: f.owner(), frame: 1 }]]);
    f.emit({ type: 'state', phase: 'live' });
    expect(f.state().phase).toBe('live'); expect(f.state().frame?.id).toBe(1);
    f.session.dispose();
  });

  test('out-of-order frames cannot replace the latest frame or cause stale decode ACKs', async () => {
    const f = fixture(); f.session.setActive(true); f.frame(); const old = f.state().frame!;
    f.frame(2); const latest = f.state().frame;
    f.frame(1); expect(f.state().frame).toBe(latest);
    await f.session.decoded(old);
    expect(f.call.mock.calls.filter(([name]) => name === 'remoteDesktop.ack')).toHaveLength(0);
    f.session.dispose();
  });

  test.each([
    { source: 'https://untrusted.invalid/screen.jpg' },
    { source: 'data:image/jpeg;base64,' + 'A'.repeat(700_000) },
    { source: 'data:image/jpeg;base64,not base64' },
    { width: 2561 }, { width: 2560, height: 2560 }, { height: 0 }, { frame: 0 }, { frame: 1.1 },
  ])('untrusted bridge frame is rejected before native image display: %o', patch => {
    const f = fixture(); f.session.setActive(true);
    f.emit({ type: 'frame', frame: 1, width: 1440, height: 810, source: 'data:image/jpeg;base64,/9j/2Q==', ...patch });
    expect(f.state()).toEqual({ phase: 'closed', code: 'connection_failed' });
    expect(f.call).toHaveBeenLastCalledWith('remoteDesktop.close', { owner: f.owner() });
    f.session.dispose();
  });

  test('background closes capture, drops image/input, and resumes with a new owner', async () => {
    const f = fixture(); f.session.setActive(true); const old = f.owner(); f.frame();
    f.emit({ type: 'state', phase: 'live' });
    f.session.setActive(false);
    expect(f.state()).toEqual({ phase: 'paused' });
    expect(await f.session.send({ type: 'key', key: 'Enter' })).toBe(false);
    f.session.setActive(true); expect(f.owner()).not.toBe(old);
    const snapshot = f.state();
    f.emit({ owner: old, type: 'frame', frame: 99, width: 1440, height: 810, source: 'data:image/jpeg;base64,/9j/2Q==' });
    f.emit({ owner: old, type: 'state', phase: 'live' });
    expect(f.state()).toBe(snapshot);
    f.session.dispose();
  });

  test('runtime/transport change is terminal and cannot reopen onto a different Host', async () => {
    const f = fixture(); f.session.setActive(true);
    f.session.setActive(true, 'host:1:relay:2');
    expect(f.state()).toEqual({ phase: 'closed', code: 'runtime_changed' });
    f.session.retry(); f.session.setActive(true); f.session.setZoomed(true);
    expect(f.call.mock.calls.filter(([name]) => name === 'remoteDesktop.open')).toHaveLength(1);
    expect(await f.session.send({ type: 'text', text: 'not sent' })).toBe(false);
    f.session.dispose();
  });

  test('a rejected old close cannot replace the terminal Host-change guidance', async () => {
    const f = fixture(name => name === 'remoteDesktop.close' ? Promise.reject(new Error('Synthetic close failure')) : Promise.resolve(true));
    f.session.setActive(true); f.session.setActive(true, 'fixture:next-host');
    await Promise.resolve(); await Promise.resolve();
    expect(f.state()).toEqual({ phase: 'closed', code: 'runtime_changed' });
    f.session.dispose();
  });

  test.each(['disabled', 'unsupported', 'helper_unavailable', 'authentication_required', 'permission_denied'])('permanent %s does not auto-retry on foreground; only explicit retry can reopen', code => {
    const f = fixture(); f.session.setActive(true); f.emit({ type: 'state', phase: 'closed', code });
    f.session.setActive(false); f.session.setActive(true);
    expect(f.state()).toEqual({ phase: 'closed', code });
    expect(f.call.mock.calls.filter(([name]) => name === 'remoteDesktop.open')).toHaveLength(1);
    f.session.retry();
    expect(f.call.mock.calls.filter(([name]) => name === 'remoteDesktop.open')).toHaveLength(2);
    f.session.dispose();
  });

  test('retry and late open failures cannot destroy the new owner', async () => {
    let reject: ((reason: Error) => void) | undefined, opens = 0;
    const f = fixture((name) => name === 'remoteDesktop.open' && ++opens === 1 ? new Promise((_, fail) => { reject = fail; }) : Promise.resolve(true));
    f.session.setActive(true); const old = f.owner(); f.session.retry(); const latest = f.owner();
    expect(latest).not.toBe(old);
    reject?.(new Error('old failure')); await Promise.resolve(); await Promise.resolve();
    f.emit({ type: 'state', phase: 'live' });
    expect(f.state().phase).toBe('live');
    expect(f.call.mock.calls.filter(([name]) => name === 'remoteDesktop.close')).toEqual([['remoteDesktop.close', { owner: old }]]);
    f.session.dispose();
  });

  test('reconnection clears the stale screen and never replays input', async () => {
    const f = fixture(); f.session.setActive(true); f.frame(); f.emit({ type: 'state', phase: 'live' });
    expect(await f.session.send({ type: 'key', key: 'Enter' })).toBe(true);
    f.emit({ type: 'state', phase: 'connecting', code: 'desktop_failed' });
    expect(f.state().frame).toBeUndefined();
    expect(await f.session.send({ type: 'text', text: 'offline' })).toBe(false);
    f.emit({ type: 'state', phase: 'live' });
    expect(f.call.mock.calls.filter(([name]) => name === 'remoteDesktop.input')).toHaveLength(1);
    f.session.dispose();
  });

  test('view negotiation changes only with zoom state, not mode/keyboard/frame changes', () => {
    const f = fixture(); f.session.setZoomed(true); f.session.setActive(true);
    expect(f.call).toHaveBeenCalledWith('remoteDesktop.open', { owner: f.owner(), zoomed: true });
    for (let index = 0; index < 120; index++) f.session.setZoomed(true);
    expect(f.call.mock.calls.filter(([name]) => name === 'remoteDesktop.view')).toHaveLength(0);
    f.session.setZoomed(false); f.session.setZoomed(false);
    expect(f.call.mock.calls.filter(([name]) => name === 'remoteDesktop.view')).toEqual([['remoteDesktop.view', { owner: f.owner(), zoomed: false }]]);
    f.session.dispose();
  });

  test('decode failure closes rather than ACKing a screen never shown', () => {
    const f = fixture(); f.session.setActive(true); f.frame(); f.session.decodeFailed(f.state().frame!);
    expect(f.state()).toEqual({ phase: 'closed', code: 'connection_failed' });
    expect(f.call.mock.calls.some(([name]) => name === 'remoteDesktop.ack')).toBe(false);
    f.session.dispose();
  });

  test('failed and late input results are false; typing data is not persisted or replayed', async () => {
    let resolve: ((value: unknown) => void) | undefined;
    const f = fixture(name => name === 'remoteDesktop.input' ? new Promise(done => { resolve = done; }) : Promise.resolve(true));
    f.session.setActive(true); f.emit({ type: 'state', phase: 'live' });
    const pending = f.session.send({ type: 'text', text: 'draft remains until confirmed' });
    f.session.setActive(false); resolve?.(true); expect(await pending).toBe(false);
    f.session.setActive(true); f.emit({ type: 'state', phase: 'live' });
    expect(f.call.mock.calls.filter(([name]) => name === 'remoteDesktop.input')).toHaveLength(1);
    f.session.dispose();
  });

  test('disposal unsubscribes and sends one owner-scoped close without further work', () => {
    const f = fixture(); f.session.setActive(true); const owner = f.owner();
    f.session.dispose(); f.session.dispose(); f.session.retry();
    f.emit({ type: 'state', phase: 'live' });
    expect(f.unsubscribe).toHaveBeenCalledTimes(1);
    expect(f.call.mock.calls.filter(([name]) => name === 'remoteDesktop.close')).toEqual([['remoteDesktop.close', { owner }]]);
  });
});

describe('bounded Host wire vocabulary', () => {
  test('accepts supported pointer, navigation and Unicode text without arbitrary keys/shell', () => {
    expect(validRemoteDesktopInput({ type: 'pointer', action: 'right', x: 0, y: 1 })).toBe(true);
    expect(validRemoteDesktopInput({ type: 'scroll', dx: -1000, dy: 1000 })).toBe(true);
    expect(validRemoteDesktopInput({ type: 'text', text: '🙂'.repeat(512) })).toBe(true);
    expect(validRemoteDesktopInput({ type: 'key', key: 'Enter' })).toBe(true);
    expect(validRemoteDesktopInput({ type: 'release' })).toBe(true);
    expect(validRemoteDesktopInput({ type: 'pointer', action: 'move', x: NaN, y: .5 })).toBe(false);
    expect(validRemoteDesktopInput({ type: 'pointer', action: 'move', x: -.01, y: 1.01 })).toBe(false);
    expect(validRemoteDesktopInput({ type: 'scroll', dx: Infinity, dy: 0 })).toBe(false);
    expect(validRemoteDesktopInput({ type: 'text', text: '🙂'.repeat(513) })).toBe(false);
    expect(validRemoteDesktopInput({ type: 'text', text: '' })).toBe(false);
    expect(validRemoteDesktopInput({ type: 'key', key: 'Meta+R' })).toBe(false);
  });

  test('permission/disabled/revoked/runtime errors remain distinct and localizable', () => {
    expect(remoteDesktopMessageKey('permission_required')).toBe('remoteDesktop.permissions');
    expect(remoteDesktopMessageKey('permission_denied')).toBe('remoteDesktop.denied');
    expect(remoteDesktopMessageKey('disabled')).toBe('settings.remoteDesktop.disabled');
    expect(remoteDesktopMessageKey('runtime_changed')).toBe('remoteDesktop.runtimeChanged');
    expect(remoteDesktopMessageKey('authentication_required')).toBe('remoteDesktop.failed');
    expect(remoteDesktopMessageKey('capture_timeout')).toBe('remoteDesktop.failed');
  });
});

describe('page-local manual orientation', () => {
  test('inverse mapping includes root offsets and both rotation directions', () => {
    const bounds = { x: 10, y: 20, width: 390, height: 844 };
    expect(remoteDesktopLocalPoint({ x: 40, y: 60 }, bounds, 0)).toEqual({ x: 30, y: 40 });
    expect(remoteDesktopLocalPoint({ x: 40, y: 60 }, bounds, 90)).toEqual({ x: 40, y: 360 });
    expect(remoteDesktopLocalPoint({ x: 40, y: 60 }, bounds, -90)).toEqual({ x: 804, y: 30 });
  });

  test('keyboard/resize changes dimensions, never the manually selected angle; safe edges rotate', () => {
    expect(remoteDesktopPageSize(390, 844, 90)).toEqual({ width: 844, height: 390 });
    expect(remoteDesktopPageSize(390, 500, 90)).toEqual({ width: 500, height: 390 });
    const safe = { top: 47, right: 0, bottom: 34, left: 0 };
    expect(remoteDesktopSafeArea(safe, 90)).toEqual({ top: 0, right: 34, bottom: 0, left: 47 });
    expect(remoteDesktopSafeArea(safe, -90)).toEqual({ top: 0, right: 47, bottom: 0, left: 34 });
    expect(remoteDesktopSafeArea(safe, 0)).toBe(safe);
  });
});
