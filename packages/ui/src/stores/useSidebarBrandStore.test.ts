import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SIDEBAR_BRAND_NAME,
  useSidebarBrandStore,
} from '@/stores/useSidebarBrandStore';
import { switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { instanceScopedStorageKey } from '@/lib/instanceScopedStorage';
import { runtimeScopedStorageKey } from '@/lib/runtimeScopedStorage';
import type { DesktopSettings } from '@/lib/desktop';

const mocks = vi.hoisted(() => ({
  updateDesktopSettings: vi.fn(async (_changes: Partial<DesktopSettings>) => {}),
  isVSCode: false,
}));

vi.mock('@/lib/persistence', () => ({
  updateDesktopSettings: (changes: Partial<DesktopSettings>) => mocks.updateDesktopSettings(changes),
}));

vi.mock('@/contexts/runtimeAPIRegistry', () => ({
  getRegisteredRuntimeAPIs: () => ({ runtime: { isVSCode: mocks.isVSCode } }),
}));

const relayDescriptor = {
  relayUrl: 'wss://relay.example/ws',
  serverId: 'srv-ssh-dev',
  hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'abc', y: 'def' },
};

const simulateAppRestartAt = async (endpoint: Parameters<typeof switchRuntimeEndpoint>[0]) => {
  const snapshot = new Map<string, string>();
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (key !== null) snapshot.set(key, localStorage.getItem(key)!);
  }
  switchRuntimeEndpoint(endpoint);
  useSidebarBrandStore.setState({ sidebarBrandName: DEFAULT_SIDEBAR_BRAND_NAME });
  localStorage.clear();
  for (const [key, value] of snapshot) localStorage.setItem(key, value);
  await useSidebarBrandStore.persist.rehydrate();
};

describe('useSidebarBrandStore persistence across SSH restarts and transport changes', () => {
  beforeEach(() => {
    localStorage.clear();
    mocks.updateDesktopSettings.mockReset();
    mocks.updateDesktopSettings.mockImplementation(async () => {});
    mocks.isVSCode = false;
    switchRuntimeEndpoint({
      apiBaseUrl: 'http://127.0.0.1:57123',
      runtimeKey: 'local',
    });
    useSidebarBrandStore.setState({ sidebarBrandName: DEFAULT_SIDEBAR_BRAND_NAME });
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('retains SSH host sidebar brand when the local forwarded port changes on restart/update', async () => {
    switchRuntimeEndpoint({
      apiBaseUrl: 'http://127.0.0.1:54321',
      runtimeKey: 'host:ssh-dev',
    });
    useSidebarBrandStore.getState().setSidebarBrandName('开发机!');
    expect(useSidebarBrandStore.getState().sidebarBrandName).toBe('开发机!');

    // Simulate Electron restart / update where SSH allocates a different local forwarded port
    // for the same saved SSH host id.
    await simulateAppRestartAt({
      apiBaseUrl: 'http://127.0.0.1:58901',
      runtimeKey: 'host:ssh-dev',
    });

    expect(useSidebarBrandStore.getState().sidebarBrandName).toBe('开发机!');
  });

  it('retains SSH host sidebar brand across direct SSH tunnel and Relay transport switches', async () => {
    switchRuntimeEndpoint({
      apiBaseUrl: 'http://127.0.0.1:54321',
      runtimeKey: 'host:ssh-dev',
    });
    useSidebarBrandStore.getState().setSidebarBrandName('开发机!');

    // Reconnect same SSH host over Relay
    await simulateAppRestartAt({
      apiBaseUrl: 'http://127.0.0.1:57123',
      runtimeKey: 'host:ssh-dev',
      relay: relayDescriptor,
    });

    expect(useSidebarBrandStore.getState().sidebarBrandName).toBe('开发机!');
  });

  it('migrates an existing transport-scoped brand entry to instance-scoped storage on upgrade', async () => {
    switchRuntimeEndpoint({
      apiBaseUrl: 'http://127.0.0.1:54321',
      runtimeKey: 'host:ssh-dev',
    });
    const legacyTransportKey = runtimeScopedStorageKey('sidebar-brand-store');
    localStorage.setItem(
      legacyTransportKey,
      JSON.stringify({ state: { sidebarBrandName: '开发机!' }, version: 3 }),
    );

    await simulateAppRestartAt({
      apiBaseUrl: 'http://127.0.0.1:54321',
      runtimeKey: 'host:ssh-dev',
    });
    expect(useSidebarBrandStore.getState().sidebarBrandName).toBe('开发机!');

    // Once migrated to the instance bucket, a later SSH port change still keeps it.
    expect(localStorage.getItem(instanceScopedStorageKey('sidebar-brand-store', 'host:ssh-dev'))).not.toBeNull();
    await simulateAppRestartAt({
      apiBaseUrl: 'http://127.0.0.1:59999',
      runtimeKey: 'host:ssh-dev',
    });
    expect(useSidebarBrandStore.getState().sidebarBrandName).toBe('开发机!');
  });

  it('persists sidebar brand to host settings and restores it from yuri:settings-synced on a clean profile', async () => {
    switchRuntimeEndpoint({
      apiBaseUrl: 'http://127.0.0.1:54321',
      runtimeKey: 'host:ssh-dev',
    });
    useSidebarBrandStore.getState().setSidebarBrandName('开发机!');
    expect(mocks.updateDesktopSettings).toHaveBeenCalledWith({ sidebarBrandName: '开发机!' });
    await Promise.resolve();

    // Simulate clean Electron profile / cache wipe connecting to the same host.
    localStorage.clear();
    useSidebarBrandStore.setState({ sidebarBrandName: DEFAULT_SIDEBAR_BRAND_NAME });
    localStorage.clear();
    window.dispatchEvent(new CustomEvent<DesktopSettings>('yuri:settings-synced', {
      detail: { sidebarBrandName: '开发机!' },
    }));
    expect(useSidebarBrandStore.getState().sidebarBrandName).toBe('开发机!');

    // Explicit empty string hides logo and must not revert to default.
    window.dispatchEvent(new CustomEvent<DesktopSettings>('yuri:settings-synced', {
      detail: { sidebarBrandName: '' },
    }));
    expect(useSidebarBrandStore.getState().sidebarBrandName).toBe('');
  });

  it('preserves local brand when an older remote server omits sidebarBrandName and backfills once', async () => {
    switchRuntimeEndpoint({
      apiBaseUrl: 'http://127.0.0.1:54321',
      runtimeKey: 'host:ssh-older',
    });
    useSidebarBrandStore.getState().setSidebarBrandName('开发机!');
    await Promise.resolve();
    mocks.updateDesktopSettings.mockClear();

    window.dispatchEvent(new CustomEvent<DesktopSettings>('yuri:settings-synced', {
      detail: { themeId: 'dark' },
    }));
    expect(useSidebarBrandStore.getState().sidebarBrandName).toBe('开发机!');
    expect(mocks.updateDesktopSettings).toHaveBeenCalledTimes(1);
    expect(mocks.updateDesktopSettings).toHaveBeenCalledWith({ sidebarBrandName: '开发机!' });

    // Second sync without sidebarBrandName does not spam repeated PUTs.
    window.dispatchEvent(new CustomEvent<DesktopSettings>('yuri:settings-synced', {
      detail: { themeId: 'dark' },
    }));
    expect(mocks.updateDesktopSettings).toHaveBeenCalledTimes(1);
  });

  it('does not clobber newer keystrokes when an earlier settings save resolves', async () => {
    switchRuntimeEndpoint({
      apiBaseUrl: 'http://127.0.0.1:54321',
      runtimeKey: 'host:ssh-dev',
    });
    let resolveFirst!: () => void;
    let resolveSecond!: () => void;
    mocks.updateDesktopSettings
      .mockImplementationOnce(() => new Promise<void>((resolve) => { resolveFirst = resolve; }))
      .mockImplementationOnce(() => new Promise<void>((resolve) => { resolveSecond = resolve; }));

    useSidebarBrandStore.getState().setSidebarBrandName('开发');
    useSidebarBrandStore.getState().setSidebarBrandName('开发机!');

    // Stale first PUT finishes and dispatches yuri:settings-synced with the older text.
    window.dispatchEvent(new CustomEvent<DesktopSettings>('yuri:settings-synced', {
      detail: { sidebarBrandName: '开发' },
    }));
    resolveFirst();
    await Promise.resolve();
    expect(useSidebarBrandStore.getState().sidebarBrandName).toBe('开发机!');

    // Second PUT finishes with latest text.
    window.dispatchEvent(new CustomEvent<DesktopSettings>('yuri:settings-synced', {
      detail: { sidebarBrandName: '开发机!' },
    }));
    resolveSecond();
    await Promise.resolve();
    expect(useSidebarBrandStore.getState().sidebarBrandName).toBe('开发机!');
  });

  it('resets to default on in-window host switch when the target host has no saved brand without polluting its storage', async () => {
    switchRuntimeEndpoint({
      apiBaseUrl: 'http://127.0.0.1:54321',
      runtimeKey: 'host:ssh-dev',
    });
    useSidebarBrandStore.getState().setSidebarBrandName('开发机!');

    // Switch to another host with no saved brand: must not leak '开发机!'.
    switchRuntimeEndpoint({
      apiBaseUrl: 'http://127.0.0.1:55555',
      runtimeKey: 'host:other-ssh',
    });
    await Promise.resolve();
    expect(useSidebarBrandStore.getState().sidebarBrandName).toBe(DEFAULT_SIDEBAR_BRAND_NAME);
    expect(localStorage.getItem(instanceScopedStorageKey('sidebar-brand-store', 'host:other-ssh'))).toBeNull();

    // Switch back to ssh-dev on a new forwarded port: restores '开发机!'.
    switchRuntimeEndpoint({
      apiBaseUrl: 'http://127.0.0.1:58901',
      runtimeKey: 'host:ssh-dev',
    });
    await Promise.resolve();
    expect(useSidebarBrandStore.getState().sidebarBrandName).toBe('开发机!');
  });
});
