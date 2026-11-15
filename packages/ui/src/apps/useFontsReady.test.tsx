import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  loadFont: vi.fn<() => Promise<void>>(),
}));
vi.mock('@/hooks/useFontPreferences', () => ({ useFontPreferences: () => ({ uiFont: 'test-font' }) }));
vi.mock('@/lib/fontLoader', () => ({ loadUiFont: () => fixture.loadFont() }));
vi.mock('./appBootReady', () => ({ appBootReadyPromise: Promise.resolve() }));
import { useFontsReady } from './useFontsReady';

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture.loadFont.mockReset();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const splash = document.createElement('div');
  splash.id = 'initial-loading';
  document.body.append(splash);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.getElementById('initial-loading')?.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function MobilePaint() {
  const ready = useFontsReady();
  return <div>{ready ? 'ready' : 'loading'}</div>;
}

test('late mobile boot dismisses the external splash after the HTML fallback already elapsed', async () => {
  let loaded!: () => void;
  fixture.loadFont.mockReturnValue(new Promise(resolve => { loaded = resolve; }));
  await vi.advanceTimersByTimeAsync(12_000);
  await act(async () => root.render(<MobilePaint />));
  expect(document.getElementById('initial-loading')?.classList.contains('fade-out')).toBe(false);
  await act(async () => {
    loaded();
    await vi.advanceTimersByTimeAsync(100);
  });
  expect(host.textContent).toBe('ready');
  expect(document.getElementById('initial-loading')?.classList.contains('fade-out')).toBe(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
  expect(document.getElementById('initial-loading')).toBeNull();
});

test('a stalled font still releases the hosted mobile splash at the existing readiness timeout', async () => {
  fixture.loadFont.mockReturnValue(new Promise(() => {}));
  await act(async () => root.render(<MobilePaint />));
  await act(async () => { await vi.advanceTimersByTimeAsync(2600); });
  expect(host.textContent).toBe('ready');
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
  expect(document.getElementById('initial-loading')).toBeNull();
});
