import { formatMessageTimestampForLocale, formatTimeForLocale, type DisplayTimePreference } from '../ui/src/lib/time-format-core';

/**
 * NSH 0.4's hand-written locale table pads numeric 24h hours for en-GB/zh-CN
 * and uses uppercase en-GB day periods. Explicit ja-JP 12h needs h11, not the
 * h12 that NSH forces with hour12:true. Its resolvedOptions echoes `numeric`
 * even when padding, so it cannot supply the browser's pattern width.
 * Only these verified patterns are adapted; all other Intl output is retained.
 * See longbridge/nsh v0.4.0 crates/nsh-js/src/web/intl/{date,locale}.rs.
 * This is not a CLDR/ICU replacement: NSH ignores Unicode locale extensions,
 * has no IANA zone database, and exposes no device hour-cycle override here.
 * `auto` still means the locale default, never a guessed system 12h/24h setting.
 */
export const formatNativeTimeForLocale: typeof formatTimeForLocale = (timestamp, preference, locale, options = {}) => {
  const tag = locale.toLowerCase();
  const british = tag === 'en-gb';
  const chinese = tag === 'zh-cn' || tag === 'zh-hans-cn';
  const japaneseH11 = tag === 'ja-jp' && preference === '12h';
  if (!british && !chinese && !japaneseH11) return formatTimeForLocale(timestamp, preference, locale, options);
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return options.fallback ?? '';
  const formatter = new Intl.DateTimeFormat(locale, {
    hour: options.hour ?? 'numeric', minute: '2-digit',
    second: options.precision === 'second' ? '2-digit' : undefined,
    hour12: japaneseH11 ? undefined : preference === '12h' ? true : preference === '24h' ? false : undefined,
    hourCycle: japaneseH11 ? 'h11' : undefined,
  });
  const original = formatter.format(date);
  const parts = formatter.formatToParts(date);
  // Never reinterpret a runtime whose parts do not reproduce its actual string
  // (e.g. browser ICU can expose a narrow no-break space only in parts).
  if (parts.map(part => part.value).join('') !== original) return original;
  const cycle = formatter.resolvedOptions().hourCycle;
  return parts.map(part => {
    if (part.type === 'hour' && (options.hour ?? 'numeric') === 'numeric' && cycle === 'h23' && /^0\d$/.test(part.value)) return String(Number(part.value));
    if (part.type === 'dayPeriod' && british && /^(AM|PM)$/.test(part.value)) return part.value.toLowerCase();
    return part.value;
  }).join('');
};

export function formatNativeMessageTimestamp(timestamp: number, preference: DisplayTimePreference, locale: string, yesterdayWithTime: (time: string) => string, now = new Date()): string {
  return formatMessageTimestampForLocale(timestamp, preference, locale, yesterdayWithTime, now, formatNativeTimeForLocale);
}
