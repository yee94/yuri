import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useUIStore } from '@/stores/useUIStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionNavigationStore } from '@/stores/useSessionNavigationStore';
import * as worktreeCreator from '@/lib/worktreeSessionCreator';
import { locationKey } from '@/lib/remote-projects/location';
import { useTerminalStore } from '@/stores/useTerminalStore';
import { setActiveChatInputSurface } from '@/components/chat/activeChatInputSurface';
import type { ChatInputSurface } from '@/components/chat/chatInputSurface';
import { useKeyboardShortcuts } from './useKeyboardShortcuts';

const mocks = vi.hoisted(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { headers: { 'Content-Type': 'application/json' } })));
  return { cycle: vi.fn(), ipc: vi.fn(), error: vi.fn() };
});
vi.mock('@/lib/desktop', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/desktop')>(),
  canUseElectronDesktopIPC: () => true,
  invokeDesktop: mocks.ipc,
}));
vi.mock('@/components/ui', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/components/ui')>(), toast: { error: mocks.error },
}));
vi.mock('@/lib/i18n', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/i18n')>(),
  useI18n: () => ({ t: (key: string) => key }),
}));
vi.mock('@/contexts/useThemeSystem', () => ({
  useThemeSystem: () => ({ themeMode: 'dark', setThemeMode: vi.fn() }),
}));
vi.mock('@/hooks/useAssistantStatus', () => ({
  useAssistantStatus: () => ({ working: { canAbort: false } }),
}));

const surface: ChatInputSurface = {
  kind: 'primary', surfaceID: 'primary', active: true,
  sessionID: 'session-input', directory: '/workspace',
  draftKey: { transportIdentity: 'local', owner: { kind: 'session', ownerID: 'session-input' } },
  transportIdentity: 'local', runtimeGeneration: 1,
  deliveryTarget: { kind: 'primary' },
  selection: { value: { agent: 'build' }, flush: async () => {} },
  backend: {
    send: async () => {}, sendQueued: async () => {}, create: async () => {},
    compact: async () => {}, abort: async () => {},
  },
  shortcuts: { cycle: mocks.cycle, new: () => {}, abort: () => {}, submit: () => {} },
};

let root: Root;
let textarea: HTMLTextAreaElement;
function Harness() {
  useKeyboardShortcuts();
  return <textarea data-chat-input="true" />;
}
beforeEach(async () => {
  useProjectsStore.setState({ projects: [], activeProjectId: null });
  useSessionNavigationStore.setState({ remoteSession: null });
  useUIStore.setState({ ...useUIStore.getInitialState(), activeMainTab: 'chat', shortcutOverrides: {} });
  useSessionUIStore.setState({ ...useSessionUIStore.getInitialState(), currentSessionId: 'session-input' });
  setActiveChatInputSurface(surface);
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root.render(<Harness />));
  textarea = host.querySelector('textarea')!;
  textarea.focus();
});
afterEach(async () => {
  await act(async () => root.unmount());
  setActiveChatInputSurface(null);
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  mocks.cycle.mockClear();
  mocks.ipc.mockClear();
  mocks.error.mockClear();
});
afterAll(() => vi.unstubAllGlobals());

async function press(init: KeyboardEventInit) {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  await act(async () => { textarea.dispatchEvent(event); });
  return event;
}

test('typing Tab or inserting a tab character does not cycle agents', async () => {
  for (const [key, code] of [['T', 'KeyT'], ['a', 'KeyA'], ['b', 'KeyB']]) {
    expect((await press({ key, code, shiftKey: key === 'T' })).defaultPrevented).toBe(false);
  }
  for (const [inputType, data] of [['insertText', 'Tab'], ['insertFromPaste', '\t']]) {
    await act(async () => {
      textarea.value += data;
      textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType, data }));
    });
  }
  expect(textarea.value).toBe('Tab\t');
  expect(mocks.cycle).not.toHaveBeenCalled();
});

test.each([
  { isComposing: true },
  { keyCode: 229 },
])('IME Tab stays with text input (%j)', async (composition) => {
  for (let index = 0; index < 50; index += 1) {
    const event = await press({ key: 'Tab', code: 'Tab', ...composition });
    expect(event.defaultPrevented).toBe(false);
  }
  expect(mocks.cycle).not.toHaveBeenCalled();
});

test('Tab and Shift+Tab shortcuts still cycle once in each direction', async () => {
  expect((await press({ key: 'Tab', code: 'Tab' })).defaultPrevented).toBe(true);
  expect((await press({ key: 'Tab', code: 'Tab', shiftKey: true })).defaultPrevented).toBe(true);
  expect(mocks.cycle.mock.calls).toEqual([[1], [-1]]);
});

test('a Tab consumed by the input never cycles again in the global listener', async () => {
  textarea.addEventListener('keydown', (event) => event.preventDefault(), { once: true });
  await press({ key: 'Tab', code: 'Tab' });
  expect(mocks.cycle).not.toHaveBeenCalled();
});

async function selectRemote(hubId: string | undefined = 'hub') {
  const project = { id: 'ref-b', path: '/remote', hostId: 'b', hubId, addedAt: 1, lastOpenedAt: 1 };
  await act(async () => useProjectsStore.setState({ projects: [project], activeProjectId: project.id }));
  return project;
}

test.each(['new_chat', 'leader'] as const)('%s opens a remote worktree draft despite retained local session and mounted local surface', async (shortcut) => {
  const project = await selectRemote();
  useSessionNavigationStore.getState().openRemoteSession(project, { hubId: 'hub', hostId: 'b', directory: '/remote-worktree' }, 'same-id');
  const localDraft = vi.spyOn(useSessionUIStore.getState(), 'openNewSessionDraft');
  if (shortcut === 'leader') {
    await press({ key: 'x', ctrlKey: true });
    await press({ key: 'n' });
  } else {
    await act(async () => useUIStore.getState().setShortcutOverride('new_chat', 'ctrl+n'));
    await press({ key: 'n', ctrlKey: true });
  }
  expect(useSessionNavigationStore.getState().remoteSession).toMatchObject({ projectId: 'ref-b', sessionId: null,
    location: { hubId: 'hub', hostId: 'b', directory: '/remote-worktree' } });
  expect(localDraft).not.toHaveBeenCalled();
  expect(useSessionUIStore.getState().currentSessionId).toBe('session-input');
  expect(mocks.ipc).not.toHaveBeenCalled();
});

test('remote MiniChat rejects with an explicit Host reason and never calls local IPC', async () => {
  await selectRemote();
  await act(async () => useUIStore.getState().setShortcutOverride('new_mini_chat', 'ctrl+shift+n'));
  expect((await press({ key: 'n', ctrlKey: true, shiftKey: true })).defaultPrevented).toBe(true);
  expect(mocks.ipc).not.toHaveBeenCalled();
  expect(mocks.error.mock.calls[0][1].description).toBe('remoteProjects.miniChatUnsupportedReason');
});

test('new chat without a mounted surface still goes to the selected remote project root', async () => {
  await selectRemote();
  setActiveChatInputSurface(null);
  await act(async () => useUIStore.getState().setShortcutOverride('new_chat', 'ctrl+n'));
  const localDraft = vi.spyOn(useSessionUIStore.getState(), 'openNewSessionDraft');
  await press({ key: 'n', ctrlKey: true });
  expect(useSessionNavigationStore.getState().remoteSession).toMatchObject({ sessionId: null,
    location: { hubId: 'hub', hostId: 'b', directory: '/remote' } });
  expect(localDraft).not.toHaveBeenCalled();
});

test('missing remote Hub identity fails closed rather than opening a local draft', async () => {
  await selectRemote('');
  await act(async () => useUIStore.getState().setShortcutOverride('new_chat', 'ctrl+n'));
  const localDraft = vi.spyOn(useSessionUIStore.getState(), 'openNewSessionDraft');
  await press({ key: 'n', ctrlKey: true });
  expect(useSessionNavigationStore.getState().remoteSession).toBeNull();
  expect(localDraft).not.toHaveBeenCalled();
  expect(mocks.error).toHaveBeenCalledWith('remoteProjects.host-unavailable');
});

test('worktree shortcut reaches the production worktree entrypoint, not a Hub draft', async () => {
  await selectRemote();
  await act(async () => useUIStore.getState().setShortcutOverride('new_chat_worktree', 'ctrl+alt+shift+w'));
  const create = vi.spyOn(worktreeCreator, 'createWorktreeSession').mockResolvedValue('/remote-worktree');
  const localDraft = vi.spyOn(useSessionUIStore.getState(), 'openNewSessionDraft');
  expect((await press({ key: 'w', ctrlKey: true, altKey: true, shiftKey: true })).defaultPrevented).toBe(true);
  expect(create).toHaveBeenCalledOnce();
  expect(localDraft).not.toHaveBeenCalled();
  expect(mocks.ipc).not.toHaveBeenCalled();
});

test('close panel shortcut uses the remote worktree Location key and never falls through to closing the window', async () => {
  const project = await selectRemote();
  const location = { hubId: 'hub', hostId: 'b', directory: '/remote-worktree' };
  useSessionNavigationStore.getState().openRemoteSession(project, location, 'remote-session');
  const close = vi.spyOn(useUIStore.getState(), 'closeActiveContextPanelTab').mockReturnValue(true);
  await act(async () => useUIStore.getState().setShortcutOverride('close_context_panel_tab', 'ctrl+w'));
  await press({ key: 'w', ctrlKey: true });
  expect(close).toHaveBeenCalledWith(locationKey(location));
  expect(mocks.ipc).not.toHaveBeenCalled();
});

test('new terminal shortcut indexes tabs by remote Location, not the physical path shared with Hub', async () => {
  const project = await selectRemote();
  const location = { hubId: 'hub', hostId: 'b', directory: '/remote' };
  useSessionNavigationStore.getState().openRemoteSession(project, location, null);
  useTerminalStore.setState({ sessions: new Map() });
  await act(async () => useUIStore.getState().setShortcutOverride('open_new_terminal', 'ctrl+alt+shift+t'));
  await press({ key: 't', ctrlKey: true, altKey: true, shiftKey: true });
  expect(useTerminalStore.getState().getDirectoryState(locationKey(location))?.tabs).toHaveLength(1);
  expect(useTerminalStore.getState().getDirectoryState('/remote')).toBeUndefined();
});
