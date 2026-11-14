import { Scroll, Text, View, openUrl, resource } from 'nsh';
import { Button, NavPage } from 'nsh/base';
import { t } from '../core/i18n';
import { colors, space } from '../core/theme';
import { Icon } from '../core/Icon';
import { QuietButton, Surface } from '../core/ui';
import { native, record, request, textOf } from '../core/host';
import { connection } from '../core/store';
import { tabBarInset } from '../shell/nav';
import { Group, Row } from './ui';

const GITHUB_ISSUES_URL = 'https://github.com/yee94/yuri/issues/new';

const MANAGEMENT_KEYS = {
  'manual-global': 'settings.yuri.about.opencodeManagement.manual-global',
  'manual-external': 'settings.yuri.about.opencodeManagement.manual-external',
  bundled: 'settings.yuri.about.opencodeManagement.bundled',
  'in-app': 'settings.yuri.about.opencodeManagement.in-app',
  none: 'settings.yuri.about.opencodeManagement.none',
} as const;

const GUIDANCE_KEYS = {
  'manual-global': 'settings.yuri.about.opencodeGuidance.manualGlobal',
  'manual-external': 'settings.yuri.about.opencodeGuidance.manualExternal',
  bundled: 'settings.yuri.about.opencodeGuidance.bundled',
} as const;

type Management = keyof typeof MANAGEMENT_KEYS;

const versionText = (value: unknown): string => {
  const text = textOf(value).trim();
  return /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(text) ? text : '';
};

/** `/settings/about`: the client shell and the connected instance's versions. */
export function AboutPage() {
  const client = resource(async () => record(await native('native.clientMetadata')));
  const info = resource(async () => record(await request('/api/system/info')));
  const upgrade = resource(async () => record(await request('/api/opencode/upgrade-status')));

  const unknown = () => t('settings.yuri.about.state.unknown');

  const clientVersion = () => {
    const version = versionText(client()?.version);
    if (!version) return unknown();
    const build = textOf(client()?.build);
    return build ? `${version} (${build})` : version;
  };
  const yuriVersion = () => versionText(info()?.yuriVersion) || unknown();
  const management = (): Management | null => {
    const value = textOf(upgrade()?.management);
    return value && Object.hasOwn(MANAGEMENT_KEYS, value) ? (value as Management) : null;
  };
  const openCodeVersion = () => {
    const version = versionText(upgrade()?.serveVersion) || versionText(upgrade()?.currentVersion);
    if (!version) return unknown();
    const label = management();
    return upgrade()?.canManage === false && label
      ? t('settings.yuri.about.opencodeVersionWithManagement', {
          version,
          management: t(MANAGEMENT_KEYS[label]),
        })
      : version;
  };
  const guidance = () => {
    const label = management();
    if (!label || upgrade()?.canManage !== false) return undefined;
    const key = GUIDANCE_KEYS[label as keyof typeof GUIDANCE_KEYS];
    return key ? t(key) : undefined;
  };

  const error = () =>
    info.error() instanceof Error
      ? (info.error() as Error).message
      : upgrade.error() instanceof Error
        ? (upgrade.error() as Error).message
        : client.error() instanceof Error
          ? (client.error() as Error).message
          : '';

  const reload = () => {
    client.refetch();
    info.refetch();
    upgrade.refetch();
  };

  return (
    <NavPage
      title={t('settings.page.about.title')}
      headerBackTitle={t('mobile.settings.placeholder.title')}
      hidesBottomBarWhenPushed
      class="flex-1"
      style={{ backgroundColor: colors.background() }}
      headerRight={
        <Button
          testID="about-refresh"
          onPress={reload}
          accessibilityLabel={t('settings.yuri.about.actions.checkForUpdates')}
          style={{ width: 36, height: 36, alignItems: 'center', justifyContent: 'center' }}
        >
          <Icon name="refresh" size={18} />
        </Button>
      }
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
          <If when={!!error()}>
            <Surface style={{ padding: 14, gap: 8 }}>
              <Text style={{ fontSize: 13, lineHeight: 18, color: colors.destructive() }}>{error()}</Text>
              <QuietButton label={() => t('assistants.actions.retry')} onPress={reload} />
            </Surface>
          </If>

          <Group label={t('settings.yuri.about.title')}>
            <Row
              testID="about-client-version"
              label={t('settings.yuri.about.field.clientVersion')}
              value={clientVersion}
            />
            <Row
              testID="about-host-version"
              label={t('settings.yuri.about.field.instanceYuriVersion')}
              value={yuriVersion}
            />
            <Row
              testID="about-opencode-version"
              label={t('settings.yuri.about.field.instanceOpenCodeVersion')}
              description={() => guidance() ?? ''}
              value={openCodeVersion}
            />
          </Group>

          <Group label={t('mobile.settings.switchInstance')}>
            <Row label={t('mobile.settings.switchInstance')} value={() => connection()?.label ?? ''} />
            <Row label={t('mobile.instances.status.connected')} value={() => connection()?.url ?? ''} />
          </Group>

          <Group label={t('settings.yuri.about.actions.submitFeedback')}>
            <Row
              label={t('settings.yuri.about.actions.submitFeedback')}
              onPress={() => void openUrl(GITHUB_ISSUES_URL).catch(() => {})}
            />
          </Group>
        </View>
      </Scroll>
    </NavPage>
  );
}
