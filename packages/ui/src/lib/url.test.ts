import { afterEach, expect, test, vi } from 'vitest';

const native = vi.hoisted(() => ({
  platform: 'android',
  available: true,
  open: vi.fn(async () => undefined),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: () => native.platform,
    isNativePlatform: () => native.platform !== 'web',
    isPluginAvailable: () => native.available,
  },
  registerPlugin: () => ({ open: native.open }),
}));

import { openExternalUrl } from './url';
import { useMobileHtmlPreviewStore } from '@/mobile/useMobileHtmlPreviewStore';

afterEach(() => {
  vi.restoreAllMocks();
  native.open.mockReset();
  native.platform = 'android';
  native.available = true;
  useMobileHtmlPreviewStore.getState().close();
});

test('Android hands external links to the native system browser', async () => {
  const popup = vi.spyOn(window, 'open');
  expect(await openExternalUrl(' https://example.com/actions ')).toBe(true);
  expect(native.open).toHaveBeenCalledWith({ url: 'https://example.com/actions' });
  expect(popup).not.toHaveBeenCalled();
});

test('native browser failure is not reported as successful window.open', async () => {
  const popup = vi.spyOn(window, 'open');
  native.open.mockRejectedValueOnce(new Error('unavailable'));
  expect(await openExternalUrl('https://example.com')).toBe(false);
  native.available = false;
  expect(await openExternalUrl('https://example.com')).toBe(false);
  expect(popup).not.toHaveBeenCalled();
});

test('rejects non-http links before calling native code', async () => {
  expect(await openExternalUrl('javascript:alert(1)')).toBe(false);
  expect(native.open).not.toHaveBeenCalled();
});

test.each(['web', 'ios'])('%s keeps the window browser handoff', async (platform) => {
  native.platform = platform;
  const popup = vi.spyOn(window, 'open').mockReturnValue(null);
  expect(await openExternalUrl('https://example.com')).toBe(true);
  expect(popup).toHaveBeenCalledWith('https://example.com/', '_blank', 'noopener,noreferrer');
  expect(native.open).not.toHaveBeenCalled();
});

test.each(['http://localhost:3000/page?x=1#top', 'http://127.0.0.1:3000/', 'http://[::1]:3000/', 'localhost:3000'])('native local link %s opens the in-app Relay preview', async url => {
  const popup = vi.spyOn(window, 'open');
  expect(await openExternalUrl(url)).toBe(true);
  expect(useMobileHtmlPreviewStore.getState().target?.url).toBe(url === 'localhost:3000' ? 'http://localhost:3000/' : url);
  expect(native.open).not.toHaveBeenCalled();
  expect(popup).not.toHaveBeenCalled();
});
