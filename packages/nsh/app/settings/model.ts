import type { IconName } from '../core/Icon';
import { t, type I18nKey } from '../core/i18n';
import type { SettingsSlug } from '../shell/nav';

export type SettingsGroupID = 'connection' | 'personalization' | 'workspace' | 'opencode' | 'content' | 'system';

export type SettingsPageEntry = {
  slug: SettingsSlug;
  titleKey: I18nKey;
  icon: IconName;
  /** Web's search keywords, kept so the phone's search matches the same pages. */
  keywords: string;
};

export type SettingsGroupEntry = {
  id: SettingsGroupID;
  labelKey: I18nKey;
  pages: SettingsPageEntry[];
};

/** Web `MOBILE_SETTINGS_PAGE_SLUGS`, in `groupSettingsPages` order. */
export const SETTINGS_GROUPS: SettingsGroupEntry[] = [
  {
    id: 'connection',
    labelKey: 'settings.view.navigation.groups.connection',
    pages: [
      { slug: 'instances', titleKey: 'mobile.settings.switchInstance', icon: 'server', keywords: 'instance server connection switch' },
    ],
  },
  {
    id: 'personalization',
    labelKey: 'settings.view.navigation.groups.personalization',
    pages: [
      { slug: 'appearance', titleKey: 'settings.page.appearance.title', icon: 'palette', keywords: 'theme font spacing radius language' },
      { slug: 'chat', titleKey: 'settings.page.chat.title', icon: 'chat-ai-3', keywords: 'tools diff reasoning draft queue output copy' },
      { slug: 'notifications', titleKey: 'settings.page.notifications.title', icon: 'notification-3', keywords: 'alerts native summary' },
      { slug: 'sessions', titleKey: 'settings.page.sessions.title', icon: 'chat-history', keywords: 'defaults retention memory limits' },
      { slug: 'archived-sessions', titleKey: 'settings.page.archivedSessions.title', icon: 'archive', keywords: 'archive restore history' },
      { slug: 'summary-ai', titleKey: 'settings.page.summaryAI.title', icon: 'ai-generate-2', keywords: 'summary commit title prompt provider' },
    ],
  },
  {
    id: 'workspace',
    labelKey: 'settings.view.navigation.groups.workspace',
    pages: [
      { slug: 'projects', titleKey: 'settings.page.projects.title', icon: 'folders', keywords: 'project worktree repository directory' },
      { slug: 'git', titleKey: 'settings.page.git.title', icon: 'git-branch', keywords: 'git github identity ssh credentials' },
    ],
  },
  {
    id: 'opencode',
    labelKey: 'settings.view.navigation.groups.opencode',
    pages: [
      { slug: 'providers', titleKey: 'settings.page.providers.title', icon: 'cloud', keywords: 'provider models api key credentials' },
      { slug: 'agents', titleKey: 'settings.page.agents.title', icon: 'node-tree', keywords: 'agent prompts tools permissions' },
      { slug: 'assistants', titleKey: 'assistants.title', icon: 'robot-2', keywords: 'bot bots assistant assistants sharing' },
      { slug: 'behavior', titleKey: 'settings.page.behavior.title', icon: 'brain', keywords: 'behavior agents.md instructions' },
      { slug: 'commands', titleKey: 'settings.page.commands.title', icon: 'slash-commands-2', keywords: 'command slash macros' },
      { slug: 'mcp', titleKey: 'settings.page.mcp.title', icon: 'server', keywords: 'mcp servers tools' },
      { slug: 'plugins', titleKey: 'settings.page.plugins.title', icon: 'code-box', keywords: 'plugin extensions' },
    ],
  },
  {
    id: 'content',
    labelKey: 'settings.view.navigation.groups.content',
    pages: [
      { slug: 'magic-prompts', titleKey: 'settings.page.magicPrompts.title', icon: 'ai-generate-2', keywords: 'prompts templates' },
      { slug: 'skills.installed', titleKey: 'settings.page.skills.title', icon: 'book-open', keywords: 'skill skills instructions' },
    ],
  },
  {
    id: 'system',
    labelKey: 'settings.view.navigation.groups.system',
    pages: [
      { slug: 'usage', titleKey: 'settings.page.usage.title', icon: 'bar-chart-2', keywords: 'quota billing tokens usage limits' },
      { slug: 'voice', titleKey: 'settings.page.voice.title', icon: 'mic', keywords: 'tts speech voice' },
      { slug: 'about', titleKey: 'settings.page.about.title', icon: 'information', keywords: 'about version updates release' },
    ],
  },
];

export const ALL_SETTINGS_PAGES = SETTINGS_GROUPS.flatMap((group) => group.pages);

export const settingsPageTitle = (slug: SettingsSlug): string => {
  const page = ALL_SETTINGS_PAGES.find((entry) => entry.slug === slug);
  return page ? t(page.titleKey) : '';
};

export function filterSettingsPages(query: string): SettingsGroupEntry[] {
  const value = query.trim().toLowerCase();
  if (!value) return SETTINGS_GROUPS;
  return SETTINGS_GROUPS.map((group) => ({
    ...group,
    pages: group.pages.filter((page) => {
      const title = t(page.titleKey).toLowerCase();
      return title.includes(value) || page.slug.includes(value) || page.keywords.includes(value);
    }),
  })).filter((group) => group.pages.length > 0);
}
