import { locale, mount, signal, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { formatTimeForLocale, type DisplayTimePreference } from '../../ui/src/lib/time-format-core';
import { language } from '../i18n';
import { NativeUserTimestamp } from '../transcript-time';
import { formatNativeMessageTimestamp, formatNativeTimeForLocale } from '../transcript-time-core';
import { nativeAppearance, nativeTimeFormat } from '../appearance';
import { appearanceFromSettings } from '../appearance-core';

function TranscriptTimeFixture() {
  const today = new Date(); today.setHours(9, 5, 0, 0);
  const created = signal(today.getTime());
  language.set('zh-CN');
  const matrix = ['en-US', 'en-GB', 'zh-CN', 'ja', 'zh-Hans-CN', 'ja-JP'].flatMap(locale => (['auto', '12h', '24h'] as const).flatMap(preference => {
    const now = new Date(2026, 10, 7, 16, 30);
    const dates = [new Date(2026, 10, 7, 0, 48), new Date(2026, 10, 7, 12, 0), new Date(2026, 10, 7, 9, 5), new Date(2026, 10, 7, 23, 5), new Date(2026, 10, 6, 9, 5), new Date(2026, 9, 20, 9, 5), new Date(2025, 9, 20, 9, 5)];
    return dates.map((date, index) => {
      const formatter = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', hour12: preference === 'auto' ? undefined : preference === '12h' });
      return {
        locale, preference, index, timestamp: date.getTime(), offset: date.getTimezoneOffset(),
        raw: formatTimeForLocale(date, preference, locale),
        format: formatter.format(date), parts: formatter.formatToParts(date), resolved: formatter.resolvedOptions(),
        clock: formatNativeTimeForLocale(date, preference, locale),
        padded: formatNativeTimeForLocale(date, preference, locale, { hour: '2-digit', precision: 'second' }),
        message: formatNativeMessageTimestamp(date.getTime(), preference, locale, time => `yesterday ${time}`, now),
        yearBoundary: formatNativeMessageTimestamp(new Date(2025, 11, 31, 9, 5).getTime(), preference, locale, time => `yesterday ${time}`, new Date(2026, 0, 1, 16)),
      };
    });
  }));
  const setPreference = async (timeFormatPreference: DisplayTimePreference | 'unknown') => {
    const snapshot = await appearanceFromSettings({ timeFormatPreference }, async () => []);
    nativeAppearance.current.set({ ...snapshot, uiFontFamily: 'System', monoFontFamily: 'System', assistantFontFamilies: { light: 'System', dark: 'System' }, unsupportedFonts: [] });
  };
  const gapDate = new Date(2026, 10, 7, 0, 48);
  const extensions = ['en-US-u-hc-h23', 'zh-CN-u-nu-hanidec'].map(tag => {
    const formatter = new Intl.DateTimeFormat(tag, { hour: 'numeric', minute: '2-digit' });
    return { locale: tag, formatted: formatter.format(gapDate), resolved: formatter.resolvedOptions() };
  });
  let zone: string;
  try { zone = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Paris' }).resolvedOptions().timeZone; }
  catch (error) { zone = error instanceof Error ? error.name : String(error); }
  const untouched = ['fr-FR', 'de-DE', 'zh-TW', 'en-US-u-hc-h23'].map(tag => ({ locale: tag, raw: formatTimeForLocale(gapDate, 'auto', tag), native: formatNativeTimeForLocale(gapDate, 'auto', tag) }));
  const invalid = [NaN, Infinity, -Infinity, 9e20].map(value => ({ clock: formatNativeTimeForLocale(value, 'auto', 'zh-CN'), fallback: formatNativeTimeForLocale(value, 'auto', 'en-GB', { fallback: '—' }), message: formatNativeMessageTimestamp(value, 'auto', 'en-US', time => time) }));
  return <View>
    <Text testID="clock-matrix" numberOfLines={1} style={{ width: 1, height: 1 }}>{'clock-matrix:' + JSON.stringify(matrix)}</Text>
    <Text numberOfLines={1} style={{ width: 1, height: 1 }}>{'clock-gaps:' + JSON.stringify({ extensions, zone, untouched, invalid })}</Text>
    <Text>{'system-locale:' + locale()}</Text>
    <NativeUserTimestamp created={created()} />
    <Button testID="clock-switch-locale" onPress={() => language.set('en-US')}><Text>Change fixture locale</Text></Button>
    <Button testID="clock-british-locale" onPress={() => language.set('en-GB')}><Text>British locale</Text></Button>
    <Button testID="clock-system-locale" onPress={() => language.set('system')}><Text>System locale</Text></Button>
    <Button testID="clock-12h" onPress={() => setPreference('12h')}><Text>12h</Text></Button>
    <Button testID="clock-24h" onPress={() => setPreference('24h')}><Text>24h</Text></Button>
    <Button testID="clock-auto" onPress={() => setPreference('auto')}><Text>Auto</Text></Button>
    <Button testID="clock-unknown" onPress={() => setPreference('unknown')}><Text>Unknown</Text></Button>
    <Text>{'preference:' + String(nativeTimeFormat())}</Text>
    <Button testID="clock-reuse-message" onPress={() => { const next = new Date(); next.setHours(14, 5, 0, 0); created.set(next.getTime()); }}><Text>Reuse fixture identity</Text></Button>
    <Button testID="clock-yesterday" onPress={() => { const next = new Date(); next.setDate(next.getDate() - 1); next.setHours(9, 5, 0, 0); created.set(next.getTime()); language.set('zh-CN'); }}><Text>Yesterday fixture</Text></Button>
    <Text testID="clock-midnight-probe">{formatNativeTimeForLocale(new Date(2026, 10, 7, 0, 48), 'auto', 'zh-CN')}</Text>
    <Text>{'invalid:' + formatNativeMessageTimestamp(NaN, 'auto', 'en-US', time => time)}</Text>
  </View>;
}

mount(TranscriptTimeFixture);
