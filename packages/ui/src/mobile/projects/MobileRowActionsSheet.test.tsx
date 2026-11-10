import { afterAll, afterEach, describe, expect, test, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';

vi.mock('@/components/ui/MobileResizableSheet', () => ({
  MobileResizableSheet: ({ children }: { children: React.ReactNode }) => children,
}));

import { MobileRowActionsSheet } from './MobileRowActionsSheet';
import { useSessionReadMenuAction } from '../useSessionReadMenuAction';
import { appendNotification, applySessionUnreadSnapshot, installSessionReadSync, resetSessionUnreadProjection, useNotificationStore } from '@/sync/notification-store';
import { toast } from '@/components/ui/toast';

vi.hoisted(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ home: '/workspace', data: [] })));
});
afterAll(() => vi.unstubAllGlobals());
let root: ReturnType<typeof createRoot> | undefined;
let container: HTMLDivElement | undefined;
let stopReadSync: (() => void) | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
  stopReadSync?.();
  stopReadSync = undefined;
  resetSessionUnreadProjection();
  vi.restoreAllMocks();
});

function ReadActionHarness({ id = 'session-1', parentID }: { id?: string; parentID?: string }) {
  renderReadAction();
  const { unread, onToggleRead } = useSessionReadMenuAction({ id, directory: '/project', parentID });
  return <MobileRowActionsSheet
    open
    target={{ kind: 'session', title: 'Session', pinned: false, shared: false, unread }}
    actions={{ onTogglePin: () => undefined, onToggleRead, onArchive: () => undefined }}
    onOpenChange={closeSheet}
  />;
}
const closeSheet = vi.fn();
const renderReadAction = vi.fn();
async function mountReadAction(props: { id?: string; parentID?: string } = {}) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  closeSheet.mockClear();
  renderReadAction.mockClear();
  await act(async () => root!.render(<I18nProvider><ReadActionHarness {...props} /></I18nProvider>));
}
const readAction = () => Array.from(container!.querySelectorAll('button'))
  .find(button => button.textContent?.includes('Mark as'));

describe('MobileRowActionsSheet session actions', () => {
  test('toggles shared unread state directly below pin and closes the sheet', async () => {
    await mountReadAction();
    const buttons = Array.from(container!.querySelectorAll('button'));
    expect(buttons[0].textContent).toContain('Pin');
    expect(buttons[1]).toBe(readAction());
    expect(readAction()?.textContent).toContain('Mark as unread');
    expect(readAction()?.querySelector('use')?.getAttribute('href')).toBe('#yuri-mail');
    await act(async () => readAction()!.click());
    expect(closeSheet).toHaveBeenCalledWith(false);
    expect(useNotificationStore.getState().sessionUnseenCount('session-1')).toBe(1);
    expect(readAction()?.textContent).toContain('Mark as read');
    expect(readAction()?.querySelector('use')?.getAttribute('href')).toBe('#yuri-mail-open');
    await act(async () => readAction()!.click());
    expect(useNotificationStore.getState().sessionUnseenCount('session-1')).toBe(0);
    expect(readAction()?.textContent).toContain('Mark as unread');
  });

  test('reflects remote unread changes while the menu is open', async () => {
    await mountReadAction();
    await act(async () => applySessionUnreadSnapshot({
      'session-1': { directory: '/project', unreadCount: 1, manual: true, hasError: false, revision: 1 },
    }));
    expect(readAction()?.textContent).toContain('Mark as read');
    await act(async () => applySessionUnreadSnapshot({}));
    expect(readAction()?.textContent).toContain('Mark as unread');
  });

  test('writes through the installed Host sync for both actions', async () => {
    const unread = vi.fn(async (id: string) => applySessionUnreadSnapshot({
      [id]: { directory: '/project', unreadCount: 1, manual: true, hasError: false, revision: 1 },
    }));
    const read = vi.fn(() => applySessionUnreadSnapshot({}));
    stopReadSync = installSessionReadSync({ read, unread });
    await mountReadAction();
    await act(async () => readAction()!.click());
    expect(unread).toHaveBeenCalledWith('session-1');
    expect(readAction()?.textContent).toContain('Mark as read');
    await act(async () => readAction()!.click());
    expect(read).toHaveBeenCalledWith('session-1');
    expect(readAction()?.textContent).toContain('Mark as unread');
  });

  test('unrelated session notifications do not rerender the open action menu', async () => {
    await mountReadAction();
    const initialRenders = renderReadAction.mock.calls.length;
    for (let index = 0; index < 50; index++) {
      await act(async () => appendNotification({
        session: `other-${index}`, directory: '/other', type: 'turn-complete', viewed: false, time: Date.now(),
      }));
    }
    expect(renderReadAction).toHaveBeenCalledTimes(initialRenders);
  });

  test('switching menu targets sends the action to the latest session', async () => {
    await mountReadAction();
    await act(async () => readAction()!.click());
    await act(async () => root!.render(<I18nProvider><ReadActionHarness id="session-2" /></I18nProvider>));
    expect(readAction()?.textContent).toContain('Mark as unread');
    await act(async () => readAction()!.click());
    expect(useNotificationStore.getState().sessionUnseenCount('session-1')).toBe(1);
    expect(useNotificationStore.getState().sessionUnseenCount('session-2')).toBe(1);
  });

  test('reports a failed server write without fabricating unread state', async () => {
    const errorToast = vi.spyOn(toast, 'error').mockImplementation(() => 'error');
    stopReadSync = installSessionReadSync({ read: vi.fn(), unread: vi.fn().mockRejectedValue(new Error('offline')) });
    await mountReadAction();
    await act(async () => readAction()!.click());
    expect(errorToast).toHaveBeenCalledTimes(1);
    expect(useNotificationStore.getState().sessionUnseenCount('session-1')).toBe(0);
    expect(readAction()?.textContent).toContain('Mark as unread');
  });

  test('child sessions omit the action like desktop', async () => {
    await mountReadAction({ parentID: 'parent' });
    expect(readAction()).toBeUndefined();
  });

  test('renders Sync messages when the session callback is available', () => {
    const html = renderToString(
      <I18nProvider>
        <MobileRowActionsSheet
          open
          target={{ kind: 'session', title: 'Session', pinned: false, shared: false }}
          actions={{ onRefreshTranscript: () => undefined }}
          onOpenChange={() => undefined}
        />
      </I18nProvider>,
    );

    expect(html).toContain('Sync messages');
  });
});

describe('MobileRowActionsSheet project actions', () => {
  test('separates only Close project and keeps destructive icons in the label color', () => {
    const html = renderToString(
      <I18nProvider>
        <MobileRowActionsSheet
          open
          target={{ kind: 'project', title: 'Project', gitRepository: true }}
          actions={{
            onSyncSessions: () => undefined,
            onEditProject: () => undefined,
            onCloseProject: () => undefined,
          }}
          onOpenChange={() => undefined}
        />
      </I18nProvider>,
    );
    const content = document.createElement('div');
    content.innerHTML = html;
    const rows = Array.from(content.querySelectorAll('button'));
    expect(rows).toHaveLength(3);
    expect(content.querySelectorAll('button.border-b')).toHaveLength(0);
    expect(content.querySelectorAll('button.border-t')).toHaveLength(1);
    expect(rows[2].classList.contains('border-t')).toBe(true);
    expect(rows[2].classList.contains('border-[var(--yuri-popup-divider)]')).toBe(true);
    expect(content.querySelectorAll('[data-mobile-action-group]')).toHaveLength(1);
    for (const row of rows) {
      expect(row.querySelector('svg')?.classList.contains('text-inherit')).toBe(true);
    }
    expect(rows[2].classList.contains('text-[var(--status-error)]')).toBe(true);
  });

  test('renders Sync sessions when the project callback is available', () => {
    const html = renderToString(
      <I18nProvider>
        <MobileRowActionsSheet
          open
          target={{ kind: 'project', title: 'Yuri', gitRepository: true }}
          actions={{ onSyncSessions: () => undefined }}
          onOpenChange={() => undefined}
        />
      </I18nProvider>,
    );

    expect(html).toContain('Sync sessions');
    expect(html).toContain('rounded-none');
    expect(html).toContain('supports-[corner-shape:squircle]:rounded-none');
    expect(html).toContain('data-mobile-press-feedback="none"');
    expect(html).toContain('active:bg-interactive-active');
    expect(html).toContain('dark:active:bg-interactive-active');
    expect(html).toContain('data-page-scroll-lock="true"');
    expect(html).toContain('min-h-14');
    expect(html).toContain('leading-6');
  });
});

describe('MobileRowActionsSheet worktree actions', () => {
  test('renders the destructive action in a separate grouped card', () => {
    const html = renderToString(
      <I18nProvider>
        <MobileRowActionsSheet
          open
          target={{ kind: 'worktree', title: 'ios-native' }}
          actions={{
            onNewSession: () => undefined,
            onDeleteWorktree: () => undefined,
          }}
          onOpenChange={() => undefined}
        />
      </I18nProvider>,
    );
    const container = document.createElement('div');
    container.innerHTML = html;
    const standardGroup = container.querySelector('[data-mobile-action-group="standard"]');
    const separatedGroup = container.querySelector('[data-mobile-action-group="separated"]');

    expect(container.querySelectorAll('[data-mobile-action-group]')).toHaveLength(2);
    expect(standardGroup?.querySelectorAll('button')).toHaveLength(1);
    expect(standardGroup?.textContent).toContain('New Session');
    expect(separatedGroup?.querySelectorAll('button')).toHaveLength(1);
    expect(separatedGroup?.textContent).toContain('Remove');
    expect(separatedGroup?.classList.contains('flex')).toBe(true);
    expect(separatedGroup?.classList.contains('flex-col')).toBe(true);
    expect(separatedGroup?.querySelector('button')?.classList.contains('border-0')).toBe(true);
    expect(html).toContain('gap-5');
  });
});
