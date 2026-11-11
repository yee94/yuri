import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { YuriVisualSettings } from './YuriVisualSettings';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  error: vi.fn(),
  dockBadge: vi.fn(),
  ui: { settingsFocusItemId: null as string | null, isSettingsDialogOpen: false },
}));
vi.mock('@/lib/desktop', () => ({
  invokeDesktop: mocks.invoke,
  isDesktopShell: () => true,
  isVSCodeRuntime: () => false,
  isWebRuntime: () => false,
}));
vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key, locale: 'en', locales: [], label: (key: string) => key }),
}));
vi.mock('@/contexts/useThemeSystem', () => ({ useThemeSystem: () => ({ availableThemes: [] }) }));
vi.mock('@/lib/device', () => ({ useDeviceInfo: () => ({ isMobile: false }) }));
vi.mock('@/hooks/usePwaDetection', () => ({ usePwaDetection: () => ({ browserTab: false }) }));
vi.mock('@/stores/useUIStore', () => ({
  useUIStore: Object.assign((selector: (state: Record<string, unknown>) => unknown) => selector({
    dockBadgeEnabled: false,
    setDockBadgeEnabled: mocks.dockBadge,
    showReasoningTraces: true,
    ...mocks.ui,
  }), {
    getState: () => mocks.ui,
    setState: (patch: Partial<typeof mocks.ui>) => Object.assign(mocks.ui, patch),
  }),
}));
vi.mock('@/stores/useConfigStore', () => ({ useConfigStore: (selector: (state: object) => unknown) => selector({}) }));
vi.mock('@/stores/useSidebarBrandStore', () => ({ useSidebarBrandStore: (selector: (state: object) => unknown) => selector({ sidebarBrandName: 'My Studio' }) }));
vi.mock('@/stores/messageQueueStore', () => ({ useMessageQueueStore: (selector: (state: object) => unknown) => selector({}) }));
vi.mock('@/lib/iosNativeUi', () => ({
  canShowIosNativeUiSetting: () => false,
  useIosNativeUiStore: (selector: (state: object) => unknown) => selector({}),
}));
vi.mock('@/lib/runtime-fetch', () => ({ runtimeFetch: vi.fn() }));
vi.mock('@/lib/persistence', () => ({ updateDesktopSettings: vi.fn() }));
vi.mock('@/components/ui', () => ({ toast: { error: mocks.error } }));
vi.mock('@/sync/transcript-durable-store-runtime', () => ({ clearCurrentRuntimeTranscriptCache: vi.fn() }));
vi.mock('./QuestionAutoDelegateSetting', () => ({ QuestionAutoDelegateSetting: () => null }));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.ui.settingsFocusItemId = null;
  mocks.ui.isSettingsDialogOpen = false;
  mocks.invoke.mockResolvedValue({ enabled: true, requiresRestart: true });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  window.__YURI_ELECTRON__ = { macVibrancy: false, macVibrancySupported: true };
  Object.assign(window, { __YURI_PLATFORM__: 'darwin' });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  delete window.__YURI_ELECTRON__;
  Reflect.deleteProperty(window, '__YURI_PLATFORM__');
  vi.unstubAllGlobals();
});

const renderSettings = async (visibleSettings: React.ComponentProps<typeof YuriVisualSettings>['visibleSettings'] = ['theme']) => {
  await act(async () => root.render(<TooltipProvider><YuriVisualSettings visibleSettings={visibleSettings} /></TooltipProvider>));
};
const option = (item: string, enabled: boolean) => host.querySelectorAll<HTMLButtonElement>(`[data-settings-item="${item}"] button[role="radio"]`)[enabled ? 1 : 0]!;
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]:not([data-ending-style])');
const dialogButton = (key: string) => [...dialog()!.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === key)!;

test('a logo focus request selects the brand name once and does not steal later focus', async () => {
  mocks.ui.settingsFocusItemId = 'appearance.sidebar-brand';
  mocks.ui.isSettingsDialogOpen = true;
  await renderSettings(['sidebarBrand']);
  await act(async () => { await new Promise(resolve => window.requestAnimationFrame(resolve)); });
  const input = host.querySelector<HTMLInputElement>('[data-settings-item="appearance.sidebar-brand"] input')!;
  expect(document.activeElement).toBe(input);
  expect(input.selectionStart).toBe(0);
  expect(input.selectionEnd).toBe('My Studio'.length);
  expect(mocks.ui.settingsFocusItemId).toBeNull();
  input.blur();
  await renderSettings(['sidebarBrand']);
  expect(document.activeElement).not.toBe(input);
});

test('closing before the deferred focus cancels the request without moving focus', async () => {
  const frames: FrameRequestCallback[] = [];
  const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { frames.push(callback); return frames.length; });
  mocks.ui.settingsFocusItemId = 'appearance.sidebar-brand';
  mocks.ui.isSettingsDialogOpen = true;
  try {
    await renderSettings(['sidebarBrand']);
    mocks.ui.isSettingsDialogOpen = false;
    await act(async () => frames.forEach(callback => callback(0)));
    expect(document.activeElement).not.toBe(host.querySelector('input'));
  } finally { raf.mockRestore(); }
});

test('navigation keeps the editor keymap without an editor toolbar preference', async () => {
  await renderSettings(['fileEditorKeymap']);
  expect(host.querySelector('[data-settings-item="appearance.file-editor-keymap"]')).not.toBeNull();
  expect(host.querySelector('[data-settings-item="appearance.expanded-editor-toolbar"]')).toBeNull();
  expect(host.textContent).not.toContain('settings.yuri.visual.field.expandedEditorToolbar');
});

test('confirms restart on switching, keeps the current value on cancel or Escape, and has no save action', async () => {
  await renderSettings();
  await act(async () => option('appearance.window-transparency', true).click());
  expect(dialog()).not.toBeNull();
  expect(dialog()!.textContent).toContain('settings.yuri.visual.vibrancy.confirmDescription');
  expect(option('appearance.window-transparency', false).getAttribute('aria-checked')).toBe('true');
  expect(host.textContent).not.toContain('settings.yuri.visual.actions.saveAndRestart');
  expect(mocks.invoke).not.toHaveBeenCalled();
  await act(async () => dialogButton('settings.common.actions.cancel').click());
  expect(dialog()).toBeNull();
  expect(mocks.invoke).not.toHaveBeenCalled();
  expect(option('appearance.window-transparency', false).getAttribute('aria-checked')).toBe('true');
  await act(async () => option('appearance.window-transparency', true).click());
  await act(async () => dialog()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(dialog()).toBeNull();
  expect(mocks.invoke).not.toHaveBeenCalled();
});

test.each([false, true])('only confirmation persists the requested value and restarts (initial %s)', async (enabled) => {
  window.__YURI_ELECTRON__!.macVibrancy = enabled;
  let resolve!: (value: { enabled: boolean; requiresRestart: boolean }) => void;
  mocks.invoke.mockReturnValue(new Promise((done) => { resolve = done; }));
  await renderSettings();
  await act(async () => option('appearance.window-transparency', !enabled).click());
  expect(dialog()).not.toBeNull();
  const confirm = dialogButton('settings.yuri.visual.vibrancy.confirmRestart');
  await act(async () => confirm.click());
  expect(mocks.invoke.mock.calls).toEqual([['desktop_set_vibrancy', { enabled: !enabled }]]);
  expect(confirm.disabled).toBe(true);
  expect(dialogButton('settings.common.actions.cancel').disabled).toBe(true);
  expect(option('appearance.window-transparency', !enabled).disabled).toBe(true);
  await act(async () => dialog()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(dialog()).not.toBeNull();
  await act(async () => confirm.click());
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
  await act(async () => resolve({ enabled: !enabled, requiresRestart: true }));
  expect(mocks.error).not.toHaveBeenCalled();
});

test.each(['write failure', 'missing bridge'])('%s preserves the current value and allows confirmation to be retried', async (failure) => {
  if (failure === 'write failure') mocks.invoke.mockRejectedValueOnce(new Error('write failed'));
  else mocks.invoke.mockResolvedValueOnce(null);
  await renderSettings();
  await act(async () => option('appearance.window-transparency', true).click());
  expect(dialog()).not.toBeNull();
  await act(async () => dialogButton('settings.yuri.visual.vibrancy.confirmRestart').click());
  expect(mocks.error).toHaveBeenCalledWith('settings.yuri.visual.vibrancy.failed');
  expect(option('appearance.window-transparency', false).getAttribute('aria-checked')).toBe('true');
  expect(dialogButton('settings.yuri.visual.vibrancy.confirmRestart').disabled).toBe(false);
  await act(async () => dialogButton('settings.yuri.visual.vibrancy.confirmRestart').click());
  expect(mocks.invoke).toHaveBeenCalledTimes(2);
});

test('appearance and chat switches use the right value column without duplicate settings', async () => {
  await renderSettings(['theme', 'sessionAssist', 'reasoning', 'subagentReadOnlyBanner', 'collapsibleUserMessages', 'showAssistantTps', 'showSubagentTaskDetails', 'persistDraft', 'inputSpellcheck']);
  for (const control of host.querySelectorAll('[data-slot="settings-switch"]')) {
    expect(control.closest('[data-settings-value]'), control.getAttribute('aria-label') ?? '').not.toBeNull();
  }
  expect(host.querySelectorAll('[data-settings-item="chat.subagent-task-details"]')).toHaveLength(1);
  await act(async () => option('appearance.dock-badge', true).click());
  expect(mocks.dockBadge.mock.calls).toEqual([[true]]);
  expect(mocks.invoke).not.toHaveBeenCalled();
});
