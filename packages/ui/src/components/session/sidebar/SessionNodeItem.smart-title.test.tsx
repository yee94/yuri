import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, afterEach, expect, test, vi } from 'vitest';
import type { Session } from '@/lib/opencode/v2-types';

const { requestTitle, loadChildren, saveTitle, openWindow, desktopAvailable, sessionActivity } = vi.hoisted(() => ({
  requestTitle: vi.fn(() => new Promise<void>(() => {})),
  loadChildren: vi.fn(async () => {}),
  saveTitle: vi.fn(),
  openWindow: vi.fn(async () => {}),
  desktopAvailable: vi.fn(() => false),
  sessionActivity: vi.fn(() => true),
}));
vi.mock('@/lib/desktop', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/desktop')>(),
  canUseElectronDesktopIPC: desktopAvailable,
  invokeDesktop: openWindow,
}));
vi.mock('@/sync/session-actions', () => ({ requestSessionSmartTitle: requestTitle }));
vi.mock('@/sync/sync-context', () => ({
  useDirectoryStore: () => null,
  useLiveSessionStatus: () => ({ type: 'busy' }),
  useSessionActivity: sessionActivity,
  useSessionPermissions: () => [],
  useSessionQuestions: () => [],
}));
vi.mock('@/sync/use-sync', () => ({ useSync: () => ({ loadChildren }) }));
vi.mock('./sessionFolderDnd', () => ({ DraggableSessionRow: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/multirun/MultiRunFusionDialog', () => ({ MultiRunFusionDialog: () => null }));
vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
  getCurrentIntlLocale: () => 'en-US',
  t: (key: string) => key,
}));
vi.hoisted(() => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ home: '/workspace', data: [] })));
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

import { SessionNodeItem } from './SessionNodeItem';
import { TooltipProvider } from '@/components/ui/tooltip';
import { toast } from '@/components/ui';
import { applySessionUnreadSnapshot, resetSessionUnreadProjection, useNotificationStore } from '@/sync/notification-store';
import { getSessionFocusKey } from '@/stores/useSessionFocusStore';
import { createSidebarShortcutNumberStore, SidebarShortcutNumberContext } from './sidebarShortcutNumbers';
import { useGitStore } from '@/stores/useGitStore';

const noop = () => {};
const session = { id: 'ses_title', title: 'Original title', directory: '/repo', time: { created: 1, updated: 2 } } as Session;
const container = document.createElement('div');
document.body.append(container);
let root: ReturnType<typeof createRoot>;
afterEach(async () => {
  await act(async () => root?.unmount());
  requestTitle.mockClear();
  loadChildren.mockClear();
  saveTitle.mockClear();
  openWindow.mockClear();
  desktopAvailable.mockReset().mockReturnValue(false);
  sessionActivity.mockReset().mockReturnValue(true);
  vi.restoreAllMocks();
  vi.useRealTimers();
});
afterAll(() => {
  container.remove();
  vi.unstubAllGlobals();
});

function Harness({ live = session, editing = true, indexed = session, children = [], duplicateRows = false, onRestore, card = false, active = false }: {
  live?: Session;
  editing?: boolean;
  indexed?: Session;
  children?: Array<{ session: Session; children: []; worktree: null }>;
  duplicateRows?: boolean;
  onRestore?: (sessionId: string, settled: boolean) => void;
  card?: boolean;
  active?: boolean;
}) {
  const [editingId, setEditingId] = React.useState<string | null>(editing ? session.id : null);
  const [expandedParents, setExpandedParents] = React.useState<Set<string>>(new Set());
  const row = <SessionNodeItem
    node={{ session: indexed, children, worktree: null }}
    groupDirectory="/repo"
    currentSessionId={active ? session.id : null}
    pinnedSessionIds={new Set()}
    expandedParents={expandedParents}
    hasSessionSearchQuery={false}
    normalizedSessionSearchQuery=""
    notifyOnSubtasks={false}
    editingId={editingId}
    setEditingId={setEditingId}
    editTitle={session.title ?? ''}
    setEditTitle={noop}
    handleSaveEdit={saveTitle}
    handleCancelEdit={() => setEditingId(null)}
    toggleParent={(key) => setExpandedParents((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    })}
    handleSessionSelect={noop}
    handleSessionDoubleClick={noop}
    togglePinnedSession={noop}
    handleShareSession={noop}
    copiedSessionId={null}
    handleCopyShareUrl={noop}
    handleUnshareSession={noop}
    openSidebarMenuKey={null}
    setOpenSidebarMenuKey={noop}
    renamingFolderId={null}
    getFoldersForScope={() => []}
    getSessionFolderId={() => null}
    removeSessionFromFolder={noop}
    addSessionToFolder={noop}
    createFolderAndStartRename={() => null}
    handleDeleteSession={noop}
    mobileVariant={false}
    alwaysShowActions={false}
    renderSessionNode={() => null}
    subtreeContainsActive={new Set()}
    subtreeContainsEditing={new Set([session.id])}
    menuOpenSessionId={null}
    nodeStructureKey={session.id}
    liveSessionById={new Map([[session.id, live]])}
    secondaryMeta={card ? { card: true, projectLabel: 'Project', branchLabel: 'main' } : onRestore ? { slim: true, projectLabel: 'Project' } : undefined}
    settledSessionIds={onRestore ? new Set([session.id]) : undefined}
    setSessionSettled={onRestore}
  />;
  return <TooltipProvider>{duplicateRows ? <>
    <div data-test-section="pinned">{React.cloneElement(row, { renderContext: 'pinned' })}</div>
    <div data-test-section="project">{row}</div>
  </> : row}</TooltipProvider>;
}

test.each([false, true])('sidebar shows the destination branch after a session move (task card: %s)', async (card) => {
  const git = useGitStore.getState();
  const destination = '/worktrees/feature';
  const moved = { ...session, directory: destination };
  const setBranch = (directory: string, current: string) => {
    git.setActiveDirectory(directory);
    git.restoreStatus(directory, { current, tracking: null, ahead: 0, behind: 0, files: [], isClean: true });
  };
  root = createRoot(container);
  try {
    await act(async () => {
      setBranch('/repo', 'main');
      root.render(<Harness editing={false} card={card} />);
    });
    expect(container.textContent).not.toContain('feat/destination');
    await act(async () => root.render(<Harness editing={false} card={card} indexed={moved} live={moved} />));
    await act(async () => setBranch(destination, 'feat/destination'));
    expect(container.querySelector('[data-session-title]')?.textContent).toContain('feat/destination');
    expect(container.querySelector('[data-session-title]')?.textContent).not.toContain('main');
    await act(async () => setBranch('/repo', 'feat/unrelated'));
    expect(container.querySelector('[data-session-title]')?.textContent).toContain('feat/destination');
    await act(async () => root.render(<Harness editing={false} card={card} />));
    expect(container.querySelector('[data-session-title]')?.textContent).not.toContain('feat/destination');
    expect(container.querySelector('[data-session-worktree-footer]')).toBeNull();
  } finally {
    await act(async () => useGitStore.setState({ directories: git.directories, activeDirectory: git.activeDirectory }));
  }
});

test.each([false, true])('task card puts its unread dot inline before project text when selected=%s', async (active) => {
  sessionActivity.mockReturnValue(false);
  root = createRoot(container);
  try {
    await act(async () => {
      applySessionUnreadSnapshot({
        [session.id]: { directory: '/repo', unreadCount: 1, manual: true, hasError: false, revision: 1 },
      });
      root.render(<Harness editing={false} card active={active} />);
    });
    const dot = container.querySelector('.yuri-task-unread-dot')!;
    expect(dot).not.toBeNull();
    expect(dot.getAttribute('aria-label')).toBe('sessions.sidebar.session.status.unread');
    expect(dot.nextElementSibling?.textContent).toBe('Project');
    expect(dot.parentElement?.classList.contains('h-5')).toBe(true);
    expect(dot.classList.contains('size-2')).toBe(true);
    expect(dot.classList.contains('self-center')).toBe(true);
    await act(async () => applySessionUnreadSnapshot({}));
    expect(container.querySelector('.yuri-task-unread-dot')).toBeNull();
    await act(async () => {
      applySessionUnreadSnapshot({
        [session.id]: { directory: '/repo', unreadCount: 1, manual: true, hasError: false, revision: 2 },
      });
      sessionActivity.mockReturnValue(true);
      root.render(<Harness editing={false} card active={active} />);
    });
    expect(container.querySelector('.yuri-task-unread-dot')).toBeNull();
  } finally {
    await act(async () => resetSessionUnreadProjection());
  }
});

test('the Mod+1…9 hint reads its slot from the sidebar number store, so renumbering needs no new row props', async () => {
  vi.useFakeTimers();
  const key = getSessionFocusKey({ scope: 'project', sessionId: session.id, projectId: null })!;
  const store = createSidebarShortcutNumberStore(new Map([[key, 3]]));
  const modifier = (type: 'keydown' | 'keyup') => {
    for (const name of ['Meta', 'Control']) window.dispatchEvent(new KeyboardEvent(type, { key: name }));
  };
  root = createRoot(container);
  try {
    await act(async () => root.render(
      <SidebarShortcutNumberContext.Provider value={store}><Harness editing={false} /></SidebarShortcutNumberContext.Provider>,
    ));
    await act(async () => {
      modifier('keydown');
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(container.querySelector('[data-sidebar-shortcut-number]')?.getAttribute('data-sidebar-shortcut-number')).toBe('3');
    await act(async () => store.setState({ numbers: new Map([[key, 5]]) }));
    expect(container.querySelector('[data-sidebar-shortcut-number]')?.getAttribute('data-sidebar-shortcut-number')).toBe('5');
    await act(async () => store.setState({ numbers: new Map() }));
    expect(container.querySelector('[data-sidebar-shortcut-number]')).toBeNull();
  } finally {
    await act(async () => modifier('keyup'));
  }
});

test('archived task quick action restores with undo-2 instead of offering another archive or pin', async () => {
  const restore = vi.fn();
  root = createRoot(container);
  await act(async () => root.render(<Harness editing={false} onRestore={restore} />));
  const button = container.querySelector<HTMLButtonElement>('[aria-label="sessions.sidebar.session.menu.unsettle"]')!;
  expect(button.querySelector('use')?.getAttribute('href')).toBe('#yuri-undo-2');
  expect(container.querySelector('[aria-label="sessions.sidebar.session.menu.pin"]')).toBeNull();
  expect(container.querySelector('[data-session-title] use[href="#yuri-folder-open"]')).not.toBeNull();
  await act(async () => button.click());
  expect(restore).toHaveBeenCalledExactlyOnceWith(session.id, false);
});

test('archived task details stay unmounted until keyboard focus opens the real row tooltip', async () => {
  root = createRoot(container);
  await act(async () => root.render(<Harness editing={false} onRestore={() => undefined} />));
  expect(document.querySelector('[data-session-hover-details]')).toBeNull();
  const title = container.querySelector<HTMLButtonElement>('[data-session-title]')!;
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    title.focus();
  });
  expect(document.querySelector('[data-session-hover-details]')?.textContent).toContain('Original title');
  expect(document.querySelector('[data-session-hover-details]')?.textContent).toContain('Project');
});

test('AI title admission alone does not show title loading', async () => {
  root = createRoot(container);
  await act(async () => root.render(<Harness />));
  const button = container.querySelector<HTMLButtonElement>('[aria-label="sessions.sidebar.session.rename.smartTitle"]');
  expect(button).not.toBeNull();
  await act(async () => button!.click());
  expect(requestTitle).toHaveBeenCalledWith(session.id);
  expect(container.querySelector('.animate-text-shimmer')).toBeNull();
});

test('rename check saves while losing focus outside cancels', async () => {
  root = createRoot(container);
  await act(async () => root.render(<Harness />));
  const input = container.querySelector<HTMLInputElement>('input')!;
  const save = container.querySelector<HTMLButtonElement>('[aria-label="sessions.sidebar.session.rename.save"]')!;
  await act(async () => {
    save.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    save.click();
  });
  expect(saveTitle).toHaveBeenCalledWith('Original title');
  await act(async () => input.blur());
  expect(container.querySelector('input')).toBeNull();
});

test('mouse-focused row enters rename with Enter and double-click reuses Mini Chat only on Electron', async () => {
  root = createRoot(container);
  await act(async () => root.render(<Harness editing={false} />));
  const title = container.querySelector<HTMLButtonElement>('[data-session-title]')!;
  await act(async () => title.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
  expect(openWindow).not.toHaveBeenCalled();
  desktopAvailable.mockReturnValue(true);
  await act(async () => title.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
  expect(openWindow).toHaveBeenCalledWith('desktop_open_session_mini_chat_window', expect.objectContaining({ sessionId: session.id, directory: '/repo' }));
  const row = container.querySelector<HTMLElement>('[data-session-row]')!;
  await act(async () => row.click());
  await act(async () => title.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  expect(container.querySelector('input')).not.toBeNull();
});

test.each([
  ['pinned', 'keyboard'],
  ['project', 'keyboard'],
  ['pinned', 'context-menu'],
  ['project', 'context-menu'],
])('rename started in %s via %s selects text in that section without moving focus to the duplicate row', async (section, method) => {
  root = createRoot(container);
  await act(async () => root.render(<Harness editing={false} duplicateRows />));
  const origin = container.querySelector<HTMLElement>(`[data-test-section="${section}"]`)!;
  if (method === 'context-menu') {
    await act(async () => origin.querySelector<HTMLElement>('[data-session-row]')!.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, button: 2, clientX: 20, clientY: 20 }),
    ));
    const rename = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'))
      .find(item => item.textContent?.includes('sessions.sidebar.session.menu.rename'))!;
    await act(async () => rename.click());
    await act(async () => vi.waitFor(() => expect(origin.querySelector('input')).not.toBeNull()));
  } else {
    const title = origin.querySelector<HTMLButtonElement>('[data-session-title]')!;
    await act(async () => origin.querySelector<HTMLElement>('[data-session-row]')!.click());
    await act(async () => title.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  }
  const input = origin.querySelector<HTMLInputElement>('input')!;
  expect(input).not.toBeNull();
  expect(document.activeElement).toBe(input);
  expect(input.selectionStart).toBe(0);
  expect(input.selectionEnd).toBe(input.value.length);
  expect(container.querySelectorAll('input')).toHaveLength(1);
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(container.querySelector('input')).toBeNull();
  const otherSection = section === 'pinned' ? 'project' : 'pinned';
  const other = container.querySelector<HTMLElement>(`[data-test-section="${otherSection}"]`)!;
  const otherTitle = other.querySelector<HTMLButtonElement>('[data-session-title]')!;
  await act(async () => other.querySelector<HTMLElement>('[data-session-row]')!.click());
  await act(async () => otherTitle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  expect(container.querySelectorAll('input')).toHaveLength(1);
  expect(document.activeElement).toBe(other.querySelector('input'));
});

test('read/unread action stays directly below pin and toggles without opening the session', async () => {
  resetSessionUnreadProjection();
  root = createRoot(container);
  await act(async () => root.render(<Harness editing={false} />));
  await act(async () => {
    container.querySelector('[data-session-row]')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2, clientX: 20, clientY: 20 }));
  });
  const items = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'));
  const pinIndex = items.findIndex(item => item.textContent?.includes('sessions.sidebar.session.menu.pin'));
  expect(items[pinIndex + 1]?.textContent).toContain('sessions.sidebar.session.menu.markUnread');
  expect(items[pinIndex + 2]?.textContent).toContain('sessions.sidebar.session.menu.rename');
  const action = items
    .find(item => item.textContent?.includes('sessions.sidebar.session.menu.markUnread'));
  expect(action).toBeDefined();
  expect(action!.querySelector('svg use')?.getAttribute('href')).toBe('#yuri-mail');
  await act(async () => action!.click());
  expect(useNotificationStore.getState().sessionUnseenCount(session.id)).toBe(1);
  await act(async () => {
    container.querySelector('[data-session-row]')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2, clientX: 20, clientY: 20 }));
  });
  const unreadItems = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'));
  const unreadPinIndex = unreadItems.findIndex(item => item.textContent?.includes('sessions.sidebar.session.menu.pin'));
  const readAction = unreadItems[unreadPinIndex + 1];
  expect(readAction?.textContent).toContain('sessions.sidebar.session.menu.markRead');
  expect(unreadItems[unreadPinIndex + 2]?.textContent).toContain('sessions.sidebar.session.menu.rename');
  expect(readAction.querySelector('svg use')?.getAttribute('href')).toBe('#yuri-mail-open');
  expect(unreadItems.some(item => item.textContent?.includes('sessions.sidebar.session.menu.markUnread'))).toBe(false);
  await act(async () => readAction.click());
  expect(useNotificationStore.getState().sessionUnseenCount(session.id)).toBe(0);
  await act(async () => resetSessionUnreadProjection());
});

test('indexed child availability survives a live session snapshot without hasChildren and loads only on expansion', async () => {
  root = createRoot(container);
  await act(async () => root.render(<Harness editing={false} indexed={{ ...session, hasChildren: true } as Session} />));
  expect(loadChildren).not.toHaveBeenCalled();
  const expand = container.querySelector<HTMLElement>('[aria-label="sessions.sidebar.session.subsessions.expand"]');
  expect(expand).not.toBeNull();
  await act(async () => expand!.click());
  expect(loadChildren).toHaveBeenCalledWith(session.id, '/repo');
  await act(async () => container.querySelector<HTMLElement>('[aria-label="sessions.sidebar.session.subsessions.collapse"]')!.click());
  expect(loadChildren).toHaveBeenCalledTimes(1);
});

test('expanding a partially known subtree still loads the remaining children', async () => {
  root = createRoot(container);
  await act(async () => root.render(<Harness editing={false} children={[
    { session: { ...session, id: 'ses_child', parentID: session.id }, children: [], worktree: null },
  ]} />));
  expect(loadChildren).not.toHaveBeenCalled();
  await act(async () => container.querySelector<HTMLElement>('[aria-label="sessions.sidebar.session.subsessions.expand"]')!.click());
  expect(loadChildren).toHaveBeenCalledWith(session.id, '/repo');
});

test('expansion shows pending state and reports failure so a later expansion can retry', async () => {
  const error = vi.spyOn(toast, 'error').mockImplementation(() => 'error-toast');
  let reject!: (error: Error) => void;
  loadChildren.mockImplementationOnce(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
  root = createRoot(container);
  await act(async () => root.render(<Harness editing={false} indexed={{ ...session, hasChildren: true } as Session} />));
  await act(async () => container.querySelector<HTMLElement>('[aria-label="sessions.sidebar.session.subsessions.expand"]')!.click());
  expect(container.querySelector('[aria-expanded="true"]')?.getAttribute('aria-busy')).toBe('true');
  await act(async () => reject(new Error('offline')));
  expect(error).toHaveBeenCalledWith('sessions.sidebar.session.subsessions.loadFailed');
  expect(container.querySelector('[aria-expanded="true"]')?.getAttribute('aria-busy')).toBe('false');
  await act(async () => container.querySelector<HTMLElement>('[aria-label="sessions.sidebar.session.subsessions.collapse"]')!.click());
  await act(async () => container.querySelector<HTMLElement>('[aria-label="sessions.sidebar.session.subsessions.expand"]')!.click());
  expect(loadChildren).toHaveBeenCalledTimes(2);
});

test('server first-title generation shows loading without clicking the AI button', async () => {
  root = createRoot(container);
  const generating = { ...session, title: '', metadata: { yuri: { titleRefresh: { isGenerating: true, generationExpiresAt: Date.now() + 10_000 } } } } as Session;
  await act(async () => root.render(<Harness editing={false} live={generating} />));
  expect(container.querySelector('[aria-busy="true"]')?.classList.contains('animate-text-shimmer')).toBe(true);
  expect(requestTitle).not.toHaveBeenCalled();
  const completed = { ...session, title: 'Generated first title' };
  await act(async () => root.render(<Harness editing={false} live={completed} />));
  expect(container.querySelector('[aria-busy="true"]')).toBeNull();
  expect(container.textContent).toContain('Generated first title');
});

test('metadata-only title completion stops text loading while execution remains busy', async () => {
  root = createRoot(container);
  const generating = { ...session, metadata: { yuri: { titleRefresh: { isGenerating: true, generationExpiresAt: Date.now() + 10_000 } } } } as Session;
  await act(async () => root.render(<Harness editing={false} live={generating} />));
  expect(container.querySelector('.animate-text-shimmer')?.textContent).toBe(session.title);
  const completed = { ...session, metadata: { yuri: { titleRefresh: {} } } } as Session;
  await act(async () => root.render(<Harness editing={false} live={completed} />));
  expect(container.querySelector('.animate-text-shimmer')).toBeNull();
  expect(container.querySelector('[aria-busy="true"]')).toBeNull();
  expect(container.querySelector('[aria-label="sessions.sidebar.session.status.active"]')).not.toBeNull();
});

test('title loading expires without a completion event and only restarts for a fresh attempt', async () => {
  vi.useFakeTimers();
  root = createRoot(container);
  const deadline = Date.now() + 10_000;
  const generating = { ...session, metadata: { yuri: { titleRefresh: { isGenerating: true, generationExpiresAt: deadline } } } } as Session;
  await act(async () => root.render(<Harness editing={false} live={generating} />));
  expect(container.querySelector('.animate-text-shimmer')).not.toBeNull();
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  expect(container.querySelector('.animate-text-shimmer')).toBeNull();
  await act(async () => root.render(<Harness editing={false} live={{ ...generating }} />));
  expect(container.querySelector('.animate-text-shimmer')).toBeNull();
  const retry = { ...session, metadata: { yuri: { titleRefresh: { isGenerating: true, generationExpiresAt: Date.now() + 10_000 } } } } as Session;
  await act(async () => root.render(<Harness editing={false} live={retry} />));
  expect(container.querySelector('.animate-text-shimmer')).not.toBeNull();
  await act(async () => root.render(<Harness editing={false} live={session} />));
  expect(container.querySelector('.animate-text-shimmer')).toBeNull();
});

test.each([undefined, 1])('persisted loading without a valid deadline does not shimmer (%s)', async (generationExpiresAt) => {
  root = createRoot(container);
  const stale = { ...session, metadata: { yuri: { titleRefresh: { isGenerating: true, generationExpiresAt } } } } as Session;
  await act(async () => root.render(<Harness editing={false} live={stale} />));
  expect(container.querySelector('.animate-text-shimmer')).toBeNull();
});
