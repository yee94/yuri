import type { SettingsRoute } from '../shell/nav';
import { AboutPage } from './AboutPage';
import { AgentsPage } from './AgentsPage';
import { AppearancePage } from './AppearancePage';
import { InstancesPage } from './InstancesPage';
import { NotificationsPage } from './NotificationsPage';
import { ProvidersPage } from './ProvidersPage';
import {
  ArchivedSessionsSettingsPage,
  AssistantsSettingsListPage,
  BehaviorSettingsPage,
  ChatSettingsPage,
  CommandsSettingsPage,
  ConfigPrefixPage,
  GitSettingsPage,
  McpSettingsPage,
  PluginsSettingsPage,
  ProjectsSettingsPage,
  SessionsSettingsPage,
  SkillsSettingsPage,
  UsageSettingsPage,
} from './MorePages';

/** One Settings page, picked by the pushed route's slug. */
export function SettingsDetailPage(props: { route: SettingsRoute }) {
  switch (props.route.slug) {
    case 'instances':
      return <InstancesPage />;
    case 'appearance':
      return <AppearancePage />;
    case 'chat':
      return <ChatSettingsPage />;
    case 'notifications':
      return <NotificationsPage />;
    case 'sessions':
      return <SessionsSettingsPage />;
    case 'archived-sessions':
      return <ArchivedSessionsSettingsPage />;
    case 'projects':
      return <ProjectsSettingsPage />;
    case 'git':
      return <GitSettingsPage />;
    case 'providers':
      return <ProvidersPage />;
    case 'agents':
      return <AgentsPage />;
    case 'assistants':
      return <AssistantsSettingsListPage />;
    case 'commands':
      return <CommandsSettingsPage />;
    case 'mcp':
      return <McpSettingsPage />;
    case 'plugins':
      return <PluginsSettingsPage />;
    case 'skills.installed':
      return <SkillsSettingsPage />;
    case 'usage':
      return <UsageSettingsPage />;
    case 'about':
      return <AboutPage />;
    case 'summary-ai':
      return <ConfigPrefixPage titleKey="settings.page.summaryAI.title" prefix="summary" />;
    case 'behavior':
      return <BehaviorSettingsPage />;
    case 'magic-prompts':
      return <ConfigPrefixPage titleKey="settings.page.magicPrompts.title" prefix="magicprompt" />;
    case 'voice':
      return <ConfigPrefixPage titleKey="settings.page.voice.title" prefix="voice" />;
    default:
      return <InstancesPage />;
  }
}
