import { Text, View, platform, setColorScheme, signal } from 'nsh';
import { NavStack, Tab, Tabs } from 'nsh/base';
import { TabBar } from 'nsh/mobile';
import { loadSettings, settingsFlag, settingsText } from '../core/config';
import { language, t } from '../core/i18n';
import { colors, space } from '../core/theme';
import { connection, loadConnections, loadProjectOrder, refreshCatalog } from '../core/store';
import { alpha } from '../core/ui';
import { ToastHost } from '../core/ToastHost';
import { AssistantConversationPage } from '../assistant/AssistantConversationPage';
import { AssistantPage } from '../assistant/AssistantPage';
import { AssistantSettingsPage } from '../assistant/AssistantSettingsPage';
import { ChatPage } from '../chat/ChatPage';
import { ProjectsPage } from '../projects/ProjectsPage';
import { SearchPage } from '../projects/SearchPage';
import { ScheduledPage } from '../scheduled/ScheduledPage';
import { ScheduledRunsPage } from '../scheduled/ScheduledRunsPage';
import { SettingsDetailPage } from '../settings/SettingsDetailPage';
import { SettingsPage } from '../settings/SettingsPage';
import { ConnectPage } from './ConnectPage';
import { TABS, type TabID } from './tabs';
import { selectTab, stackFor, tab, tabBarInset, type Route } from './nav';

const booted = signal(false);
const bootFailure = signal('');
let bootStarted = false;

function boot() {
  if (bootStarted) return;
  bootStarted = true;
  void (async () => {
    try {
      await loadConnections();
      await loadProjectOrder();
      await loadSettings();
      const savedLanguage = settingsText('language');
      if (savedLanguage) language.set(savedLanguage);
      setColorScheme(
        settingsFlag('useSystemTheme', true)
          ? 'system'
          : settingsText('themeVariant') === 'dark'
            ? 'dark'
            : 'light',
      );
    } catch (error) {
      bootFailure.set(error instanceof Error ? error.message : String(error));
    } finally {
      booted.set(true);
    }
  })();
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

function Retry(props: { message: string; onPress: () => void }) {
  return (
    <View class="flex-1" style={{ alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 }}>
      <Text style={{ fontSize: 14, color: colors.destructive(), textAlign: 'center' }}>{props.message}</Text>
      <View
        onPress={props.onPress}
        role="button"
        style={{ paddingHorizontal: 18, paddingVertical: 10, borderRadius: 18, backgroundColor: colors.foreground() }}
      >
        <Text style={{ fontSize: 14, fontWeight: '600', color: colors.background() }}>{t('layout.browserProvider.retry')}</Text>
      </View>
    </View>
  );
}

function CurrentPage(props: { tab: TabID; route: Route }) {
  if (props.route.kind === 'chat') return <ChatPage route={props.route} />;
  if (props.route.kind === 'connect') return <ConnectPage />;
  if (props.route.kind === 'search') return <SearchPage />;
  if (props.route.kind === 'assistant') return <AssistantConversationPage route={props.route} />;
  if (props.route.kind === 'assistantSettings') return <AssistantSettingsPage assistantID={props.route.assistantID} />;
  if (props.route.kind === 'settings') return <SettingsDetailPage route={props.route} />;
  if (props.route.kind === 'scheduledRuns')
    return (
      <ScheduledRunsPage
        projectId={props.route.projectId}
        taskId={props.route.taskId}
        title={props.route.title}
      />
    );
  if (props.tab === 'assistant') return <AssistantPage />;
  if (props.tab === 'scheduled') return <ScheduledPage />;
  if (props.tab === 'settings') return <SettingsPage />;
  return <ProjectsPage />;
}

/** One tab's native stack; tabs stay mounted and keep their pages (display only). */
function TabStack(props: { id: TabID }) {
  return (
    <View style={{ flex: 1, display: tab() === props.id ? 'flex' : 'none' }}>
      <NavStack state={stackFor(props.id)} style={{ flex: 1 }}>
        {(route) => <CurrentPage tab={props.id} route={route} />}
      </NavStack>
    </View>
  );
}

/** The web has no system tab bar; it renders the same tabs itself, as Web's phone shell does. */
const usesBaseTabs = platform.select({ web: true, default: false }) ?? false;

/** The phone shell: connection gate, four tabs of their own stacks, the system tab bar over them. */
function Shell() {
  const showsBar = () => {
    const routes = stackFor(tab()).routes();
    return routes[routes.length - 1]?.kind === 'home';
  };
  return (
    <View style={{ flex: 1 }}>
      <TabStack id="projects" />
      <TabStack id="assistant" />
      <TabStack id="scheduled" />
      <TabStack id="settings" />
      <If when={showsBar()}>
        <If when={usesBaseTabs} else={
          <TabBar
            testID="main-tabs"
            style={{ position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: 'transparent' }}
            selectedIndex={TABS.findIndex((entry) => entry.id === tab())}
            onChange={(event) => {
              const next = TABS[event.index];
              if (next) selectTab(next.id);
            }}
            onLayout={(event) => {
              const height = event.bounds.size.height;
              if (height > 0 && height !== tabBarInset()) tabBarInset.set(height);
            }}
            items={TABS.map((entry) => ({ title: t(entry.labelKey), icon: entry.symbol }))}
          />
        }>
          <Tabs
            testID="main-tabs"
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: 0,
              flexDirection: 'row',
              backgroundColor: alpha(colors.background(), 0.94),
              borderTopWidth: 0.5,
              borderTopColor: colors.border(),
            }}
            onLayout={(event) => {
              const height = event.bounds.size.height;
              if (height > 0 && height !== tabBarInset()) tabBarInset.set(height);
            }}
          >
            <Each of={TABS} key={(entry) => entry.id}>
              {(entry) => (
                <Tab
                  testID={`tab-${entry().id}`}
                  selected={tab() === entry().id}
                  accessibilityLabel={t(entry().labelKey)}
                  onPress={() => selectTab(entry().id)}
                  style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 9 }}
                >
                  <Text
                    style={{
                      fontSize: 11,
                      fontWeight: '500',
                      color: tab() === entry().id ? colors.foreground() : colors.mutedForeground(),
                    }}
                  >
                    {t(entry().labelKey)}
                  </Text>
                </Tab>
              )}
            </Each>
          </Tabs>
        </If>
      </If>
    </View>
  );
}

export function Root() {
  boot();
  return (
    <View class="flex-1" style={{ backgroundColor: colors.background() }}>
      <If when={booted()} else={<View class="flex-1" style={{ padding: space.pageInset }} />}>
        <If
          when={!bootFailure()}
          else={
            <Retry
              message={bootFailure()}
              onPress={() => {
                bootFailure.set('');
                void (async () => {
                  try {
                    await loadConnections();
                  } catch (error) {
                    bootFailure.set(errorMessage(error));
                  }
                })();
              }}
            />
          }
        >
          <If when={!!connection()} else={<ConnectPage embedded />}>
            <Shell />
          </If>
          <ToastHost inset={tabBarInset()} />
        </If>
      </If>
    </View>
  );
}
