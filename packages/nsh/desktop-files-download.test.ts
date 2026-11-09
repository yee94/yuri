import { expect, test } from 'vitest';
import { createDesktopFileDownload } from './desktop-files-download';
const scope = { host: { hostID: 'synthetic', lease: 'synthetic-lease' }, authorityKey: 'authority', sessionID: 'session', directory: '/workspace' };
const clock = { after: () => () => {} };
const capability = { version: 2, save: true, maxBytes: 2 ** 40, windowID: 'native_window' };
const receipt = (body: Record<string, unknown>, state = 'pending', extra = {}) => ({ requestID: body.requestID, windowID: body.windowID, state, received: 0, total: null, resumable: false, error: null, ...extra });
test('download submits exact Host/window/file intent; native owns bytes, credentials and destination', async () => {
  const calls: Array<{ name: string; body: Record<string, unknown> }> = [];
  const owner = createDesktopFileDownload(scope, async <T>(name: string, body: Record<string, unknown>) => {
    calls.push({ name, body }); return (name.endsWith('capabilities') ? capability : receipt(body, 'saved')) as T;
  }, () => true, () => {}, clock);
  await owner.probe(); expect(await owner.save('binary.bin')).toBe(true);
  expect(Object.keys(calls[1].body).sort()).toEqual(['directory', 'expectedHost', 'ownerID', 'path', 'requestID', 'windowID']);
  expect(calls[1].body.path).toBe('/workspace/binary.bin'); expect(calls[1].body.windowID).toBe('native_window'); expect(owner.state().phase).toBe('saved');
});
test('unknown save permits only status/cancel; never another save, resume, fetch or JS filesystem fallback', async () => {
  const calls: string[] = [];
  const owner = createDesktopFileDownload(scope, async <T>(name: string, body: Record<string, unknown>) => {
    calls.push(name);
    if (name.endsWith('capabilities')) return capability as T;
    if (name.endsWith('save')) throw new Error('lost_receipt');
    return receipt(body, 'unknown', { error: 'download_write_unknown' }) as T;
  }, () => true, () => {}, clock);
  await owner.probe(); expect(await owner.save('binary.bin')).toBe(false);
  expect(await owner.save('binary.bin')).toBe(false); expect(await owner.resume()).toBe(false); await owner.inspect(); await owner.cancel();
  expect(calls.filter(name => name.endsWith('save'))).toHaveLength(1); expect(owner.state().phase).toBe('unknown');
});
test('missing/old capability stays unavailable; retired authority and forged receipts fail closed', async () => {
  let calls = 0;
  const missing = createDesktopFileDownload(scope, async () => { calls++; throw new Error('unsupported'); }, () => true, () => {}, clock);
  await missing.probe(); expect(await missing.save('a.ts')).toBe(false); expect(calls).toBe(1);
  const old = createDesktopFileDownload(scope, async <T>() => ({ save: true, maxBytes: 25 * 1024 * 1024 }) as T, () => true, () => {}, clock);
  await old.probe(); expect(old.state().available).toBe(false);
  let current = true;
  const owner = createDesktopFileDownload(scope, async <T>(name: string, body: Record<string, unknown>) => (name.endsWith('capabilities') ? capability : { ...receipt(body, 'saved'), localPath: 'forbidden' }) as T, () => current, () => {}, clock);
  await owner.probe(); current = false; expect(await owner.save('a.ts')).toBe(false);
  current = true; expect(await owner.save('a.ts')).toBe(false); expect(owner.state().phase).toBe('unknown');
});
test('explicit resume retains receipt and byte counts; unknown total never fabricates a total', async () => {
  const calls: Array<{ name: string; body: Record<string, unknown> }> = [];
  const owner = createDesktopFileDownload(scope, async <T>(name: string, body: Record<string, unknown>) => {
    calls.push({ name, body });
    return (name.endsWith('capabilities') ? capability : name.endsWith('save') ? receipt(body, 'error', { received: 3, total: 6, resumable: true, error: 'disconnected' }) : receipt(body, 'saved', { received: 6, total: 6 })) as T;
  }, () => true, () => {}, clock);
  await owner.probe(); await owner.save('binary.bin'); expect(owner.state().received).toBe(3); expect(owner.state().resumable).toBe(true);
  expect(await owner.save('other.bin')).toBe(false); expect(await owner.resume()).toBe(true);
  expect(calls[1].body.requestID).toBe(calls[2].body.requestID); expect(calls[2].name).toMatch(/\.resume$/); expect(owner.state().received).toBe(6);
});
test('cancel receipt fences late save ACK; disposal and retired scope never publish late success', async () => {
  let resolve!: (value: unknown) => void, savedBody: Record<string, unknown> = {};
  let changes = 0, current = true;
  const owner = createDesktopFileDownload(scope, async <T>(name: string, body: Record<string, unknown>) => {
    if (name.endsWith('capabilities')) return capability as T;
    if (name.endsWith('save')) { savedBody = body; return await new Promise<T>(done => { resolve = value => done(value as T); }); }
    return receipt(body, 'cancelled') as T;
  }, () => current, () => { changes++; }, clock);
  await owner.probe(); const flight = owner.save('a.bin'); await owner.cancel();
  resolve(receipt(savedBody, 'saved')); expect(await flight).toBe(false); expect(owner.state().phase).toBe('idle');
  const later = owner.save('b.bin'); current = false; const count = changes;
  resolve(receipt(savedBody, 'saved')); expect(await later).toBe(false); expect(changes).toBe(count);
  owner.dispose();
});
test('progress polling is single-flight, stops hidden/disposed, and no-op receipts do not notify', async () => {
  const queued: Array<() => void> = []; let notifications = 0, statuses = 0;
  const owner = createDesktopFileDownload(scope, async <T>(name: string, body: Record<string, unknown>) => {
    if (name.endsWith('capabilities')) return capability as T;
    if (name.endsWith('status')) statuses++;
    return receipt(body, 'pending', { received: 1024, total: null }) as T;
  }, () => true, () => { notifications++; }, { after(callback) { queued.push(callback); return () => {}; } });
  await owner.probe(); await owner.save('a.bin'); const count = notifications;
  await Promise.all([owner.inspect(), owner.inspect(), owner.inspect()]); expect(statuses).toBe(1); expect(notifications).toBe(count); expect(owner.state().total).toBeNull();
  for (let index = 0; index < 50; index++) await owner.inspect();
  expect(notifications).toBe(count); expect(statuses).toBe(51);
  owner.dispose(); for (const callback of queued) callback(); expect(statuses).toBe(51);
});
test('a capability response arriving while inactive is not a permanent unavailability cache', async () => {
  let current = true, resolve!: (value: unknown) => void, calls = 0;
  const owner = createDesktopFileDownload(scope, async <T>() => {
    calls++; if (calls > 1) return capability as T;
    return await new Promise<T>(done => { resolve = value => done(value as T); });
  }, () => current, () => {}, clock);
  const first = owner.probe(); current = false; resolve(capability); await first;
  expect(owner.state().available).toBe(false); current = true; await owner.probe();
  expect(owner.state().available).toBe(true); expect(calls).toBe(2);
});
test('unknown inspection polls a native verifying receipt and cannot use resume or another save', async () => {
  const calls: string[] = []; let statuses = 0;
  const owner = createDesktopFileDownload(scope, async <T>(name: string, body: Record<string, unknown>) => {
    calls.push(name); if (name.endsWith('capabilities')) return capability as T;
    const state = name.endsWith('save') ? 'unknown' : ++statuses === 1 ? 'verifying' : 'saved';
    return receipt(body, state, { received: 6, total: 6 }) as T;
  }, () => true, () => {}, clock);
  await owner.probe(); await owner.save('binary.bin'); expect(owner.state().phase).toBe('unknown');
  expect(await owner.resume()).toBe(false); expect(await owner.save('other.bin')).toBe(false);
  await owner.inspect(); expect(owner.state().phase).toBe('checking'); expect(owner.state().received).toBe(6);
  await owner.inspect(); expect(owner.state().phase).toBe('saved');
  expect(calls.filter(name => name.endsWith('.save'))).toHaveLength(1); expect(calls.some(name => name.endsWith('.resume'))).toBe(false);
});
test('native may explicitly retry a zero-byte read or local seal failure without losing the receipt', async () => {
  for (const received of [0, 6]) {
    const calls: Array<{ name: string; body: Record<string, unknown> }> = [];
    const owner = createDesktopFileDownload(scope, async <T>(name: string, body: Record<string, unknown>) => {
      calls.push({ name, body }); if (name.endsWith('capabilities')) return capability as T;
      return receipt(body, name.endsWith('save') ? 'error' : 'saved', { received: name.endsWith('save') ? received : 6, total: 6, resumable: name.endsWith('save') }) as T;
    }, () => true, () => {}, clock);
    await owner.probe(); await owner.save('binary.bin'); expect(owner.state().resumable).toBe(true);
    expect(await owner.resume()).toBe(true); expect(owner.state().received).toBe(6);
    expect(calls[1].body.requestID).toBe(calls[2].body.requestID); expect(calls[2].name).toMatch(/\.resume$/);
  }
});
test('wrong window, backwards counts and invented totals are not accepted as native saved receipts', async () => {
  for (const extra of [{ windowID: 'another_window' }, { received: 10, total: 5 }, { received: -1 }, { total: 1.1 }]) {
    const owner = createDesktopFileDownload(scope, async <T>(name: string, body: Record<string, unknown>) => (name.endsWith('capabilities') ? capability : receipt(body, 'saved', extra)) as T, () => true, () => {}, clock);
    await owner.probe(); expect(await owner.save('a.bin')).toBe(false); expect(owner.state().phase).toBe('unknown');
  }
});
