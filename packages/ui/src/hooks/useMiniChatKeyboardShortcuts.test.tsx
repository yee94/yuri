import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useMiniChatKeyboardShortcuts } from './useMiniChatKeyboardShortcuts';

const calls = vi.hoisted(() => ({ invoke: vi.fn(), draft: vi.fn(), config: vi.fn() }));
vi.mock('@/lib/desktop', () => ({ canUseElectronDesktopIPC: () => true, invokeDesktop: calls.invoke }));
vi.mock('@/lib/shortcuts', () => ({ getEffectiveShortcutCombo: (id: string) => id, eventMatchesShortcut: (event: KeyboardEvent, id: string) => event.key === id }));
vi.mock('@/stores/useConfigStore', () => ({ useConfigStore: { getState: calls.config } }));
vi.mock('@/stores/useDirectoryStore', () => ({ useDirectoryStore: (select: (value: unknown) => unknown) => select({ currentDirectory: '/workspace' }) }));
vi.mock('@/stores/useProjectsStore', () => ({ useProjectsStore: (select: (value: unknown) => unknown) => select({ getActiveProject: () => null }) }));
vi.mock('@/stores/useUIStore', () => ({ useUIStore: (select: (value: unknown) => unknown) => select({ shortcutOverrides: {} }) }));
vi.mock('@/sync/session-ui-store', () => ({ useSessionUIStore: (select: (value: unknown) => unknown) => select({ openNewSessionDraft: calls.draft }) }));
vi.mock('@/sync/selection-store', () => ({ useSelectionStore: {} }));
const Fixture = ({ assistant }: { assistant: boolean }) => { useMiniChatKeyboardShortcuts(assistant); return <textarea />; };
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.clearAllMocks(); calls.invoke.mockResolvedValue(null);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const press = async (key: string) => act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key, cancelable: true })); });

test('Assistant windows keep focus/close/new-window shortcuts without mutating coding-session drafts or models', async () => {
  await act(async () => root.render(<Fixture assistant />));
  await press('focus_input');
  expect(document.activeElement).toBe(host.querySelector('textarea'));
  for (const key of ['new_chat', 'open_model_selector', 'cycle_thinking_variant', 'cycle_favorite_model_forward']) await press(key);
  expect(calls.draft).not.toHaveBeenCalled(); expect(calls.config).not.toHaveBeenCalled();
  await press('close_context_panel_tab');
  expect(calls.invoke).toHaveBeenCalledWith('desktop_close_current_window');
  await press('new_mini_chat');
  expect(calls.invoke).toHaveBeenCalledWith('desktop_open_draft_mini_chat_window', { directory: '/workspace', projectId: null });
});

test('ordinary Mini Chat keeps its existing new-session shortcut', async () => {
  await act(async () => root.render(<Fixture assistant={false} />));
  await press('new_chat');
  expect(calls.draft).toHaveBeenCalledExactlyOnceWith({ selectedProjectId: null, directoryOverride: '/workspace', preserveDirectoryOverride: true });
});
