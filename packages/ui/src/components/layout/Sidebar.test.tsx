import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Sidebar } from './Sidebar';

const state = vi.hoisted(() => ({ sidebarWidth: 300, setSidebarWidth: vi.fn() }));
vi.mock('@/stores/useUIStore', () => ({ useUIStore: (select: (value: typeof state) => unknown) => select(state) }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('../ui/ErrorBoundary', () => ({ ErrorBoundary: ({ children }: React.PropsWithChildren) => children }));

let host: HTMLDivElement;
let root: Root;
const render = (isOpen = true) => act(async () => root.render(
  <Sidebar isOpen={isOpen} isMobile={false}><textarea defaultValue="draft" /></Sidebar>,
));
const pointer = async (type: string, clientX: number) => {
  await act(async () => host.querySelector('[role="separator"]')!.dispatchEvent(
    new PointerEvent(type, { bubbles: true, pointerId: 1, clientX }),
  ));
};

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  state.sidebarWidth = 300;
  state.setSidebarWidth.mockReset().mockImplementation((width: number) => { state.sidebarWidth = width; });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

it('tracks live widths through parent renders and commits only once at pointer end', async () => {
  await render();
  const input = host.querySelector('textarea')!;
  const content = input.parentElement!.parentElement!;
  await pointer('pointerdown', 300);
  for (let i = 1; i <= 50; i++) await pointer('pointermove', 300 + i);
  expect(host.querySelector('aside')!.style.width).toBe('350px');
  expect(content.style.width).toBe('350px');
  expect(state.setSidebarWidth).not.toHaveBeenCalled();
  await render();
  expect(content.style.width).toBe('350px');
  expect(host.querySelector('textarea')).toBe(input);
  await pointer('pointerup', 350);
  expect(state.setSidebarWidth).toHaveBeenCalledExactlyOnceWith(350);
  await render(false);
  expect(host.querySelector('aside')!.style.width).toBe('0px');
  expect(content.style.width).toBe('350px');
  await render();
  expect(host.querySelector('aside')!.style.width).toBe('350px');
});

it('clamps both visible widths and finishes a cancelled drag consistently', async () => {
  await render();
  await pointer('pointerdown', 300);
  await pointer('pointermove', 900);
  expect(host.querySelector('aside')!.style.width).toBe('500px');
  await pointer('pointermove', 100);
  expect(host.querySelector('aside')!.style.width).toBe('260px');
  await pointer('pointercancel', 100);
  expect(state.setSidebarWidth).toHaveBeenCalledExactlyOnceWith(260);
});
