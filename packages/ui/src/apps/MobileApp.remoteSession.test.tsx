import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { useEvent } from '@reactuses/core';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'MobileApp.tsx'), 'utf8');
const refreshSource = source.slice(source.indexOf('  const transcriptRefreshFlight ='), source.indexOf('  // Re-bind when the chat subtree'));
const overflowSource = source.slice(source.indexOf('  const overflowItems:'), source.indexOf('\n  return (\n    <MobileAutoReadProvider'));
const parentSource = source.slice(source.indexOf('  const returnToParent ='), source.indexOf('  useNativeLiveActivity();', source.indexOf('  const returnToParent =')));
const desktopSource = source.slice(source.indexOf('  const openRemoteDesktop = useEvent'), source.indexOf('  const closeRemoteDesktop ='));
const state = {
  remoteScope: { enabled: true, key: 'location-a', entry: { key: 'location-a' }, openSession: vi.fn(), refresh: vi.fn(async () => {}) },
  isIPad: false, sync: { refreshSessionTranscript: vi.fn(async () => {}) },
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
  setRemoteDesktopOpen: vi.fn(),
  parentSessionTarget: { id: 'parent', directory: 'C:\\raw\\worktree' },
  setCurrentSession: vi.fn(), openNewSessionDraft: vi.fn(),
  navigation: { openDraft: vi.fn(), openRemoteProject: vi.fn() }, setActiveMainTab: vi.fn(),
};
const binding = {
  React, useEvent, state, McpIcon: () => null,
  useMobileNavigationStore: { getState: () => state.navigation },
};
// Mount the actual production menu/refresh/parent handlers, not a reimplementation.
const compiled = ts.transpileModule(`return function Surface() {
  const { remoteScope, isIPad, sync, toast, parentSessionTarget, setCurrentSession, openNewSessionDraft, setActiveMainTab } = state;
  const currentSessionId = 'same'; const currentSessionDirectory = 'C:\\\\raw\\\\worktree'; const currentDirectory = '/retained-hub';
  const [isTranscriptRefreshing, setIsTranscriptRefreshing] = React.useState(false);
  const t = (key, params) => params ? [key, params.capability].join(':') : key;
  const dirtyChangeCount = 0; const showUpdateItem = false;
  const openChangesSurface = () => {}; const openFilesSurface = () => {}; const openSettingsSurface = () => {};
  const setOverflowOpen = () => {}; const setRemoteDesktopOpen = state.setRemoteDesktopOpen;
  const setMcpOpen = () => {}; const setUpdateOpen = () => {};
  ${parentSource}
  ${desktopSource}
  ${refreshSource}
  ${overflowSource}
  return <div>{overflowItems.map(item => <button key={item.key} data-action={item.key} disabled={item.disabled} onClick={item.onSelect}>{item.label}</button>)}<button data-action="parent" onClick={returnToParent}>Parent</button></div>;
}`, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText;
const Surface = new Function(...Object.keys(binding), compiled)(...Object.values(binding)) as React.ComponentType;
let root: Root, node: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks(); state.remoteScope.enabled = true; state.remoteScope.key = 'location-a'; state.isIPad = false;
  node = document.createElement('div'); root = createRoot(node);
});
afterEach(async () => { await act(async () => root.unmount()); vi.restoreAllMocks(); });
const click = async (action: string) => { await act(async () => node.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)!.click()); };
const mount = async () => { await act(async () => root.render(<Surface />)); };

it.each([false, true])('real phone/iPad overflow New remains remote (iPad=%s), without added terminal or machine-configuration entries', async (isIPad) => {
  state.isIPad = isIPad; await mount();
  await click('new-session');
  expect(state.remoteScope.openSession).toHaveBeenCalledWith(null);
  expect(state.openNewSessionDraft).not.toHaveBeenCalled(); expect(state.navigation.openDraft).not.toHaveBeenCalled();
  if (!isIPad) expect(state.navigation.openRemoteProject).toHaveBeenCalledTimes(1);
  expect(node.querySelector('[data-action="refresh-transcript"]')).not.toBeNull();
  expect(node.querySelector('[data-action="mcp"]')).toBeNull();
  expect(node.querySelector('[data-action="terminal"]')).toBeNull();
  expect(node.querySelector('[data-action="remote-desktop"]')).not.toBeNull();
});

it('real refresh and parent handlers do not mutate or read the retained same-ID Hub session', async () => {
  await mount(); await click('refresh-transcript'); await click('parent');
  expect(state.remoteScope.refresh).toHaveBeenCalledTimes(1); expect(state.sync.refreshSessionTranscript).not.toHaveBeenCalled();
  expect(state.remoteScope.openSession).toHaveBeenCalledWith('parent'); expect(state.setCurrentSession).not.toHaveBeenCalled();
});

it('refresh failure preserves the menu for retry and never falls back to the Hub', async () => {
  state.remoteScope.refresh.mockRejectedValueOnce(new Error('offline'));
  await mount(); await click('refresh-transcript');
  expect(state.toast.error).toHaveBeenCalledWith('sessions.sidebar.session.menu.refreshTranscriptFailed');
  expect(node.querySelector<HTMLButtonElement>('[data-action="refresh-transcript"]')?.disabled).toBe(false);
  await click('refresh-transcript'); expect(state.remoteScope.refresh).toHaveBeenCalledTimes(2);
  expect(state.sync.refreshSessionTranscript).not.toHaveBeenCalled();
});

it('a late old-Host refresh cannot clear the new Host flight or report success for that Host', async () => {
  let finishOld!: () => void, finishNew!: () => void;
  state.remoteScope.refresh.mockImplementationOnce(() => new Promise<void>((resolve) => { finishOld = resolve; }))
    .mockImplementationOnce(() => new Promise<void>((resolve) => { finishNew = resolve; }));
  await mount(); await click('refresh-transcript');
  state.remoteScope.key = 'location-b'; await mount(); await click('refresh-transcript');
  await act(async () => finishOld());
  expect(state.toast.success).not.toHaveBeenCalled();
  expect(node.querySelector<HTMLButtonElement>('[data-action="refresh-transcript"]')?.disabled).toBe(true);
  await act(async () => finishNew());
  expect(state.toast.success).toHaveBeenCalledTimes(1);
});

it('local menu and refresh retain their original production path', async () => {
  state.remoteScope.enabled = false; await mount(); await click('new-session'); await click('refresh-transcript'); await click('parent');
  expect(state.navigation.openDraft).toHaveBeenCalledTimes(1);
  expect(state.sync.refreshSessionTranscript).toHaveBeenCalledWith('same', { directory: 'C:\\raw\\worktree' });
  expect(state.setCurrentSession).toHaveBeenCalledWith('parent', 'C:\\raw\\worktree');
  expect(state.remoteScope.openSession).not.toHaveBeenCalled();
  expect(node.querySelector('[data-action="mcp"]')).not.toBeNull();
  expect(node.querySelector('[data-action="terminal"]')).toBeNull();
});

it('production root passes explicit remote owner into auto-read while preserving bootstrap and leaf scopes', () => {
  expect(source).toContain('<MobileAutoReadProvider remote={remoteScope.enabled} remoteState={remoteScope.owner?.state}');
  expect(source).toContain('<RemoteProjectsBootstrap');
  expect(source).toContain('<SelectedProjectHostBoundary><UnscopedChatView');
  expect(source).toContain('<SelectedProjectHostBoundary><UnscopedDiffView');
});

it('explicitly out-of-scope remote desktop explains the limitation without opening the retained Hub desktop', async () => {
  await mount(); await click('remote-desktop');
  expect(state.toast.info).toHaveBeenCalledWith('remoteProjects.nativeCapabilityUnavailable:remoteDesktop.title');
  expect(state.setRemoteDesktopOpen).not.toHaveBeenCalled();
  state.remoteScope.enabled = false; await mount(); await click('remote-desktop');
  expect(state.setRemoteDesktopOpen).toHaveBeenCalledWith(true);
});
