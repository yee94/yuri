import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { CSSVariableGenerator } from '@/lib/theme/cssGenerator';
import { getDefaultTheme } from '@/lib/theme/themes';

const native = vi.hoisted(() => ({
  update: vi.fn(async (_payload: { seq: number; visible: boolean; html?: string; css?: string; rootClass?: string }) => {}),
  listeners: new Map<string, (event: { seq?: number; path?: string }) => void>(),
}));
vi.mock('@capacitor/core', () => ({
  registerPlugin: () => ({
    update: native.update,
    addListener: async (event: string, handler: (event: { seq?: number; path?: string }) => void) => {
      native.listeners.set(event, handler);
      return { remove: async () => { native.listeners.delete(event); } };
    },
  }),
}));

import { startNativeImeHeader } from './nativeImeHeader';

let stop: (() => void) | undefined;
let host: HTMLDivElement;
let frames: Map<number, FrameRequestCallback>;
type HeaderWindow = typeof window & { __yuriNativeHeader?: (on: boolean) => Promise<number> };

const flushFrame = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  const pending = [...frames.values()];
  frames.clear();
  for (const callback of pending) callback(0);
  await new Promise((resolve) => setTimeout(resolve, 0));
};

beforeEach(() => {
  native.update.mockClear();
  native.listeners.clear();
  frames = new Map();
  let nextFrame = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(56);
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([new DOMRect(0, 0, 400, 56)] as unknown as DOMRectList);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 400, 56));
  vi.spyOn(document, 'elementFromPoint').mockImplementation(() => host.querySelector('header'));
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  stop?.();
  stop = undefined;
  host.remove();
  document.getElementById('opencode-theme-variables')?.remove();
  document.documentElement.classList.remove('light', 'dark');
  document.documentElement.removeAttribute('data-theme');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test.each([false, true])('refreshes mirror theme CSS without restarting (keyboard engaged: %s)', async (engaged) => {
  host.innerHTML = '<header class="yuri-mobile-detail-navigation"><button>Back</button></header>';
  const generator = new CSSVariableGenerator();
  generator.apply(getDefaultTheme(false));
  stop = startNativeImeHeader();
  await flushFrame();
  if (engaged) void (window as HeaderWindow).__yuriNativeHeader!(true);
  let mirrorCss = native.update.mock.calls.at(-1)![0].css!;
  expect(mirrorCss).toContain('--background:');
  const ruleCount = document.querySelector<HTMLStyleElement>('#opencode-theme-variables')!.sheet!.cssRules.length;

  for (const dark of [true, false]) {
    const previousUpdates = native.update.mock.calls.length;
    generator.apply(getDefaultTheme(dark));
    expect(document.querySelector<HTMLStyleElement>('#opencode-theme-variables')!.sheet!.cssRules.length).toBe(ruleCount);
    await flushFrame();
    expect(native.update.mock.calls.length).toBeGreaterThan(previousUpdates);
    const payload = native.update.mock.calls.at(-1)![0];
    if (payload.css !== undefined) mirrorCss = payload.css;
    expect(payload.rootClass?.split(' ')).toContain(dark ? 'dark' : 'light');
    const background = getDefaultTheme(dark).colors.surface.background;
    expect(mirrorCss.includes(`--background: ${background} !important;`)).toBe(true);
  }
});

test('refreshes CSS for a same-variant theme change and keeps header-only updates CSS-free', async () => {
  host.innerHTML = '<header class="yuri-mobile-detail-navigation"><button>Back</button></header>';
  const generator = new CSSVariableGenerator();
  const theme = getDefaultTheme(true);
  generator.apply(theme);
  stop = startNativeImeHeader();
  await flushFrame();
  const originalCss = native.update.mock.calls.at(-1)![0].css;
  const originalClass = document.documentElement.className;
  const updated = structuredClone(theme);
  updated.colors.surface.background = getDefaultTheme(false).colors.surface.background;
  generator.apply(updated);
  await flushFrame();
  expect(document.documentElement.className).toBe(originalClass);
  const payload = native.update.mock.calls.at(-1)![0];
  expect(payload.css).toBeDefined();
  expect(payload.css).not.toBe(originalCss);
  expect(payload.css?.includes(`--background: ${updated.colors.surface.background} !important;`)).toBe(true);

  native.update.mockClear();
  for (let i = 0; i < 50; i++) {
    host.querySelector('button')!.textContent = `Back ${i}`;
    await flushFrame();
  }
  expect(native.update).toHaveBeenCalledTimes(50);
  expect(native.update.mock.calls.every(([update]) => update.css === undefined)).toBe(true);
});

test.each(['input', 'textarea', 'select', '[contenteditable]'])('keeps a header containing %s in the live page during IME motion', async (control) => {
  host.innerHTML = `<section class="yuri-global-search-page"><header class="yuri-mobile-detail-navigation">${control === '[contenteditable]' ? '<div contenteditable="true"></div>' : `<${control}></${control}>`}</header></section>`;
  stop = startNativeImeHeader();
  await flushFrame();
  void (window as HeaderWindow).__yuriNativeHeader!(true);
  await flushFrame();
  expect(host.querySelector('header')!.classList.contains('yuri-native-header-source')).toBe(false);
  expect(document.documentElement.classList.contains('yuri-native-header-ready')).toBe(false);
  expect(native.update.mock.calls.some(([payload]) => payload.visible)).toBe(false);
});

test('switching from a mirrored conversation to search releases the mirror and restores it on return', async () => {
  host.innerHTML = '<div data-underlay><header class="yuri-mobile-detail-navigation"><button>Back</button></header></div>';
  stop = startNativeImeHeader();
  await flushFrame();
  const header = host.querySelector('header')!;
  expect(header.classList.contains('yuri-native-header-source')).toBe(true);
  void (window as HeaderWindow).__yuriNativeHeader!(true);
  expect(document.documentElement.classList.contains('yuri-native-header-ready')).toBe(true);
  const previousSeq = native.update.mock.calls.at(-1)![0].seq;

  const underlay = host.querySelector<HTMLElement>('[data-underlay]')!;
  underlay.inert = true;
  host.insertAdjacentHTML('beforeend', '<section class="yuri-global-search-page"><header class="yuri-mobile-detail-navigation"><input aria-label="Search" /></header></section>');
  await flushFrame();
  native.listeners.get('shown')!({ seq: previousSeq });
  expect(native.update.mock.calls.at(-1)![0].visible).toBe(false);
  expect(header.classList.contains('yuri-native-header-source')).toBe(false);
  expect(document.documentElement.classList.contains('yuri-native-header-ready')).toBe(false);
  const input = host.querySelector('input')!;
  expect(input.closest('header')!.classList.contains('yuri-native-header-source')).toBe(false);
  input.focus();
  input.value = 'matching';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await flushFrame();
  expect(document.activeElement).toBe(input);
  expect(input.value).toBe('matching');
  const updates = native.update.mock.calls.length;
  for (let i = 0; i < 50; i++) {
    host.append(document.createElement('p'));
    await flushFrame();
  }
  expect(native.update).toHaveBeenCalledTimes(updates);

  input.closest('section')!.remove();
  underlay.inert = false;
  await flushFrame();
  expect(native.update.mock.calls.at(-1)![0].visible).toBe(true);
  expect(header.classList.contains('yuri-native-header-source')).toBe(true);
});

test('a header that gains an editable field releases its existing mirror', async () => {
  host.innerHTML = '<header class="yuri-mobile-detail-navigation"><button>Back</button></header>';
  stop = startNativeImeHeader();
  await flushFrame();
  const header = host.querySelector('header')!;
  header.insertAdjacentHTML('beforeend', '<input />');
  await flushFrame();
  expect(native.update.mock.calls.at(-1)![0].visible).toBe(false);
  expect(header.classList.contains('yuri-native-header-source')).toBe(false);
});

test('non-editable headers retain native button tap replay', async () => {
  host.innerHTML = '<header class="yuri-mobile-detail-navigation"><div contenteditable="false"><button>Back</button></div></header>';
  const click = vi.fn();
  host.querySelector('button')!.addEventListener('click', click);
  stop = startNativeImeHeader();
  await flushFrame();
  void (window as HeaderWindow).__yuriNativeHeader!(true);
  native.listeners.get('tap')!({ path: '[0,0]' });
  expect(click).toHaveBeenCalledOnce();
  expect(native.update.mock.calls.at(-1)![0].visible).toBe(true);
});
