import { Scroll, View } from 'nsh';
import { NavPage } from 'nsh/base';
import { t } from '../core/i18n';
import { colors, space } from '../core/theme';
import { loadSettings, saveSettings, settingsDocument, settingsFlag } from '../core/config';
import { tabBarInset } from '../shell/nav';
import { Group, SwitchRow } from './ui';
import type { I18nKey } from '../core/i18n';

const events: { key: string; labelKey: I18nKey }[] = [
  { key: 'notifyOnCompletion', labelKey: 'settings.notifications.page.events.completionLabel' },
  { key: 'notifyOnSubtasks', labelKey: 'settings.notifications.page.events.subtaskLabel' },
  { key: 'notifyOnError', labelKey: 'settings.notifications.page.events.errorLabel' },
  { key: 'notifyOnQuestion', labelKey: 'settings.notifications.page.events.questionLabel' },
  { key: 'notifyOnPermission', labelKey: 'settings.notifications.page.events.permissionLabel' },
  { key: 'notifyOnScheduledTasks', labelKey: 'settings.notifications.page.events.scheduledTasksLabel' },
  { key: 'notifyOnAssistants', labelKey: 'settings.notifications.page.events.assistantsLabel' },
  { key: 'notifyOnGoals', labelKey: 'settings.notifications.page.events.goalsLabel' },
];

/** `/settings/notifications`: delivery and the events the Host notifies about. */
export function NotificationsPage() {
  if (!settingsDocument()) void loadSettings();
  const flag = (key: string) => settingsFlag(key, true);
  const save = (key: string, value: boolean) => void saveSettings({ [key]: value });

  return (
    <NavPage
      title={t('settings.page.notifications.title')}
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
          <Group label={t('settings.notifications.page.delivery.title')}>
            <SwitchRow
              label={t('settings.notifications.page.delivery.enableLabel')}
              checked={() => flag('nativeNotificationsEnabled')}
              onChange={(value) => save('nativeNotificationsEnabled', value)}
            />
            <SwitchRow
              label={t('settings.notifications.page.delivery.focusedLabel')}
              description={t('settings.notifications.native.policy')}
              checked={() => (settingsDocument()?.notificationMode ?? 'always') === 'always'}
              onChange={(value) => void saveSettings({ notificationMode: value ? 'always' : 'hidden-only' })}
            />
          </Group>

          <Group label={t('settings.notifications.page.events.title')}>
            <Each of={events} key={(event) => event.key}>
              {(event) => (
                <SwitchRow
                  label={t(event().labelKey)}
                  checked={() => flag(event().key)}
                  onChange={(value) => save(event().key, value)}
                />
              )}
            </Each>
          </Group>
        </View>
      </Scroll>
    </NavPage>
  );
}
