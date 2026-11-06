import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MobileHtmlNetworkBoundary } from './MobileHtmlNetworkBoundary';

const fixture = vi.hoisted(() => ({ native: true, generation: 1, changed: () => {}, acquire: vi.fn() }));
vi.mock('@/lib/platform', () => ({ isCapacitorApp: () => fixture.native }));
vi.mock('@/lib/runtime-switch', () => ({
  getRuntimeGeneration: () => fixture.generation,
  subscribeRuntimeEndpointChanged: (notify: () => void) => { fixture.changed = notify; return () => {}; },
}));
vi.mock('@/lib/preview/mobile-html-network', () => ({ acquireMobileHtmlNetwork: fixture.acquire }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const render = () => root.render(<MobileHtmlNetworkBoundary>{() => <iframe srcDoc="<p>Built-in HTML</p>" title="Built-in HTML" />}</MobileHtmlNetworkBoundary>);
beforeEach(() => {
  fixture.native = true; fixture.generation = 1; fixture.acquire.mockReset();
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

it('gates native built-in HTML without a GUI plugin, retains its lease across 50 updates, and removes it before releasing', async () => {
  let ready!: (lease: { release: () => Promise<void> }) => void;
  fixture.acquire.mockImplementation(() => new Promise(resolve => { ready = resolve; }));
  await act(async () => render());
  expect(container.querySelector('iframe')).toBeNull();
  await act(async () => ready({ release: async () => {} }));
  const frame = container.querySelector('iframe');
  expect(frame).not.toBeNull();
  for (let i = 0; i < 50; i++) await act(async () => render());
  expect(fixture.acquire).toHaveBeenCalledOnce();
  expect(container.querySelector('iframe')).toBe(frame);
  let mountedAtRelease = true;
  const signal = fixture.acquire.mock.calls[0][0] as AbortSignal;
  signal.addEventListener('abort', () => { mountedAtRelease = Boolean(container.querySelector('iframe')); });
  await act(async () => fixture.acquire.mock.calls[0][1]());
  expect(container.querySelector('iframe')).toBeNull();
  expect(signal.aborted).toBe(true);
  expect(mountedAtRelease).toBe(false);
});

it('drops the old document immediately on runtime switch and waits for the new gateway', async () => {
  fixture.acquire.mockResolvedValueOnce({ release: async () => {} }).mockImplementationOnce(() => new Promise(() => {}));
  await act(async () => render());
  expect(container.querySelector('iframe')).not.toBeNull();
  await act(async () => { fixture.generation++; fixture.changed(); });
  expect(container.querySelector('iframe')).toBeNull();
  expect(fixture.acquire.mock.calls[0][0].aborted).toBe(true);
  expect(fixture.acquire).toHaveBeenCalledTimes(2);
});

it('leaves ordinary web rendering independent of the native gateway', async () => {
  fixture.native = false;
  await act(async () => render());
  expect(container.querySelector('iframe')).not.toBeNull();
  expect(fixture.acquire).not.toHaveBeenCalled();
});
