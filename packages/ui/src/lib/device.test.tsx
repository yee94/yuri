import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getDeviceInfo, useDeviceInfo } from './device';

const runtime = vi.hoisted(() => ({ desktop: false, vscode: false, capacitor: false }));
vi.mock('@/lib/desktop', () => ({
  isDesktopShell: () => runtime.desktop,
  isVSCodeRuntime: () => runtime.vscode,
}));
vi.mock('@/lib/platform', () => ({ isCapacitorApp: () => runtime.capacitor }));

let root: Root;
let host: HTMLDivElement;
let frames: Map<number, FrameRequestCallback>;
let queries: Map<string, MediaQueryList>;
let frameId: number;

const resize = async (width: number) => {
  vi.stubGlobal('innerWidth', width);
  await act(async () => {
    window.dispatchEvent(new Event('resize'));
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback(0));
  });
};

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.assign(runtime, { desktop: false, vscode: false, capacitor: false });
  vi.stubGlobal('innerWidth', 1100);
  vi.spyOn(navigator, 'maxTouchPoints', 'get').mockReturnValue(0);
  frames = new Map();
  queries = new Map();
  frameId = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.stubGlobal('matchMedia', (query: string) => {
    if (!queries.has(query)) {
      const target = new EventTarget();
      queries.set(query, Object.assign(target, {
        media: query, matches: false, onchange: null,
        addListener: vi.fn(), removeListener: vi.fn(),
      }) as MediaQueryList);
    }
    return queries.get(query)!;
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('keeps 24 layout consumers idle over 50 pixel resizes while an explicit width consumer stays current', async () => {
  const layoutRender = vi.fn();
  const widthRender = vi.fn();
  function Layout() {
    const info = useDeviceInfo();
    layoutRender(info);
    return <span>{info.breakpoint}</span>;
  }
  function Width() {
    const info = useDeviceInfo({ includeScreenWidth: true });
    widthRender(info.screenWidth);
    return <output>{info.screenWidth}</output>;
  }
  await act(async () => root.render(<>{Array.from({ length: 24 }, (_, i) => <Layout key={i} />)}<Width /></>));
  const initialRenders = layoutRender.mock.calls.length;
  const rootChanges: MutationRecord[] = [];
  const observer = new MutationObserver((records) => rootChanges.push(...records));
  observer.observe(document.documentElement, { attributes: true });
  for (let i = 1; i <= 50; i++) await resize(1100 + i);
  observer.disconnect();
  expect(layoutRender).toHaveBeenCalledTimes(initialRenders);
  expect(layoutRender.mock.calls.at(-1)?.[0]).toBe(layoutRender.mock.calls[0][0]);
  expect(widthRender.mock.calls.at(-1)?.[0]).toBe(1150);
  expect(host.querySelector('output')?.textContent).toBe('1150');
  expect(rootChanges).toHaveLength(0);
  await resize(1280);
  expect(layoutRender).toHaveBeenCalledTimes(initialRenders + 24);
  expect(host.querySelector('span')?.textContent).toBe('xl');
});

it('shares one resize listener and cancels pending work when the last consumer leaves', async () => {
  const add = vi.spyOn(window, 'addEventListener');
  const remove = vi.spyOn(window, 'removeEventListener');
  function Consumer({ width = false }: { width?: boolean }) {
    useDeviceInfo({ includeScreenWidth: width });
    return null;
  }
  await act(async () => root.render(<><Consumer /><Consumer width /></>));
  expect(add.mock.calls.filter(([type]) => String(type) === 'resize')).toHaveLength(1);
  await act(async () => root.render(<Consumer />));
  expect(remove.mock.calls.filter(([type]) => String(type) === 'resize')).toHaveLength(0);
  window.dispatchEvent(new Event('resize'));
  expect(frames.size).toBe(1);
  await act(async () => root.render(null));
  expect(frames.size).toBe(0);
  expect(remove.mock.calls.filter(([type]) => String(type) === 'resize')).toHaveLength(1);
  vi.stubGlobal('innerWidth', 1500);
  await act(async () => root.render(<Consumer />));
  expect(getDeviceInfo().screenWidth).toBe(1500);
});

it('publishes pointer changes without a window resize and preserves runtime layout overrides', async () => {
  let current: ReturnType<typeof useDeviceInfo>;
  function Consumer() { current = useDeviceInfo(); return null; }
  await act(async () => root.render(<Consumer />));
  await resize(700);
  expect(current!.isMobile).toBe(false);
  const coarse = queries.get('(pointer: coarse)')!;
  Object.defineProperty(coarse, 'matches', { configurable: true, value: true });
  await act(async () => {
    coarse.dispatchEvent(new Event('change'));
    const pending = [...frames.values()]; frames.clear();
    pending.forEach((callback) => callback(0));
  });
  expect(current!.isMobile).toBe(true);
  expect(document.documentElement.classList.contains('mobile-pointer')).toBe(true);
  await resize(900);
  expect(current!.isTablet).toBe(true);
  runtime.desktop = true;
  await resize(700);
  expect(current!.isDesktop).toBe(true);
  expect(document.documentElement.classList.contains('mobile-pointer')).toBe(false);
  runtime.desktop = false;
  runtime.vscode = true;
  await resize(701);
  expect(current!.isDesktop).toBe(true);
  runtime.vscode = false;
  runtime.capacitor = true;
  await resize(1400);
  expect(current!.isMobile).toBe(true);
  expect(current!.isTablet).toBe(false);
});
