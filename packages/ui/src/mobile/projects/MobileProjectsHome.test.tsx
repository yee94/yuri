import { describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';
import { toast } from '@/components/ui/toast';
import {
  appendNotification,
  applySessionUnreadSnapshot,
  installSessionReadSync,
  resetSessionUnreadProjection,
  useNotificationStore,
} from '@/sync/notification-store';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useMobileProjectsHomeModel } from './useMobileProjectsHomeModel';
import { MobileTaskCard } from './MobileTaskCard';
import type { MobileTaskNode } from './MobileTaskCard';
import { MobileSessionRow } from './MobileSessionRow';

import {
  MobileProjectsHome,
  type MobileProjectHomeItem,
  type MobileProjectsHomeProps,
} from './MobileProjectsHome';

const fixtures = vi.hoisted(() => ({
  sessions: [],
  pinned: new Set<string>(),
  running: new Set<string>(),
  activityReads: new Map<string, number>(),
  iconFetch: vi.fn(async (_path: string) => new Response(new Blob(['logo'], { type: 'image/png' }))),
}));
vi.mock('@/lib/runtime-fetch', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/runtime-fetch')>(),
  runtimeFetch: fixtures.iconFetch,
}));
vi.mock('@/hooks/useSessionOrderSync', () => ({ useSessionOrderSync: () => {} }));
vi.mock('@/stores/useDirectoryStore', async () => {
  const { create } = await import('zustand');
  return { useDirectoryStore: create(() => ({ currentDirectory: '' })) };
});
vi.mock('@/queries/sessionIndexPinQueries', () => ({ usePinnedSessionIds: () => fixtures.pinned }));
vi.mock('@/components/session/sidebar/hooks/useAlwaysVisibleSessionIds', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/components/session/sidebar/hooks/useAlwaysVisibleSessionIds')>(),
  useRunningSessionIds: () => fixtures.running,
}));
vi.mock('@/sync/sync-context', () => ({
  useAllLiveSessions: () => fixtures.sessions,
  useSessionActivity: (id: string) => {
    fixtures.activityReads.set(id, (fixtures.activityReads.get(id) ?? 0) + 1);
    return fixtures.running.has(id);
  },
  useSessionPermissions: () => [],
  useSessionQuestions: () => [],
}));

const homeSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'MobileProjectsHome.tsx'),
  'utf8',
);

const noop = () => undefined;

test.each([
  { branchState: 'loading' as const },
  { branch: 'feature/compact-branch' },
  { branchState: 'no-git' as const, pathLabel: '~/notes' },
  { branchState: 'no-git' as const },
  { pinned: true },
])('task branch line reserves compact space for $branchState $branch $pinned', (patch) => {
  const task: MobileTaskNode = {
    id: 'branch-slot', title: 'Task', projectLabel: 'Project', project: null,
    unread: false, pinned: false, active: false, ...patch,
  };
  const host = document.createElement('div');
  host.innerHTML = renderToString(<I18nProvider>
    <MobileTaskCard task={task} runStartedAt={null}
      onSelect={noop} onOpenActions={noop} onPin={noop} onArchive={noop} />
  </I18nProvider>);
  const slot = host.querySelector('.yuri-mobile-task-branch')!;
  expect(slot.classList.contains('h-3.5')).toBe(true);
  expect(slot.classList.contains('mt-1.5')).toBe(true);
  if (task.branchState === 'loading') {
    expect(slot.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(slot.querySelector('use[href="#yuri-git-branch"]')).not.toBeNull();
    expect(slot.className).not.toContain('animate-');
  } else {
    expect(slot.querySelector('[aria-busy="true"]')).toBeNull();
    expect(slot.textContent).toBe(task.branch ?? task.pathLabel ?? '');
  }
  expect(Boolean(slot.querySelector('.yuri-mobile-task-pin'))).toBe(task.pinned);
});

test('project session swipe archive shares the solid red plate and white content', () => {
  const host = document.createElement('div');
  host.innerHTML = renderToString(<I18nProvider>
    <MobileSessionRow session={{ id: 'project-archive', title: 'Session' }}
      onSelect={noop} onPin={noop} onArchive={noop} onOpenActions={noop} />
  </I18nProvider>);
  const [pin, archive] = host.querySelectorAll<HTMLButtonElement>('.yuri-mobile-session-action');
  expect(pin.className).toContain('bg-interactive-selection');
  expect(archive.className).toContain('bg-[var(--solid-destructive-background)]');
  expect(archive.className).toContain('text-[var(--solid-destructive-foreground)]');
});

test.each([
  [false, false],
  [false, true],
  [true, false],
  [true, true],
])('inbox task rows stay flat when selected=%s and running=%s', (active, running) => {
  const id = 'task-surface';
  if (running) fixtures.running.add(id);
  try {
    const host = document.createElement('div');
    host.innerHTML = renderToString(<I18nProvider>
      <MobileTaskCard
        task={{ id, title: 'Task', projectLabel: 'Project', project: null, unread: false, pinned: false, active }}
        runStartedAt={Date.now() - 60_000}
        onSelect={noop}
        onOpenActions={noop}
        onPin={noop}
        onArchive={noop}
      />
    </I18nProvider>);
    const row = host.querySelector('.yuri-mobile-task-card')!;
    const main = row.querySelector('.yuri-mobile-task-content > button')!;
    expect(row.className).not.toContain('yuri-mobile-floating-surface');
    expect(row.querySelector('.yuri-mobile-task-avatar')).not.toBeNull();
    expect(main.querySelectorAll('use[href="#yuri-folder-open"]')).toHaveLength(1);
    expect(main.className).not.toContain('bg-');
    expect(Boolean(main.querySelector('.text-status-info'))).toBe(running);
  } finally {
    fixtures.running.delete(id);
  }
});

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const projects: MobileProjectHomeItem[] = [{
  id: 'project-1',
  name: 'Yuri',
  path: '/code/yuri',
  sessionCount: 2,
  expanded: true,
  worktrees: [{
    id: 'main',
    name: 'Main workspace',
    path: '/code/yuri',
    kind: 'main',
    sessionCount: 1,
    sessions: [{ id: 'main-session', kind: 'pagination', title: 'Main session' }],
  }, {
    id: 'feature',
    name: 'Feature branch',
    path: '/code/yuri-feature',
    kind: 'worktree',
    sessionCount: 1,
    expanded: true,
    sessions: [{ id: 'feature-session', kind: 'pagination', title: 'Feature session' }],
  }],
}];

const props: MobileProjectsHomeProps = {
  projects,
  pinnedSessions: [{
    id: 'global-pinned-session',
    kind: 'pagination',
    title: 'Global pinned session',
    subtitle: 'Yuri',
    pinned: true,
  }],
  onAddProject: noop,
  onNewSession: noop,
  onToggleProject: noop,
  onOpenProjectActions: noop,
  onToggleWorktree: noop,
  onNewWorktreeSession: noop,
  onOpenWorktreeActions: noop,
  onDeleteWorktree: noop,
  onSelectSession: noop,
  onPinSession: noop,
  onArchiveSession: noop,
  onOpenSessionActions: noop,
};

test('inbox task rows keep project mark selection separate from menu actions and preserve long title and branch content', async () => {
  const select = vi.fn();
  const actions = vi.fn();
  const task = {
    id: 'compact-task',
    title: '移动端交互设计与任务状态布局'.repeat(4),
    projectLabel: 'project-with-a-long-name',
    project: null,
    branch: 'feature/compact-mobile-task-cards',
    activityLabel: '1h',
    unread: true,
    pinned: true,
    active: false,
  };
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    await act(async () => root.render(<I18nProvider>
      <MobileTaskCard task={task} runStartedAt={null} onSelect={select} onOpenActions={actions} onPin={noop} onArchive={noop} />
    </I18nProvider>));
    const [card, menu] = host.querySelectorAll<HTMLButtonElement>('.yuri-mobile-task-content > button');
    expect(card.textContent).toContain(task.title);
    expect(card.textContent).toContain(task.projectLabel);
    expect(card.textContent).toContain(task.branch);
    expect(card.querySelector('use[href="#yuri-pushpin-2-fill"]')).not.toBeNull();
    expect(card.querySelector('.yuri-mobile-task-pin use[href="#yuri-pushpin-2-fill"]')).not.toBeNull();
    expect(menu.classList.contains('yuri-mobile-task-more')).toBe(true);
    expect(card.querySelector('button')).toBeNull();
    await act(async () => menu.click());
    expect(actions).toHaveBeenCalledExactlyOnceWith(task.id);
    expect(select).not.toHaveBeenCalled();
    await act(async () => (card.querySelector('.yuri-mobile-task-avatar') as HTMLElement).click());
    expect(select).toHaveBeenCalledExactlyOnceWith(task.id);
    await act(async () => card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
    expect(actions).toHaveBeenCalledTimes(2);
    expect(select).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
  }
});

test('task swipe, long press and three-dot actions preserve scrolling and route through the existing home callbacks', async () => {
  const select = vi.fn();
  const actions = vi.fn();
  const pin = vi.fn();
  const archive = vi.fn();
  const active = ['a', 'b'].map(id => ({ id, title: id, projectLabel: 'Project', project: null, unread: false, pinned: false, active: false }));
  const task: NonNullable<MobileProjectsHomeProps['task']> = {
    view: 'tasks', onViewChange: noop,
    model: { pinned: [], active, settled: [], settledTotal: 0, settledIds: new Set(), runStartTimes: new Map() },
    settledOpen: false, onSettledOpenChange: noop, onShowMoreSettled: noop,
    onSelectTask: select, onOpenTaskActions: actions, onRestoreTask: noop,
  };
  const host = document.createElement('div');
  const root = createRoot(host);
  const pointer = (target: Element, type: string, x: number, y = 0, pointerType = 'touch') => act(() => {
    target.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: 1, button: 0, pointerType, clientX: x, clientY: y,
    }));
  });
  try {
    await act(async () => root.render(<I18nProvider>
      <MobileProjectsHome {...props} task={task} onPinSession={pin} onArchiveSession={archive} />
    </I18nProvider>));
    expect(host.querySelector('main')!.className).not.toContain('max-w-');
    expect(host.querySelector('.yuri-mobile-task-list > section')?.getAttribute('aria-label')).toBe('Tasks');
    expect(host.querySelector('.yuri-mobile-task-select')).not.toBeNull();
    expect(host.querySelector('.yuri-mobile-task-more')).not.toBeNull();
    vi.useFakeTimers();
    const rows = [...host.querySelectorAll('.yuri-mobile-task-card')];
    const mains = rows.map(row => row.querySelector('.yuri-mobile-task-content > button')!);
    const rails = rows.map(row => row.querySelector('.yuri-mobile-session-actions')!);
    rails.forEach(rail => Object.defineProperty(rail, 'offsetWidth', { value: 168 }));
    expect(rails[0].querySelectorAll('button')).toHaveLength(3);
    const swipe = (index: number) => {
      pointer(mains[index], 'pointerdown', 200);
      pointer(mains[index], 'pointermove', 100);
      act(() => vi.advanceTimersByTime(700));
      pointer(mains[index], 'pointerup', 100);
    };

    pointer(mains[0], 'pointerdown', 200);
    pointer(mains[0], 'pointermove', 195, 80);
    act(() => vi.advanceTimersByTime(700));
    pointer(mains[0], 'pointerup', 195, 80);
    expect(actions).not.toHaveBeenCalled();
    expect(rails[0].getAttribute('aria-hidden')).toBe('true');

    pointer(mains[0], 'pointerdown', 200);
    act(() => vi.advanceTimersByTime(500));
    expect(actions).toHaveBeenCalledExactlyOnceWith('a');
    pointer(mains[0], 'pointerup', 200);
    act(() => (mains[0] as HTMLButtonElement).click());
    expect(select).not.toHaveBeenCalled();
    actions.mockClear();

    swipe(0);
    expect(rails[0].getAttribute('aria-hidden')).toBe('false');
    expect(actions).not.toHaveBeenCalled();
    act(() => (mains[0] as HTMLButtonElement).click());
    expect(select).not.toHaveBeenCalled();
    act(() => (rails[0].querySelector('button[aria-label="Pin"]') as HTMLButtonElement).click());
    expect(pin).toHaveBeenCalledExactlyOnceWith({ id: 'a', title: '' });
    expect(rails[0].getAttribute('aria-hidden')).toBe('true');

    swipe(0);
    swipe(1);
    expect(rails[0].getAttribute('aria-hidden')).toBe('true');
    expect(rails[1].getAttribute('aria-hidden')).toBe('false');
    act(() => (rails[1].querySelector('button[aria-label="Archive"]') as HTMLButtonElement).click());
    expect(archive).toHaveBeenCalledExactlyOnceWith({ id: 'b', title: '' });
    expect(rails[1].getAttribute('aria-hidden')).toBe('true');

    swipe(0);
    act(() => (rows[0].querySelector('.yuri-mobile-task-content > button[aria-label="Session menu"]') as HTMLButtonElement).click());
    expect(actions).toHaveBeenCalledExactlyOnceWith('a');
    expect(rails[0].getAttribute('aria-hidden')).toBe('true');
    actions.mockClear();
    pointer(mains[0], 'pointerdown', 200);
    pointer(mains[0], 'pointermove', 100);
    pointer(mains[0], 'pointercancel', 100);
    act(() => vi.advanceTimersByTime(700));
    expect(rails[0].getAttribute('aria-hidden')).toBe('true');
    expect(actions).not.toHaveBeenCalled();
    pointer(mains[0], 'pointerdown', 200, 0, 'mouse');
    pointer(mains[0], 'pointermove', 100, 0, 'mouse');
    pointer(mains[0], 'pointerup', 100, 0, 'mouse');
    act(() => vi.advanceTimersByTime(700));
    expect(rails[0].getAttribute('aria-hidden')).toBe('true');
    expect(actions).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    vi.useRealTimers();
  }
});

test('task swipe read action shares Host state, reflects external updates and never navigates', async () => {
  const task = { id: 'swipe-read', directory: '/project', title: 'Task', projectLabel: 'Project', project: null, unread: false, pinned: false, active: false };
  const select = vi.fn();
  const unread = vi.fn(async (id: string) => applySessionUnreadSnapshot({
    [id]: { directory: '/project', unreadCount: 1, manual: true, hasError: false, revision: 1 },
  }));
  const read = vi.fn(() => applySessionUnreadSnapshot({}));
  const stopReadSync = installSessionReadSync({ read, unread });
  const host = document.createElement('div');
  const root = createRoot(host);
  const readAction = () => host.querySelector<HTMLButtonElement>('button[aria-label^="Mark as"]')!;
  const reveal = () => {
    const main = host.querySelector('.yuri-mobile-task-content > button')!;
    for (const [type, x] of [['pointerdown', 240], ['pointermove', 60], ['pointerup', 60]] as const) {
      act(() => main.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: 1, button: 0, pointerType: 'touch', clientX: x, clientY: 0,
      })));
    }
  };
  try {
    await act(async () => root.render(<I18nProvider>
      <MobileTaskCard task={task} runStartedAt={null} onSelect={select} onOpenActions={noop} onPin={noop} onArchive={noop} />
    </I18nProvider>));
    const rail = host.querySelector('.yuri-mobile-session-actions')!;
    Object.defineProperty(rail, 'offsetWidth', { value: 168 });
    const buttons = [...rail.querySelectorAll('button')];
    expect(buttons.map(button => button.textContent)).toEqual(['Unread', 'Pin', 'Archive']);
    expect(buttons[0]).toBe(readAction());
    expect(buttons[0].className).toContain('bg-[var(--surface-muted)]');
    expect(buttons[0].className).not.toContain('bg-interactive-selection');
    expect(buttons[1].className).toContain('bg-interactive-selection');
    expect(buttons[2].className).toContain('bg-[var(--solid-destructive-background)]');
    expect(buttons[2].className).toContain('text-[var(--solid-destructive-foreground)]');
    expect(readAction().querySelector('span')!.className).toContain('truncate');
    expect(readAction().getAttribute('aria-label')).toBe('Mark as unread');
    expect(readAction().querySelector('use')?.getAttribute('href')).toBe('#yuri-mail');
    reveal();
    expect(host.querySelector<HTMLElement>('.yuri-mobile-task-content')!.style.transform).toBe('translate3d(-168px, 0, 0)');
    await act(async () => readAction().click());
    expect(unread).toHaveBeenCalledExactlyOnceWith(task.id);
    expect(rail.getAttribute('aria-hidden')).toBe('true');
    expect(readAction().getAttribute('aria-label')).toBe('Mark as read');
    expect(readAction().textContent).toBe('Read');
    expect(readAction().querySelector('use')?.getAttribute('href')).toBe('#yuri-mail-open');
    reveal();
    await act(async () => readAction().click());
    expect(read).toHaveBeenCalledExactlyOnceWith(task.id);
    expect(readAction().getAttribute('aria-label')).toBe('Mark as unread');
    reveal();
    await act(async () => applySessionUnreadSnapshot({
      [task.id]: { directory: '/project', unreadCount: 1, manual: true, hasError: false, revision: 2 },
    }));
    expect(readAction().getAttribute('aria-label')).toBe('Mark as read');
    expect(rail.getAttribute('aria-hidden')).toBe('false');
    await act(async () => applySessionUnreadSnapshot({}));
    expect(readAction().getAttribute('aria-label')).toBe('Mark as unread');
    expect(select).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    stopReadSync();
    resetSessionUnreadProjection();
  }
});

test('failed task swipe unread write reports the error and preserves authoritative read state', async () => {
  const errorToast = vi.spyOn(toast, 'error').mockImplementation(() => 'error');
  const stopReadSync = installSessionReadSync({ read: vi.fn(), unread: vi.fn().mockRejectedValue(new Error('offline')) });
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    await act(async () => root.render(<I18nProvider>
      <MobileTaskCard task={{ id: 'swipe-read-failure', title: 'Task', projectLabel: 'Project', project: null, unread: false, pinned: false, active: false }}
        runStartedAt={null} onSelect={noop} onOpenActions={noop} onPin={noop} onArchive={noop} />
    </I18nProvider>));
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Mark as unread"]')!.click());
    expect(errorToast).toHaveBeenCalledExactlyOnceWith('Could not mark as unread. Try again.');
    expect(useNotificationStore.getState().sessionUnseenCount('swipe-read-failure')).toBe(0);
    expect(host.querySelector('button[aria-label="Mark as unread"]')).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
    stopReadSync();
    resetSessionUnreadProjection();
    errorToast.mockRestore();
  }
});

test('100 inbox rows isolate 50 pointer moves and unrelated parent updates to the active row', async () => {
  const tasks = Array.from({ length: 100 }, (_, index) => ({
    id: `swipe-perf-${index}`, title: 'Task', projectLabel: 'Project', project: null, unread: false, pinned: false, active: false,
  }));
  function Surface({ bump }: { bump: number }) {
    void bump;
    return <I18nProvider>{tasks.map(task => <MobileTaskCard key={task.id} task={task}
      runStartedAt={null} onSelect={noop} onOpenActions={noop} onPin={noop} onArchive={noop} />)}</I18nProvider>;
  }
  const host = document.createElement('div');
  const root = createRoot(host);
  const measure = vi.fn(() => 168);
  const pointer = (target: Element, type: string, x: number) => act(() => {
    target.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: 1, button: 0, pointerType: 'touch', clientX: x, clientY: 0,
    }));
  });
  try {
    await act(async () => root.render(<Surface bump={0} />));
    fixtures.activityReads.clear();
    for (let bump = 1; bump <= 50; bump++) {
      await act(async () => root.render(<Surface bump={bump} />));
    }
    expect(fixtures.activityReads.size).toBe(0);
    for (let index = 0; index < 50; index++) {
      await act(async () => appendNotification({
        session: `unrelated-${index}`, directory: '/other', type: 'turn-complete', viewed: false, time: Date.now(),
      }));
    }
    expect(fixtures.activityReads.size).toBe(0);
    const row = host.querySelector('.yuri-mobile-task-card')!;
    const rail = row.querySelector('.yuri-mobile-session-actions')!;
    const main = row.querySelector('.yuri-mobile-task-content > button')!;
    Object.defineProperty(rail, 'offsetWidth', { get: measure });
    pointer(main, 'pointerdown', 200);
    for (let move = 1; move <= 50; move++) pointer(main, 'pointermove', 200 - move * 2);
    pointer(main, 'pointerup', 100);
    expect([...fixtures.activityReads.keys()]).toEqual([tasks[0].id]);
    expect(measure).toHaveBeenCalledOnce();
    expect(rail.getAttribute('aria-hidden')).toBe('false');
  } finally {
    await act(async () => root.unmount());
    fixtures.activityReads.clear();
    resetSessionUnreadProjection();
  }
});

test('inline task archive stays after the rows and restores without selecting a session', async () => {
  const select = vi.fn();
  const restore = vi.fn();
  const toggle = vi.fn();
  const showMore = vi.fn();
  const active = { id: 'active', title: 'Active task', projectLabel: 'Project', project: null, unread: false, pinned: false, active: false };
  const settled = { ...active, id: 'archived', title: 'Archived task with a long title'.repeat(4), activityLabel: '2d' };
  const task: NonNullable<MobileProjectsHomeProps['task']> = {
    view: 'tasks',
    onViewChange: noop,
    model: { pinned: [], active: [active], settled: [settled], settledTotal: 2, settledIds: new Set([settled.id]), runStartTimes: new Map() },
    settledOpen: false,
    onSettledOpenChange: toggle,
    onShowMoreSettled: showMore,
    onSelectTask: select,
    onOpenTaskActions: noop,
    onRestoreTask: restore,
  };
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    await act(async () => root.render(<I18nProvider><MobileProjectsHome {...props} task={task} /></I18nProvider>));
    expect(host.textContent).not.toContain(settled.title);
    const cardList = host.querySelector('.yuri-mobile-task-card')!.parentElement!;
    const archive = cardList.nextElementSibling!;
    expect(archive.classList.contains('yuri-mobile-floating-surface')).toBe(false);
    expect(archive.querySelector('button')?.getAttribute('aria-expanded')).toBe('false');
    await act(async () => (archive.querySelector('button') as HTMLButtonElement).click());
    expect(toggle).toHaveBeenCalledExactlyOnceWith(true);
    await act(async () => root.render(<I18nProvider><MobileProjectsHome {...props} task={{ ...task, settledOpen: true }} /></I18nProvider>));
    const disclosure = archive.querySelector('button')!;
    const archivedList = host.querySelector('.yuri-mobile-task-archived-row')!.parentElement!;
    expect(archivedList.id).toBe(disclosure.getAttribute('aria-controls'));
    const archivedRow = archivedList.querySelector('.yuri-mobile-task-archived-row')!;
    expect(archivedRow.textContent).toContain(settled.title);
    expect(archivedRow.textContent).not.toContain(settled.activityLabel);
    expect(archivedRow.querySelector('use[href="#yuri-folder-open"]')).toBeNull();
    await act(async () => (archivedRow.querySelector('button') as HTMLButtonElement).click());
    expect(select).toHaveBeenCalledExactlyOnceWith(settled.id);
    select.mockClear();
    const restoreButton = host.querySelector('use[href="#yuri-undo-2"]')!.closest('button')!;
    await act(async () => restoreButton.click());
    expect(restore).toHaveBeenCalledExactlyOnceWith(settled.id);
    expect(select).not.toHaveBeenCalled();
    await act(async () => (archivedList.lastElementChild as HTMLButtonElement).click());
    expect(showMore).toHaveBeenCalledOnce();
    await act(async () => root.render(<I18nProvider><MobileProjectsHome {...props} task={task} /></I18nProvider>));
    expect(host.querySelector('.yuri-mobile-task-archived-row')).toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});

test.each(['custom', 'auto'] as const)('inbox project mark reuses the configured %s logo and falls back without duplicating it', async (source) => {
  const project = { id: `inbox-${source}`, icon: 'rocket', iconImage: { mime: 'image/png', updatedAt: 1, source } };
  const task = { id: 'inbox-logo-task', title: 'Task', projectLabel: 'Project', project, unread: false, pinned: false, active: false };
  const createUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue(`blob:inbox-${source}`);
  fixtures.iconFetch.mockClear();
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    await act(async () => root.render(<I18nProvider>
      <MobileTaskCard task={task} runStartedAt={null} onSelect={noop} onOpenActions={noop} onPin={noop} onArchive={noop} />
    </I18nProvider>));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(host.querySelectorAll('.yuri-mobile-task-avatar')).toHaveLength(1);
    expect(host.querySelectorAll('img')).toHaveLength(1);
    expect(host.querySelector('.yuri-mobile-task-avatar img')?.getAttribute('src')).toBe(`blob:inbox-${source}`);
    expect(fixtures.iconFetch.mock.calls.map(([path]) => path)).toEqual([`/api/projects/${project.id}/icon`]);
    await act(async () => host.querySelector('img')!.dispatchEvent(new Event('error')));
    expect(host.querySelector('img')).toBeNull();
    expect(host.querySelector('.yuri-mobile-task-avatar use')?.getAttribute('href')).toBe('#yuri-rocket');
  } finally {
    await act(async () => root.unmount());
    createUrl.mockRestore();
  }
});

test.each(['custom', 'auto'] as const)('mobile home project circle uses the configured %s logo from the project store', async (source) => {
  const previousProjects = useProjectsStore.getState().projects;
  const project = { id: `home-${source}`, path: '/project', label: 'Logo project', icon: 'rocket', iconImage: { mime: 'image/png', updatedAt: 1, source } };
  useProjectsStore.setState({ projects: [project] });
  const createUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue(`blob:home-${source}`);
  fixtures.iconFetch.mockClear();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  function Home() {
    const model = useMobileProjectsHomeModel();
    return <MobileProjectsHome {...props} projects={model.projects} pinnedSessions={[]} />;
  }
  const circle = () => host.querySelector('.yuri-mobile-project-icon')!;
  try {
    await act(async () => root.render(<I18nProvider><Home /></I18nProvider>));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(circle().querySelector('img')?.getAttribute('src')).toBe(`blob:home-${source}`);
    expect(circle().querySelector('use')).toBeNull();
    expect(fixtures.iconFetch.mock.calls.map(([path]) => path)).toEqual([`/api/projects/${project.id}/icon`]);
    for (let i = 0; i < 50; i++) {
      await act(async () => root.render(<I18nProvider><Home /></I18nProvider>));
    }
    expect(fixtures.iconFetch).toHaveBeenCalledTimes(1);
    await act(async () => circle().querySelector('img')!.dispatchEvent(new Event('error')));
    expect(circle().querySelector('img')).toBeNull();
    expect(circle().querySelector('use')?.getAttribute('href')).toBe('#yuri-rocket');
    await act(async () => useProjectsStore.setState({ projects: [{ ...project, iconImage: { ...project.iconImage, updatedAt: 2 } }] }));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(fixtures.iconFetch).toHaveBeenCalledTimes(2);
    expect(circle().querySelector('img')).not.toBeNull();
    await act(async () => useProjectsStore.setState({ projects: [{ ...project, iconImage: undefined }] }));
    expect(circle().querySelector('img')).toBeNull();
    expect(circle().querySelector('use')?.getAttribute('href')).toBe('#yuri-rocket');
  } finally {
    await act(async () => root.unmount());
    useProjectsStore.setState({ projects: previousProjects });
    createUrl.mockRestore(); host.remove();
  }
});

describe('MobileProjectsHome session row isolation', () => {
  test('live rows and session lists use default React.memo against parent identity churn', () => {
    expect(homeSource).toContain('const MobileLiveSessionRow = React.memo(MobileLiveSessionRowImpl)');
    expect(homeSource).toContain('const SessionList = React.memo(SessionListImpl)');
    expect(homeSource).not.toContain('areMobileSessionRowPropsEqual');
  });
});

describe('MobileProjectsHome workspace groups', () => {
  test.each([
    { name: 'no workspaces', worktrees: [] },
    { name: 'empty main workspace', worktrees: [{
      id: 'main',
      name: 'Main workspace',
      path: '/code/empty',
      kind: 'main' as const,
      sessionCount: 0,
      sessions: [],
    }] },
  ])('expanded empty projects show an empty-state message instead of a blank padded group ($name)', ({ worktrees }) => {
    const html = renderToString(
      <I18nProvider>
        <MobileProjectsHome
          {...props}
          pinnedSessions={[]}
          projects={[{ ...projects[0], name: 'Empty project', sessionCount: 0, worktrees }]}
        />
      </I18nProvider>,
    );
    const host = document.createElement('div');
    host.innerHTML = html;

    expect(host.querySelector('.yuri-mobile-project-groups')?.textContent).toBe('No sessions yet');
  });

  test('collapsed empty projects do not reserve a content area or show an empty-state message', () => {
    const html = renderToString(
      <I18nProvider>
        <MobileProjectsHome
          {...props}
          pinnedSessions={[]}
          projects={[{ ...projects[0], expanded: false, sessionCount: 0, worktrees: [] }]}
        />
      </I18nProvider>,
    );

    expect(html).not.toContain('yuri-mobile-project-groups');
    expect(html).not.toContain('No sessions yet');
  });

  test('projects with linked worktrees keep their groups without a project empty-state message', () => {
    const html = renderToString(
      <I18nProvider>
        <MobileProjectsHome
          {...props}
          pinnedSessions={[]}
          projects={[{ ...projects[0], worktrees: [projects[0].worktrees[1]] }]}
        />
      </I18nProvider>,
    );

    expect(html).toContain('Feature branch');
    expect(html).toContain('Feature session');
    expect(html).not.toContain('No sessions yet');
  });

  test('renders one global pinned project card before projects', () => {
    const html = renderToString(
      <I18nProvider>
        <MobileProjectsHome {...props} />
      </I18nProvider>,
    );

    expect(html).toContain('Global pinned session');
    expect(html).toContain('Yuri');
    expect(html).toContain('yuri-mobile-project-shell');
    expect(html.indexOf('Global pinned session')).toBeLessThan(html.indexOf('Main session'));
    expect(html.match(/aria-label="Pinned \/ In progress"/g)).toHaveLength(1);
    expect(html).toContain('yuri-mobile-project-card');
  });

  test('groups pinned sessions above in-progress sessions without extra labels', () => {
    const html = renderToString(
      <I18nProvider>
        <MobileProjectsHome
          {...props}
          inProgressSessions={[{
            id: 'running-session',
            kind: 'pagination',
            title: 'Running session',
            subtitle: 'Yuri',
          }]}
        />
      </I18nProvider>,
    );

    expect(html.indexOf('Global pinned session')).toBeLessThan(html.indexOf('Running session'));
    expect(html.indexOf('Running session')).toBeLessThan(html.indexOf('Main session'));
  });

  test('renders unread attention sessions with the ordinary unread row chrome', () => {
    const html = renderToString(
      <I18nProvider>
        <MobileProjectsHome
          {...props}
          pinnedSessions={[]}
          inProgressSessions={[{
            id: 'unread-session',
            title: 'Unread session',
            unread: true,
          }]}
          projects={[{
            id: 'project-with-unread',
            name: 'Unread project',
            path: '/code/unread-project',
            sessionCount: 1,
            expanded: true,
            worktrees: [{
              id: 'main',
              name: 'Main workspace',
              path: '/code/unread-project',
              kind: 'main',
              sessionCount: 1,
              sessions: [{
                id: 'ordinary-unread-session',
                title: 'Ordinary unread session',
                unread: true,
              }],
            }],
          }]}
        />
      </I18nProvider>,
    );

    expect(html).toContain('Unread session');
    expect(html).toContain('aria-label="Pinned / In progress"');
    expect(html.match(/data-session-status="completed-unread"/g)).toHaveLength(2);
    expect(html.match(/bg-\[var\(--status-info\)\]/g)).toHaveLength(2);
    expect(html).toMatch(/data-session-status="completed-unread"[\s\S]*yuri-mobile-session-title truncate font-semibold[^>]*>Unread session/);
    expect(html).toMatch(/data-session-status="completed-unread"[\s\S]*yuri-mobile-session-title truncate font-semibold[^>]*>Ordinary unread session/);
  });

  test('renders main sessions directly and keeps linked worktree headers', () => {
    const html = renderToString(
      <I18nProvider>
        <MobileProjectsHome {...props} />
      </I18nProvider>,
    );

    expect(html).toContain('Main session');
    expect(html).not.toContain('Main workspace');
    expect(html).toContain('Feature branch');
    expect(html).toContain('Feature session');
    // Worktree name is secondary to the project title — not the same
    // semibold ui-label treatment, or it visually outranks the project.
    expect(html).toMatch(/yuri-mobile-entity-title[^"]*font-semibold[^"]*text-foreground[^>]*>Feature branch/);
  });

  test('wires worktree action affordances on linked worktree headers', () => {
    const html = renderToString(
      <I18nProvider>
        <MobileProjectsHome {...props} />
      </I18nProvider>,
    );

    // Swipe rail + trailing overflow menu (session-row parity; no always-on +).
    expect(html).toContain('yuri-mobile-worktree-actions');
    expect(html).toContain('yuri-mobile-worktree-more');
    expect(html).toContain('yuri-mobile-worktree-label-trigger');
    expect(html).not.toContain('yuri-mobile-worktree-new-session');
  });
});
