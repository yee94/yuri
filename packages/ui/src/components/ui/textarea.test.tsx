import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Textarea } from './textarea';

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test.each([false, true])('exposes one material surface and accessible validation in simple=%s mode', async (simple) => {
  await act(() => root.render(<Textarea simple={simple} embedded hasError defaultValue="Keep this draft" />));
  const surface = host.querySelector('[data-slot="textarea"]')!;
  const input = host.querySelector('textarea')!;
  expect(host.querySelectorAll('[data-slot="textarea"]')).toHaveLength(1);
  expect(input.getAttribute('aria-invalid')).toBe('true');
  expect(input.value).toBe('Keep this draft');
  if (!simple) {
    expect(surface.getAttribute('data-invalid')).toBe('true');
    expect(input.getAttribute('data-slot')).toBe('textarea-input');
  } else {
    expect(surface).toBe(input);
  }
});

test('retains the compound resize interaction and draft', async () => {
  await act(() => root.render(<Textarea embedded defaultValue="Keep this draft" />));
  const surface = host.querySelector<HTMLElement>('[data-slot="textarea"]')!;
  const handle = host.querySelector<HTMLElement>('[role="separator"]')!;
  vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 120));
  Object.defineProperty(handle, 'setPointerCapture', { value: vi.fn() });
  await act(() => { handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, clientY: 200 })); });
  await act(() => { handle.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientY: 280 })); });
  expect(surface.style.height).toBe('200px');
  expect(host.querySelector('textarea')!.value).toBe('Keep this draft');
  await act(() => { handle.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 })); });
  await act(() => { handle.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientY: 400 })); });
  expect(surface.style.height).toBe('200px');
});
