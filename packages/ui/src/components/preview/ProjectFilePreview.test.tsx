import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { HostRuntimeEntry } from '@/lib/remote-projects/registry';
import { ProjectFilePreview } from './ProjectFilePreview';

const fixture = vi.hoisted(() => ({ resolve: vi.fn(), releaseAuth: vi.fn(), auth: 0, generation: 0, hostOrigin: undefined as string | undefined,
  tokens: new Set<() => void>(), authListeners: new Set<() => void>(), endpoints: new Set<() => void>() }));
vi.mock('@/lib/preview/project-file-preview', () => ({ resolveProjectFilePreview: fixture.resolve }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/preview/MobileHtmlNetworkBoundary', () => ({ MobileHtmlNetworkBoundary: ({ children }: { children: (network: { hostOrigin?: string }) => React.ReactNode }) => children({ hostOrigin: fixture.hostOrigin }) }));
vi.mock('@/components/ui/iframeSheetOverscroll', () => ({ attachIframeSheetOverscroll: () => () => {} }));
vi.mock('@/lib/runtime-auth', () => ({
  acquireRuntimeUrlAuthToken: () => fixture.releaseAuth,
  subscribeRuntimeUrlAuthToken: (listener: () => void) => { fixture.tokens.add(listener); return () => fixture.tokens.delete(listener); },
  getRuntimeAuthGeneration: () => fixture.auth,
  subscribeRuntimeAuthGeneration: (listener: () => void) => { fixture.authListeners.add(listener); return () => fixture.authListeners.delete(listener); },
}));
vi.mock('@/lib/runtime-switch', () => ({
  getRuntimeGeneration: () => fixture.generation,
  subscribeRuntimeEndpointChanged: (listener: () => void) => { fixture.endpoints.add(listener); return () => fixture.endpoints.delete(listener); },
}));

let node: HTMLDivElement; let root: Root;
const entry = (host: string): HostRuntimeEntry => ({ queryScope: ['transport', 'hub', host, '/project', 1],
  location: { hubId: 'hub', hostId: host, directory: '/project' }, key: host, cachePartition: host, connectionGeneration: 1,
  sdk: () => { throw new Error('Unexpected SDK read'); }, service: () => { throw new Error('Unexpected service read'); },
  fetch: () => { throw new Error('Unexpected HTTP read'); } });
const source = (name: string, expiresAt = Date.now() + 30 * 60_000) => ({ src: `about:blank#${name}`, expiresAt, release: vi.fn(async () => {}) });
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  fixture.resolve.mockReset(); fixture.releaseAuth.mockClear(); fixture.hostOrigin = undefined; fixture.auth = 0; fixture.generation = 0;
  node = document.createElement('div'); document.body.append(node); root = createRoot(node);
});
afterEach(async () => {
  await act(async () => root.unmount()); node.remove(); vi.useRealTimers();
  expect(fixture.tokens.size).toBe(0); expect(fixture.authListeners.size).toBe(0); expect(fixture.endpoints.size).toBe(0);
});

it('uses the scoped resource graph/native origin, keeps sandbox and adds no work on 50 unrelated updates', async () => {
  const host = entry('a'); const loaded = source('a'); fixture.hostOrigin = 'http://native-gateway.example';
  fixture.resolve.mockResolvedValue(loaded);
  await act(async () => root.render(<ProjectFilePreview entry={host} path="/project/index.html" directory="/project" />));
  expect(fixture.resolve).toHaveBeenCalledWith(host, '/project/index.html', '/project', expect.any(AbortSignal), fixture.hostOrigin);
  expect(node.querySelector('iframe')?.src).toBe(loaded.src);
  expect(node.querySelector('iframe')?.getAttribute('srcdoc')).toBeNull();
  expect(node.querySelector('iframe')?.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin allow-forms');
  for (let index = 0; index < 50; index++) await act(async () => root.render(<ProjectFilePreview entry={host} path="/project/index.html" directory="/project" />));
  expect(fixture.resolve).toHaveBeenCalledTimes(1);
  await act(async () => root.unmount());
  expect(loaded.release).toHaveBeenCalled();
  expect(fixture.resolve.mock.calls[0][3].aborted).toBe(true);
  expect(fixture.releaseAuth).toHaveBeenCalledTimes(1);
});

it('removes old same-path Host document immediately and releases a late cancelled registration', async () => {
  const a = source('a'); fixture.resolve.mockResolvedValueOnce(a);
  await act(async () => root.render(<ProjectFilePreview entry={entry('a')} path="/project/index.html" directory="/project" />));
  let finish!: (value: ReturnType<typeof source>) => void;
  fixture.resolve.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await act(async () => root.render(<ProjectFilePreview entry={entry('b')} path="/project/index.html" directory="/project" />));
  expect(node.querySelector('iframe')).toBeNull(); expect(a.release).toHaveBeenCalled();
  const late = source('b');
  await act(async () => root.unmount());
  await act(async () => finish(late));
  expect(late.release).toHaveBeenCalled(); expect(node.querySelector('iframe')).toBeNull();
});

it('failed registration/iframe load shows retry, never srcDoc or direct FS fallback', async () => {
  fixture.resolve.mockRejectedValueOnce(new Error('preview_gateway_unavailable'));
  const host = entry('a');
  await act(async () => root.render(<ProjectFilePreview entry={host} path="/project/index.html" directory="/project" />));
  expect(node.querySelector('iframe')).toBeNull();
  const loaded = source('retry'); fixture.resolve.mockResolvedValueOnce(loaded);
  await act(async () => node.querySelector('button')!.click());
  expect(node.querySelector('iframe')?.src).toBe(loaded.src);
  await act(async () => node.querySelector('iframe')!.dispatchEvent(new Event('error', { bubbles: true })));
  expect(node.querySelector('iframe')).toBeNull(); expect(loaded.release).toHaveBeenCalled();
  expect(node.textContent).toContain('contextPanel.preview.actions.retry');
});

it('replaces the path token long before target expiry and does not display a response overtaken by another token', async () => {
  const first = source('first'); fixture.resolve.mockResolvedValueOnce(first);
  await act(async () => root.render(<ProjectFilePreview path="/project/index.html" directory="/project" />));
  let finish!: (value: ReturnType<typeof source>) => void;
  fixture.resolve.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await act(async () => fixture.tokens.forEach(listener => listener()));
  expect(node.querySelector('iframe')).toBeNull(); expect(first.release).toHaveBeenCalled();
  await act(async () => fixture.tokens.forEach(listener => listener()));
  const superseded = source('superseded'); const latest = source('latest'); fixture.resolve.mockResolvedValueOnce(latest);
  await act(async () => finish(superseded));
  expect(superseded.release).toHaveBeenCalled();
  expect(node.querySelector('iframe')?.src).toBe(latest.src);
});

it('renews target expiry and removes the document on runtime/auth generation change', async () => {
  vi.useFakeTimers(); const first = source('first', Date.now() + 20_000); const renewed = source('renewed');
  fixture.resolve.mockResolvedValueOnce(first).mockResolvedValueOnce(renewed);
  await act(async () => root.render(<ProjectFilePreview path="/project/index.html" directory="/project" />));
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  expect(first.release).toHaveBeenCalled(); expect(node.querySelector('iframe')?.src).toBe(renewed.src);
  fixture.resolve.mockImplementation(() => new Promise(() => {}));
  await act(async () => { fixture.auth++; fixture.authListeners.forEach(listener => listener()); });
  expect(node.querySelector('iframe')).toBeNull(); expect(renewed.release).toHaveBeenCalled();
  await act(async () => { fixture.generation++; fixture.endpoints.forEach(listener => listener()); });
  expect(fixture.resolve.mock.calls.at(-2)![3].aborted).toBe(true);
});
