import type { MenuItem, TitleBarArea } from 'nsh/desktop';
import type { I18nKey } from '../ui/src/lib/i18n/messages/en';
import { getEffectiveShortcutCombo } from '../ui/src/lib/shortcuts-core';
import { nativeShortcutEditsText, nativeShortcutKeystroke, nativeShortcutReserved, type ShortcutOverrides } from './desktop-shortcuts-core';

export type NativeDesktopAction = {
  run: () => void;
  disabled?: boolean;
  /** Web combo syntax. Undefined derives from the shared registry; null/empty
   * explicitly removes the accelerator, never falls back to a default. */
  shortcut?: string | null;
};
export type NativeDesktopActions = {
  newSession?: NativeDesktopAction;
  search?: NativeDesktopAction;
  switchSession?: NativeDesktopAction;
  settings?: NativeDesktopAction;
  toggleSidebar?: NativeDesktopAction;
  togglePanel?: NativeDesktopAction;
  toggleTerminal?: NativeDesktopAction;
  closeTab?: NativeDesktopAction;
};
export type NativeDesktopMenuGroup = { label: string; submenu: MenuItem[] };
export type NativeDesktopMenuShortcuts = { userOverrides?: ShortcutOverrides; ready?: boolean };

/** Layout idiom is deliberately not a window capability check. */
export function nativeDesktopTitleBarLayout(area: TitleBarArea, height = 40) {
  return {
    height: area.height || height,
    paddingLeft: area.left + 8,
    paddingRight: area.right + 8,
  };
}

/** Roles keep the OS's labels, shortcuts and focused-field editing behavior. */
export function nativeDesktopMenuItems(
  os: string,
  actions: NativeDesktopActions,
  translate: (key: I18nKey) => string,
  shortcuts: NativeDesktopMenuShortcuts = {},
): NativeDesktopMenuGroup[] {
  const mac = os === 'macos';
  const apple = mac || os === 'ios';
  const action = (value: NativeDesktopAction | undefined, key: I18nKey, actionId?: string): MenuItem[] => {
    if (!value) return [];
    const disabled = value.disabled === true || shortcuts.ready === false;
    const combo = value.shortcut === undefined ? actionId ? getEffectiveShortcutCombo(actionId, shortcuts.userOverrides) : '' : value.shortcut ?? '';
    const stroke = !disabled ? nativeShortcutKeystroke(combo, apple) : null;
    const shortcut = stroke && !nativeShortcutReserved(stroke, apple) && !nativeShortcutEditsText(stroke) ? stroke : undefined;
    return [{ label: translate(key), ...(shortcut ? { shortcut } : {}), disabled, when: 'auto',
      onSelect: () => { if (!disabled) value.run(); },
    }];
  };
  const settings = action(actions.settings, 'mobile.menu.settings', 'open_settings');
  const workspace = [
    ...action(actions.toggleSidebar, 'helpDialog.item.toggleSessionSidebar', 'toggle_sidebar'),
    ...action(actions.togglePanel, 'helpDialog.item.toggleRightSidebar', 'toggle_right_sidebar'),
    ...action(actions.toggleTerminal, 'helpDialog.item.toggleTerminal', 'toggle_terminal'),
    ...action(actions.closeTab, 'helpDialog.item.closeContextPanelTab', 'close_context_panel_tab'),
  ];
  // The native close role owns mod+w by default; never let it compete with closeTab.
  const windowItems: MenuItem[] = [{ role: 'minimize' }, { role: 'zoom' }, { role: 'toggleFullScreen' }, ...(!actions.closeTab ? [{ role: 'close' } as const] : [])];
  const appItems: MenuItem[] = [
    ...(mac ? [{ role: 'about' } as const, { type: 'separator' } as const] : []),
    ...settings,
    ...(settings.length ? [{ type: 'separator' } as const] : []),
    ...workspace,
    ...(workspace.length ? [{ type: 'separator' } as const] : []),
    ...(mac ? [{ role: 'hide' } as const, { role: 'hideOthers' } as const, { role: 'showAll' } as const, { type: 'separator' } as const] : []),
    ...windowItems,
    { type: 'separator' }, { role: 'quit' },
  ];
  const sessions = [
    ...action(actions.newSession, 'mobile.menu.newSession', 'new_chat'),
    ...action(actions.search, 'mobile.sessions.searchAria', 'open_command_palette'),
    ...action(actions.switchSession, 'helpDialog.item.switchSession'),
  ];
  return [
    { label: 'Yuri', submenu: appItems },
    ...(sessions.length ? [{ label: translate('header.sessions.title'), submenu: sessions }] : []),
    { label: translate('mobile.instances.edit'), submenu: [
      { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
    ] },
  ];
}

/** Actual app accelerators only. OS edit/window roles retain their native owner. */
export function nativeDesktopMenuKeystrokes(items: readonly NativeDesktopMenuGroup[]): readonly string[] {
  const strokes = new Set<string>();
  function visit(rows: readonly (MenuItem | null | undefined | false)[]) {
    for (const item of rows) {
      if (!item || 'type' in item) continue;
      if (!item.disabled && item.shortcut) strokes.add(item.shortcut);
      if (item.submenu) visit(item.submenu);
    }
  }
  for (const item of items) visit(item.submenu);
  return [...strokes];
}

/** One root owns the installed menu; retired JS callbacks cannot navigate. */
export function createNativeDesktopMenuOwner(api: {
  available: boolean;
  setApplicationMenu: (items: NativeDesktopMenuGroup[] | null) => void;
  popup: (items: MenuItem[]) => Promise<void>;
}) {
  let disposed = false, revision = 0;
  let installed = false;
  let current: NativeDesktopMenuGroup[] = [];
  const guard = (items: MenuItem[], captured: number): MenuItem[] => items.map(item => {
    if ('type' in item) return item;
    const select = item.onSelect;
    return { ...item,
      ...(select ? { onSelect: () => { if (!disposed && captured === revision) select(); } } : {}),
      ...(item.submenu ? { submenu: guard(item.submenu.filter((child): child is MenuItem => !!child), captured) } : {}),
    };
  });
  return {
    update(items: NativeDesktopMenuGroup[]) {
      if (disposed || !api.available) return;
      const captured = revision + 1;
      const next = items.map(item => ({ ...item, submenu: guard(item.submenu, captured) }));
      api.setApplicationMenu(next);
      revision = captured; current = next; installed = true;
    },
    async popup(index: number): Promise<void> {
      if (disposed || !api.available || !current[index]) return;
      await api.popup(current[index].submenu);
    },
    async popupApplication(): Promise<void> {
      if (disposed || !api.available || !current.length) return;
      await api.popup(current);
    },
    dispose() {
      if (disposed) return;
      disposed = true; revision++; current = [];
      if (installed) api.setApplicationMenu(null);
    },
  };
}
