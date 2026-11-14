import { Scroll, Text, View, resource } from 'nsh';
import { NavPage } from 'nsh/base';
import { t } from '../core/i18n';
import { colors, space } from '../core/theme';
import { QuietButton, Surface, fontSize } from '../core/ui';
import { record, request, textOf } from '../core/host';
import { connection } from '../core/store';
import { tabBarInset } from '../shell/nav';
import { Group, Row } from './ui';

/** `/settings/about`: the service and OpenCode versions this phone is connected to. */
export function AboutPage() {
  const info = resource(async () => record(await request('/api/system/info')));
  const upgrade = resource(async () => record(await request('/api/opencode/upgrade-status')));

  const version = () => textOf(info()?.serveVersion) || textOf(info()?.currentVersion) || t('settings.yuri.about.state.unknown');
  const openCode = () =>
    textOf(upgrade()?.version) || textOf(info()?.opencodeVersion) || t('settings.yuri.about.state.unknown');

  return (
    <NavPage
      title={t('settings.page.about.title')}
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
          <If when={!!(info.error() || upgrade.error())}>
            <Surface style={{ padding: 14, gap: 8 }}>
              <Text style={{ fontSize: 13, color: colors.destructive() }}>
                {info.error() instanceof Error
                  ? (info.error() as Error).message
                  : upgrade.error() instanceof Error
                    ? (upgrade.error() as Error).message
                    : t('settings.yuri.about.state.unknown')}
              </Text>
              <QuietButton
                label={() => t('assistants.actions.retry')}
                onPress={() => {
                  info.refetch();
                  upgrade.refetch();
                }}
              />
            </Surface>
          </If>

          <Group label={t('settings.yuri.about.title')}>
            <Row label={t('settings.yuri.about.field.instanceYuriVersion')} value={version} />
            <Row label={t('settings.yuri.about.field.openCodeVersion')} value={openCode} />
            <Row label={t('mobile.settings.switchInstance')} value={() => connection()?.label ?? ''} />
            <Row label={t('mobile.instances.status.connected')} value={() => connection()?.url ?? ''} />
          </Group>
        </View>
      </Scroll>
    </NavPage>
  );
}
