import { beforeEach, expect, test, vi } from 'vitest';
import { instanceScopedStorageKey } from '@/lib/instanceScopedStorage';
import { useSetupTourStore } from './useSetupTourStore';

const runtime = vi.hoisted(() => ({ key: 'tour-host-a', listener: (() => {}) as (detail: unknown) => void }));
vi.mock('@/lib/runtime-switch', () => ({
  getRuntimeKey: () => runtime.key,
  getRuntimeApiBaseUrl: () => '',
  isRuntimeInstanceChange: () => true,
  subscribeRuntimeEndpointChanged: (listener: (detail: unknown) => void) => { runtime.listener = listener; return () => {}; },
}));
vi.mock('@/lib/desktop', () => ({ isDesktopShell: () => false, isDesktopLocalOriginActive: () => false }));

beforeEach(() => {
  localStorage.clear();
  runtime.key = 'tour-host-a';
  useSetupTourStore.setState({ progress: {}, openedRuntime: null });
});

test('closing preserves progress, does not reopen automatically after hydration, and can be resumed explicitly', async () => {
  const store = useSetupTourStore.getState();
  store.open(runtime.key);
  expect(useSetupTourStore.getState().progress[runtime.key]).toEqual({ step: 0, dismissed: false });
  store.move(runtime.key, 1);
  store.dismiss(runtime.key);
  await useSetupTourStore.persist.rehydrate();
  expect(useSetupTourStore.getState().openedRuntime).toBeNull();
  expect(useSetupTourStore.getState().progress[runtime.key]).toEqual({ step: 1, dismissed: true });
  store.open(runtime.key);
  expect(useSetupTourStore.getState().openedRuntime).toBe(runtime.key);
  expect(useSetupTourStore.getState().progress[runtime.key].step).toBe(1);
});

test('paired hosts have independent storage and transient open state', async () => {
  useSetupTourStore.getState().open(runtime.key);
  useSetupTourStore.getState().move(runtime.key, 2);
  useSetupTourStore.getState().dismiss(runtime.key);
  runtime.key = 'tour-host-b'; runtime.listener({});
  expect(useSetupTourStore.getState().progress).toEqual({});
  expect(useSetupTourStore.getState().openedRuntime).toBeNull();
  useSetupTourStore.getState().open(runtime.key);
  runtime.key = 'tour-host-a'; runtime.listener({});
  expect(useSetupTourStore.getState().progress[runtime.key]).toEqual({ step: 2, dismissed: true });
});

test('malformed saved records cannot suppress or misposition the tour', async () => {
  localStorage.setItem(instanceScopedStorageKey('yuri-setup-tour', runtime.key), JSON.stringify({ state: { progress: {
    [runtime.key]: { step: 99, dismissed: true }, other: { step: 1, dismissed: 'yes' },
  } }, version: 0 }));
  await useSetupTourStore.persist.rehydrate();
  expect(useSetupTourStore.getState().progress).toEqual({});
});

test('old persisted voice progress moves from step three to four without clearing dismissal', async () => {
  localStorage.setItem(instanceScopedStorageKey('yuri-setup-tour', runtime.key), JSON.stringify({ state: { progress: {
    [runtime.key]: { step: 2, dismissed: true },
  } }, version: 0 }));
  await useSetupTourStore.persist.rehydrate();
  expect(useSetupTourStore.getState().progress[runtime.key]).toEqual({ step: 3, dismissed: true });
  useSetupTourStore.getState().move(runtime.key, 2);
  await useSetupTourStore.persist.rehydrate();
  expect(useSetupTourStore.getState().progress[runtime.key].step).toBe(2);
});
