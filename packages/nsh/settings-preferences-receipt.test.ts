import { beforeEach, expect, test, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ storage: new Map<string, string>(), fail: false }));
vi.mock('nsh', () => ({
  signal: <T>(value: T) => Object.assign(() => value, { set: (next: T) => { value = next; } }),
  batch: (work: () => void) => work(), untracked: (work: () => unknown) => work(),
  Storage: {
    getItem: async (key: string) => fixture.storage.get(key) ?? null,
    setItem: async (key: string, value: string) => { if (fixture.fail) throw new Error('fixture storage failed'); fixture.storage.set(key, value); },
  },
}));
import { openPreferenceReceipt, type PreferenceReceipt } from './settings-preferences-receipt';

const receipt = (): PreferenceReceipt => ({ acknowledged: false, patch: { followUpBehavior: 'steer', fontSize: 125 }, submitted: { followUpBehavior: 'steer', fontSize: '125' }, edits: { followUpBehavior: 1, fontSize: 2 }, revision: 2 });
beforeEach(() => { fixture.storage.clear(); fixture.fail = false; });

test('unknown operation and original edit revisions survive page close and a fresh process module', async () => {
  const first = openPreferenceReceipt('restart-host', 'auth'); await first.ready;
  const input = receipt(); await first.prepare(input); first.enterPut(input); await first.handoff(input); await first.close();
  vi.resetModules();
  const restarted = (await import('./settings-preferences-receipt')).openPreferenceReceipt('restart-host', 'auth');
  await restarted.ready;
  expect(restarted.value()).toEqual(receipt());
  await expect(restarted.clear(receipt())).rejects.toThrow('unknown');
  expect(restarted.value()).toEqual(receipt()); await restarted.close();
});

test('connection plus authorization isolates the journal; URL/lease and page names are not its identity', async () => {
  const first = openPreferenceReceipt('same-host', 'first-auth'); await first.ready; await first.prepare(receipt());
  const reauthorized = openPreferenceReceipt('same-host', 'other-auth'), other = openPreferenceReceipt('other-host', 'first-auth');
  await Promise.all([reauthorized.ready, other.ready]);
  expect(reauthorized.value()).toBe(null); expect(other.value()).toBe(null);
  const nextPage = openPreferenceReceipt('same-host', 'first-auth'); await nextPage.ready;
  expect(nextPage.value()).toEqual(receipt());
  await Promise.all([first.close(), nextPage.close(), reauthorized.close(), other.close()]);
});

test('handoff failure does not claim transfer or erase the pending receipt; explicit retry persists it', async () => {
  const owner = openPreferenceReceipt('handoff-host', 'auth'); await owner.ready; const input = receipt(); await owner.prepare(input); owner.enterPut(input);
  const before = [...fixture.storage.entries()]; fixture.fail = true;
  await expect(owner.handoff(receipt())).rejects.toThrow('storage failed');
  expect(owner.value()).toEqual(receipt()); expect([...fixture.storage.entries()]).toEqual(before);
  fixture.fail = false; await owner.handoff(receipt());
  const envelope = JSON.parse(JSON.parse([...fixture.storage.values()][0]).draft);
  expect(envelope.handoffs).toBe(1); expect(envelope.receipt).toEqual(receipt()); await owner.close();
});

test('late old confirm/clear/close cannot mutate or retire the next owner', async () => {
  const first = openPreferenceReceipt('owner-host', 'auth'); await first.ready; await first.prepare(receipt());
  const next = openPreferenceReceipt('owner-host', 'auth'); await next.ready;
  const before = [...fixture.storage.entries()];
  await expect(first.confirm(receipt())).rejects.toThrow('retired');
  await expect(first.clear(receipt())).rejects.toThrow('retired');
  await expect(first.handoff(receipt())).rejects.toThrow('retired');
  await first.close();
  expect(next.current()).toBe(true); expect(next.value()).toEqual(receipt()); expect([...fixture.storage.entries()]).toEqual(before);
  await next.handoff(receipt()); await next.close();
});

test('acknowledged-but-not-applied survives reopening; only acknowledged recovery can remove it', async () => {
  const first = openPreferenceReceipt('ack-host', 'auth'); await first.ready; const input = receipt(); await first.prepare(input); first.enterPut(input); await first.confirm(input); await first.close();
  const next = openPreferenceReceipt('ack-host', 'auth'); await next.ready;
  expect(next.value()).toEqual({ ...receipt(), acknowledged: true });
  await next.clear(next.value()!); await next.close();
  const third = openPreferenceReceipt('ack-host', 'auth'); await third.ready; expect(third.value()).toBe(null); await third.close();
});

test('invalid enum, numeric bounds and credential-shaped keys never enter the journal', async () => {
  const owner = openPreferenceReceipt('validation-host', 'auth'); await owner.ready;
  for (const patch of [{ followUpBehavior: 'bogus' }, { fontSize: 201 }, { apiKey: 'synthetic-forbidden' }]) {
    await expect(owner.prepare({ ...receipt(), patch, submitted: {}, edits: {} })).rejects.toThrow();
    expect(fixture.storage.size).toBe(0);
  }
  await owner.close();
});

test('corrupt durable receipt cannot be replaced with an empty success or overwritten', async () => {
  const first = openPreferenceReceipt('corrupt-host', 'auth'); await first.ready; await first.prepare(receipt()); await first.close();
  const [key, raw] = [...fixture.storage.entries()][0], outer = JSON.parse(raw); outer.draft = '{invalid';
  fixture.storage.set(key, JSON.stringify(outer)); const before = fixture.storage.get(key);
  const next = openPreferenceReceipt('corrupt-host', 'auth'); await expect(next.ready).rejects.toThrow();
  await expect(next.prepare(receipt())).rejects.toThrow(); expect(fixture.storage.get(key)).toBe(before); await next.close();
});

test('only the exact preparing owner can cancel its definitely-unsent input after a failed prepare write', async () => {
  const owner = openPreferenceReceipt('unsent-host', 'auth'); await owner.ready; const input = receipt(); fixture.fail = true;
  await expect(owner.prepare(input)).rejects.toThrow('storage failed');
  fixture.fail = false;
  await expect(owner.cancelUnsent(receipt())).rejects.toThrow('not-definitely-unsent');
  await owner.cancelUnsent(input); expect(owner.value()).toBe(null);
  const next = receipt(); await owner.prepare(next);
  await expect(owner.cancelUnsent(input)).rejects.toThrow('not-definitely-unsent');
  owner.enterPut(next);
  await expect(owner.cancelUnsent(next)).rejects.toThrow('not-definitely-unsent');
  expect(owner.value()).toEqual(next); await owner.close();
});

test('cleanup failure cannot hand off a known-unsent attempt; successful cleanup is durable and retryable', async () => {
  const owner = openPreferenceReceipt('unsent-cleanup-host', 'auth'); await owner.ready; const input = receipt(); await owner.prepare(input);
  const before = [...fixture.storage.entries()]; fixture.fail = true;
  await expect(owner.cancelUnsent(input)).rejects.toThrow('storage failed');
  await expect(owner.handoff(input)).rejects.toThrow('unsent');
  expect(owner.value()).toEqual(input); expect([...fixture.storage.entries()]).toEqual(before);
  fixture.fail = false; await owner.cancelUnsent(input); await owner.cancelUnsent(input); expect(owner.value()).toBe(null); await owner.close();
  const restored = openPreferenceReceipt('unsent-cleanup-host', 'auth'); await restored.ready; expect(restored.value()).toBe(null); await restored.close();
});

test('restarted or transferred prepare records have no unsent proof and remain unknown', async () => {
  const first = openPreferenceReceipt('prepared-restart-host', 'auth'); await first.ready; const input = receipt(); await first.prepare(input); await first.close();
  vi.resetModules();
  const next = (await import('./settings-preferences-receipt')).openPreferenceReceipt('prepared-restart-host', 'auth'); await next.ready;
  const before = [...fixture.storage.entries()];
  await expect(next.cancelUnsent(input)).rejects.toThrow('not-definitely-unsent');
  await expect(next.confirm(input)).rejects.toThrow('not-entered');
  expect(() => next.enterPut(input)).toThrow('not-prepared');
  expect(next.value()).toEqual(input); expect([...fixture.storage.entries()]).toEqual(before);
  await next.handoff(input); await next.close();
});

test('old-owner unsent cleanup cannot erase the transferred owner record', async () => {
  const first = openPreferenceReceipt('unsent-old-host', 'auth'); await first.ready; const input = receipt(); await first.prepare(input);
  const next = openPreferenceReceipt('unsent-old-host', 'auth'); await next.ready; const before = [...fixture.storage.entries()];
  await expect(first.cancelUnsent(input)).rejects.toThrow('retired');
  expect(next.value()).toEqual(input); expect([...fixture.storage.entries()]).toEqual(before); await first.close(); await next.close();
});
