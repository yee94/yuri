import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/lib/i18n';
import { RemoteDesktopPanel } from './RemoteDesktopPanel';
import { mobileBackNavigationCoordinator } from './mobileBackNavigation';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileProductionCssAsync, evidenceRoot, openChromeSession, openPageSession, resolveChrome } from '@/components/ui/chromeCdpHarness';

const mock = vi.hoisted(() => ({
  supported: true, enabled: true, query: vi.fn(), connect: vi.fn(), send: vi.fn(), close: vi.fn(), setZoomed: vi.fn(),
  resize: null as null | ((entries: { contentRect: { width: number; height: number } }[]) => void),
  observers: new Map<{ current: HTMLElement | null }, (entries: { contentRect: { width: number; height: number } }[]) => void>(),
}));
vi.mock('@/queries/remoteDesktopQueries', () => ({ useRemoteDesktopCapability: () => {
  mock.query(); return { data: { supported: mock.supported, enabled: mock.enabled }, error: null, refetch: vi.fn() };
} }));
vi.mock('@/lib/remote-desktop/connection', () => ({ connectRemoteDesktop: mock.connect }));
vi.mock('@/lib/nativeComposerCover', () => ({ holdNativeComposerCover: () => () => {} }));
vi.mock('@reactuses/core', async importOriginal => ({ ...await importOriginal<typeof import('@reactuses/core')>(),
  useResizeObserver: (ref: { current: HTMLElement | null }, callback: NonNullable<typeof mock.resize>) => { mock.resize = callback; mock.observers.set(ref, callback); },
}));
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  mock.supported = true; mock.enabled = true; mock.query.mockClear(); mock.send.mockClear(); mock.close.mockClear();
  mock.setZoomed.mockClear();
  mock.observers.clear();
  mock.connect.mockReset().mockReturnValue({ send: mock.send, close: mock.close, setZoomed: mock.setZoomed });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount()); document.body.innerHTML = '';
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false });
});
const onClose = vi.fn();
function render(count = 0) {
  act(() => root.render(<I18nProvider><RemoteDesktopPanel onClose={onClose} instanceName="Connected Mac" /><span>{count}</span></I18nProvider>));
}
it('does no remote-desktop hook or connection work for 50 unrelated homepage renders', () => {
  render();
  expect(mock.connect).toHaveBeenCalledTimes(1);
  const queryCalls = mock.query.mock.calls.length;
  for (let count = 1; count <= 50; count++) render(count);
  expect(mock.query).toHaveBeenCalledTimes(queryCalls);
  expect(mock.connect).toHaveBeenCalledTimes(1);
});
it('shows explicit unsupported feedback without opening a socket', () => {
  mock.supported = false; render();
  expect(document.body.textContent).toContain('does not support remote desktop');
  expect(mock.connect).not.toHaveBeenCalled();
});
it('explains how to enable the Host and opens no socket while disabled', () => {
  mock.enabled = false; render();
  expect(document.body.textContent).toContain('Remote desktop is off on this Mac');
  expect(mock.connect).not.toHaveBeenCalled();
});
it('maps Cursor touches and pinch without click leakage, then pans locally in Drag mode', () => {
  render();
  const options = mock.connect.mock.calls[0][0];
  act(() => { mock.resize?.([{ contentRect: { width: 400, height: 600 } }]); options.onSize(1600, 900); options.onState('webrtc'); });
  act(() => document.querySelector<HTMLButtonElement>('button[aria-label="Cursor · Control computer"]')!.click());
  const viewport = document.querySelector<HTMLElement>('div[aria-label="Remote screen"]')!;
  viewport.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 400, bottom: 600, width: 400, height: 600, toJSON: () => ({}) });
  const captures = new Set<number>();
  viewport.setPointerCapture = id => { captures.add(id); };
  viewport.hasPointerCapture = id => captures.has(id);
  viewport.releasePointerCapture = id => { captures.delete(id); };
  const pointer = (type: string, id: number, x: number, y: number) => act(() => {
    viewport.dispatchEvent(new PointerEvent(type, { pointerId: id, clientX: x, clientY: y, bubbles: true }));
  });
  pointer('pointerdown', 1, 200, 300); pointer('pointerup', 1, 200, 300);
  expect(mock.send).toHaveBeenLastCalledWith({ type: 'pointer', action: 'click', x: 0.5, y: 0.5 });
  mock.send.mockClear();
  pointer('pointerdown', 1, 150, 300); pointer('pointerdown', 2, 250, 300);
  pointer('pointermove', 1, 100, 300); pointer('pointermove', 2, 300, 300);
  pointer('pointerup', 2, 300, 300); pointer('pointerup', 1, 100, 300);
  expect(mock.send).not.toHaveBeenCalled();
  const drag = document.querySelector<HTMLButtonElement>('button[aria-label="Drag · Pan canvas"]')!;
  act(() => drag.click());
  pointer('pointerdown', 1, 200, 300); pointer('pointermove', 1, 200, 350); pointer('pointerup', 1, 200, 350);
  expect(mock.send).not.toHaveBeenCalled();
});
it('blocks native touch panning on the remote viewport, like image preview, and cleans up on close', () => {
  render();
  const viewport = document.querySelector<HTMLElement>('div[aria-label="Remote screen"]')!;
  const nativeMove = () => new Event('touchmove', { bubbles: true, cancelable: true });
  const move = nativeMove();
  viewport.dispatchEvent(move);
  expect(move.defaultPrevented).toBe(true);
  const keyboard = document.querySelector<HTMLButtonElement>('button[aria-label="Type on the remote computer"]')!;
  const controlMove = nativeMove();
  keyboard.dispatchEvent(controlMove);
  expect(controlMove.defaultPrevented).toBe(false);
  expect(() => viewport.dispatchEvent(new Event('touchmove', { cancelable: false }))).not.toThrow();
  act(() => root.render(<></>));
  const afterClose = nativeMove();
  viewport.dispatchEvent(afterClose);
  expect(afterClose.defaultPrevented).toBe(false);
});
it('opens a full-width keyboard footer outside the pointer surface with icon-only navigation keys', () => {
  render();
  const options = mock.connect.mock.calls[0][0];
  act(() => options.onState('webrtc'));
  const keyboard = document.querySelector<HTMLButtonElement>('button[aria-label="Type on the remote computer"]')!;
  const viewport = document.querySelector<HTMLElement>('div[aria-label="Remote screen"]')!;
  expect(keyboard.getAttribute('aria-expanded')).toBe('false');
  expect(document.querySelector('footer')).toBeNull();
  expect(document.body.textContent).not.toContain('Scroll mode');
  expect(document.body.textContent).not.toContain('WebRTC');
  expect(document.querySelector('button[aria-label="Fit screen"]')).toBeNull();
  expect(document.querySelector('button[aria-label="Scroll mode"]')).toBeNull();
  for (const label of ['Drag · Pan canvas', 'Cursor · Control computer', 'Type on the remote computer', 'Switch portrait / landscape']) {
    const button = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
    expect(button).not.toBeNull();
    expect(button.textContent).toBe('');
    expect(button.classList.contains('yuri-mobile-floating-action')).toBe(true);
    expect(button.classList.contains('size-10')).toBe(true);
    expect(button.className).not.toMatch(/opacity-60|aria-pressed:ring|backdrop-blur|shadow-/);
    expect(viewport.contains(button)).toBe(false);
  }
  act(() => keyboard.click());
  expect(keyboard.getAttribute('aria-expanded')).toBe('true');
  expect(keyboard.classList.contains('yuri-mobile-inverse-action')).toBe(true);
  const footer = document.querySelector<HTMLElement>('footer[data-remote-desktop-keyboard]')!;
  expect(footer.parentElement?.tagName).toBe('MAIN');
  expect(footer.classList.contains('w-full')).toBe(true);
  expect(footer.className).not.toMatch(/absolute|fixed|rounded/);
  expect(document.querySelector('[data-remote-desktop-stage-region]')?.contains(footer)).toBe(false);
  for (const key of ['Escape', 'Tab', 'Backspace', 'Enter', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'ArrowRight']) {
    const button = footer.querySelector<HTMLButtonElement>(`button[aria-label="Press ${key}"]`)!;
    expect(button.querySelector('svg')).not.toBeNull();
    expect(button.textContent).toBe('');
    expect(button.title).toBe(`Press ${key}`);
    act(() => button.click());
    expect(mock.send).toHaveBeenLastCalledWith({ type: 'key', key });
  }
  const input = document.querySelector('input')!;
  expect(viewport.contains(input)).toBe(false);
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'hello');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  act(() => document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(mock.send).toHaveBeenLastCalledWith({ type: 'text', text: 'hello' });
  act(() => keyboard.click());
  expect(document.querySelector('input')).toBeNull();
  expect(document.querySelector('footer')).toBeNull();
  expect(keyboard.classList.contains('yuri-mobile-inverse-action')).toBe(false);
  expect(mock.connect).toHaveBeenCalledTimes(1);
  act(() => options.onState('tunnel'));
  expect(document.body.textContent).not.toContain('Compatibility stream');
});
it('owns a full page history entry and rotates only this page without reconnecting', () => {
  render();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  const page = document.querySelector<HTMLElement>('[data-remote-desktop-page]')!;
  expect(page.parentElement).toBe(document.body);
  expect(mobileBackNavigationCoordinator.getTopRoute()?.id).toBe('remote-desktop-page');
  expect(mobileBackNavigationCoordinator.getTopRoute()?.layer).toBe('root');
  const surface = page.querySelector('main')!;
  expect(surface.style.transform).toBe('');
  act(() => document.querySelector<HTMLButtonElement>('button[aria-label="Switch portrait / landscape"]')!.click());
  expect(surface.style.transform).toContain('rotate(90deg)');
  expect(document.documentElement.style.transform).toBe('');
  expect(document.body.style.transform).toBe('');
  expect(mock.connect).toHaveBeenCalledTimes(1);
  onClose.mockClear();
  act(() => { mobileBackNavigationCoordinator.backImmediately('root'); });
  expect(onClose).toHaveBeenCalledOnce();
  expect(mock.close).toHaveBeenCalledOnce();
});
it('ignores all sensor samples and preserves the manually selected orientation without requesting permission', () => {
  const requestPermission = vi.fn();
  vi.stubGlobal('DeviceOrientationEvent', { requestPermission });
  const listen = vi.spyOn(window, 'addEventListener');
  render();
  const surface = document.querySelector('[data-remote-desktop-page] main') as HTMLElement;
  const tilt = (beta: number, gamma: number) => {
    const event = new Event('deviceorientation');
    Object.defineProperties(event, { beta: { value: beta }, gamma: { value: gamma } });
    act(() => window.dispatchEvent(event));
  };
  const original = surface.style.transform;
  tilt(80, 0); tilt(0, 80); tilt(0, -80);
  expect(surface.style.transform).toBe(original);
  act(() => document.querySelector<HTMLButtonElement>('button[aria-label="Switch portrait / landscape"]')!.click());
  expect(surface.style.transform).toContain('rotate(90deg)');
  const queryCalls = mock.query.mock.calls.length;
  for (let index = 0; index < 100; index++) tilt(index % 2 ? 0 : 80, index % 2 ? -80 : 0);
  expect(mock.query).toHaveBeenCalledTimes(queryCalls);
  expect(surface.style.transform).toContain('rotate(90deg)');
  expect(requestPermission).not.toHaveBeenCalled();
  expect(listen.mock.calls.map(([event]) => String(event))).not.toContain('deviceorientation');
  act(() => document.querySelector<HTMLButtonElement>('button[aria-label="Switch portrait / landscape"]')!.click());
  expect(surface.style.transform).toBe(original);
  expect(mock.connect).toHaveBeenCalledTimes(1);
  expect(document.body.style.transform).toBe('');
});
it('closes capture when the phone goes to the background', () => {
  render();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(mock.close).toHaveBeenCalledTimes(1);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});

it('manually rotates a portrait-locked viewport and discards orientation on close', () => {
  vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(390);
  vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(844);
  render();
  const surface = document.querySelector('[data-remote-desktop-page] main') as HTMLElement;
  expect(surface.style.transform).toBe('');
  act(() => document.querySelector<HTMLButtonElement>('button[aria-label="Switch portrait / landscape"]')!.click());
  expect(surface.style.transform).toContain('rotate(90deg)');
  expect(surface.style.width).toBe('844px');
  expect(surface.style.height).toBe('390px');
  act(() => root.render(<></>));
  render();
  expect(document.querySelector<HTMLElement>('[data-remote-desktop-page] main')!.style.transform).toBe('');
});

it.each([[390, 844], [844, 390]])('never changes rotation on viewport or keyboard resize (opened at %i × %i)', (width, height) => {
  vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(width);
  vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(height);
  render();
  act(() => mock.connect.mock.calls[0][0].onState('webrtc'));
  const surface = document.querySelector<HTMLElement>('[data-remote-desktop-page] main')!;
  const resizePage = (width: number, height: number) => {
    const observer = [...mock.observers].find(([ref]) => ref.current?.hasAttribute('data-remote-desktop-page'))![1];
    act(() => observer([{ contentRect: { width, height } }]));
  };
  resizePage(height, width);
  expect(surface.style.transform).toBe('');
  resizePage(width, height);
  act(() => document.querySelector<HTMLButtonElement>('button[aria-label="Switch portrait / landscape"]')!.click());
  expect(surface.style.transform).toContain('rotate(90deg)');
  resizePage(height, width);
  expect(surface.style.transform).toContain('rotate(90deg)');
  act(() => document.querySelector<HTMLButtonElement>('button[aria-label="Type on the remote computer"]')!.click());
  resizePage(390, 240);
  expect(surface.style.transform).toContain('rotate(90deg)');
  act(() => document.querySelector<HTMLButtonElement>('button[aria-label="Type on the remote computer"]')!.click());
  resizePage(390, 844);
  expect(surface.style.transform).toContain('rotate(90deg)');
  expect(mock.connect).toHaveBeenCalledTimes(1);
});

it('keeps an Android pinch alive without pointer-capture reports or lost-capture cancels, and ignores resize resets mid-gesture', () => {
  const frames = new Map<number, FrameRequestCallback>();
  let id = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++id, callback); return id; });
  vi.stubGlobal('cancelAnimationFrame', (key: number) => frames.delete(key));
  render();
  const options = mock.connect.mock.calls[0][0];
  act(() => { mock.resize?.([{ contentRect: { width: 390, height: 844 } }]); options.onState('webrtc'); });
  const viewport = document.querySelector<HTMLElement>('div[aria-label="Remote screen"]')!;
  const stage = viewport.firstElementChild as HTMLElement;
  viewport.setPointerCapture = () => {};
  viewport.hasPointerCapture = () => false;
  viewport.releasePointerCapture = () => {};
  vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, right: 390, bottom: 844 } as DOMRect);
  const pointer = (type: string, pointerId: number, clientX: number) => act(() => {
    viewport.dispatchEvent(new PointerEvent(type, { pointerId, clientX, clientY: 422, bubbles: true, cancelable: true }));
  });
  const flush = () => act(() => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(16)); });
  pointer('pointerdown', 1, 145); pointer('pointerdown', 2, 245);
  pointer('pointermove', 1, 85); pointer('pointermove', 2, 305); flush();
  expect(stage.style.transform).toContain('scale(2.2)');
  pointer('lostpointercapture', 1, 85);
  act(() => { mock.resize?.([{ contentRect: { width: 390.4, height: 844 } }]); });
  act(() => { mock.resize?.([{ contentRect: { width: 390, height: 780 } }]); });
  expect(stage.style.transform).toContain('scale(2.2)');
  pointer('pointermove', 1, 45); pointer('pointermove', 2, 345); flush();
  expect(stage.style.transform).toContain('scale(3');
  pointer('pointerup', 2, 345); pointer('pointerup', 1, 45);
  expect(stage.style.transform).toContain('scale(3');
  act(() => { mock.resize?.([{ contentRect: { width: 390, height: 700 } }]); });
  expect(stage.style.transform).toContain('scale(3');
  act(() => { options.onSize(960, 540); options.onSize(1920, 1080); });
  expect(stage.style.transform).toContain('scale(3');
  act(() => { options.onSize(1080, 1920); });
  expect(stage.style.transform).toBe('translate(0px, 0px) scale(1)');
});

it('coalesces a pinch burst into one layout read and one transform write per frame', () => {
  const frames = new Map<number, FrameRequestCallback>();
  let id = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++id, callback); return id; });
  vi.stubGlobal('cancelAnimationFrame', (key: number) => frames.delete(key));
  render();
  const options = mock.connect.mock.calls[0][0];
  act(() => { mock.resize?.([{ contentRect: { width: 390, height: 844 } }]); options.onState('webrtc'); });
  const viewport = document.querySelector<HTMLElement>('div[aria-label="Remote screen"]')!;
  const captures = new Set<number>();
  viewport.setPointerCapture = key => { captures.add(key); };
  viewport.hasPointerCapture = key => captures.has(key);
  const rect = vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, right: 390, bottom: 844 } as DOMRect);
  const pointer = (type: string, pointerId: number, clientX: number) => act(() => {
    viewport.dispatchEvent(new PointerEvent(type, { pointerId, clientX, clientY: 422, bubbles: true }));
  });
  pointer('pointerdown', 1, 145); pointer('pointerdown', 2, 245);
  rect.mockClear();
  const writes = vi.spyOn((viewport.firstElementChild as HTMLElement).style, 'transform', 'set');
  const queryCalls = mock.query.mock.calls.length;
  for (let step = 1; step <= 60; step++) {
    pointer('pointermove', 1, 145 - step); pointer('pointermove', 2, 245 + step);
  }
  expect(frames.size).toBe(1);
  act(() => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(16)); });
  expect(rect).toHaveBeenCalledTimes(1);
  expect(writes).toHaveBeenCalledTimes(1);
  expect((viewport.firstElementChild as HTMLElement).style.transform).toContain('scale(2.2)');
  for (let frame = 0; frame < 60; frame++) {
    pointer('pointermove', 1, 85 - frame / 2); pointer('pointermove', 2, 305 + frame / 2);
    act(() => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(32 + frame * 16)); });
  }
  expect(rect).toHaveBeenCalledTimes(61);
  expect(writes).toHaveBeenCalledTimes(61);
  expect(mock.query).toHaveBeenCalledTimes(queryCalls);
  expect(mock.send).not.toHaveBeenCalled();
  expect(mock.setZoomed.mock.calls).toEqual([[false], [true]]);
});

it('requests detail on Drag double-tap, preserves it across encoder size changes, then releases it on Fit', () => {
  render();
  const options = mock.connect.mock.calls[0][0];
  act(() => { mock.resize?.([{ contentRect: { width: 390, height: 844 } }]); options.onState('webrtc'); });
  const viewport = document.querySelector<HTMLElement>('div[aria-label="Remote screen"]')!;
  viewport.setPointerCapture = () => {};
  viewport.hasPointerCapture = () => false;
  vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, right: 390, bottom: 844 } as DOMRect);
  const tap = () => act(() => {
    for (const type of ['pointerdown', 'pointerup']) viewport.dispatchEvent(new PointerEvent(type,
      { pointerId: 1, clientX: 195, clientY: 422, pointerType: 'touch', bubbles: true, cancelable: true }));
  });
  tap(); tap();
  expect(mock.setZoomed.mock.calls).toEqual([[false], [true]]);
  act(() => { options.onSize(960, 540); options.onSize(1920, 1080); });
  expect((viewport.firstElementChild as HTMLElement).style.transform).toContain('scale(2.5)');
  expect(mock.setZoomed).toHaveBeenCalledTimes(2);
  tap(); tap();
  expect(mock.setZoomed.mock.calls).toEqual([[false], [true], [false]]);
  expect(mock.connect).toHaveBeenCalledOnce();
});

it.skipIf(!resolveChrome())('clips the zoomed screen without scrollports under production mobile-pointer CSS', async () => {
  vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(390);
  vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(844);
  render();
  act(() => { mock.resize?.([{ contentRect: { width: 390, height: 844 } }]); mock.connect.mock.calls[0][0].onState('tunnel'); });
  const viewport = document.querySelector<HTMLElement>('div[aria-label="Remote screen"]')!;
  viewport.setPointerCapture = () => {};
  viewport.hasPointerCapture = () => false;
  vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, right: 390, bottom: 844 } as DOMRect);
  for (let tap = 0; tap < 2; tap++) {
    act(() => viewport.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, clientX: 200, clientY: 422, bubbles: true })));
    act(() => viewport.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: 200, clientY: 422, bubbles: true })));
  }
  expect((viewport.firstElementChild as HTMLElement).style.transform).toContain('scale(2.5)');
  const pageNode = document.querySelector<HTMLElement>('[data-remote-desktop-page]')!;
  const snapshots = [pageNode.outerHTML];
  act(() => document.querySelector<HTMLButtonElement>('button[aria-label="Type on the remote computer"]')!.click());
  snapshots.push(pageNode.outerHTML);
  act(() => document.querySelector<HTMLButtonElement>('button[aria-label="Switch portrait / landscape"]')!.click());
  snapshots.push(pageNode.outerHTML);
  act(() => document.querySelector<HTMLButtonElement>('button[aria-label="Type on the remote computer"]')!.click());
  snapshots.push(pageNode.outerHTML);

  const css = await compileProductionCssAsync(join(dirname(fileURLToPath(import.meta.url)), '..'));
  const work = mkdtempSync(join(evidenceRoot(), 'remote-desktop-overflow-'));
  const browser = await openChromeSession({ width: 390, height: 844 });
  try {
    const page = await openPageSession(browser, { width: 390, height: 844, standalone: false });
    for (const [index, markup] of snapshots.entries()) {
      const file = join(work, `layout-${index}.html`);
      writeFileSync(file, `<!doctype html><html class="mobile-pointer device-mobile yuri-capacitor-app yuri-platform-android"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body>${markup}</body></html>`);
      await page.navigateFile(file);
      const samples = await page.evaluate<Array<{ overflowX: string; overflowY: string; scrollTop: number }>>(`(() => {
        const viewport = document.querySelector('div[aria-label="Remote screen"]');
        const samples = [];
        for (let node = viewport; node && node !== document.body; node = node.parentElement) {
          const style = getComputedStyle(node);
          node.scrollTop = 60;
          samples.push({ overflowX: style.overflowX, overflowY: style.overflowY, scrollTop: node.scrollTop });
        }
        return samples;
      })()`);
      for (const sample of samples) {
        expect(sample.scrollTop, `snapshot ${index}: canvas must not scroll independently of gestures`).toBe(0);
        expect(sample.overflowY, `snapshot ${index}`).toBe('clip');
        expect(sample.overflowX, `snapshot ${index}`).toBe('clip');
      }
    }
  } finally {
    await browser.close();
    rmSync(work, { recursive: true, force: true });
  }
}, 120_000);
