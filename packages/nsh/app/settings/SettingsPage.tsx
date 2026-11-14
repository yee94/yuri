import { Scroll, Text, View, signal } from 'nsh';
import { Button, Input, NavPage } from 'nsh/base';
import { t } from '../core/i18n';
import { colors, space } from '../core/theme';
import { Icon } from '../core/Icon';
import { QuietButton, Surface, actionMenu, alpha, confirm, fontSize } from '../core/ui';
import { reloadOpenCode, settingsDocument, settingsError, settingsLoading, loadSettings } from '../core/config';
import { connection, connections, online, refreshCatalog, removeConnection, switchConnection } from '../core/store';
import { openConnect, openSettingsPage, tabBarInset } from '../shell/nav';
import { filterSettingsPages } from './model';
import { Group, Row } from './ui';

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Settings home: the same groups, pages, search and instance commands as the Web phone. */
export function SettingsPage() {
  const query = signal('');
  const pending = signal(false);
  const failure = signal('');
  if (!settingsDocument()) void loadSettings();

  const use = async (id: string) => {
    if (pending() || connection()?.id === id) return;
    pending.set(true);
    failure.set('');
    try {
      await switchConnection(id);
      void refreshCatalog();
    } catch (error) {
      failure.set(errorText(error));
    } finally {
      pending.set(false);
    }
  };

  const remove = async (id: string, label: string) => {
    const action = await actionMenu({
      title: label,
      actions: [{ id: 'delete', label: t('mobile.instances.delete'), destructive: true }],
    });
    if (action !== 'delete') return;
    const confirmed = await confirm({
      title: t('mobile.connect.history.remove'),
      message: t('mobile.connect.history.removeHint', { name: label }),
      confirmLabel: t('mobile.connect.history.remove'),
      cancelLabel: t('gitView.common.cancel'),
      destructive: true,
    });
    if (!confirmed) return;
    failure.set('');
    try {
      await removeConnection(id);
      void refreshCatalog();
    } catch (error) {
      failure.set(errorText(error));
    }
  };

  const searchField = (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 12,
        minHeight: 40,
        borderRadius: 20,
        backgroundColor: alpha(colors.muted(), 0.9),
        backdropFilter: 'blur(18px) saturate(1.3)',
        glassEffect: 'regular',
      }}
    >
      <Icon name="search" size={15} tone="muted" />
      <Input
        testID="settings-search"
        value={query()}
        onChange={(event) => query.set(event.value)}
        placeholder={t('settings.view.search.placeholder')}
        autoCapitalize="none"
        autoCorrect={false}
        style={{
          flex: 1,
          minHeight: 38,
          fontSize: 14,
          color: colors.foreground(),
          placeholderColor: colors.mutedForeground(),
        }}
      />
      <If when={query().length > 0}>
        <Button
          onPress={() => query.set('')}
          accessibilityLabel={t('settings.view.search.clear')}
          style={{
            width: 26,
            height: 26,
            borderRadius: 13,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: alpha(colors.mutedForeground(), 0.16),
          }}
        >
          <Icon name="close" size={12} tone="muted" />
        </Button>
      </If>
    </View>
  );

  return (
    <NavPage title={t('mobile.settings.placeholder.title')} headerLargeTitle class="flex-1" style={{ backgroundColor: colors.background() }}>
      <Scroll class="flex-1" keyboardDismissMode="on-drag" contentStyle={{ paddingBottom: tabBarInset() + 28 }}>
        <View
          style={{
            width: '100%',
            maxWidth: 452,
            alignSelf: 'center',
            paddingHorizontal: space.pageInset,
            gap: 20,
          }}
        >
          {searchField}

          <If when={settingsLoading() && !settingsDocument()}>
            <View style={{ alignItems: 'center', paddingVertical: 18 }}>
              <Icon name="loader-4" size={18} tone="muted" />
            </View>
          </If>

          <If when={!!settingsError()}>
            <Surface style={{ padding: 14, gap: 8 }}>
              <Text style={{ fontSize: 13, color: colors.destructive() }}>{settingsError()}</Text>
              <QuietButton label={() => t('assistants.actions.retry')} onPress={() => void loadSettings(true)} />
            </Surface>
          </If>

          <If when={!!(failure() || (connection()?.id && !online()))}>
            <Text style={{ fontSize: 13, color: failure() ? colors.destructive() : colors.mutedForeground(), paddingHorizontal: 6 }}>
              {failure() || t('mobile.instances.status.saved')}
            </Text>
          </If>

          <Each of={filterSettingsPages(query())} key={(group) => group.id}>
            {(group) => (
              <Group label={t(group().labelKey)}>
                <Each of={group().pages} key={(page) => page.slug}>
                  {(page) => (
                    <Row
                      label={t(page().titleKey)}
                      icon={page().icon}
                      onPress={() => openSettingsPage(page().slug)}
                    />
                  )}
                </Each>
              </Group>
            )}
          </Each>

          <If when={filterSettingsPages(query()).length === 0}>
            <Text style={{ fontSize: fontSize.entityTitle, color: colors.mutedForeground(), textAlign: 'center', paddingVertical: 24 }}>
              {t('settings.view.search.noResults')}
            </Text>
          </If>

          <If when={!query().trim()}>
            <Group label={t('mobile.connect.saved.title')}>
              <If when={connections().length === 0}>
                <Row label={t('mobile.connect.saved.empty')} />
              </If>
              <Each of={connections()} key={(entry) => entry.id}>
                {(entry) => (
                  <Row
                    label={entry().label}
                    description={entry().url}
                    icon="server"
                    value={() =>
                      connection()?.id === entry().id
                        ? online()
                          ? t('mobile.instances.status.connected')
                          : t('mobile.instances.status.saved')
                        : ''
                    }
                    onPress={() => void use(entry().id)}
                    onLongPress={() => void remove(entry().id, entry().label)}
                  />
                )}
              </Each>
              <View style={{ paddingVertical: 8, alignItems: 'center' }}>
                <QuietButton label={() => t('mobile.instances.addTitle')} onPress={() => openConnect()} />
              </View>
            </Group>
          </If>

          <If when={!query().trim()}>
            <Group>
              <Row
                label={t('settings.view.actions.reloadOpenCode')}
                icon="restart"
                onPress={() =>
                  void reloadOpenCode().catch((error) => failure.set(errorText(error)))
                }
              />
            </Group>
          </If>

          <If when={!!query().trim() && connections().length > 0}>
            <Text style={{ fontSize: fontSize.sessionMeta, color: colors.mutedForeground(), textAlign: 'center' }}>
              {connection()?.url ?? ''}
            </Text>
          </If>
        </View>
      </Scroll>
    </NavPage>
  );
}
