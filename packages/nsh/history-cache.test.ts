import { expect, it, vi } from 'vitest';
import { createNativeHistoryCache, nativeHistoryCacheKey, settledHistoryPrefix } from './history-cache';
import { messageFrom } from './model';
import { createAuthorizationCacheCleanup } from './authorization-cache-cleanup';
const message = (id: string, role = 'assistant', completed: number | undefined = 2) => messageFrom({ id, type: role, time: { created: 1, completed }, text: id })!;
const snapshot = (id: string) => ({ messages: [message(id)], cursor: 'opaque:older', complete: false, revert: null });
function storageFixture() {
  const values = new Map<string, string>();
  return { values, getItem: vi.fn(async (key: string) => values.get(key) ?? null), setItem: vi.fn(async (key: string, value: string) => { values.set(key, value); }), removeItem: vi.fn(async (key: string) => { values.delete(key); }) };
}
const authorizationKey = (connection = 'host', authorization = 'auth', id = 'session') => JSON.stringify([connection, authorization, 'session', '/repo', id]);
it('rejects a completed disk seed at the final consumer when clear runs between Promise delivery callbacks', async () => {
  const storage = storageFixture(), cache = createNativeHistoryCache(storage), key = authorizationKey();
  await cache.write(key, snapshot('old'), () => true); cache.clearMemory();
  const admitted = cache.captureRead(key), publish = vi.fn(), liveCurrent = () => true;
  const seedHistory = (value: ReturnType<typeof cache.peek>) => {
    if (!value || !liveCurrent()) return;
    // This is the synchronous consumer boundary immediately before its signal write.
    if (admitted()) publish(value.messages);
  };
  const read = cache.read(key);
  // read has already completed its final index write and returned the old snapshot.
  // Both callbacks receive that same snapshot; clear runs before the seed consumer.
  const clear = read.then(value => { expect(value?.messages[0].id).toBe('old'); return cache.clear(); });
  const consume = read.then(seedHistory);
  await clear; await consume;
  expect(liveCurrent()).toBe(true); expect(publish).not.toHaveBeenCalled(); expect(admitted()).toBe(false);
  await cache.write(key, snapshot('new-authority'), () => true);
  const nextAdmission = cache.captureRead(key), next = await cache.read(key);
  expect(nextAdmission()).toBe(true); expect(next?.messages[0].id).toBe('new-authority'); expect(admitted()).toBe(false);
});
it('rejects an already-peeked seed after even a failed clear and admits only newly captured authoritative seeds', async () => {
  const storage = storageFixture(), cache = createNativeHistoryCache(storage), key = authorizationKey();
  await cache.write(key, snapshot('peeked-old'), () => true);
  const admitted = cache.captureRead(key), peeked = cache.peek(key), publish = vi.fn();
  expect(admitted()).toBe(true); expect(peeked?.messages[0].id).toBe('peeked-old');
  storage.setItem.mockRejectedValueOnce(Error('journal-full'));
  await expect(cache.clear()).rejects.toThrow('journal-full');
  if (admitted()) publish(peeked);
  expect(publish).not.toHaveBeenCalled();
  await cache.write(key, snapshot('fresh'), () => true);
  const freshAdmission = cache.captureRead(key);
  expect(freshAdmission()).toBe(true); expect(admitted()).toBe(false);
  expect(cache.peek(key)?.messages[0].id).toBe('fresh'); expect(cache.captureRead(null)()).toBe(false);
});
it('keeps seed admissions authorization-scoped while exact retirement is pending', async () => {
  const storage = storageFixture(), cache = createNativeHistoryCache(storage);
  const a = authorizationKey('host', 'a'), b = authorizationKey('host', 'b');
  await cache.write(a, snapshot('a'), () => true); await cache.write(b, snapshot('b'), () => true);
  const old = cache.captureRead(a), fresh = cache.captureRead(b);
  const retiring = cache.retireAuthorization('host', 'a');
  expect(old()).toBe(false); expect(fresh()).toBe(true); await retiring;
  expect(cache.captureRead(a)()).toBe(false); expect(fresh()).toBe(true);
});
it('manually clears all history records and memory while preserving authorization tombstones and unrelated storage', async () => {
  const storage = storageFixture(), cache = createNativeHistoryCache(storage), old = authorizationKey('host', 'old'), current = authorizationKey();
  await cache.write(old, snapshot('retired'), () => true); await cache.retireAuthorization('host', 'old');
  const live = snapshot('live'); await cache.write(current, live, () => true);
  for (const key of ['draft', 'pendingSend', 'queueEdit', 'receipt', 'attachments', 'settings', 'credentials']) storage.values.set(key, key);
  await cache.clear();
  expect(cache.peek(current)).toBeUndefined(); expect(live.messages[0].id).toBe('live');
  expect([...storage.values.keys()].filter(key => key.includes(':record:'))).toEqual([]);
  const cold = createNativeHistoryCache(storage);
  expect(await cold.read(current)).toBeUndefined(); await cold.write(old, snapshot('forbidden'), () => true);
  expect(await cold.read(old)).toBeUndefined();
  for (const key of ['draft', 'pendingSend', 'queueEdit', 'receipt', 'attachments', 'settings', 'credentials']) expect(storage.values.get(key)).toBe(key);
  await cache.write(current, snapshot('new-authority'), () => true);
  expect((await createNativeHistoryCache(storage).read(current))?.messages[0].id).toBe('new-authority');
});
it('fences a pre-clear in-flight read and queued write while allowing writes admitted after the clear boundary', async () => {
  const storage = storageFixture(), cache = createNativeHistoryCache(storage);
  await cache.write('read', snapshot('old-read'), () => true);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  const get = storage.getItem.getMockImplementation()!;
  storage.getItem.mockImplementation(async key => { if (key.includes(':record:')) { entered(); await gate; } return get(key); });
  const read = cache.read('read'); await started;
  const queuedRead = cache.read('read');
  const queued = cache.write('queued', snapshot('old-queued'), () => true);
  const clear = cache.clear(), newWrite = cache.write('new', snapshot('new-authority'), () => true);
  expect(cache.peek('read')).toBeUndefined(); release();
  expect(await read).toBeUndefined(); expect(await queuedRead).toBeUndefined(); await queued; await clear; await newWrite;
  expect(cache.peek('read')).toBeUndefined(); expect(cache.peek('queued')).toBeUndefined();
  expect((await createNativeHistoryCache(storage).read('new'))?.messages[0].id).toBe('new-authority');
  expect([...storage.values.values()].some(raw => raw.includes('old-queued'))).toBe(false);
});
it('fences an in-flight write before it can publish a memory seed after clear', async () => {
  const storage = storageFixture(), cache = createNativeHistoryCache(storage);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  const get = storage.getItem.getMockImplementation()!; let held = false;
  storage.getItem.mockImplementation(async key => { if (!held) { held = true; entered(); await gate; } return get(key); });
  const old = cache.write('old', snapshot('old-authority'), () => true); await started;
  const clear = cache.clear(); release(); await old; await clear;
  expect(cache.peek('old')).toBeUndefined(); expect(await createNativeHistoryCache(storage).read('old')).toBeUndefined();
});
it('journals indexed, pending and garbage records, continues after a failed slot, and retries explicitly after restart', async () => {
  const storage = storageFixture(), cache = createNativeHistoryCache(storage), a = authorizationKey('host', 'a'), b = authorizationKey('host', 'b');
  await cache.write(a, snapshot('a'), () => true); await cache.write(b, snapshot('b'), () => true);
  const indexKey = 'nsh:history-cache:v1:index';
  const first = JSON.parse(storage.values.get(indexKey)!);
  const aSlot = first.entries.find((entry: { key: string }) => entry.key === a).slot;
  const remove = storage.removeItem.getMockImplementation()!;
  storage.removeItem.mockImplementation(async slot => { if (slot === aSlot) throw Error('locked'); await remove(slot); });
  await expect(cache.retireAuthorization('host', 'a')).rejects.toThrow('locked');
  const set = storage.setItem.getMockImplementation()!; let writes = 0;
  // The first write persists cleanup of A's retained garbage, then candidate/content/commit.
  storage.setItem.mockImplementation(async (slot, raw) => { if (++writes === 4) throw Error('interrupted-commit'); await set(slot, raw); });
  await expect(cache.write(b, snapshot('pending-b'), () => true)).rejects.toThrow('interrupted-commit');
  storage.setItem.mockImplementation(set);
  expect(JSON.parse(storage.values.get(indexKey)!).pending).toBeDefined();
  await expect(cache.clear()).rejects.toThrow('locked');
  expect([...storage.values.keys()].filter(slot => slot.includes(':record:'))).toEqual([aSlot]);
  const journal = JSON.parse(storage.values.get(indexKey)!);
  expect(journal.entries).toEqual([]); expect(journal.garbage).toEqual([aSlot]); expect(journal.pending).toBeUndefined();
  const cold = createNativeHistoryCache(storage);
  expect(await cold.read(b)).toBeUndefined();
  await expect(cold.clear()).rejects.toThrow('locked');
  storage.removeItem.mockImplementation(remove); await cold.clear();
  expect([...storage.values.keys()].filter(slot => slot.includes(':record:'))).toEqual([]);
  await cold.write(a, snapshot('retired-revival'), () => true); expect(await cold.read(a)).toBeUndefined();
});
it.each([1, 2])('rejects clear journal write failure %i and supports idempotent explicit retry', async failAt => {
  const storage = storageFixture(), cache = createNativeHistoryCache(storage);
  await cache.write('scope', snapshot('old'), () => true);
  const set = storage.setItem.getMockImplementation()!; let writes = 0;
  storage.setItem.mockImplementation(async (slot, raw) => { if (++writes === failAt) throw Error('journal-full'); await set(slot, raw); });
  await expect(cache.clear()).rejects.toThrow('journal-full'); expect(cache.peek('scope')).toBeUndefined();
  if (failAt === 1) expect(storage.removeItem).not.toHaveBeenCalled();
  storage.setItem.mockImplementation(set); const cold = createNativeHistoryCache(storage); await cold.clear();
  expect(await cold.read('scope')).toBeUndefined(); expect(storage.values.size).toBe(1);
});
it('coalesces concurrent clears and preserves authoritative writes queued after their shared boundary', async () => {
  const storage = storageFixture(), cache = createNativeHistoryCache(storage);
  await cache.write('old', snapshot('old'), () => true);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  const remove = storage.removeItem.getMockImplementation()!;
  storage.removeItem.mockImplementation(async slot => { entered(); await gate; await remove(slot); });
  const first = cache.clear(); await started;
  const newWrite = cache.write('new', snapshot('new'), () => true), second = cache.clear();
  expect(first).toBe(second); release(); await first; await newWrite;
  expect((await cache.read('new'))?.messages[0].id).toBe('new');
});
it('never reuses an old failed-clear slot for a new write after restart, even when clock and entropy repeat', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1000), entropy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
  try {
    const storage = storageFixture(), cache = createNativeHistoryCache(storage), old = authorizationKey('host', 'old'), fresh = authorizationKey('host', 'new');
    await cache.write(old, snapshot('old'), () => true);
    const oldSlot = [...storage.values.keys()].find(slot => slot.includes(':record:'))!;
    const remove = storage.removeItem.getMockImplementation()!;
    storage.removeItem.mockImplementation(async slot => { if (slot === oldSlot) throw Error('locked'); await remove(slot); });
    await expect(cache.clear()).rejects.toThrow('locked');
    const cold = createNativeHistoryCache(storage); await cold.write(fresh, snapshot('fresh'), () => true);
    const index = JSON.parse(storage.values.get('nsh:history-cache:v1:index')!);
    expect(index.entries[0].slot).not.toBe(oldSlot); expect(index.garbage).toContain(oldSlot);
    const reference = cold.peek(fresh);
    storage.removeItem.mockImplementation(remove); await cold.retireAuthorization('host', 'old');
    expect(cold.peek(fresh)).toBe(reference); expect((await createNativeHistoryCache(storage).read(fresh))?.messages[0].id).toBe('fresh');
  } finally { clock.mockRestore(); entropy.mockRestore(); }
});
it('isolates a permanently undeletable authorization through the real cleanup runner and across restart', async () => {
  const storage = storageFixture(), cache = createNativeHistoryCache(storage);
  const a = authorizationKey('host', 'a'), b = authorizationKey('host', 'b'), fresh = authorizationKey('host', 'new');
  await cache.write(a, snapshot('a'), () => true); await cache.write(b, snapshot('b'), () => true);
  await cache.write(fresh, snapshot('fresh'), () => true); const reference = cache.peek(fresh);
  const indexKey = 'nsh:history-cache:v1:index';
  const entries = JSON.parse(storage.values.get(indexKey)!).entries as { key: string; slot: string }[];
  const aSlot = entries.find(entry => entry.key === a)!.slot, bSlot = entries.find(entry => entry.key === b)!.slot;
  const remove = storage.removeItem.getMockImplementation()!;
  storage.removeItem.mockImplementation(async slot => { if (slot === aSlot) throw Error('a-locked'); await remove(slot); });
  const acked: string[] = [];
  const runner = (current: ReturnType<typeof createNativeHistoryCache>) => createAuthorizationCacheCleanup({
    ready: async () => ({ owner: 'root', tickets: ['a', 'b'] }), list: async () => ['a', 'b'],
    claim: async (_, ticket) => ({ connectionID: 'host', authorizationID: ticket }), ack: async (_, ticket) => { acked.push(ticket); },
  }, (connection, authorization) => current.retireAuthorization(connection, authorization));
  expect(await runner(cache).run()).toEqual({ completed: ['b'], failed: ['a'] });
  expect(acked).toEqual(['b']); expect(storage.values.has(bSlot)).toBe(false); expect(storage.values.has(aSlot)).toBe(true);
  expect(cache.peek(fresh)).toBe(reference);
  await cache.write(authorizationKey('other', 'auth'), snapshot('other'), () => true);
  expect((await cache.read(fresh))?.messages[0].id).toBe('fresh');
  const cold = createNativeHistoryCache(storage);
  expect(await runner(cold).run()).toEqual({ completed: ['b'], failed: ['a'] });
  const index = JSON.parse(storage.values.get(indexKey)!);
  expect(index.garbage).toContain(aSlot); expect(index.owners[aSlot]).toBe(JSON.stringify(['host', 'a']));
  expect(await cold.read(a)).toBeUndefined(); expect((await cold.read(fresh))?.messages[0].id).toBe('fresh');
});
it.each(['garbage', 'pending'] as const)('recovers the owner of legacy v1 %s without allowing unknown ownership to count as completion', async journal => {
  const storage = storageFixture(), cache = createNativeHistoryCache(storage), a = authorizationKey('host', 'a'), b = authorizationKey('host', 'b');
  await cache.write(a, snapshot('a'), () => true); await cache.write(b, snapshot('b'), () => true);
  const indexKey = 'nsh:history-cache:v1:index', index = JSON.parse(storage.values.get(indexKey)!);
  const aEntry = index.entries.find((entry: { key: string }) => entry.key === a);
  index.entries = index.entries.filter((entry: { key: string }) => entry.key !== a);
  index.garbage = journal === 'garbage' ? [aEntry.slot] : [];
  if (journal === 'pending') index.pending = aEntry.slot;
  delete index.owners; storage.values.set(indexKey, JSON.stringify(index));
  const originalRecord = storage.values.get(aEntry.slot)!; storage.values.set(aEntry.slot, '{unknown');
  const remove = storage.removeItem.getMockImplementation()!;
  storage.removeItem.mockImplementation(async slot => { if (slot === aEntry.slot) throw Error('unknown-owner'); await remove(slot); });
  const cold = createNativeHistoryCache(storage);
  await expect(cold.retireAuthorization('host', 'b')).rejects.toThrow('unknown-owner');
  expect(JSON.parse(storage.values.get(indexKey)!).garbage).toContain(aEntry.slot);
  storage.values.set(aEntry.slot, originalRecord);
  await cold.retireAuthorization('host', 'b');
  const recovered = JSON.parse(storage.values.get(indexKey)!);
  expect(recovered.owners[aEntry.slot]).toBe(JSON.stringify(['host', 'a']));
  await expect(createNativeHistoryCache(storage).retireAuthorization('host', 'a')).rejects.toThrow('unknown-owner');
});
it('does not ACK physical deletion until the remaining garbage journal write commits', async () => {
  const storage = storageFixture(), cache = createNativeHistoryCache(storage), key = authorizationKey();
  await cache.write(key, snapshot('old'), () => true);
  const set = storage.setItem.getMockImplementation()!; let writes = 0;
  storage.setItem.mockImplementation(async (slot, raw) => { if (++writes === 2) throw Error('journal-full'); await set(slot, raw); });
  await expect(cache.retireAuthorization('host', 'auth')).rejects.toThrow('journal-full');
  expect([...storage.values.keys()].filter(slot => slot.includes(':record:'))).toHaveLength(0);
  storage.setItem.mockImplementation(set);
  await createNativeHistoryCache(storage).retireAuthorization('host', 'auth');
  expect(JSON.parse(storage.values.get('nsh:history-cache:v1:index')!).garbage).toEqual([]);
});
it('persists the retirement journal before deletion and retries physical failures after restart', async () => {
  const storage = storageFixture(), cache = createNativeHistoryCache(storage), key = authorizationKey();
  await cache.write(key, snapshot('secret-history'), () => true);
  storage.removeItem.mockRejectedValueOnce(Error('locked'));
  await expect(cache.retireAuthorization('host', 'auth')).rejects.toThrow('locked');
  expect(cache.peek(key)).toBeUndefined();
  expect([...storage.values.values()].some(value => value.includes('secret-history'))).toBe(true);
  const cold = createNativeHistoryCache(storage);
  await cold.retireAuthorization('host', 'auth');
  expect(await cold.read(key)).toBeUndefined();
  expect([...storage.values.values()].some(value => value.includes('secret-history'))).toBe(false);
  await cold.retireAuthorization('host', 'auth');
});
it('keeps a partial multi-session deletion retryable without deleting other authorization records', async () => {
  const storage = storageFixture(), cache = createNativeHistoryCache(storage);
  for (const id of ['one', 'two']) await cache.write(authorizationKey('host', 'auth', id), snapshot(id), () => true);
  const fresh = authorizationKey('host', 'fresh'); await cache.write(fresh, snapshot('fresh'), () => true);
  const remove = storage.removeItem.getMockImplementation()!; let removed = 0;
  storage.removeItem.mockImplementation(async key => { if (++removed === 2) throw Error('partial'); await remove(key); });
  await expect(cache.retireAuthorization('host', 'auth')).rejects.toThrow('partial');
  const cold = createNativeHistoryCache(storage); await cold.retireAuthorization('host', 'auth');
  expect((await cold.read(fresh))?.messages[0].id).toBe('fresh');
  expect([...storage.values.keys()].filter(key => key.includes(':record:'))).toHaveLength(1);
});
it('retires both committed records and an interrupted candidate journal before ACK', async () => {
  const storage = storageFixture(), cache = createNativeHistoryCache(storage), key = authorizationKey();
  await cache.write(key, snapshot('old'), () => true);
  const set = storage.setItem.getMockImplementation()!; let writes = 0;
  storage.setItem.mockImplementation(async (slot, raw) => { if (++writes === 3) throw Error('commit'); await set(slot, raw); });
  await expect(cache.write(key, snapshot('candidate'), () => true)).rejects.toThrow('commit');
  storage.setItem.mockImplementation(set);
  await cache.retireAuthorization('host', 'auth');
  expect([...storage.values.keys()].filter(slot => slot.includes(':record:'))).toHaveLength(0);
  expect(await createNativeHistoryCache(storage).read(key)).toBeUndefined();
});
it('does not delete when the tombstone write fails and allows exact receipt retry', async () => {
  const storage = storageFixture(), cache = createNativeHistoryCache(storage), key = authorizationKey();
  await cache.write(key, snapshot('old'), () => true);
  storage.setItem.mockRejectedValueOnce(Error('full'));
  await expect(cache.retireAuthorization('host', 'auth')).rejects.toThrow('full');
  expect(storage.removeItem).not.toHaveBeenCalled();
  expect(cache.peek(key)).toBeUndefined();
  await cache.write(key, snapshot('blocked'), () => true);
  await cache.retireAuthorization('host', 'auth');
  expect(await createNativeHistoryCache(storage).read(key)).toBeUndefined();
});
it('fences an in-flight read, queued writes and a same-authorization invalidation without touching new auth refs', async () => {
  const storage = storageFixture(), cache = createNativeHistoryCache(storage), key = authorizationKey(), fresh = authorizationKey('host', 'new');
  await cache.write(key, snapshot('old'), () => true);
  const next = snapshot('fresh'); await cache.write(fresh, next, () => true); const retained = cache.peek(fresh);
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), blocked = new Promise<void>(resolve => { release = resolve; });
  const get = storage.getItem.getMockImplementation()!;
  storage.getItem.mockImplementation(async slot => { if (slot.includes(':record:')) { entered(); await blocked; } return get(slot); });
  const read = cache.read(key); await started;
  const write = cache.write(key, snapshot('queued'), () => true);
  const retire = cache.retireAuthorization('host', 'auth');
  expect(cache.peek(key)).toBeUndefined(); release();
  expect(await read).toBeUndefined(); await write; await retire;
  await cache.invalidate(key);
  expect(cache.peek(fresh)).toBe(retained);
  await createNativeHistoryCache(storage).write(key, snapshot('revival'), () => true);
  expect(await createNativeHistoryCache(storage).read(key)).toBeUndefined();
});
it('physically retires only the exact authorization and permanently rejects its old keys', async () => {
  const storage = storageFixture(), cache = createNativeHistoryCache(storage);
  const retired = authorizationKey(), other = [authorizationKey('host-extra'), authorizationKey('host', 'auth-new')];
  await cache.write(retired, snapshot('retired'), () => true);
  for (const key of other) await cache.write(key, snapshot(key), () => true);
  storage.values.set('draft:host', 'untouched');
  await cache.retireAuthorization('host', 'auth');
  expect(cache.peek(retired)).toBeUndefined();
  await cache.write(retired, snapshot('revived'), () => true);
  const cold = createNativeHistoryCache(storage);
  await cold.write(retired, snapshot('cold-revival'), () => true);
  expect(await cold.read(retired)).toBeUndefined();
  for (const key of other) expect((await cold.read(key))?.messages[0].id).toBe(key);
  expect(storage.values.get('draft:host')).toBe('untouched');
  expect([...storage.values.values()].some(value => value.includes('"id":"retired"'))).toBe(false);
});
it('partitions by authorization and target, not endpoint/lease; legacy unknown authorization opts out', () => {
  const connection = { id: 'host', authorizationID: 'auth', url: 'https://host.example', label: '', lastUsedAt: 0 }, target = { kind: 'session' as const, directory: '/repo', id: 'session', title: '' };
  const key = nativeHistoryCacheKey(connection, target);
  expect(nativeHistoryCacheKey({ ...connection, url: 'https://relay.example' }, target)).toBe(key);
  for (const changed of [{ ...connection, id: 'other' }, { ...connection, authorizationID: 'new' }]) expect(nativeHistoryCacheKey(changed, target)).not.toBe(key);
  expect(nativeHistoryCacheKey({ ...connection, authorizationID: undefined }, target)).toBeNull();
  expect(nativeHistoryCacheKey(connection, { ...target, directory: '/other' })).not.toBe(key);
});
it('restores a settled contiguous snapshot across cache instances, including opaque cursor and exact body', async () => {
  const storage = storageFixture(), cache = createNativeHistoryCache(storage), value = snapshot('full');
  value.messages[0].content = [{ id: 'tool', type: 'tool', state: { status: 'completed', output: 'full output' } }];
  value.messages[0].contextContent = value.messages[0].content;
  await cache.write('scope', value, () => true);
  expect(cache.peek('scope')?.messages[0]).toBe(value.messages[0]);
  const cold = createNativeHistoryCache(storage), restored = await cold.read('scope');
  expect(restored).toEqual(value); expect(cold.peek('scope')).toBe(restored);
  expect(restored?.messages[0].contextContent).toBe(restored?.messages[0].content);
  expect(await cold.read('other')).toBeUndefined();
});
it('never persists unfinished rows or following rows that would make a hole in the prefix', async () => {
  const done = message('done'), live = message('live'); live.time = { created: 2 }; const following = message('later', 'user');
  expect(settledHistoryPrefix([done, live, following])).toEqual([done]);
  const storage = storageFixture(), cache = createNativeHistoryCache(storage);
  await cache.write('scope', { ...snapshot('unused'), messages: [done, live, following] }, () => true);
  expect((await createNativeHistoryCache(storage).read('scope'))?.messages).toEqual([done]);
});
it('keeps the old durable snapshot after failed slot/index commit and recovers the journal on next read', async () => {
  for (const failAt of [2, 3]) {
    const storage = storageFixture(), cache = createNativeHistoryCache(storage);
    await cache.write('scope', snapshot('old'), () => true);
    let calls = 0; const original = storage.setItem.getMockImplementation()!;
    storage.setItem.mockImplementation(async (key, value) => { if (++calls === failAt) throw Error('disk-full'); await original(key, value); });
    await expect(cache.write('scope', snapshot('new'), () => true)).rejects.toThrow('disk-full');
    storage.setItem.mockImplementation(original);
    const restored = await createNativeHistoryCache(storage).read('scope');
    expect(restored?.messages[0].id).toBe('old');
    expect(storage.values.size).toBe(2);
  }
});
it('fences late writes/invalidation and keeps unrelated sessions intact', async () => {
  const storage = storageFixture(), cache = createNativeHistoryCache(storage); let current = true;
  const work = cache.write('scope', snapshot('stale'), () => current); current = false; await work;
  expect(await createNativeHistoryCache(storage).read('scope')).toBeUndefined();
  await cache.write('other', snapshot('other'), () => true);
  const write = cache.write('scope', snapshot('removed'), () => true), clear = cache.invalidate('scope'); await Promise.all([write, clear]);
  expect(cache.peek('scope')).toBeUndefined(); expect(await createNativeHistoryCache(storage).read('scope')).toBeUndefined();
  expect((await cache.read('other'))?.messages[0].id).toBe('other');
});
it('bounds memory LRU separately from durable byte/session retention and evicts in one transaction', async () => {
  const storage = storageFixture(), cache = createNativeHistoryCache(storage, { sessions: 2, bytes: 4000, durableSessions: 3 });
  await cache.write('a', snapshot('a'), () => true); await cache.write('b', snapshot('b'), () => true); cache.peek('a');
  await cache.write('c', snapshot('c'), () => true); expect(cache.peek('b')).toBeUndefined();
  await cache.write('d', snapshot('d'), () => true);
  const cold = createNativeHistoryCache(storage, { sessions: 2, bytes: 4000, durableSessions: 3 });
  expect(await cold.read('a')).toBeUndefined(); expect((await cold.read('d'))?.messages[0].id).toBe('d');
  expect(storage.values.size).toBe(4);
  const giant = snapshot('huge'); giant.messages[0].text = 'x'.repeat(5000); await cache.write('giant', giant, () => true);
  expect(cache.peek('giant')).toBeUndefined(); expect(await cold.read('giant')).toBeUndefined();
});
it('rejects malformed or cross-scope records without fabricating authoritative empty data', async () => {
  const storage = storageFixture(), cache = createNativeHistoryCache(storage); await cache.write('scope', snapshot('row'), () => true);
  const slot = [...storage.values.keys()].find(key => key.includes(':record:'))!;
  storage.values.set(slot, JSON.stringify({ version: 1, key: 'other', snapshot: snapshot('row') }));
  expect(await createNativeHistoryCache(storage).read('scope')).toBeUndefined();
  storage.values.set(slot, '{'); await expect(createNativeHistoryCache(storage).read('scope')).rejects.toThrow();
});
