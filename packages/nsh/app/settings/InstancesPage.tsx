import { Scroll, Text, View, signal } from 'nsh';
import { NavPage } from 'nsh/base';
import { t } from '../core/i18n';
import { colors, radius, space } from '../core/theme';
import { Icon } from '../core/Icon';
import { QuietButton, actionMenu, alpha, confirm, fontSize } from '../core/ui';
import { connection, connections, online, refreshCatalog, removeConnection, switchConnection } from '../core/store';
import { openConnect, tabBarInset } from '../shell/nav';

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** `/settings/instances`: the Hosts this phone knows, switch, remove, add. */
export function InstancesPage() {
  const pending = signal(false);
  const failure = signal('');

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

  return (
    <NavPage
      title={t('mobile.settings.switchInstance')}
      headerBackTitle={t('mobile.settings.placeholder.title')}
      hidesBottomBarWhenPushed
      class="flex-1"
      style={{ backgroundColor: colors.background() }}
    >
      <Scroll class="flex-1" contentStyle={{ paddingBottom: tabBarInset() + 28 }}>
        <View
          style={{
            width: '100%',
            maxWidth: 452,
            alignSelf: 'center',
            paddingHorizontal: space.pageInset,
            gap: 16,
            paddingTop: 8,
          }}
        >
          <View style={{ gap: 8 }}>
            <Text style={{ paddingHorizontal: 8, fontSize: 12, color: colors.mutedForeground() }}>
              {t('mobile.connect.saved.title')}
            </Text>
            <View
              style={{
                borderRadius: radius.inset,
                overflow: 'hidden',
                borderWidth: 1,
                borderColor: colors.border(),
                backgroundColor: alpha(colors.muted(), 0.55),
              }}
            >
              <If when={connections().length === 0}>
                <Text style={{ fontSize: 13, color: colors.mutedForeground(), padding: 16 }}>
                  {t('mobile.connect.saved.empty')}
                </Text>
              </If>
              <Each of={connections()} key={(entry) => entry.id}>
                {(entry) => {
                  const active = () => connection()?.id === entry().id;
                  return (
                    <View
                      role="button"
                      onPress={() => void use(entry().id)}
                      onLongPress={() => void remove(entry().id, entry().label)}
                      activeStyle={{ backgroundColor: alpha(colors.mutedForeground(), 0.06) }}
                      style={{
                        minHeight: 58,
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 12,
                        paddingHorizontal: 14,
                        paddingVertical: 10,
                        opacity: pending() ? 0.6 : 1,
                      }}
                    >
                      <View
                        style={{
                          width: 34,
                          height: 34,
                          borderRadius: 12,
                          alignItems: 'center',
                          justifyContent: 'center',
                          backgroundColor: active() ? colors.foreground() : colors.muted(),
                        }}
                      >
                        <Icon
                          name="server"
                          size={17}
                          color={() => (active() ? colors.background() : undefined)}
                          tone={active() ? undefined : 'muted'}
                        />
                      </View>
                      <View style={{ flex: 1, gap: 2 }}>
                        <Text style={{ fontSize: fontSize.entityTitle, fontWeight: '600', color: colors.foreground(), numberOfLines: 1 }}>
                          {entry().label}
                        </Text>
                        <Text style={{ fontSize: fontSize.sessionMeta, color: colors.mutedForeground(), numberOfLines: 1 }}>
                          {entry().url}
                        </Text>
                      </View>
                      <Text style={{ fontSize: fontSize.sessionMeta, color: active() && online() ? colors.success() : colors.mutedForeground() }}>
                        {active()
                          ? online()
                            ? t('mobile.instances.status.connected')
                            : t('mobile.instances.status.saved')
                          : ''}
                      </Text>
                    </View>
                  );
                }}
              </Each>
              <View style={{ paddingVertical: 10, alignItems: 'center' }}>
                <QuietButton label={() => t('mobile.instances.addTitle')} onPress={() => openConnect()} />
              </View>
            </View>
          </View>

          <If when={!!failure()}>
            <Text style={{ fontSize: 13, color: colors.destructive(), paddingHorizontal: 6 }}>{failure()}</Text>
          </If>

          <View
            style={{
              borderRadius: radius.inset,
              borderWidth: 1,
              borderColor: colors.border(),
              padding: 14,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 10,
            }}
          >
            <Icon name="shield" size={16} tone="muted" />
            <Text style={{ flex: 1, fontSize: fontSize.sessionMeta, color: colors.mutedForeground() }}>
              {connection()?.url ?? ''}
            </Text>
          </View>
        </View>
      </Scroll>
    </NavPage>
  );
}
