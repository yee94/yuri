import { Scroll, Text, View, signal } from 'nsh';
import { NavPage } from 'nsh/base';
import { t } from '../core/i18n';
import { colors, space } from '../core/theme';
import { Icon } from '../core/Icon';
import { QuietButton, Surface, fontSize } from '../core/ui';
import { catalogError, catalogLoading, defaultModel, loadCatalog, providers } from '../core/models';
import { tabBarInset } from '../shell/nav';
import { Empty, Group, Loading, Row } from './ui';

/** `/settings/providers`: the Host's provider catalog and each provider's models. */
export function ProvidersPage() {
  const open = signal<string | null>(null);
  if (providers().length === 0 && !catalogLoading()) void loadCatalog();

  const modelsOf = (providerID: string) => providers().find((provider) => provider.id === providerID)?.models ?? [];

  return (
    <NavPage
      title={t('settings.page.providers.title')}
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
            gap: 20,
            paddingTop: 8,
          }}
        >
          <If when={!!catalogError()}>
            <Surface style={{ padding: 14, gap: 8 }}>
              <Text style={{ fontSize: 13, color: colors.destructive() }}>{catalogError()}</Text>
              <QuietButton label={() => t('assistants.actions.retry')} onPress={() => void loadCatalog(true)} />
            </Surface>
          </If>

          <If when={!!defaultModel()}>
            <Group label={t('settings.page.providers.title')}>
              <Row
                label={t('assistants.settings.model')}
                value={() => `${defaultModel()?.providerID ?? ''} · ${defaultModel()?.modelID ?? ''}`}
              />
            </Group>
          </If>

          <Group label={t('settings.page.providers.title')}>
            <If when={catalogLoading() && providers().length === 0}>
              <Loading />
            </If>
            <If when={!catalogLoading() && providers().length === 0}>
              <Empty text={t('common.unavailable')} />
            </If>
            <Each of={providers()} key={(provider) => provider.id}>
              {(provider) => (
                <View>
                  <Row
                    testID={`provider-${provider().id}`}
                    label={provider().name}
                    icon="cloud"
                    value={() => String(provider().models.length)}
                    onPress={() => open.set(open() === provider().id ? null : provider().id)}
                  />
                  <If when={open() === provider().id}>
                    <Each of={provider().models} key={(model) => model.id}>
                      {(model) => (
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 9, paddingLeft: 44, paddingRight: 14 }}>
                          <Icon name="ai-agent" size={13} tone="muted" />
                          <Text style={{ flex: 1, fontSize: fontSize.entityMeta, color: colors.mutedForeground(), numberOfLines: 1 }}>
                            {model().name}
                          </Text>
                          <Text style={{ fontSize: fontSize.sessionMeta, color: colors.mutedForeground(), numberOfLines: 1 }}>
                            {model().id}
                          </Text>
                        </View>
                      )}
                    </Each>
                  </If>
                </View>
              )}
            </Each>
          </Group>

          <If when={modelsOf(open() ?? '').length === 0 && !!open()}>
            <Text style={{ fontSize: fontSize.entityMeta, color: colors.mutedForeground(), textAlign: 'center' }}>
              {t('common.unavailable')}
            </Text>
          </If>
        </View>
      </Scroll>
    </NavPage>
  );
}
