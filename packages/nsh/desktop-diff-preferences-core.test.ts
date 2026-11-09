import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDesktopDiffPreferences, DESKTOP_DIFF_PREFERENCES_KEY } from './desktop-diff-preferences-core';
import { settingsPreferenceAvailable, settingsPreferenceFields, settingsPreferencePatch } from './settings-preferences-core';

const raw = (layoutPreference = 'inline', wrapLines = false) => JSON.stringify({ version: 1, layoutPreference, wrapLines });
function fixture(initial: string | null = null, options: Parameters<typeof createDesktopDiffPreferences>[2] = {}) {
  let stored = initial;
  const storage = { getItem: vi.fn(async () => stored), setItem: vi.fn(async (_key: string, value: string) => { stored = value; }) };
  const owner = createDesktopDiffPreferences(storage, () => {}, options);
  return { owner, storage, get: () => stored, external: (value: string | null) => { stored = value; } };
}
it('matches Web defaults, device-global layout/wrap and non-persisted exact path overrides across Host/scope consumers', async () => {
  const f = fixture(); await f.owner.load();
  expect(f.owner.preferences('a.ts')).toEqual({ layoutPreference: 'inline', wrapLines: false });
  f.owner.setFileLayout(['a.ts', '/other/a.ts'], 'side-by-side');
  expect(f.owner.preferences('a.ts')).toMatchObject({ fileLayout: 'side-by-side' });
  await f.owner.save({ layoutPreference: 'dynamic' }); await f.owner.setWrapLines(true);
  expect(f.owner.preferences('/other/a.ts')).toEqual({ layoutPreference: 'dynamic', wrapLines: true, fileLayout: 'side-by-side' });
  expect(f.get()).toBe(raw('dynamic', true)); expect(f.get()).not.toContain('a.ts');
  const cold = fixture(f.get()); await cold.owner.load(); expect(cold.owner.preferences('a.ts')).toEqual({ layoutPreference: 'dynamic', wrapLines: true });
  const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../ui/src/stores/useUIStore.ts'), 'utf8');
  const partialize = source.slice(source.indexOf('partialize:'));
  expect(partialize).toContain('diffLayoutPreference: state.diffLayoutPreference'); expect(partialize).toContain('diffWrapLines: state.diffWrapLines');
  expect(partialize).not.toContain('diffFileLayout: state.diffFileLayout');
});
it('hydrates once and repeated input/read projections do not read or write storage', async () => {
  const f = fixture(); await Promise.all([f.owner.load(), f.owner.load()]);
  for (let index = 0; index < 50; index++) { f.owner.state(); f.owner.preferences('a.ts'); await f.owner.load(); }
  expect(f.storage.getItem).toHaveBeenCalledTimes(1); expect(f.storage.setItem).not.toHaveBeenCalled();
});
it.each(['{}', raw('bogus'), '{broken', JSON.stringify({ version: 1, layoutPreference: 'inline', wrapLines: false, fileLayout: {} }), JSON.stringify({ version: 2, layoutPreference: 'inline', wrapLines: false }), 'null'])('malformed restore preserves prior storage, refuses mutation and supports read-only explicit retry %#', async invalid => {
  const f = fixture(invalid); expect(await f.owner.load()).toBe(false); expect(f.owner.state().error).toBe('malformed');
  expect(f.owner.available()).toBe(false); expect(await f.owner.save({ wrapLines: true })).toBe(false); expect(f.storage.setItem).not.toHaveBeenCalled();
  expect(f.get()).toBe(invalid); f.external(raw('side-by-side')); expect(await f.owner.retry()).toBe(true); expect(f.owner.preferences()).toMatchObject({ layoutPreference: 'side-by-side' });
});
it('failed restore is not authoritative empty and only explicit retry re-reads', async () => {
  const f = fixture(raw('dynamic')); f.storage.getItem.mockRejectedValueOnce(new Error('read'));
  expect(await f.owner.load()).toBe(false); expect(f.owner.state().error).toBe('read'); expect(await f.owner.flush()).toBe(false);
  expect(await f.owner.retry()).toBe(true); expect(f.owner.preferences()?.layoutPreference).toBe('dynamic');
});
it('capacity refusal is atomic and never LRU-evicts a previously used path or loses a batch prefix', async () => {
  const f = fixture(null, { fileLimit: 2, pathUnitsLimit: 16 }); await f.owner.load();
  expect(f.owner.setFileLayout(['a.ts'], 'inline')).toBe(true);
  expect(f.owner.setFileLayout(['b.ts', 'c.ts'], 'side-by-side')).toBe(false);
  expect(f.owner.fileCount()).toBe(1); expect(f.owner.preferences('a.ts')?.fileLayout).toBe('inline'); expect(f.owner.preferences('b.ts')?.fileLayout).toBeUndefined();
  expect(await f.owner.retry()).toBe(true); expect(f.owner.setFileLayout(['a.ts'], 'side-by-side')).toBe(true);
  expect(f.storage.setItem).not.toHaveBeenCalled();
});
it('coalesces accepted later writes and flush waits for the latest revision; close cannot approve early', async () => {
  const f = fixture(); await f.owner.load();
  let release!: () => void;
  f.storage.setItem.mockImplementationOnce(async (_key, value) => { await new Promise<void>(done => { release = done; }); f.external(value); });
  const first = f.owner.save({ layoutPreference: 'side-by-side' }); await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  const later = f.owner.setWrapLines(true); const flush = f.owner.flush(); expect(f.owner.canClose()).toBe(false);
  expect(f.owner.preferences()).toEqual({ layoutPreference: 'inline', wrapLines: false }); release();
  expect(await first).toBe(true); expect(await later).toBe(true); expect(await flush).toBe(true);
  expect(f.get()).toBe(raw('side-by-side', true)); expect(f.owner.canClose()).toBe(true);
});
it('lost ACK is reconciled only by readback, not replay; a prior value never clears an unknown write', async () => {
  const f = fixture(); await f.owner.load();
  f.storage.setItem.mockImplementationOnce(async (_key, value) => { f.external(value); throw new Error('lost ACK'); });
  expect(await f.owner.setWrapLines(true)).toBe(true); expect(f.storage.setItem).toHaveBeenCalledTimes(1);
  f.storage.setItem.mockRejectedValueOnce(new Error('unconfirmed'));
  expect(await f.owner.save({ layoutPreference: 'dynamic' })).toBe(false); expect(f.owner.state()).toMatchObject({ error: 'unknown', pending: true, value: { layoutPreference: 'inline', wrapLines: true } });
  const before = f.storage.setItem.mock.calls.length;
  expect(await f.owner.retry()).toBe(false); expect(await f.owner.flush()).toBe(false); expect(f.storage.setItem).toHaveBeenCalledTimes(before); expect(f.owner.canClose()).toBe(false);
  f.external(raw('dynamic', true)); expect(await f.owner.reconcile()).toBe(true); expect(f.storage.setItem).toHaveBeenCalledTimes(before); expect(f.owner.canClose()).toBe(true);
});
it('late failed verification retains the confirmed value/draft and permits no automatic reads or repeated writes', async () => {
  const f = fixture(); await f.owner.load();
  f.storage.setItem.mockImplementationOnce(async () => { f.storage.getItem.mockRejectedValueOnce(new Error('offline')); throw new Error('unknown'); });
  expect(await f.owner.setWrapLines(true)).toBe(false); const reads = f.storage.getItem.mock.calls.length;
  for (let index = 0; index < 50; index++) { f.owner.preferences('a.ts'); f.owner.state(); }
  expect(f.storage.getItem).toHaveBeenCalledTimes(reads); expect(f.owner.dispose()).toBe(false);
});
it('only the actual NSH quota negative receipt allows explicit write retry; refusal never clears the candidate or claims success', async () => {
  const f = fixture(); await f.owner.load();
  f.storage.setItem.mockRejectedValueOnce(Object.assign(new Error('quota'), { code: 'ERR_NSH_QUOTA_EXCEEDED' }));
  expect(await f.owner.setWrapLines(true)).toBe(false); expect(f.owner.state()).toMatchObject({ pending: true, error: 'capacity', value: { wrapLines: false } });
  expect(f.owner.canClose()).toBe(false); expect(f.get()).toBeNull(); expect(await f.owner.retry()).toBe(true);
  expect(f.storage.setItem).toHaveBeenCalledTimes(2); expect(f.owner.preferences()?.wrapLines).toBe(true);
});
it('preflight failure is safe to retry explicitly; foreign writers and invalid patches never overwrite anything', async () => {
  const f = fixture(); await f.owner.load(); f.storage.getItem.mockRejectedValueOnce(new Error('offline'));
  expect(await f.owner.setWrapLines(true)).toBe(false); expect(f.storage.setItem).not.toHaveBeenCalled(); expect(await f.owner.retry()).toBe(true);
  f.external(raw('side-by-side')); expect(await f.owner.save({ layoutPreference: 'dynamic' })).toBe(false); expect(f.owner.state().error).toBe('conflict'); expect(await f.owner.retry()).toBe(false);
  expect(f.get()).toBe(raw('side-by-side')); expect(f.storage.setItem).toHaveBeenCalledTimes(1);
  expect(await f.owner.save({ fake: true } as never)).toBe(false);
});
it('multi-Engine mode is explicitly unsupported and performs zero Storage IO without native coordination', async () => {
  const f = fixture(null, { coordination: 'multi-engine' }); expect(await f.owner.load()).toBe(false);
  expect(f.owner.state().error).toBe('unsupported'); expect(await f.owner.setWrapLines(true)).toBe(false); expect(f.owner.setFileLayout(['a.ts'], 'inline')).toBe(false);
  expect(f.storage.getItem).not.toHaveBeenCalled(); expect(f.storage.setItem).not.toHaveBeenCalled(); expect(f.owner.canClose()).toBe(true);
  expect(await f.owner.flush()).toBe(true); expect(f.owner.state().error).toBe('unsupported');
  expect(() => fixture(null, { coordination: 'unverified' as never })).toThrow('diff_preferences_coordination');
});
it('Settings reuses the existing diff-layout entry, only enables the actual desktop owner, and excludes local fields from Host PUT', () => {
  expect(settingsPreferenceFields.find(field => field.key === 'diffLayoutPreference')).toMatchObject({ id: 'chat.diff-layout', local: true, consumer: 'device-local' });
  for (const os of ['macos', 'windows', 'linux', 'ios', 'android']) {
    expect(settingsPreferenceAvailable('diffLayoutPreference', os)).toBe(false);
    expect(settingsPreferenceAvailable('diffLayoutPreference', os, false, true)).toBe(['macos', 'windows', 'linux'].includes(os));
  }
  expect(() => settingsPreferencePatch({ diffLayoutPreference: 'side-by-side' })).toThrow('No Host preference contract');
  expect(DESKTOP_DIFF_PREFERENCES_KEY).toBe('desktop.diff-preferences.v1');
});
