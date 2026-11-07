import type { I18nKey } from '../ui/src/lib/i18n/messages/en';
import type { ChatTarget } from './model';
import type { ProjectSearchCommand } from './projects-search-core';

export type SessionSwitcherLocation = { messageID?: string };

/** Close only the picker. The retained Chat remains the sole owner of its draft. */
export function createSessionSwitcherSelection(options: {
  currentTarget?: ChatTarget;
  current: () => boolean;
  close: () => void;
  openChat: (target: ChatTarget, location?: SessionSwitcherLocation) => void;
}) {
  return (target: ChatTarget, location?: SessionSwitcherLocation): void => {
    if (!options.current()) return;
    const previous = options.currentTarget;
    options.close();
    if (!location?.messageID && previous?.kind === target.kind && previous.id === target.id && previous.directory === target.directory) return;
    options.openChat(target, location);
  };
}

/** Inventory only: the app injects actual navigation/overview owners, not derived usage. */
export function chatNavigationSearchCommands(options: {
  t: (key: I18nKey) => string;
  current: () => boolean;
  closeSearch: () => void;
  openSessions: () => void;
  /** Explicit open (not toggle). Omit until the owning context surface is wired. */
  openContextUsage?: () => void;
}): ProjectSearchCommand[] {
  const action = (open: () => void) => () => { if (options.current()) { options.closeSearch(); open(); } };
  return [
    { id: 'toggle-sidebar', title: options.t('commandPalette.item.showSessionSwitcher'), group: 'commands', onSelect: action(options.openSessions) },
    ...(options.openContextUsage ? [{ id: 'context-usage', title: options.t('commandPalette.item.showContextUsage'), group: 'commands' as const, onSelect: action(options.openContextUsage) }] : []),
  ];
}
