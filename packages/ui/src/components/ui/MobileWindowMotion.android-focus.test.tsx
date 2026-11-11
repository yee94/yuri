import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { useNativeMobileChrome } from '@/apps/MobileApp';
import { I18nProvider } from '@/lib/i18n';
import { MobileModelPickerPanel } from '../model-picker/MobileModelPickerPanel';
import { mobileWindowStack } from './MobileWindowStack';

// MobileApp imports stores that initialize server state. Keep those unrelated
// requests inside the test while exercising the real native chrome hook.
vi.mock('@/lib/runtime-fetch', () => ({
  runtimeFetch: async () => new Response('{}', { headers: { 'Content-Type': 'application/json' } }),
}));

const keyboard = vi.hoisted(() => ({
  listeners: new Map<string, (info: { keyboardHeight: number }) => void>(),
  setImeSync: vi.fn(async (_options: { enabled: boolean }) => undefined),
}));
vi.mock('@/mobile/nativeImeHeader', () => ({
  nativeImeHeader: { setImeSync: keyboard.setImeSync },
  startNativeImeHeader: () => () => undefined,
}));
vi.mock('@capacitor/keyboard', () => ({ Keyboard: {
  setAccessoryBarVisible: async () => undefined,
  addListener: async (event: string, handler: (info: { keyboardHeight: number }) => void) => {
    keyboard.listeners.set(event, handler);
    return { remove: async () => { keyboard.listeners.delete(event); } };
  },
} }));
vi.mock('@capacitor/status-bar', () => ({ StatusBar: {
  setOverlaysWebView: async () => undefined, setBackgroundColor: async () => undefined,
  setStyle: async () => undefined, show: async () => undefined,
}, Style: { Dark: 'DARK', Light: 'LIGHT' } }));
vi.mock('@capacitor/app', () => ({ App: { addListener: async () => ({ remove: async () => undefined }) } }));

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.useFakeTimers();
  keyboard.listeners.clear();
  keyboard.setImeSync.mockClear();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal('Capacitor', { isNativePlatform: () => true, getPlatform: () => 'android' });
  vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
    matches: query.includes('prefers-reduced-motion'), media: query, onchange: null,
    addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(),
    removeEventListener: vi.fn(), dispatchEvent: () => true,
  }));
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.getElementById('mobile-overlay-root')?.remove();
  document.documentElement.classList.remove('yuri-native-app-active');
  document.documentElement.classList.remove('yuri-native-ios-composer');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe.each(['ios', 'android'])('%s native IME lift ownership', (platform) => {
  beforeEach(() => {
    vi.stubGlobal('Capacitor', { isNativePlatform: () => true, getPlatform: () => platform });
  });

  test('search and ordinary question inputs never arm whole-page translation', async () => {
    await act(async () => root.render(<Host initialFocus="settings" />));
    expect(keyboard.setImeSync).toHaveBeenLastCalledWith({ enabled: false });
    expect(document.documentElement.classList.contains('yuri-native-ime')).toBe(false);
    await act(async () => keyboard.listeners.get('keyboardWillShow')?.({ keyboardHeight: 300 }));
    expect(document.documentElement.style.getPropertyValue('--yuri-kb-layout')).toBe('0px');
    const question = document.createElement('textarea');
    container.append(question);
    await act(async () => question.focus());
    expect(keyboard.setImeSync).toHaveBeenLastCalledWith({ enabled: false });
    expect(document.documentElement.classList.contains('yuri-native-ime')).toBe(false);
  });

  test('composer to search transfer releases lift without waiting for another keyboard frame', async () => {
    await act(async () => root.render(<Host initialFocus="composer" />));
    expect(keyboard.setImeSync).toHaveBeenLastCalledWith({ enabled: true });
    await ime(true, 'native');
    const search = container.querySelector<HTMLInputElement>('input')!;
    await act(async () => search.focus());
    expect(document.activeElement).toBe(search);
    expect(keyboard.setImeSync).toHaveBeenLastCalledWith({ enabled: false });
    expect(document.documentElement.classList.contains('yuri-native-ime')).toBe(false);
    expect(document.documentElement.classList.contains('yuri-keyboard-open')).toBe(false);
    expect(document.documentElement.style.getPropertyValue('--yuri-keyboard-inset')).toBe('300px');
    await act(async () => container.querySelector<HTMLTextAreaElement>('textarea')!.focus());
    expect(keyboard.setImeSync).toHaveBeenLastCalledWith({ enabled: true });
    expect(document.documentElement.style.getPropertyValue('--yuri-keyboard-inset')).toBe('0px');
  });

  test('blur and cancelled dismiss retain native choreography; typing does not republish ownership', async () => {
    await act(async () => root.render(<Host initialFocus="composer" />));
    const composer = container.querySelector<HTMLTextAreaElement>('textarea')!;
    await ime(true, 'native');
    keyboard.setImeSync.mockClear();
    await act(async () => {
      for (let index = 0; index < 50; index++) composer.dispatchEvent(new Event('input', { bubbles: true }));
      composer.blur();
    });
    expect(keyboard.setImeSync).not.toHaveBeenCalled();
    await ime(false, 'native', 'start');
    await act(async () => composer.focus());
    await ime(true, 'native');
    expect(document.activeElement).toBe(composer);
    expect(keyboard.setImeSync).not.toHaveBeenCalled();
  });

  test('no focused input leaves native lift off and unmount releases the owner', async () => {
    await act(async () => root.render(<Host />));
    expect(keyboard.setImeSync).toHaveBeenLastCalledWith({ enabled: false });
    await act(async () => container.querySelector<HTMLTextAreaElement>('textarea')!.focus());
    expect(keyboard.setImeSync).toHaveBeenLastCalledWith({ enabled: true });
    const detachedSearch = container.querySelector<HTMLInputElement>('input')!;
    const anotherField = document.createElement('input');
    document.body.append(anotherField);
    await act(async () => root.render(null));
    expect(keyboard.setImeSync).toHaveBeenLastCalledWith({ enabled: false });
    keyboard.setImeSync.mockClear();
    anotherField.focus();
    anotherField.remove();
    expect(detachedSearch.isConnected).toBe(false);
    expect(keyboard.setImeSync).not.toHaveBeenCalled();
  });

  if (platform === 'ios') test('native composer yields only to the bottom Side Chat, never search', async () => {
    document.documentElement.classList.add('yuri-native-ios-composer');
    await act(async () => root.render(<Host initialFocus="composer" />));
    expect(keyboard.setImeSync).toHaveBeenLastCalledWith({ enabled: false });
    const sideChat = document.createElement('form');
    sideChat.className = 'yuri-mobile-composer';
    sideChat.dataset.btwComposer = '';
    const field = document.createElement('textarea');
    sideChat.append(field);
    container.append(sideChat);
    await act(async () => field.focus());
    expect(keyboard.setImeSync).toHaveBeenLastCalledWith({ enabled: true });
    await act(async () => container.querySelector<HTMLInputElement>('input')!.focus());
    expect(keyboard.setImeSync).toHaveBeenLastCalledWith({ enabled: false });
  });

  if (platform === 'ios') test('native composer ownership changes release the web lift before another focus', async () => {
    await act(async () => root.render(<Host initialFocus="composer" />));
    expect(keyboard.setImeSync).toHaveBeenLastCalledWith({ enabled: true });
    await act(async () => document.documentElement.classList.add('yuri-native-ios-composer'));
    expect(keyboard.setImeSync).toHaveBeenLastCalledWith({ enabled: false });
    await act(async () => document.documentElement.classList.remove('yuri-native-ios-composer'));
    expect(keyboard.setImeSync).toHaveBeenLastCalledWith({ enabled: true });
  });
});

function Host({ initialFocus }: { initialFocus?: 'settings' | 'composer' }) {
  useNativeMobileChrome();
  const [open, setOpen] = React.useState(false);
  return <I18nProvider>
    <input data-testid="settings-field" autoFocus={initialFocus === 'settings'} />
    <div className="yuri-mobile-composer">
      <textarea data-testid="composer-field" autoFocus={initialFocus === 'composer'} />
    </div>
    <button data-testid="model-trigger" onClick={() => setOpen(true)}>Choose model</button>
    <MobileModelPickerPanel open={open} onClose={() => setOpen(false)}
      selectedProviderID="" selectedModelID="" resolveSelectedVariant={() => undefined}
      onSelect={() => setOpen(false)} providers={[]} favoriteModels={[]} recentModels={[]}
      isFavorite={() => false} onToggleFavorite={() => undefined} />
  </I18nProvider>;
}

async function ime(open: boolean, payload: 'native' | 'detail', phase: 'start' | 'settled' = 'settled', height = 300) {
  await act(async () => {
    const data = { open, height: open ? height : 0, phase, durationMs: 250, nativeResize: true };
    // Native Bridge.triggerJSEvent copies payload fields directly onto Event.
    window.dispatchEvent(payload === 'native'
      ? Object.assign(new Event('yuri:ime-state'), data)
      : new CustomEvent('yuri:ime-state', { detail: data }));
  });
}

describe('Android native IME close during Settings picker focus transfer', () => {
  async function openPicker() {
    await act(async () => root.render(<Host />));
    const previous = document.querySelector<HTMLInputElement>('[data-testid="settings-field"]')!;
    await act(async () => previous.focus());
    expect(document.documentElement.style.getPropertyValue('--yuri-keyboard-inset')).toBe('0px');
    await ime(true, 'native');
    await act(async () => {
      const trigger = document.querySelector<HTMLElement>('[data-testid="model-trigger"]')!;
      trigger.focus();
      trigger.click();
    });
    return document.querySelector<HTMLInputElement>('#mobile-overlay-root input')!;
  }

  test.each(['native', 'detail'] as const)('retains the new search focus when the previous IME close arrives (%s)', async (payload) => {
    const input = await openPicker();
    await act(async () => input.focus());
    expect(document.activeElement).toBe(input);
    const blur = vi.spyOn(input, 'blur');
    const surface = input.closest('[data-yuri-motion-id]');
    const top = mobileWindowStack.getSnapshot();
    await ime(false, payload);
    expect(input.isConnected).toBe(true);
    expect(input.closest('[data-yuri-motion-id]')).toBe(surface);
    expect(surface?.parentElement?.getAttribute('data-mobile-overlay-active')).toBe('true');
    expect(mobileWindowStack.getSnapshot()).toBe(top);
    expect(document.activeElement === input,
      `active=${document.activeElement?.tagName}; input.blur calls=${blur.mock.calls.length}; sheet and stack unchanged`,
    ).toBe(true);
    expect(blur).not.toHaveBeenCalled();
    expectClosedGeometry();
    // A repeated hide exercises markClosed's already-closed branch while the
    // same search field retains focus.
    await ime(false, payload);
    expect(document.activeElement === input).toBe(true);
    expect(blur).not.toHaveBeenCalled();
    expectClosedGeometry();
  });

  function expectClosedGeometry() {
    const html = document.documentElement;
    for (const name of ['--yuri-keyboard-inset', '--yuri-kb-layout', '--yuri-kb-scroll-inset']) {
      expect(html.style.getPropertyValue(name)).toBe('0px');
    }
    expect(html.classList.contains('yuri-keyboard-open')).toBe(false);
  }

  test.each(['settings', 'composer'] as const)('scopes a hide before the hook observed focus to its composer (%s)', async (initialFocus) => {
    // React autofocus occurs before the async native listener registration.
    await act(async () => root.render(<Host initialFocus={initialFocus} />));
    const field = document.querySelector<HTMLElement>(`[data-testid="${initialFocus}-field"]`)!;
    expect(document.activeElement === field).toBe(true);
    expect(document.documentElement.style.getPropertyValue('--yuri-keyboard-inset')).toBe('0px');
    const blur = vi.spyOn(field, 'blur');
    await ime(false, 'native');
    expect(document.activeElement === field).toBe(initialFocus === 'settings');
    expect(blur).toHaveBeenCalledTimes(initialFocus === 'composer' ? 1 : 0);
  });

  test('clears ordinary Settings field geometry while retaining DOM focus', async () => {
    await act(async () => root.render(<Host />));
    const input = document.querySelector<HTMLElement>('[data-testid="settings-field"]')!;
    await act(async () => input.focus());
    await ime(true, 'native');
    expect(document.documentElement.style.getPropertyValue('--yuri-keyboard-inset')).toBe('300px');
    await ime(false, 'native');
    expect(document.activeElement === input).toBe(true);
    expectClosedGeometry();
  });

  test('native composer dismissal blurs once, clears geometry, and permits the next focus', async () => {
    await act(async () => root.render(<Host />));
    const composer = document.querySelector<HTMLElement>('[data-testid="composer-field"]')!;
    await act(async () => composer.focus());
    await ime(true, 'native');
    expect(document.documentElement.classList.contains('yuri-keyboard-open')).toBe(true);
    const blur = vi.spyOn(composer, 'blur');
    await ime(false, 'native');
    expect(document.activeElement === document.body).toBe(true);
    expect(blur).toHaveBeenCalledTimes(1);
    expectClosedGeometry();
    await ime(false, 'native');
    await act(async () => vi.advanceTimersByTimeAsync(120));
    expect(blur).toHaveBeenCalledTimes(1);
    expect(document.documentElement.classList.contains('yuri-kb-animating')).toBe(false);
    await act(async () => composer.focus());
    expect(document.activeElement === composer).toBe(true);
    expect(document.documentElement.classList.contains('yuri-keyboard-open')).toBe(false);
    await ime(true, 'native');
    expect(document.documentElement.classList.contains('yuri-keyboard-open')).toBe(true);
  });

  test('focus and changed IME heights never apply a second web inset or transform', async () => {
    await act(async () => root.render(<Host />));
    const composer = document.querySelector<HTMLElement>('[data-testid="composer-field"]')!;
    const mover = composer.parentElement!;
    const storage = vi.spyOn(Storage.prototype, 'setItem');
    await act(async () => composer.focus());
    for (const height of [280, 420, 320]) {
      await ime(true, 'native', 'start', height);
      expect(document.documentElement.classList.contains('yuri-kb-animating')).toBe(true);
      await ime(true, 'native', 'settled', height);
      for (const name of ['--yuri-keyboard-inset', '--yuri-kb-layout', '--yuri-kb-scroll-inset']) {
        expect(document.documentElement.style.getPropertyValue(name)).toBe('0px');
      }
      expect(mover.style.transform).toBe('');
      expect(mover.style.transition).toBe('');
    }
    expect(storage.mock.calls.some(([key]) => String(key).includes('ImeHeight'))).toBe(false);
  });

  test('cancelled native back retains composer focus and settled-open state', async () => {
    await act(async () => root.render(<Host />));
    const composer = document.querySelector<HTMLElement>('[data-testid="composer-field"]')!;
    await act(async () => composer.focus());
    await ime(true, 'native');
    const blur = vi.spyOn(composer, 'blur');
    await ime(false, 'native', 'start');
    expect(document.activeElement).toBe(composer);
    await ime(true, 'native');
    expect(document.activeElement).toBe(composer);
    expect(blur).not.toHaveBeenCalled();
    expect(document.documentElement.classList.contains('yuri-keyboard-open')).toBe(true);
    expect(document.documentElement.classList.contains('yuri-kb-animating')).toBe(false);
  });

  test('retains search focus when native hide arrives before the new field focuses', async () => {
    const input = await openPicker();
    await ime(false, 'native');
    await act(async () => input.focus());
    await ime(true, 'native');
    expect(document.activeElement === input).toBe(true);
  });

  test('keeps input touch jitter uncancelled and focused without a native hide', async () => {
    const input = await openPicker();
    function touch(type: string, y: number) {
      const point = { identifier: 1, clientX: 10, clientY: y, target: input };
      const touches = Object.assign(type === 'touchend' ? [] : [point], {
        item: (index: number) => type === 'touchend' ? null : index === 0 ? point : null,
      });
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.assign(event, { touches, changedTouches: Object.assign([point], { item: () => point }) });
      input.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    await act(async () => {
      touch('touchstart', 10);
      touch('touchmove', 22);
      touch('touchend', 22);
      input.focus();
    });
    await ime(true, 'native');
    expect(document.activeElement === input).toBe(true);
  });
});
