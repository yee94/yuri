import { expect, it, vi } from 'vitest';

const disk = vi.hoisted(() => ({ values: new Map<string, string>(), get: vi.fn(), set: vi.fn() }));
vi.mock('nsh', () => ({ Storage: {
  getItem: disk.get.mockImplementation(async (key: string) => disk.values.get(key) ?? null),
  setItem: disk.set.mockImplementation(async (key: string, value: string) => { disk.values.set(key, value); }),
} }));
import { localCompatibilityPreferences } from './local-compatibility-preferences';

it('production adapter uses NSH Storage for both injectable owners without starting a root or invoking Host APIs', async () => {
  const scope = { hostID: 'connection', lease: 'lease' }, changes = vi.fn();
  const brand = localCompatibilityPreferences.openSidebarBrand({ transportID: 'opaque-route', expectedHost: scope,
    current: () => true, currentHost: () => scope, currentTransportID: () => 'opaque-route' }, changes);
  const flag = localCompatibilityPreferences.openIosNativeUi({ current: () => true, changed: changes });
  await brand.save({ sidebarBrandName: '  ' }); await flag.save({ iosNativeUiEnabled: true });
  brand.dispose(); flag.dispose();
  const reopened = localCompatibilityPreferences.openIosNativeUi({ current: () => true, changed: changes });
  expect(await reopened.load()).toEqual({ iosNativeUiEnabled: true });
  expect(disk.get).toHaveBeenCalledTimes(3); expect(disk.set).toHaveBeenCalledTimes(2);
  expect([...disk.values.values()].map(raw => JSON.parse(raw))).toEqual([{ sidebarBrandName: '  ' }, { iosNativeUiEnabled: true }]);
  reopened.dispose();
});
