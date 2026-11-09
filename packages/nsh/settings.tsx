import { Scroll, signal, Text, View } from 'nsh';
import { nativeDensity } from './appearance';
import { Button, Input, NavPage } from 'nsh/base';
import { Icon } from './Icon';
import { t } from './i18n';
import { SettingsBasics } from './settings-basics';
import { SettingsCollection, type SettingsCollectionCallbacks, type SettingsCollectionDraft, type SettingsCollectionNavigation } from './settings-collections';
import { SettingsGit } from './settings-git';
import { SettingsUsage } from './settings-usage';
import { SettingsArchive } from './settings-archive';
import { SettingsMagicPrompts } from './settings-magic-prompts';
import { SettingsProjectsPage } from './settings-projects';
import { SettingsPreferences } from './settings-preferences';
import { SettingsAbout } from './settings-about';
import { searchSettingsFields } from './settings-search-core';
import type { I18nKey } from '../ui/src/lib/i18n/messages/en';
import type { QuotaCredentialProvider } from './settings-quota-credentials-core';
import type { RetentionController } from './settings-retention-controller';
import type { SettingsHostOperation } from './settings-controls';

export type SettingsPageID = 'instances' | 'appearance' | 'chat' | 'notifications' | 'sessions' | 'archived-sessions' | 'summary-ai' | 'projects' | 'git' | 'providers' | 'agents' | 'assistants' | 'behavior' | 'commands' | 'mcp' | 'plugins' | 'magic-prompts' | 'skills.installed' | 'usage' | 'voice' | 'about';
export type SettingsRoute = { page: SettingsPageID; entity?: string; create?: boolean; target?: string; directory?: string; collectionDraft?: SettingsCollectionDraft };
export type SettingsCallbacks = SettingsCollectionCallbacks & {
  onOpen: (route: SettingsRoute) => void;
  onBack: () => void;
  onConnect: () => void;
  onEditConnection?: (id: string, mode: 'rename' | 'edit') => void;
  onProjects?: () => void;
  onAssistants?: () => void;
  onManageQuotaCredentials?: (provider: QuotaCredentialProvider, providerName: string, directory?: string) => void;
  onAppearanceChange?: (value: 'system' | 'light' | 'dark') => void;
};
type Entry = { page: SettingsPageID; title: I18nKey; group: 'connection' | 'personalization' | 'workspace' | 'opencode' | 'content' | 'system'; icon: Parameters<typeof Icon>[0]['name'] };
export const SETTINGS_ENTRIES: readonly Entry[] = [
  { page: 'instances', title: 'mobile.connect.saved.title', group: 'connection', icon: 'server' },
  { page: 'appearance', title: 'settings.page.appearance.title', group: 'personalization', icon: 'palette' },
  { page: 'chat', title: 'settings.page.chat.title', group: 'personalization', icon: 'chat-ai-3' },
  { page: 'notifications', title: 'settings.page.notifications.title', group: 'personalization', icon: 'notification-3' },
  { page: 'sessions', title: 'settings.page.sessions.title', group: 'personalization', icon: 'chat-history' },
  { page: 'archived-sessions', title: 'settings.page.archivedSessions.title', group: 'personalization', icon: 'archive' },
  { page: 'summary-ai', title: 'settings.page.summaryAI.title', group: 'personalization', icon: 'ai-generate-2' },
  { page: 'projects', title: 'settings.page.projects.title', group: 'workspace', icon: 'folders' },
  { page: 'git', title: 'settings.page.git.title', group: 'workspace', icon: 'git-branch' },
  { page: 'providers', title: 'settings.page.providers.title', group: 'opencode', icon: 'cloud' },
  { page: 'agents', title: 'settings.page.agents.title', group: 'opencode', icon: 'node-tree' },
  { page: 'assistants', title: 'mobile.tabs.assistant', group: 'opencode', icon: 'robot-2' },
  { page: 'behavior', title: 'settings.behavior.page.title', group: 'opencode', icon: 'brain' },
  { page: 'commands', title: 'settings.page.commands.title', group: 'opencode', icon: 'slash-commands-2' },
  { page: 'mcp', title: 'settings.page.mcp.title', group: 'opencode', icon: 'plug' },
  { page: 'plugins', title: 'settings.page.plugins.title', group: 'opencode', icon: 'code-box' },
  { page: 'magic-prompts', title: 'settings.page.magicPrompts.title', group: 'content', icon: 'ai-generate-2' },
  { page: 'skills.installed', title: 'settings.page.skills.title', group: 'content', icon: 'book-open' },
  { page: 'usage', title: 'settings.page.usage.title', group: 'system', icon: 'bar-chart-2' },
  { page: 'voice', title: 'settings.page.voice.title', group: 'system', icon: 'mic' },
  { page: 'about', title: 'settings.page.about.title', group: 'system', icon: 'information' },
];

/** Embeddable root content. The owner supplies the NavStack and connection flow. */
export function SettingsHome(props: SettingsCallbacks & { showTitle?: boolean; bottomInset?: number }) {
  const search = signal('');
  const groups = ['connection', 'personalization', 'workspace', 'opencode', 'content', 'system'] as const;
  const visible = () => SETTINGS_ENTRIES.filter(entry => t(entry.title).toLocaleLowerCase().includes(search().trim().toLocaleLowerCase()));
  const matches = () => searchSettingsFields(search(), t);
  return <Scroll class="flex-1 bg-background" contentClass="p-5 gap-6 pb-10" contentStyle={{ ...nativeDensity().pages.settingsHome, paddingBottom: (props.bottomInset ?? 0) + 40 }}>
    <If when={props.showTitle !== false}><Text class="text-3xl font-semibold text-foreground">{t('settings.view.home.title')}</Text></If>
    <Input testID="settings-search" class="min-h-12 px-3 rounded-xl bg-card text-foreground" value={search()} onChange={e => search.set(e.value)} placeholder={t('settings.view.search.placeholder')} />
    <If when={!visible().length && !matches().length}><Text class="text-muted-foreground">{t('settings.view.search.noResults')}</Text></If>
    <If when={matches().length > 0}><View class="bg-card rounded-2xl px-3"><Each of={matches()}>{item => <Button testID={`settings-search-${item().id}`} class="min-h-12 py-3 gap-1 active:bg-accent" onPress={() => props.onOpen({ page: item().page, target: item().id })}>
      <Text class="text-sm text-foreground">{t(item().title)}</Text><Text class="text-xs text-muted-foreground">{t(SETTINGS_ENTRIES.find(entry => entry.page === item().page)!.title)}</Text>
    </Button>}</Each></View></If>
    <Each of={groups.filter(group => visible().some(entry => entry.group === group))}>{group => <View class="gap-2">
      <Text class="text-xs text-muted-foreground px-1">{t(`settings.view.navigation.groups.${group()}`)}</Text>
      <View class="bg-card rounded-2xl px-3">
        <Each of={visible().filter(entry => entry.group === group())}>{entry =>
          <Button class="min-h-12 py-3 flex-row items-center gap-3 active:bg-accent" onPress={() => {
            if (entry().page === 'assistants' && props.onAssistants) props.onAssistants();
            else props.onOpen({ page: entry().page });
          }}>
            <Icon name={entry().icon} /><Text class="flex-1 text-base text-foreground">{t(entry().title)}</Text><Icon name="arrow-right-s" size={16} />
          </Button>
        }</Each>
      </View>
    </View>}</Each>
  </Scroll>;
}

/** Render inside the application's NavStack; route.entity opens the third level. */
export function SettingsPage(props: SettingsCallbacks & SettingsRoute & { directory?: string; active?: boolean; retention?: RetentionController; operationToken?: SettingsHostOperation | null }) {
  if (props.page === 'projects') return <SettingsProjectsPage {...props} />;
  const collectionNavigation = signal<SettingsCollectionNavigation>({ blocked: false, back: () => undefined });
  const entry = SETTINGS_ENTRIES.find(item => item.page === props.page);
  return <NavPage title={entry ? t(entry.title) : t('settings.view.home.title')} headerBackTitle="" class="flex-1 bg-background"
    popOnBack={!collectionNavigation().blocked} popOnSwipe={!collectionNavigation().blocked}
    onBackPress={() => { if (collectionNavigation().blocked) collectionNavigation().back(); }}>
    <If when={props.page === 'appearance' || props.page === 'chat'}><SettingsPreferences {...props} onCollectionNavigation={next => { collectionNavigation.set(next); props.onCollectionNavigation?.(next); }} /></If>
    <If when={props.page === 'git'}><SettingsGit {...props} active={props.active} /></If>
    <If when={props.page === 'usage'}><SettingsUsage {...props} active={props.active} /></If>
    <If when={props.page === 'about'}><SettingsAbout target={props.target} active={props.active} /></If>
    <If when={props.page === 'archived-sessions'}><SettingsArchive {...props} /></If>
    <If when={props.page === 'magic-prompts'}><SettingsMagicPrompts {...props} /></If>
    <If when={['providers', 'agents', 'commands', 'mcp', 'plugins', 'skills.installed'].includes(props.page)}>
      <SettingsCollection {...props} active={props.active} onCollectionNavigation={next => { collectionNavigation.set(next); props.onCollectionNavigation?.(next); }} />
    </If>
    <If when={!['appearance', 'chat', 'providers', 'agents', 'commands', 'mcp', 'plugins', 'skills.installed', 'git', 'usage', 'about', 'archived-sessions', 'magic-prompts', 'projects'].includes(props.page)}>
      <SettingsBasics {...props} active={props.active} operationToken={props.operationToken} />
    </If>
  </NavPage>;
}
