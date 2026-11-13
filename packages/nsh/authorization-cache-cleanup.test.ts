import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { authorizationCacheCleanupBridge, createAuthorizationCacheCleanup, createAuthorizationCacheCleanupRoot } from './authorization-cache-cleanup';

it('production manifest admits the exact native cleanup handshake before opening startup', async () => {
  const manifest = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'nsh.json'), 'utf8'));
  const calls: string[] = [];
  let ready = 0, retired = 0, failed = false;
  const bridge = authorizationCacheCleanupBridge(async name => {
    if (!manifest.capabilities.host.includes(name)) throw Error('Host call not granted: ' + name);
    calls.push(name);
    if (name === 'authorization.cache.ready') return { owner: 'startup-owner', tickets: ['retired-ticket'] };
    if (name === 'authorization.cache.list') return [];
    if (name === 'authorization.cache.claim') return { connectionID: 'fixture', authorizationID: 'retired' };
    return true;
  });
  const root = createAuthorizationCacheCleanupRoot({ bridge, retire: async () => { retired++; }, subscribe: () => () => {},
    onReady: () => { ready++; }, onState: state => { failed = state.failed; } });
  try {
    await root.start();
    expect(failed).toBe(false);
    expect(ready).toBe(1);
    expect(retired).toBe(1);
    await root.retry();
    expect(new Set(calls)).toEqual(new Set(['authorization.cache.ready', 'authorization.cache.list', 'authorization.cache.claim', 'authorization.cache.ack', 'authorization.cache.retry']));
  } finally { root.dispose(); }
});

it('claims only native tickets and ACKs only successful exact owner cleanup; partial failures remain retryable', async () => {
  const calls: unknown[] = [];
  let fail = true;
  const cleanup = createAuthorizationCacheCleanup({
    ready: async () => ({ owner: 'root-1', tickets: ['a', 'b'] }),
    list: async owner => { expect(owner).toBe('root-1'); return ['a', 'b']; },
    claim: async (owner, ticket) => { expect(owner).toBe('root-1'); return { connectionID: 'host', authorizationID: ticket }; },
    ack: async (owner, ticket) => { calls.push(['ack', owner, ticket]); },
  }, async (connection, authorization) => { calls.push(['delete', connection, authorization]); if (authorization === 'a' && fail) throw Error('disk'); });
  const result = await cleanup.run();
  expect(result.failed).toEqual(['a']); expect(result.completed).toEqual(['b']);
  expect(calls).not.toContainEqual(['ack', 'root-1', 'a']);
  fail = false; await cleanup.run(); expect(calls).toContainEqual(['ack', 'root-1', 'a']);
});
it('rejects missing handlers and unconfirmed ACKs instead of opening the startup gate', async () => {
  const missing = authorizationCacheCleanupBridge(async () => undefined);
  await expect(missing.ready()).rejects.toThrow();
  await expect(missing.list('owner')).rejects.toThrow();
  await expect(missing.ack('owner', 'ticket')).rejects.toThrow();
  await expect(missing.retry()).rejects.toThrow();
  let ready = 0, failed = false;
  const root = createAuthorizationCacheCleanupRoot({ bridge: missing, retire: async () => {}, subscribe: () => () => {}, onReady: () => { ready++; }, onState: state => { failed = state.failed; } });
  await root.start(); expect(ready).toBe(0); expect(failed).toBe(true); root.dispose();
});
it('does not lose a tip between the final state publication and the flight finalizer', async () => {
  let tip!: () => void, late!: () => void, emitted = false, lists = 0;
  const sawLate = new Promise<void>(resolve => { late = resolve; });
  const root = createAuthorizationCacheCleanupRoot({
    bridge: { ready: async () => ({ owner: 'owner', tickets: [] }), list: async () => { lists++; late(); return []; },
      claim: async () => { throw Error('unused'); }, ack: async () => {}, retry: async () => {} },
    retire: async () => {}, subscribe: callback => { tip = callback; return () => {}; }, onReady: () => {},
    onState: state => { if (!state.busy && !emitted) { emitted = true; tip(); } },
  });
  await root.start(); await sawLate; expect(lists).toBe(1); root.dispose();
});
it('does not busy-loop when native retry emits another pending event, and retries native failure explicitly', async () => {
  let tip!: () => void, retries = 0, failRetry = true, ready = 0;
  const root = createAuthorizationCacheCleanupRoot({
    bridge: { ready: async () => ({ owner: 'owner', tickets: [] }), list: async () => [], claim: async () => { throw Error('unused'); }, ack: async () => {},
      retry: async () => { retries++; tip(); if (failRetry) throw Error('native pending'); } },
    retire: async () => {}, subscribe: callback => { tip = callback; return () => {}; }, onReady: () => { ready++; }, onState: () => {},
  });
  await root.start(); expect(retries).toBe(1); expect(ready).toBe(1);
  failRetry = false; await root.retry(); expect(retries).toBe(2); root.dispose();
});
it('keeps native owner failures visible across empty tip drains until an actual cleanup retry succeeds', async () => {
  let tip!: () => void, idle: (() => void) | undefined, ready = 0, retries = 0, deletes = 0, acks = 0;
  let failNative = true, release!: () => void, entered!: () => void;
  const recovering = new Promise<void>(resolve => { entered = resolve; });
  const recovery = new Promise<void>(resolve => { release = resolve; });
  const states: { ready: boolean; busy: boolean; failed: boolean }[] = [];
  const root = createAuthorizationCacheCleanupRoot({
    bridge: {
      ready: async () => ({ owner: 'owner', tickets: ['history'] }), list: async () => [],
      claim: async () => ({ connectionID: 'host', authorizationID: 'old' }), ack: async () => { acks++; },
      retry: async () => {
        retries++; tip();
        if (failNative) throw Error('authorization_cleanup_failed');
        entered(); await recovery;
      },
    },
    retire: async () => { deletes++; },
    subscribe: callback => { tip = callback; return () => {}; },
    onReady: () => { ready++; },
    onState: state => { states.push(state); if (!state.busy) { idle?.(); idle = undefined; } },
  });
  await root.start();
  expect(ready).toBe(1); expect(deletes).toBe(1); expect(acks).toBe(1); expect(retries).toBe(1);
  expect(states.at(-1)).toEqual({ ready: true, busy: false, failed: true });
  const afterFailure = states.length;
  const emptySweep = new Promise<void>(resolve => { idle = resolve; }); tip(); await emptySweep;
  expect(retries).toBe(1);
  expect(states.slice(afterFailure).every(state => state.ready && state.failed)).toBe(true);
  await root.retry();
  expect(retries).toBe(2); expect(states.at(-1)?.failed).toBe(true);
  failNative = false;
  const explicitRecovery = root.retry(); await recovering;
  expect(states.at(-1)).toEqual({ ready: true, busy: true, failed: true });
  release(); await explicitRecovery;
  expect(states.at(-1)).toEqual({ ready: true, busy: false, failed: false });
  expect(retries).toBe(3); expect(ready).toBe(1); expect(deletes).toBe(1); expect(acks).toBe(1);
  root.dispose();
});
it('subscribes before startup and drains tips during the flight before opening the one-way gate', async () => {
  let tip!: () => void, release!: () => void, ready = 0, lists = 0;
  const order: string[] = [], gate = new Promise<void>(resolve => { release = resolve; });
  const root = createAuthorizationCacheCleanupRoot({
    bridge: {
      ready: async () => { order.push('ready'); await gate; return { owner: 'owner', tickets: [] }; },
      list: async () => { lists++; return ['late']; },
      claim: async () => ({ connectionID: 'host', authorizationID: 'auth' }), ack: async () => {}, retry: async () => {},
    }, retire: async () => {}, subscribe: callback => { order.push('subscribe'); tip = callback; return () => {}; },
    onReady: () => { ready++; }, onState: () => {},
  });
  const work = root.start(); await Promise.resolve(); tip(); expect(ready).toBe(0); release(); await work;
  expect(order).toEqual(['subscribe', 'ready']); expect(lists).toBe(1); expect(ready).toBe(1);
  await root.retry(); expect(ready).toBe(1); root.dispose();
});
it('keeps startup closed after partial failure and retries explicitly, then preserves mounted business on later failures', async () => {
  let fail = true, ready = 0, calls = 0;
  const root = createAuthorizationCacheCleanupRoot({
    bridge: { ready: async () => ({ owner: 'owner', tickets: ['a', 'b'] }), list: async () => ['a', 'b'],
      claim: async (_, ticket) => ({ connectionID: 'host', authorizationID: ticket }), ack: async () => {}, retry: async () => {} },
    retire: async (_, auth) => { calls++; if (auth === 'a' && fail) throw Error('disk'); },
    subscribe: () => () => {}, onReady: () => { ready++; }, onState: () => {},
  });
  await root.start(); expect(ready).toBe(0); expect(calls).toBe(2);
  fail = false; await root.retry(); expect(ready).toBe(1);
  fail = true; await root.retry(); expect(ready).toBe(1); root.dispose();
});
it('does not ACK or publish ready after disposal while the physical deletion is in flight', async () => {
  let release!: () => void, entered!: () => void, acked = 0, ready = 0;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  const root = createAuthorizationCacheCleanupRoot({
    bridge: { ready: async () => ({ owner: 'owner', tickets: ['a'] }), list: async () => [],
      claim: async () => ({ connectionID: 'host', authorizationID: 'auth' }), ack: async () => { acked++; }, retry: async () => {} },
    retire: async () => { entered(); await gate; }, subscribe: () => () => {}, onReady: () => { ready++; }, onState: () => {},
  });
  const work = root.start(); await started; root.dispose(); release(); await work;
  expect(acked).toBe(0); expect(ready).toBe(0);
});
it('shares overlapping sweeps and does not ACK failed claims or hide ACK persistence failures', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const deleted: string[] = [], acked: string[] = [];
  const cleanup = createAuthorizationCacheCleanup({
    ready: async () => { await gate; return { owner: 'owner', tickets: ['stale', 'valid'] }; },
    list: async () => [],
    claim: async (_, ticket) => { if (ticket === 'stale') throw Error('stale'); return { connectionID: 'host', authorizationID: ticket }; },
    ack: async (_, ticket) => { acked.push(ticket); throw Error('ack failed'); },
  }, async (_, authorization) => { deleted.push(authorization); });
  const first = cleanup.run(), second = cleanup.run(); expect(first).toBe(second); release();
  expect(await first).toEqual({ completed: [], failed: ['stale', 'valid'] });
  expect(deleted).toEqual(['valid']); expect(acked).toEqual(['valid']);
});
