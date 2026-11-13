import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, describe, expect, test, vi } from 'vitest';

import { I18nProvider } from '@/lib/i18n';
import { SortableProjectItem } from './sortableItems';

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
afterAll(() => vi.unstubAllGlobals());

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

describe('project action menus', () => {
  test.each([
    { contextMenu: false, isRepo: true, count: 3 },
    { contextMenu: false, isRepo: false, count: 4 },
    { contextMenu: true, isRepo: true, count: 3 },
    { contextMenu: true, isRepo: false, count: 4 },
  ])('separates rows and inherits icon colors ($contextMenu, $isRepo)', async ({ contextMenu, isRepo, count }) => {
    const onSyncSessions = vi.fn();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(
      <I18nProvider>
        <SortableProjectItem
          id="project-menu-test"
          projectLabel="Project"
          projectDescription="Project"
          isCollapsed
          isActiveProject
          isRepo={isRepo}
          hideDirectoryControls={false}
          mobileVariant={false}
          alwaysShowActions
          onToggle={() => undefined}
          onNewSession={() => undefined}
          onSyncSessions={onSyncSessions}
          onRenameStart={() => undefined}
          onClose={() => undefined}
          openSidebarMenuKey={contextMenu ? null : 'project:project-menu-test'}
          setOpenSidebarMenuKey={() => undefined}
        />
      </I18nProvider>,
    ));
    if (contextMenu) {
      await act(async () => {
        container!.querySelector('[data-sidebar-project-header]')!.dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }),
        );
      });
    }
    const menu = document.body.querySelector('[role="menu"]')!;
    expect(menu).not.toBeNull();
    const rows = Array.from(menu.querySelectorAll('[role="menuitem"]'));
    expect(rows).toHaveLength(count);
    const separators = menu.querySelectorAll('[role="separator"]');
    expect(separators).toHaveLength(1);
    expect(separators[0].nextElementSibling).toBe(rows.at(-1));
    for (const row of rows) {
      expect(row.querySelector('svg')?.classList.contains('text-inherit')).toBe(true);
    }
    expect(rows.at(-1)?.classList.contains('text-destructive')).toBe(true);
    const sync = rows.find(row => row.textContent?.includes('Sync sessions'))!;
    await act(async () => sync.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onSyncSessions).toHaveBeenCalledTimes(1);
  });
});
