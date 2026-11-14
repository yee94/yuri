import { Scroll, Text, View, setColorScheme, signal } from 'nsh';
import { Button, NavPage, NumberInput } from 'nsh/base';
import { t, language, currentLocale, type I18nKey } from '../core/i18n';
import { colors, space } from '../core/theme';
import { Icon } from '../core/Icon';
import { ChoiceSheet, QuietButton, Surface } from '../core/ui';
import { loadSettings, saveSettings, settingsDocument, settingsError, settingsFlag, settingsLoading, settingsText } from '../core/config';
import { tabBarInset } from '../shell/nav';
import { Row, Group } from './ui';
import {
  codeFontSize,
  interfaceFontSize,
  loadTypography,
  setCodeFontSize,
  setInterfaceFontSize,
} from './typography';

type Mode = 'system' | 'light' | 'dark';

const modeKey = (mode: Mode) =>
  mode === 'light'
    ? ('settings.yuri.visual.option.themeMode.light' as I18nKey)
    : mode === 'dark'
      ? ('settings.yuri.visual.option.themeMode.dark' as I18nKey)
      : ('settings.yuri.visual.option.themeMode.system' as I18nKey);

/** Web `LOCALES` + `LOCALE_LABEL_KEYS`: the phone offers the same ten, no System row. */
const languages: { value: string; key: I18nKey }[] = [
  { value: 'en', key: 'common.language.english' },
  { value: 'fr', key: 'common.language.french' },
  { value: 'zh-CN', key: 'common.language.simplifiedChinese' },
  { value: 'zh-TW', key: 'common.language.traditionalChinese' },
  { value: 'uk', key: 'common.language.ukrainian' },
  { value: 'es', key: 'common.language.spanish' },
  { value: 'pt-BR', key: 'common.language.brazilianPortuguese' },
  { value: 'ko', key: 'common.language.korean' },
  { value: 'pl', key: 'common.language.polish' },
  { value: 'ja', key: 'common.language.japanese' },
];

const normalized = (value: string) => {
  if (value.startsWith('zh')) return /TW|HK|Hant/.test(value) ? 'zh-TW' : 'zh-CN';
  if (value.startsWith('pt')) return 'pt-BR';
  return value.split('-')[0];
};

/** `/settings/appearance`: color mode, language, interface and code font sizes. */
export function AppearancePage() {
  if (!settingsDocument()) void loadSettings();
  loadTypography();
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

  const languageValue = () => (language() === 'system' ? normalized(currentLocale()) : language());
  const languageLabel = () =>
    t(languages.find((entry) => entry.value === languageValue())?.key ?? 'common.language.english');

  const sizeField = (value: () => number, testID: string) => (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      <NumberInput
        testID={testID}
        value={value()}
        onChange={(event) => {
          const next = event.value;
          if (next == null) return;
          if (value === interfaceFontSize) setInterfaceFontSize(next);
          else setCodeFontSize(next);
        }}
        min={50}
        max={200}
        step={5}
        accessibilityLabel={t('settings.yuri.visual.field.fontSizePercentageAria')}
        style={{
          height: 36,
          flexDirection: 'row',
          alignItems: 'stretch',
          overflow: 'hidden',
          borderRadius: 8,
          borderWidth: 1,
          borderColor: colors.border(),
          backgroundColor: 'transparent',
        }}
        inputStyle={{ width: 56, fontSize: 16, textAlign: 'center', color: colors.foreground() }}
        decrementButtonStyle={{
          width: 36,
          height: 36,
          alignItems: 'center',
          justifyContent: 'center',
          borderRightWidth: 1,
          borderRightColor: colors.border(),
        }}
        incrementButtonStyle={{
          width: 36,
          height: 36,
          alignItems: 'center',
          justifyContent: 'center',
          borderLeftWidth: 1,
          borderLeftColor: colors.border(),
        }}
        decrementButton={
          <View testID={`${testID}-minus`} style={{ alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="subtract" size={16} tone="muted" />
          </View>
        }
        incrementButton={
          <View testID={`${testID}-plus`} style={{ alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="add" size={16} tone="muted" />
          </View>
        }
      />
      <Button
        testID={`${testID}-reset`}
        onPress={() => (value === interfaceFontSize ? setInterfaceFontSize(100) : setCodeFontSize(100))}
        disabled={value() === 100}
        accessibilityLabel={t('settings.yuri.visual.actions.resetFontSizeAria')}
        style={{
          width: 28,
          height: 28,
          borderRadius: 8,
          alignItems: 'center',
          justifyContent: 'center',
          opacity: value() === 100 ? 0.35 : 1,
        }}
      >
        <Icon name="restart" size={14} tone="muted" />
      </Button>
    </View>
  );

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

          <Group label={t('settings.page.appearance.title')}>
            <Row
              testID="appearance-mode"
              label={t('settings.yuri.visual.field.themeMode')}
              value={() => t(modeKey(mode()))}
              onPress={() => picker.set('mode')}
            />
          </Group>

          <Group label={t('settings.yuri.visual.section.localization')}>
            <Row
              testID="appearance-language"
              label={t('settings.appearance.language.label')}
              description={t('settings.appearance.language.description')}
              value={languageLabel}
              onPress={() => picker.set('language')}
            />
          </Group>

          <Group label={t('settings.yuri.visual.section.spacingAndLayout')}>
            <Row label={t('settings.yuri.visual.field.interfaceFontSize')}>
              {sizeField(interfaceFontSize, 'appearance-font-size')}
            </Row>
            <Row label={t('settings.yuri.visual.field.codeFontSize')}>
              {sizeField(codeFontSize, 'appearance-code-font-size')}
            </Row>
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
        value={languageValue}
        onSelect={(value) => void applyLanguage(value)}
        onClose={() => picker.set(null)}
      />
    </NavPage>
  );
}
