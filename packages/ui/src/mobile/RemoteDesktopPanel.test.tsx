import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/lib/i18n';
import { RemoteDesktopPanel } from './RemoteDesktopPanel';

const mock = vi.hoisted(() => ({
  supported: true, enabled: true, query: vi.fn(), connect: vi.fn(), send: vi.fn(), close: vi.fn(),
  resize: null as null | ((entries: { contentRect: { width: number; height: number } }[]) => void),
}));
vi.mock('@/queries/remoteDesktopQueries', () => ({ useRemoteDesktopCapability: () => {
  mock.query(); return { data: { supported: mock.supported, enabled: mock.enabled }, error: null, refetch: vi.fn() };
} }));
vi.mock('@/lib/remote-desktop/connection', () => ({ connectRemoteDesktop: mock.connect }));
vi.mock('@reactuses/core', async importOriginal => ({ ...await importOriginal<typeof import('@reactuses/core')>(),
  useResizeObserver: (_ref: unknown, callback: typeof mock.resize) => { mock.resize = callback; },
}));
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  mock.supported = true; mock.enabled = true; mock.query.mockClear(); mock.send.mockClear(); mock.close.mockClear();
  mock.connect.mockReset().mockReturnValue({ send: mock.send, close: mock.close });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount()); document.body.innerHTML = '';
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false });
});
const onClose = () => {};
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
it('maps production touch handlers and pinch without remote click leakage, then uses the latest scroll mode', () => {
  render();
  const options = mock.connect.mock.calls[0][0];
  act(() => { mock.resize?.([{ contentRect: { width: 400, height: 600 } }]); options.onSize(1600, 900); options.onState('webrtc'); });
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
  const scroll = document.querySelector<HTMLButtonElement>('button[aria-label="Scroll mode"]')!;
  act(() => scroll.click());
  pointer('pointerdown', 1, 200, 300); pointer('pointermove', 1, 200, 350); pointer('pointerup', 1, 200, 350);
  expect(mock.send).toHaveBeenLastCalledWith({ type: 'scroll', dx: 0, dy: -50 });
});
it('keeps gamepad-style icon controls outside the pointer surface without a toolbar or protocol labels', () => {
  render();
  const options = mock.connect.mock.calls[0][0];
  act(() => options.onState('webrtc'));
  const keyboard = document.querySelector<HTMLButtonElement>('button[aria-label="Type on the remote computer"]')!;
  const viewport = document.querySelector<HTMLElement>('div[aria-label="Remote screen"]')!;
  expect(keyboard.getAttribute('aria-expanded')).toBe('false');
  expect(document.body.textContent).not.toContain('Scroll mode');
  expect(document.body.textContent).not.toContain('WebRTC');
  for (const label of ['Scroll mode', 'Fit screen', 'Type on the remote computer']) {
    const button = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
    expect(button).not.toBeNull();
    expect(button.textContent).toBe('');
    expect(viewport.contains(button)).toBe(false);
  }
  act(() => keyboard.click());
  expect(keyboard.getAttribute('aria-expanded')).toBe('true');
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
  expect(mock.connect).toHaveBeenCalledTimes(1);
  act(() => options.onState('tunnel'));
  expect(document.body.textContent).not.toContain('Compatibility stream');
});
it('closes capture when the phone goes to the background', () => {
  render();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(mock.close).toHaveBeenCalledTimes(1);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});
