import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MobileHtmlPreviewSheet } from './MobileHtmlPreviewSheet';
import { useMobileHtmlPreviewStore } from './useMobileHtmlPreviewStore';
import { openExternalUrl } from '@/lib/url';

const fixture = vi.hoisted(() => ({ generation: 1, changed: () => {}, renewed: () => {}, resolve: vi.fn(), release: vi.fn(), unsubscribe: vi.fn() }));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true }, registerPlugin: () => ({}) }));
vi.mock('@/lib/runtime-switch', () => ({
  getRuntimeGeneration: () => fixture.generation,
  subscribeRuntimeEndpointChanged: (notify: () => void) => { fixture.changed = notify; return () => {}; },
}));
vi.mock('@/lib/runtime-auth', () => ({
  acquireRuntimeUrlAuthToken: () => fixture.release,
  subscribeRuntimeUrlAuthToken: (notify: () => void) => { fixture.renewed = notify; return fixture.unsubscribe; },
}));
vi.mock('@/lib/preview/mobile-html-source', () => ({ resolveMobileHtmlUrl: fixture.resolve }));
vi.mock('@/components/preview/MobileHtmlNetworkBoundary', () => ({ MobileHtmlNetworkBoundary: ({ children }: { children: (network: { hostOrigin: string }) => React.ReactNode }) => children({ hostOrigin: 'http://localhost:4000' }) }));
vi.mock('@/components/ui/MobileResizableSheet', () => ({ MobileResizableSheet: ({ open, children }: { open: boolean; children: React.ReactNode }) => open ? children : null }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  fixture.generation = 1;
  fixture.resolve.mockReset().mockResolvedValue({ src: 'about:blank', expiresAt: Date.now() + 60_000 });
  fixture.release.mockReset(); fixture.unsubscribe.mockReset();
  useMobileHtmlPreviewStore.getState().close();
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); });
const open = async () => { await act(async () => { root.render(<MobileHtmlPreviewSheet />); await openExternalUrl('localhost:3000'); }); };

it('routes a native local link into the HTML sheet and renews credentials while mounted', async () => {
  await open();
  expect(fixture.resolve).toHaveBeenCalledWith('http://localhost:3000/', 'http://localhost:4000', expect.any(AbortSignal));
  const frame = container.querySelector('iframe'); expect(frame).not.toBeNull();
  for (let i = 0; i < 50; i++) await act(async () => root.render(<MobileHtmlPreviewSheet />));
  expect(fixture.resolve).toHaveBeenCalledOnce(); expect(container.querySelector('iframe')).toBe(frame);
  await act(async () => fixture.renewed());
  expect(fixture.resolve).toHaveBeenCalledTimes(2);
  await act(async () => useMobileHtmlPreviewStore.getState().close());
  expect(container.querySelector('iframe')).toBeNull();
  expect(fixture.release).toHaveBeenCalledOnce(); expect(fixture.unsubscribe).toHaveBeenCalledOnce();
});

it('renews an expiring target and exposes retry after failed registration', async () => {
  vi.useFakeTimers();
  await open();
  fixture.resolve.mockRejectedValueOnce(new Error('offline'));
  await act(async () => vi.advanceTimersByTimeAsync(50_000));
  expect(container.querySelector('iframe')).toBeNull();
  const retry = container.querySelector('button'); expect(retry).not.toBeNull();
  await act(async () => retry!.click());
  expect(container.querySelector('iframe')).not.toBeNull();
  expect(fixture.resolve).toHaveBeenCalledTimes(3);
});

it('does not expose a late preview in the next runtime', async () => {
  let finish!: (source: { src: string }) => void;
  fixture.resolve.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await open();
  const signal = fixture.resolve.mock.calls[0][2] as AbortSignal;
  await act(async () => { fixture.generation++; fixture.changed(); });
  expect(signal.aborted).toBe(true);
  await act(async () => finish({ src: 'about:blank' }));
  expect(container.querySelector('iframe')).toBeNull();
});

it('accepts navigation only from the currently mounted Host preview frame', async () => {
  await open();
  const source = container.querySelector('iframe')!.contentWindow;
  const data = { source: 'yuri-preview-bridge', version: 1, type: 'navigate-preview', url: 'http://localhost:3001/next' };
  await act(async () => window.dispatchEvent(new MessageEvent('message', { source, origin: 'https://untrusted.example', data })));
  expect(fixture.resolve).toHaveBeenCalledOnce();
  await act(async () => window.dispatchEvent(new MessageEvent('message', { origin: 'null', data })));
  expect(fixture.resolve).toHaveBeenCalledOnce();
  await act(async () => window.dispatchEvent(new MessageEvent('message', { source, origin: 'null', data })));
  expect(fixture.resolve).toHaveBeenLastCalledWith(data.url, 'http://localhost:4000', expect.any(AbortSignal));
});
