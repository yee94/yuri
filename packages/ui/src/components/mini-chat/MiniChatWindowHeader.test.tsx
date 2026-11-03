import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { MiniChatWindowHeader } from './MiniChatWindowHeader';

const calls = vi.hoisted(() => ({ invoke: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/desktop', () => ({ invokeDesktop: calls.invoke, isElectronShell: () => true }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/hooks/useDesktopWindowControlsLayout', () => ({ useDesktopWindowControlsLayout: () => ({ usesFramelessChrome: false, side: 'right' }) }));
vi.mock('@/components/desktop/WindowsWindowControls', () => ({ WindowsWindowControls: () => null }));
vi.mock('sonner', () => ({ toast: { error: calls.error } }));
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  calls.invoke.mockReset().mockResolvedValue({ pinned: false }); calls.error.mockReset();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const render = () => act(async () => root.render(<MiniChatWindowHeader mainWindowTarget={{ assistantID: 'a' }}>Bot</MiniChatWindowHeader>));
const pin = () => host.querySelector<HTMLButtonElement>('[aria-pressed]')!;
const main = () => host.querySelector<HTMLButtonElement>('[aria-label="miniChat.actions.openMainAria"]')!;

test('uses confirmed pin state, serializes clicks and retains state on failure', async () => {
  await render();
  let resolve!: (value: { pinned: boolean }) => void;
  calls.invoke.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  await act(async () => { pin().click(); pin().click(); });
  expect(pin().disabled).toBe(true);
  expect(calls.invoke.mock.calls.filter(([command]) => command === 'desktop_set_window_pinned')).toHaveLength(1);
  await act(async () => resolve({ pinned: true }));
  expect(pin().getAttribute('aria-pressed')).toBe('true');
  calls.invoke.mockRejectedValueOnce(new Error('failed'));
  await act(async () => pin().click());
  expect(pin().getAttribute('aria-pressed')).toBe('true');
  expect(pin().disabled).toBe(false);
  expect(calls.error).toHaveBeenCalledWith('miniChat.actions.failed');
});

test('late initial state cannot overwrite an explicit pin change', async () => {
  let initial!: (value: { pinned: boolean }) => void;
  calls.invoke.mockImplementationOnce(() => new Promise((done) => { initial = done; }));
  await render();
  calls.invoke.mockResolvedValueOnce({ pinned: true });
  await act(async () => pin().click());
  await act(async () => initial({ pinned: false }));
  expect(pin().getAttribute('aria-pressed')).toBe('true');
});

test('closes only after confirmed main-window handoff and preserves the Mini Chat on failure', async () => {
  await render();
  calls.invoke.mockResolvedValueOnce({ focused: false });
  await act(async () => main().click());
  expect(calls.invoke).not.toHaveBeenCalledWith('desktop_close_current_window');
  calls.invoke.mockRejectedValueOnce(new Error('failed'));
  await act(async () => main().click());
  expect(calls.invoke).not.toHaveBeenCalledWith('desktop_close_current_window');
  calls.invoke.mockResolvedValueOnce({ focused: true });
  await act(async () => main().click());
  expect(calls.invoke).toHaveBeenCalledWith('desktop_focus_main_window', { assistantID: 'a' });
  expect(calls.invoke).toHaveBeenCalledWith('desktop_close_current_window');
});
