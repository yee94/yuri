import type { I18nKey } from './i18n/messages/en';
import type { IconName } from '../components/icon/icons';
import { getEffectiveShortcutCombos, getShortcutAction } from './shortcuts-core';

export type HelpShortcutItem = {
  id?: string;
  keys: string | string[];
  descriptionKey: I18nKey;
  icon: IconName | null;
  /** Static contextual hints still identify their real implementation owners. */
  supportActions?: readonly string[];
  leader?: { actionID: string; key: string };
};

export type HelpShortcutSection = {
  categoryKey: I18nKey;
  items: HelpShortcutItem[];
};

/** The complete HelpDialog catalog, without a UI framework or environment read.
 * Default action keys/aliases stay in shortcuts-core; neither client copies them. */
export function helpShortcutSections(mod: string): readonly HelpShortcutSection[] {
  return [
    {
      categoryKey: "helpDialog.section.navigationCommands",
      items: [
        {
          id: 'open_command_palette',
          descriptionKey: "helpDialog.item.openCommandPalette",
          icon: "command",
          keys: '',
        },
        {
          id: 'open_help',
          descriptionKey: "helpDialog.item.showKeyboardShortcuts",
          icon: "question",
          keys: '',
        },
        {
          id: 'toggle_sidebar',
          descriptionKey: "helpDialog.item.toggleSessionSidebar",
          icon: "layout-left",
          keys: '',
        },
        {
          id: 'cycle_agent',
          keys: '',
          descriptionKey: "helpDialog.item.cycleAgent",
          icon: "ai-agent",
        },
        {
          id: 'open_model_selector',
          descriptionKey: "helpDialog.item.openModelSelector",
          icon: "ai-generate-2",
          keys: '',
        },
        {
          keys: ["↑↓"],
          descriptionKey: "helpDialog.item.navigateModels",
          icon: "ai-generate-2",
          supportActions: ['open_model_selector'],
        },
        {
          keys: ["←→"],
          descriptionKey: "helpDialog.item.adjustThinkingMode",
          icon: "brain-ai-3",
          supportActions: ['cycle_thinking_variant'],
        },
        {
          id: 'cycle_thinking_variant',
          descriptionKey: "helpDialog.item.cycleThinkingVariant",
          icon: "brain-ai-3",
          keys: '',
        },
        {
          keys: [`Shift + ${mod} + N`],
          descriptionKey: "helpDialog.item.newWindow",
          icon: "window",
          supportActions: ['new_window'],
        },
      ],
    },
    {
      categoryKey: "helpDialog.section.sessionManagement",
      items: [
        {
          id: 'new_chat',
          descriptionKey: "helpDialog.item.createNewSession",
          icon: "add",
          keys: '',
        },
        {
          id: 'new_chat_worktree',
          descriptionKey: "helpDialog.item.createNewWorktreeDraft",
          icon: "git-branch",
          keys: '',
        },
        {
          id: 'previous_session',
          descriptionKey: 'helpDialog.item.previousSession',
          icon: "arrow-left",
          keys: '',
        },
        {
          id: 'next_session',
          descriptionKey: 'helpDialog.item.nextSession',
          icon: "arrow-right",
          keys: '',
        },
        { id: 'focus_input', descriptionKey: "helpDialog.item.focusChatInput", icon: "text", keys: '' },
        {
          id: 'toggle_prompt_navigator',
          descriptionKey: "helpDialog.item.togglePromptNavigator",
          icon: "list-unordered",
          keys: '',
        },
        {
          id: 'abort_run',
          descriptionKey: "helpDialog.item.abortActiveRun",
          icon: "close-circle",
          keys: '',
        },
      ],
    },
    {
      categoryKey: "helpDialog.section.leaderChords",
      items: [
        {
          keys: '',
          leader: { actionID: 'open_model_selector', key: 'M' },
          descriptionKey: "helpDialog.item.leaderOpenModel",
          icon: "ai-generate-2",
        },
        {
          keys: '',
          leader: { actionID: 'open_agent_selector', key: 'A' },
          descriptionKey: "helpDialog.item.leaderOpenAgent",
          icon: "ai-agent",
        },
        {
          keys: '',
          leader: { actionID: 'new_chat', key: 'N' },
          descriptionKey: "helpDialog.item.leaderNewSession",
          icon: "add",
        },
        {
          keys: '',
          leader: { actionID: 'compact_session', key: 'C' },
          descriptionKey: "helpDialog.item.leaderCompact",
          icon: "scissors",
        },
      ],
    },
    {
      categoryKey: "helpDialog.section.panels",
      items: [
        {
          id: 'toggle_right_sidebar',
          descriptionKey: 'helpDialog.item.toggleRightSidebar',
          icon: "layout-right",
          keys: '',
        },
        {
          id: 'open_right_sidebar_git',
          descriptionKey: 'helpDialog.item.openRightSidebarGitTab',
          icon: "git-branch",
          keys: '',
        },
        {
          id: 'open_right_sidebar_files',
          descriptionKey: 'helpDialog.item.openRightSidebarFilesTab',
          icon: "layout-right",
          keys: '',
        },
        {
          id: 'cycle_right_sidebar_tab',
          descriptionKey: 'helpDialog.item.cycleRightSidebarTab',
          icon: "layout-right",
          keys: '',
        },
        {
          id: 'close_context_panel_tab',
          descriptionKey: 'helpDialog.item.closeContextPanelTab',
          icon: "close",
          keys: '',
        },
        {
          id: 'toggle_terminal',
          descriptionKey: 'helpDialog.item.toggleTerminal',
          icon: "window",
          keys: '',
        },
        {
          id: 'new_terminal_tab',
          descriptionKey: 'helpDialog.item.newTerminalTab',
          icon: "terminal-box",
          keys: '',
        },
        {
          id: 'open_new_terminal',
          descriptionKey: 'helpDialog.item.openNewTerminal',
          icon: "terminal-box",
          keys: '',
        },
        {
          id: 'previous_terminal_tab',
          descriptionKey: 'helpDialog.item.previousTerminalTab',
          icon: "arrow-left",
          keys: '',
        },
        {
          id: 'next_terminal_tab',
          descriptionKey: 'helpDialog.item.nextTerminalTab',
          icon: "arrow-right",
          keys: '',
        },
        {
          id: 'toggle_bottom_panel',
          descriptionKey: 'helpDialog.item.toggleBottomPanel',
          icon: "window",
          keys: '',
        },
        {
          id: 'toggle_terminal_expanded',
          descriptionKey: 'helpDialog.item.toggleTerminalExpanded',
          icon: "window",
          keys: '',
        },
      ],
    },
    {
      categoryKey: "helpDialog.section.interface",
      items: [
        {
          id: 'cycle_theme',
          descriptionKey: "helpDialog.item.cycleTheme",
          icon: "palette",
          keys: '',
        },
        {
          id: 'zoom_in',
          descriptionKey: 'helpDialog.item.zoomIn',
          icon: "add",
          keys: '',
        },
        {
          id: 'zoom_out',
          descriptionKey: 'helpDialog.item.zoomOut',
          icon: "subtract",
          keys: '',
        },
        {
          id: 'zoom_reset',
          descriptionKey: 'helpDialog.item.zoomReset',
          icon: "restart",
          keys: '',
        },
        {
          keys: [`${mod} + 1...9`],
          descriptionKey: "helpDialog.item.switchSession",
          icon: "layout-left",
          supportActions: Array.from({ length: 9 }, (_, index) => `switch_tab_${index + 1}`),
        },
        {
          id: 'toggle_services_menu',
          descriptionKey: 'helpDialog.item.toggleServicesMenu',
          icon: "stack",
          keys: '',
        },
        {
          id: 'open_usage',
          descriptionKey: 'helpDialog.item.openUsage',
          icon: "timer",
          keys: '',
        },
        {
          id: 'cycle_services_tab',
          descriptionKey: 'helpDialog.item.cycleServicesTab',
          icon: "stack",
          keys: '',
        },
        {
          id: 'open_settings',
          descriptionKey: "helpDialog.item.openSettings",
          icon: "settings-3",
          keys: '',
        },
      ],
    },
  ];
}

export function helpShortcutDisplayKeys(item: HelpShortcutItem, overrides: Readonly<Record<string, string>>, format: (combo: string) => string): readonly string[] {
  const leader = item.leader;
  if (leader) return getEffectiveShortcutCombos('leader_key', overrides).map(combo => `${format(combo)} → ${leader.key}`);
  if (item.id && getShortcutAction(item.id)) return getEffectiveShortcutCombos(item.id, overrides).map(format);
  return Array.isArray(item.keys) ? item.keys : item.keys.split(' / ');
}
