import { beforeEach, expect, test, vi } from 'vitest';
const storage = vi.hoisted(() => new Map<string, string>());
vi.mock('nsh', () => ({ Storage: { getItem: vi.fn(async (key: string) => storage.get(key) ?? null), setItem: vi.fn(async (key: string, value: string) => { storage.set(key, value); }) } }));
import { Storage } from 'nsh';
import { openModelVariantMemory, rememberedModelVariant, variantMemoryUpdate } from './model-variant-memory';

beforeEach(() => { storage.clear(); vi.clearAllMocks(); });
const ref = { providerID: 'p', modelID: 'm', variant: 'high' };
test('round-trips by Host/directory/session/Agent/model; Default deletes only that preference', async () => {
  const scope = { hostID: 'host', directory: '/project', sessionID: 'session' };
  const memory = openModelVariantMemory(scope);
  await memory.save('build', ref, () => true); await memory.save('plan', { ...ref, variant: 'low' }, () => true);
  expect(rememberedModelVariant(await openModelVariantMemory(scope).read(), 'build', ref)).toBe('high');
  expect(await openModelVariantMemory({ ...scope, hostID: 'other' }).read()).toEqual({});
  expect(await openModelVariantMemory({ ...scope, directory: '/other' }).read()).toEqual({});
  expect(await openModelVariantMemory({ ...scope, sessionID: 'other' }).read()).toEqual({});
  await memory.save('build', { ...ref, variant: undefined }, () => true);
  expect(rememberedModelVariant(await memory.read(), 'build', ref)).toBeUndefined();
  expect(rememberedModelVariant(await memory.read(), 'plan', ref)).toBe('low');
});
test('concurrent writers merge latest storage; stale Host completion cannot write', async () => {
  const scope = { hostID: 'host', directory: '/project', sessionID: 'session' };
  const memory = openModelVariantMemory(scope);
  await Promise.all([memory.save('build', ref, () => true), memory.save('plan', ref, () => true)]);
  expect(Object.keys(await memory.read())).toEqual(['build', 'plan']);
  await memory.save('stale', ref, () => false);
  expect(Object.keys(await memory.read())).toEqual(['build', 'plan']);
});
test('failed storage writes preserve prior preferences and can retry without selection writes', async () => {
  const memory = openModelVariantMemory({ hostID: 'host', directory: '/project', sessionID: 'session' });
  await memory.save('build', ref, () => true);
  vi.mocked(Storage.setItem).mockRejectedValueOnce(new Error('disk-failed'));
  await expect(memory.save('build', { ...ref, variant: undefined }, () => true)).rejects.toThrow('disk-failed');
  expect(rememberedModelVariant(await memory.read(), 'build', ref)).toBe('high');
  await memory.save('build', { ...ref, variant: undefined }, () => true);
  expect(await memory.read()).toEqual({});
});
test('MRU persistence retains at most 150 sessions and moves the updated session last', () => {
  const rows = variantMemoryUpdate(Array.from({ length: 160 }, (_, index) => ({ session: String(index), agents: {} })), '20', 'build', ref);
  expect(rows).toHaveLength(150); expect(rows.at(-1)?.session).toBe('20');
});
