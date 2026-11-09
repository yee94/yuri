import { platform, Scroll, signal, Text, View, type JSX } from 'nsh';
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
import { SettingsProjects, SettingsProjectsPage, type ProjectSettingsNavigation } from './settings-projects';
import { SettingsPreferences } from './settings-preferences';
import { SettingsAbout } from './settings-about';
import { SettingsGlobalConfig } from './settings-global-config';
import { SettingsSkillsCatalog } from './settings-skills-catalog';
import { SettingsRemoteInstances, type NativeRemoteConnectionsSlot } from './settings-remote-instances';
import { searchSettingsFields } from './settings-search-core';
import type { I18nKey } from '../ui/src/lib/i18n/messages/en';
import type { QuotaCredentialProvider } from './settings-quota-credentials-core';
import type { RetentionController } from './settings-retention-controller';
import type { SettingsHostOperation } from './settings-controls';

export type SettingsPageID = 'instances' | 'remote-instances' | 'appearance' | 'chat' | 'shortcuts' | 'global-config' | 'notifications' | 'sessions' | 'archived-sessions' | 'summary-ai' | 'projects' | 'git' | 'providers' | 'agents' | 'assistants' | 'behavior' | 'commands' | 'mcp' | 'plugins' | 'magic-prompts' | 'skills.installed' | 'skills.catalog' | 'usage' | 'voice' | 'about';
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
type Entry = { page: SettingsPageID; title: I18nKey; group: 'connection' | 'personalization' | 'workspace' | 'opencode' | 'content' | 'system'; icon: Parameters<typeof Icon>[0]['name']; desktopOnly?: boolean };
export const SETTINGS_ENTRIES: readonly Entry[] = [
  { page: 'instances', title: 'mobile.connect.saved.title', group: 'connection', icon: 'server' },
  { page: 'remote-instances', title: 'settings.page.remoteInstances.title', group: 'connection', icon: 'server' },
  { page: 'appearance', title: 'settings.page.appearance.title', group: 'personalization', icon: 'palette' },
  { page: 'chat', title: 'settings.page.chat.title', group: 'personalization', icon: 'chat-ai-3' },
  ...(['macos', 'windows', 'linux'].includes(platform.os) ? [{ page: 'shortcuts', title: 'settings.page.shortcuts.title', group: 'personalization', icon: 'keyboard', desktopOnly: true } as const] : []),
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
  ...(['macos', 'windows', 'linux'].includes(platform.os) ? [{ page: 'global-config', title: 'settings.globalConfig.title', group: 'opencode', icon: 'code-box', desktopOnly: true } as const] : []),
  { page: 'magic-prompts', title: 'settings.page.magicPrompts.title', group: 'content', icon: 'ai-generate-2' },
  { page: 'skills.installed', title: 'settings.page.skills.title', group: 'content', icon: 'book-open' },
  { page: 'skills.catalog', title: 'settings.page.skillsCatalog.title', group: 'content', icon: 'book-open' },
  { page: 'usage', title: 'settings.page.usage.title', group: 'system', icon: 'bar-chart-2' },
  { page: 'voice', title: 'settings.page.voice.title', group: 'system', icon: 'mic' },
  { page: 'about', title: 'settings.page.about.title', group: 'system', icon: 'information' },
];

/** Embeddable root content. The owner supplies the NavStack and connection flow. */
export function SettingsHome(props: SettingsCallbacks & { showTitle?: boolean; bottomInset?: number }) {
  const search = signal('');
  const groups = ['connection', 'personalization', 'workspace', 'opencode', 'content', 'system'] as const;
  const visible = () => SETTINGS_ENTRIES.filter(entry => !entry.desktopOnly && t(entry.title).toLocaleLowerCase().includes(search().trim().toLocaleLowerCase()));
  const matches = () => searchSettingsFields(search(), t, platform.os);
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

export type SettingsPageProps = SettingsCallbacks & SettingsRoute & { directory?: string; active?: boolean; retention?: RetentionController; operationToken?: SettingsHostOperation | null };

/** Render inside the application's NavStack; route.entity opens the third level. */
export function SettingsPage(props: SettingsPageProps) {
  if (props.page === 'projects') return <SettingsProjectsPage {...props} />;
  const collectionNavigation = signal<SettingsCollectionNavigation>({ blocked: false, back: () => undefined });
  const entry = SETTINGS_ENTRIES.find(item => item.page === props.page);
  return <NavPage title={entry ? t(entry.title) : t('settings.view.home.title')} headerBackTitle="" class="flex-1 bg-background"
    popOnBack={!collectionNavigation().blocked} popOnSwipe={!collectionNavigation().blocked}
    onBackPress={() => { if (collectionNavigation().blocked) collectionNavigation().back(); }}>
    <SettingsPageContent {...props} onCollectionNavigation={next => { collectionNavigation.set(next); props.onCollectionNavigation?.(next); }} />
  </NavPage>;
}

/** The same real page owners, without a NavPage/header or an independent route.
 * Desktop shells must supply navigation protection before changing this route. */
export type SettingsPageContentProps = SettingsPageProps & {
  desktopAbout?: () => import('./settings-about-core').SettingsAboutController | undefined;
  desktopGitHub?: import('./desktop-header-github-root').DesktopSettingsGitHubSlot;
  codeTypographyReady?: boolean;
  onProjectNavigation?: (navigation: ProjectSettingsNavigation) => void;
  /** Invoke under the desktop publisher, never pre-mount a second preferences owner. */
  desktopShortcuts?: (context: { readonly active: boolean }) => JSX.Element;
  remoteConnections?: NativeRemoteConnectionsSlot;
};
export function SettingsPageContent(props: SettingsPageContentProps) {
  const collectionNavigation = signal<SettingsCollectionNavigation>({ blocked: false, back: () => undefined });
  if (props.page === 'about' && props.desktopAbout) return <Each of={[props.desktopAbout()]} key={owner => owner}>{owner =>
    <If when={!!owner()} else={<View class="p-5"><Text class="text-muted-foreground">{t('settings.view.unavailable.description')}</Text></View>}>
      <SettingsAbout target={props.target} active={props.active} owner={owner()} />
    </If>
  }</Each>;
  if (props.page === 'shortcuts') return props.desktopShortcuts
    ? props.desktopShortcuts({ get active() { return props.active !== false; } })
    : <View class="p-5"><Text class="text-muted-foreground">{t('settings.view.unavailable.description')}</Text></View>;
  if (props.page === 'projects') return <SettingsProjects {...props} onNavigation={props.onProjectNavigation} />;
  if (props.page === 'global-config') return <SettingsGlobalConfig active={props.active} target={props.target} />;
  if (props.page === 'skills.catalog') return <SettingsSkillsCatalog {...props} />;
  if (props.page === 'remote-instances') return <SettingsRemoteInstances {...props} connections={props.remoteConnections} />;
  return <View class="flex-1 min-w-0 min-h-0 bg-background">
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
  </View>;
}
