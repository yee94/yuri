import { afterEach, expect, test, vi } from 'vitest';
import { useOpenInAppsStore } from './useOpenInAppsStore';

const io = vi.hoisted(() => ({ fetch: vi.fn(), update: vi.fn() }));
vi.mock('@/lib/brand-storage-bootstrap', () => ({}));
vi.mock('@/lib/desktop', () => ({
  isDesktopShell: () => true,
  fetchDesktopInstalledApps: io.fetch,
}));
vi.mock('@/lib/persistence', () => ({ updateDesktopSettings: io.update }));

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  delete window.__YURI_PLATFORM__;
});

test('initial scan, update events and explicit refresh preserve terminal ID with dynamic name/icon', async () => {
  vi.useFakeTimers();
  io.fetch.mockResolvedValue({
    apps: [{ name: 'Terminal', appName: '/Applications/Warp.app', label: 'Warp', iconDataUrl: 'warp-icon' }],
    success: true, hasCache: true, isCacheStale: false,
  });
  useOpenInAppsStore.getState().initialize();
  await vi.advanceTimersByTimeAsync(0);
  expect(useOpenInAppsStore.getState().availableApps.find((app) => app.id === 'terminal')).toEqual({
    id: 'terminal', appName: '/Applications/Warp.app', label: 'Warp', iconDataUrl: 'warp-icon',
  });
  await useOpenInAppsStore.getState().selectApp('terminal');
  expect(io.update).toHaveBeenCalledWith({ openInAppId: 'terminal' });
  expect(window.localStorage.getItem('openInAppId')).toBe('terminal');
  window.dispatchEvent(new CustomEvent('yuri:installed-apps-updated', {
    detail: [{ name: 'Terminal', appName: '/Applications/Ghostty.app', label: 'Ghostty', iconDataUrl: 'ghostty-icon' }],
  }));
  expect(useOpenInAppsStore.getState().availableApps.find((app) => app.id === 'terminal')).toMatchObject({
    label: 'Ghostty', iconDataUrl: 'ghostty-icon',
  });
  await useOpenInAppsStore.getState().loadInstalledApps(true);
  expect(useOpenInAppsStore.getState().selectedAppId).toBe('terminal');
  expect(useOpenInAppsStore.getState().availableApps.find((app) => app.id === 'terminal')?.label).toBe('Warp');
});

test('legacy shell responses and Windows keep platform defaults', async () => {
  window.__YURI_PLATFORM__ = 'win32';
  io.fetch.mockResolvedValue({
    apps: [{ name: 'Terminal', iconDataUrl: 'windows-icon' }],
    success: true, hasCache: true, isCacheStale: false,
  });
  await useOpenInAppsStore.getState().loadInstalledApps(true);
  const apps = useOpenInAppsStore.getState().availableApps;
  expect(apps.find((app) => app.id === 'terminal')).toMatchObject({ appName: 'Terminal', label: 'Terminal' });
  expect(apps.find((app) => app.id === 'finder')?.label).toBe('Explorer');
});
