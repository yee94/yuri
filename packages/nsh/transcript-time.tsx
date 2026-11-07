import { locale, Text, View } from 'nsh';
import { formatNativeMessageTimestamp } from './transcript-time-core';
import { language, t } from './i18n';
import { nativeChatTextStyle, nativeTimeFormat } from './appearance';
import { Icon } from './Icon';

export function NativeUserTimestamp(props: { created: number }) {
  const value = () => formatNativeMessageTimestamp(props.created, nativeTimeFormat() ?? 'auto', language() === 'system' ? locale() : language(), time => t('common.date.yesterdayWithTime', { time }));
  return <View testID="message-timestamp" class="flex-row items-center gap-1 opacity-70"><Icon name="time" size={12} /><Text class="text-xs text-muted-foreground" style={nativeChatTextStyle('micro')}>{value()}</Text></View>;
}
