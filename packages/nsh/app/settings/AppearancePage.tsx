import { Scroll, View, signal } from 'nsh';
import { NavPage } from 'nsh/base';
import { setColorScheme } from 'nsh';
import { t, language, currentLocale, type I18nKey } from '../core/i18n';
import { colors, space } from '../core/theme';
import { ChoiceSheet } from '../core/ui';
import { loadSettings, saveSettings, settingsDocument, settingsFlag, settingsText } from '../core/config';
import { tabBarInset } from '../shell/nav';
import { Row, Group } from './ui';

type Mode = 'system' | 'light' | 'dark';

const modeKey = (mode: Mode) =>
  mode === 'light'
    ? ('settings.yuri.visual.option.themeMode.light' as I18nKey)
    : mode === 'dark'
      ? ('settings.yuri.visual.option.themeMode.dark' as I18nKey)
      : ('settings.yuri.visual.option.themeMode.system' as I18nKey);

const languages: { value: string; key: I18nKey }[] = [
  { value: 'system', key: 'settings.yuri.visual.option.themeMode.system' },
  { value: 'en', key: 'common.language.english' },
  { value: 'zh-CN', key: 'common.language.simplifiedChinese' },
  { value: 'zh-TW', key: 'common.language.traditionalChinese' },
  { value: 'ja', key: 'common.language.japanese' },
  { value: 'ko', key: 'common.language.korean' },
  { value: 'fr', key: 'common.language.french' },
  { value: 'es', key: 'common.language.spanish' },
  { value: 'pl', key: 'common.language.polish' },
  { value: 'pt-BR', key: 'common.language.brazilianPortuguese' },
  { value: 'uk', key: 'common.language.ukrainian' },
];

/** `/settings/appearance`: the phone's color mode and language. */
export function AppearancePage() {
  if (!settingsDocument()) void loadSettings();
  const picker = signal<'mode' | 'language' | null>(null);

  const mode = (): Mode => {
    if (settingsFlag('useSystemTheme', true)) return 'system';
    return settingsText('themeVariant') === 'dark' ? 'dark' : 'light';
  };

  const applyMode = async (next: Mode) => {
    setColorScheme(next);
    await saveSettings({
      useSystemTheme: next === 'system',
      ...(next === 'system' ? {} : { themeVariant: next }),
    });
  };

  const applyLanguage = async (next: string) => {
    language.set(next);
    await saveSettings({ language: next });
  };

  return (
    <NavPage
      title={t('settings.page.appearance.title')}
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
          <Group label={t('settings.page.appearance.title')}>
            <Row
              testID="appearance-mode"
              label={t('settings.yuri.visual.field.themeMode')}
              value={() => t(modeKey(mode()))}
              onPress={() => picker.set('mode')}
            />
          </Group>

          <Group label={t('settings.appearance.language.label')}>
            <Row
              testID="appearance-language"
              label={t('settings.appearance.language.label')}
              description={t('settings.appearance.language.description')}
              value={() => t(languages.find((entry) => entry.value === language())?.key ?? 'settings.yuri.visual.option.themeMode.system')}
              onPress={() => picker.set('language')}
            />
            <Row label={t('settings.appearance.language.select')} value={() => currentLocale()} />
          </Group>
        </View>
      </Scroll>

      <ChoiceSheet
        open={() => picker() === 'mode'}
        title={t('settings.yuri.visual.field.themeMode')}
        options={() => [
          { value: 'system' as Mode, label: t('settings.yuri.visual.option.themeMode.system') },
          { value: 'light' as Mode, label: t('settings.yuri.visual.option.themeMode.light') },
          { value: 'dark' as Mode, label: t('settings.yuri.visual.option.themeMode.dark') },
        ]}
        value={mode}
        onSelect={(value) => void applyMode(value)}
        onClose={() => picker.set(null)}
      />
      <ChoiceSheet
        open={() => picker() === 'language'}
        title={t('settings.appearance.language.label')}
        options={() => languages.map((entry) => ({ value: entry.value, label: t(entry.key) }))}
        value={() => language()}
        onSelect={(value) => void applyLanguage(value)}
        onClose={() => picker.set(null)}
      />
    </NavPage>
  );
}
