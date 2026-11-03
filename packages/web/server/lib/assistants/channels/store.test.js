import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import { createAssistantChannelStore } from './store.js';

const Database = createRequire(import.meta.url)('better-sqlite3');
const cleanup = [];
afterEach(() => { while (cleanup.length) cleanup.pop()(); });
const directory = () => {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'yuri-channels-store-'));
  cleanup.push(() => fs.rmSync(value, { recursive: true, force: true }));
  return value;
};
const bind = (store, assistantID = 'bot', overrides = {}) => store.bind({
  assistant_id: assistantID,
  provider: 'wecom',
  client_id: 'client',
  client_secret: 'fake-secret',
  owner_id: 'owner',
  language: 'zh-CN',
  generation: 0,
  ordinal: 0,
  updated_at: 1,
  ...overrides,
});

describe('enterprise channel private store', () => {
  it('adds receipt routing to an existing database without losing receipts or bindings', () => {
    const dir = directory();
    const original = createAssistantChannelStore(dir);
    const binding = bind(original);
    original.accept(binding, [{ id: 'old-receipt', text: 'existing', payload: '' }]);
    original.close();
    const db = new Database(path.join(dir, 'channel.sqlite'));
    db.exec('ALTER TABLE inbox DROP COLUMN target');
    db.close();
    const store = createAssistantChannelStore(dir);
    cleanup.push(() => store.close());
    expect(store.get('bot', 'wecom')).toMatchObject({ epoch: binding.epoch });
    expect(store.receipt('old-receipt', binding.epoch)).toEqual({ id: 'old-receipt', target: '' });
    store.accept(binding, [{ id: 'new-receipt', text: 'new', payload: '', target: '{"userID":"alice"}' }]);
    expect(store.receipt('new-receipt', binding.epoch)).toEqual({ id: 'new-receipt', target: '{"userID":"alice"}' });
    expect(store.receipt('new-receipt', 'other-epoch')).toBeUndefined();
  });

  it('atomically moves one account while keeping receipts and dropping old queued content', () => {
    const store = createAssistantChannelStore(directory());
    cleanup.push(() => store.close());
    const source = bind(store, 'source');
    store.accept(source, [{ id: 'receipt', text: 'old request', payload: '', target: '' }]);
    store.collect(source, { generation: 0, ordinal: 1 }, [{ id: 'old-output', text: 'old reply' }], 1);
    const input = { sourceAssistantID: 'source', assistantID: 'target', provider: 'wecom', revision: source.epoch, generation: 2, ordinal: 8, updatedAt: 2 };
    expect(() => store.transfer({ ...input, revision: 'stale' })).toThrow('binding_changed');
    expect(store.get('source', 'wecom')).toMatchObject({ epoch: source.epoch });
    const moved = store.transfer(input);
    expect(store.get('source', 'wecom')).toBeNull();
    expect(moved).toMatchObject({ assistant_id: 'target', client_id: 'client', client_secret: 'fake-secret', generation: 2, ordinal: 8 });
    expect(moved.epoch).not.toBe(source.epoch);
    expect(store.hasReceipt('receipt')).toBe(true);
    expect(store.pending(moved.epoch)).toEqual([]);
    expect(store.nextDelivery(moved.epoch)).toBeUndefined();
    expect(store.accept(moved, [{ id: 'receipt', text: 'replay' }])).toBe(false);
  });

  it('rolls back receipts, output and ownership when moving the binding fails', () => {
    const dir = directory();
    const store = createAssistantChannelStore(dir);
    cleanup.push(() => store.close());
    const source = bind(store, 'source');
    store.accept(source, [{ id: 'pending', text: 'keep request', payload: '' }]);
    store.collect(source, { generation: 0, ordinal: 1 }, [{ id: 'output', text: 'keep reply' }], 1);
    const db = new Database(path.join(dir, 'channel.sqlite'));
    try {
      db.exec("CREATE TRIGGER fail_transfer BEFORE UPDATE OF assistant_id ON channel BEGIN SELECT RAISE(ABORT, 'move_failed'); END");
      expect(() => store.transfer({ sourceAssistantID: 'source', assistantID: 'target', provider: 'wecom', revision: source.epoch, generation: 0, ordinal: 0, updatedAt: 2 })).toThrow('move_failed');
      expect(store.get('source', 'wecom')).toMatchObject({ epoch: source.epoch });
      expect(store.get('target', 'wecom')).toBeNull();
      expect(store.pending(source.epoch)).toEqual([expect.objectContaining({ id: 'pending', text: 'keep request' })]);
      expect(store.nextDelivery(source.epoch)).toMatchObject({ id: 'output', text: 'keep reply' });
    } finally { db.close(); }
  });

  it('creates a 0700 directory and 0600 database and enforces account ownership', () => {
    const dir = directory();
    const store = createAssistantChannelStore(dir);
    cleanup.push(() => store.close());
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(dir, 'channel.sqlite')).mode & 0o777).toBe(0o600);
    bind(store);
    expect(() => bind(store, 'other')).toThrow('account_in_use');
    expect(store.get('bot', 'wecom')).toMatchObject({
      client_id: 'client', owner_id: 'owner', client_secret: 'fake-secret', status: 'connecting',
    });
    expect(store.get('other', 'wecom')).toBeNull();
    // Same client ID on another provider is a separate account.
    expect(bind(store, 'other', { provider: 'feishu' })).toMatchObject({ provider: 'feishu' });
  });

  it.each(['wecom', 'feishu', 'dingtalk'])('allows independent %s accounts to bind different Bots', (provider) => {
    const store = createAssistantChannelStore(directory());
    cleanup.push(() => store.close());
    bind(store, 'bot-one', { provider, client_id: 'account-one' });
    bind(store, 'bot-two', { provider, client_id: 'account-two' });
    expect(store.get('bot-one', provider)).toMatchObject({ client_id: 'account-one' });
    expect(store.get('bot-two', provider)).toMatchObject({ client_id: 'account-two' });
    expect(() => bind(store, 'bot-three', { provider, client_id: 'account-one' })).toThrow('account_in_use');
    store.unlink('bot-two', provider);
    expect(store.get('bot-one', provider)).toMatchObject({ client_id: 'account-one' });
  });

  it('deduplicates stable inbound IDs across restart and keeps private routing out of text', () => {
    const dir = directory();
    let store = createAssistantChannelStore(dir);
    const binding = bind(store);
    expect(store.accept(binding, [
      { id: 'm1', text: 'hello', payload: 'meta', target: '{"reply":"opaque"}' },
      { id: 'm1', text: 'duplicate', payload: 'changed', target: '{"reply":"hijack"}' },
    ])).toBe(true);
    expect(store.pending(binding.epoch)).toEqual([
      expect.objectContaining({ id: 'm1', text: 'hello', payload: 'meta', state: 'pending' }),
    ]);
    expect(store.hasReceipt('m1')).toBe(true);
    expect(store.get('bot', 'wecom').target).toBe('{"reply":"opaque"}');
    store.close();
    store = createAssistantChannelStore(dir);
    cleanup.push(() => store.close());
    const restarted = store.get('bot', 'wecom');
    expect(store.accept(restarted, [{ id: 'm1', text: 'replay', payload: '', target: '' }])).toBe(false);
    expect(store.pending(restarted.epoch)).toEqual([
      expect.objectContaining({ id: 'm1', text: 'hello', payload: 'meta' }),
    ]);
    expect(store.get('bot', 'wecom').target).toBe('{"reply":"opaque"}');
  });

  it('rotates epoch on update but preserves pending work for the same identity', () => {
    const store = createAssistantChannelStore(directory());
    cleanup.push(() => store.close());
    const binding = bind(store);
    store.accept(binding, [{ id: 'm1', text: 'pending', target: '{"reply":"opaque"}' }]);
    const updated = bind(store, 'bot', { client_secret: 'new-secret', language: 'en' });
    expect(updated.epoch).not.toBe(binding.epoch);
    expect(updated).toMatchObject({ client_secret: 'new-secret', language: 'en', status: 'connecting' });
    expect(store.pending(updated.epoch)).toEqual([expect.objectContaining({ id: 'm1', text: 'pending' })]);
    expect(store.get('bot', 'wecom').target).toBe('{"reply":"opaque"}');
  });

  it('drops the previous owner account queues and routing target on identity change', () => {
    const store = createAssistantChannelStore(directory());
    cleanup.push(() => store.close());
    const binding = bind(store);
    store.accept(binding, [{ id: 'm1', text: 'old owner', target: '{"reply":"old"}' }]);
    store.collect(binding, { generation: 0, ordinal: 1 }, [{ id: 'out', text: 'old reply' }], 2);
    const updated = bind(store, 'bot', {
      client_id: 'new-client', owner_id: 'new-owner', generation: 7, ordinal: 50,
    });
    expect(store.pending(updated.epoch)).toEqual([]);
    expect(store.nextDelivery(updated.epoch)).toBeUndefined();
    expect(store.get('bot', 'wecom')).toMatchObject({
      client_id: 'new-client', owner_id: 'new-owner', target: '', generation: 7, ordinal: 50,
    });
  });

  it('recovers admitted receipts without replay, marks interrupted sends unknown and clears private text', () => {
    const dir = directory();
    const store = createAssistantChannelStore(dir);
    cleanup.push(() => store.close());
    const binding = bind(store);
    store.accept(binding, [
      { id: 'admitted', text: 'private text', payload: 'private meta', target: '{"reply":"opaque"}' },
      { id: 'pending', text: 'still pending' },
    ]);
    store.markInbox('admitted', 'admitted');
    store.collect(binding, { generation: 0, ordinal: 0 }, [{ id: 'out', text: 'reply' }], 2);
    store.markDelivery('out', 'sending');
    store.recover(binding.epoch, 'interrupted feedback');
    expect(store.pending(binding.epoch)).toEqual([expect.objectContaining({ id: 'pending', text: 'still pending' })]);
    // The earlier indeterminate send stays at the head and is never bypassed.
    expect(store.nextDelivery(binding.epoch)).toEqual(expect.objectContaining({
      id: 'out', text: 'reply', state: 'unknown',
    }));
    expect(store.hasUnknown(binding.epoch)).toBe(true);
    const db = new Database(path.join(dir, 'channel.sqlite'));
    cleanup.push(() => db.close());
    expect(db.prepare("SELECT text,payload,state FROM inbox WHERE id='admitted'").get())
      .toEqual({ text: '', payload: '', state: 'done' });
    expect(db.prepare("SELECT text FROM outbox WHERE id='admitted:interrupted'").get().text).toBe('interrupted feedback');
    expect(db.prepare("SELECT state FROM outbox WHERE id='out'").get().state).toBe('unknown');
    // retry re-queues definitively failed rows only; unknown stays unknown.
    store.retry(binding.epoch);
    expect(store.nextDelivery(binding.epoch)).toEqual(expect.objectContaining({ id: 'out', state: 'unknown' }));
  });

  it('drops queued output from an older transcript generation and keeps stable IDs idempotent', () => {
    const store = createAssistantChannelStore(directory());
    cleanup.push(() => store.close());
    const binding = bind(store);
    store.collect(binding, { generation: 0, ordinal: 1 }, [{ id: 'old', text: 'old' }], 2);
    store.collect(binding, { generation: 1, ordinal: 2 }, [{ id: 'new', text: 'new' }], 3);
    expect(store.nextDelivery(binding.epoch)).toEqual(expect.objectContaining({ id: 'new', text: 'new' }));
    expect(store.get('bot', 'wecom')).toMatchObject({ generation: 1, ordinal: 2 });
    // Replaying the same delivery ID after a restart must not duplicate output.
    store.collect(binding, { generation: 1, ordinal: 2 }, [{ id: 'new', text: 'new' }], 4);
    expect(store.nextDelivery(binding.epoch)).toEqual(expect.objectContaining({ id: 'new' }));
  });

  it('serializes delivery retries, blocks after repeated definite failure and never clears unknown', () => {
    const store = createAssistantChannelStore(directory());
    cleanup.push(() => store.close());
    const binding = bind(store);
    store.collect(binding, { generation: 0, ordinal: 0 }, [{ id: 'out', text: 'reply' }], 1);
    store.markDelivery('out', 'sending');
    store.failDelivery('out');
    expect(store.nextDelivery(binding.epoch)).toEqual(expect.objectContaining({ id: 'out', state: 'pending' }));
    store.markDelivery('out', 'sending');
    store.failDelivery('out');
    store.markDelivery('out', 'sending');
    store.failDelivery('out');
    expect(store.hasBlocked(binding.epoch)).toBe(true);
    expect(store.nextDelivery(binding.epoch)).toEqual(expect.objectContaining({ id: 'out', state: 'blocked' }));
    store.retry(binding.epoch);
    expect(store.nextDelivery(binding.epoch)).toEqual(expect.objectContaining({ id: 'out', state: 'pending' }));
    store.markDelivery('out', 'unknown');
    store.retry(binding.epoch);
    expect(store.hasUnknown(binding.epoch)).toBe(true);
    expect(store.nextDelivery(binding.epoch)).toEqual(expect.objectContaining({ id: 'out', state: 'unknown' }));
    expect(store.hasReceipt('missing')).toBe(false);
  });

  it('preserves outbox order behind an unknown send until it is explicitly resolved', () => {
    const store = createAssistantChannelStore(directory());
    cleanup.push(() => store.close());
    const binding = bind(store);
    store.collect(binding, { generation: 0, ordinal: 0 }, [
      { id: 'first', text: 'first' },
      { id: 'second', text: 'second' },
    ], 1);
    store.markDelivery('first', 'unknown');
    expect(store.nextDelivery(binding.epoch)).toEqual(expect.objectContaining({ id: 'first', state: 'unknown' }));
    store.retry(binding.epoch);
    expect(store.nextDelivery(binding.epoch)).toEqual(expect.objectContaining({ id: 'first', state: 'unknown' }));
    store.sent('first');
    expect(store.nextDelivery(binding.epoch)).toEqual(expect.objectContaining({ id: 'second', state: 'pending' }));
  });

  it('leases one process at a time and expires a dead owner', () => {
    const store = createAssistantChannelStore(directory());
    cleanup.push(() => store.close());
    expect(store.acquire('a', 1_000)).toBe(true);
    expect(store.acquire('b', 1_000)).toBe(false);
    expect(store.owns('a', 1_000)).toBe(true);
    expect(store.owns('b', 1_000)).toBe(false);
    expect(store.acquire('b', 61_000)).toBe(true);
    expect(store.owns('a', 61_000)).toBe(false);
    store.release('b');
    expect(store.owns('b', 61_000)).toBe(false);
  });

  it('bounds each admission pass to 20 while backlog counts pending and admitted', () => {
    const store = createAssistantChannelStore(directory());
    cleanup.push(() => store.close());
    const binding = bind(store);
    store.accept(binding, Array.from({ length: 25 }, (_, index) => ({ id: `m${index}`, text: 'x' })));
    expect(store.pending(binding.epoch)).toHaveLength(20);
    expect(store.backlog(binding.epoch)).toBe(25);
    store.markInbox('m0', 'admitted');
    expect(store.backlog(binding.epoch)).toBe(25);
    store.finishTurn('m0');
    expect(store.backlog(binding.epoch)).toBe(24);
  });

  it('forgets every provider for one Bot in one transaction', () => {
    const store = createAssistantChannelStore(directory());
    cleanup.push(() => store.close());
    const wecom = bind(store);
    const feishu = bind(store, 'bot', { provider: 'feishu' });
    store.accept(wecom, [{ id: 'm1', text: 'x' }]);
    store.collect(feishu, { generation: 0, ordinal: 0 }, [{ id: 'out', text: 'y' }], 1);
    store.forget('bot');
    expect(store.get('bot', 'wecom')).toBeNull();
    expect(store.get('bot', 'feishu')).toBeNull();
    expect(store.pending(wecom.epoch)).toEqual([]);
    expect(store.nextDelivery(feishu.epoch)).toBeUndefined();
  });
});
