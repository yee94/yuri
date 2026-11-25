import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MobileHtmlPreviewSheet } from './MobileHtmlPreviewSheet';
import { useMobileHtmlPreviewStore } from './useMobileHtmlPreviewStore';
import { openExternalUrl } from '@/lib/url';
import type { HostRuntimeEntry, HostRuntimeRegistry } from '@/lib/remote-projects/registry';

const fixture = vi.hoisted(() => ({ generation: 1, changed: () => {}, renewed: () => {}, urlToken: 'yuri_url_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', resolve: vi.fn(), extend: vi.fn(), release: vi.fn(), unsubscribe: vi.fn(), host: undefined as { entry: HostRuntimeEntry } | undefined, registry: undefined as HostRuntimeRegistry | undefined }));
vi.mock('@/contexts/HostRuntimeProvider', () => ({ useHostRuntime: () => fixture.host }));
vi.mock('@/queries/remoteProjectQueries', () => ({ useRemoteProjectRuntime: () => ({ registry: fixture.registry, error: null }) }));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true }, registerPlugin: () => ({}) }));
vi.mock('@/lib/runtime-switch', () => ({
  getRuntimeGeneration: () => fixture.generation,
  subscribeRuntimeEndpointChanged: (notify: () => void) => { fixture.changed = notify; return () => {}; },
}));
vi.mock('@/lib/runtime-auth', () => ({
  acquireRuntimeUrlAuthToken: () => fixture.release,
  getRuntimeUrlAuthTokenSync: () => fixture.urlToken,
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
  const settings = (window as unknown as { happyDOM?: { settings?: { disableIframePageLoading?: boolean } } }).happyDOM?.settings;
  if (settings) settings.disableIframePageLoading = true;
  fixture.generation = 1;
  fixture.urlToken = 'yuri_url_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  fixture.host = undefined; fixture.registry = undefined;
  fixture.extend.mockReset().mockImplementation(async () => Date.now() + 60_000);
  fixture.resolve.mockReset().mockResolvedValue({
    src: 'http://localhost:4000/api/preview/proxy/0123456789abcdef/?yuri_preview_token=preview&yuri_url_token=yuri_url_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    expiresAt: Date.now() + 60_000,
    extend: fixture.extend,
  });
  fixture.release.mockReset(); fixture.unsubscribe.mockReset();
  useMobileHtmlPreviewStore.getState().close();
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); });
const open = async () => { await act(async () => { root.render(<MobileHtmlPreviewSheet />); await openExternalUrl('localhost:3000'); }); };

it('routes a native local link into the HTML sheet and syncs rotated tokens in place without reloading', async () => {
  await open();
  expect(fixture.resolve).toHaveBeenCalledWith('http://localhost:3000/', 'http://localhost:4000', expect.any(AbortSignal), undefined);
  const frame = container.querySelector('iframe')!; expect(frame).not.toBeNull();
  const initialSrc = frame.src;
  const postMessage = vi.fn();
  Object.defineProperty(frame, 'contentWindow', { value: { postMessage }, configurable: true });
  for (let i = 0; i < 50; i++) await act(async () => root.render(<MobileHtmlPreviewSheet />));
  expect(fixture.resolve).toHaveBeenCalledOnce(); expect(container.querySelector('iframe')).toBe(frame);
  fixture.urlToken = 'yuri_url_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  await act(async () => fixture.renewed());
  expect(fixture.resolve).toHaveBeenCalledOnce();
  expect(container.querySelector('iframe')).toBe(frame);
  expect(frame.src).toBe(initialSrc);
  expect(postMessage).toHaveBeenCalledWith(
    { source: 'yuri-preview-parent', version: 1, type: 'update-url-auth-token', token: fixture.urlToken },
    'http://localhost:4000',
  );
  await act(async () => useMobileHtmlPreviewStore.getState().close());
  expect(container.querySelector('iframe')).toBeNull();
  expect(fixture.release).toHaveBeenCalledOnce(); expect(fixture.unsubscribe).toHaveBeenCalledOnce();
});

it('extends an expiring target in place and exposes retry after failed initial registration', async () => {
  vi.useFakeTimers();
  fixture.resolve.mockRejectedValueOnce(new Error('offline'));
  await open();
  expect(container.querySelector('iframe')).toBeNull();
  const retry = container.querySelector('button'); expect(retry).not.toBeNull();
  await act(async () => retry!.click());
  const frame = container.querySelector('iframe')!; expect(frame).not.toBeNull();
  const initialSrc = frame.src;
  expect(fixture.resolve).toHaveBeenCalledTimes(2);
  await act(async () => vi.advanceTimersByTimeAsync(50_000));
  expect(fixture.extend).toHaveBeenCalledTimes(1);
  expect(container.querySelector('iframe')).toBe(frame);
  expect(frame.src).toBe(initialSrc);
  expect(fixture.resolve).toHaveBeenCalledTimes(2);
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
  const frame = container.querySelector('iframe')!;
  const source = {} as Window;
  Object.defineProperty(frame, 'contentWindow', { value: source, configurable: true });
  const data = { source: 'yuri-preview-bridge', version: 1, type: 'navigate-preview', url: 'http://localhost:3001/next' };
  await act(async () => window.dispatchEvent(new MessageEvent('message', { source, origin: 'https://untrusted.example', data })));
  expect(fixture.resolve).toHaveBeenCalledOnce();
  await act(async () => window.dispatchEvent(new MessageEvent('message', { origin: 'http://localhost:4000', data })));
  expect(fixture.resolve).toHaveBeenCalledOnce();
  await act(async () => window.dispatchEvent(new MessageEvent('message', { source, origin: 'http://localhost:4000', data })));
  expect(fixture.resolve).toHaveBeenLastCalledWith(data.url, 'http://localhost:4000', expect.any(AbortSignal), undefined);
});

it('captures the requested Host location and never substitutes the currently selected different Host', async () => {
  const location = { hubId: 'hub', hostId: 'a', directory: 'C:\\Raw Path\\' };
  const entry = { location, queryScope: ['transport', 'hub', 'a', 'a-key', 0] } as unknown as HostRuntimeEntry;
  fixture.host = { entry };
  await act(async () => { useMobileHtmlPreviewStore.getState().open('http://localhost:3000/', location); root.render(<MobileHtmlPreviewSheet />); });
  expect(fixture.resolve).toHaveBeenLastCalledWith('http://localhost:3000/', 'http://localhost:4000', expect.any(AbortSignal), entry);
  location.hostId = 'mutated-by-caller';
  expect(useMobileHtmlPreviewStore.getState().target?.location?.hostId).toBe('a');
  const requested = useMobileHtmlPreviewStore.getState().target!.location!;
  const resolved = { ...entry, location: requested };
  fixture.registry = { hubId: 'hub', resolve: vi.fn(() => resolved) } as unknown as HostRuntimeRegistry;
  fixture.host = { entry: { ...entry, location: { ...requested, hostId: 'b' } } };
  await act(async () => root.render(<MobileHtmlPreviewSheet />));
  expect(fixture.registry.resolve).toHaveBeenCalledWith(requested);
  expect(fixture.resolve).toHaveBeenLastCalledWith('http://localhost:3000/', 'http://localhost:4000', expect.any(AbortSignal), resolved);
});
