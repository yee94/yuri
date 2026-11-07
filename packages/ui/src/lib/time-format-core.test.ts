import { describe, expect, test } from 'vitest';
import { formatMessageTimestampForLocale, formatTimeForLocale } from './time-format-core';

describe('shared message clock contract', () => {
  const now = new Date(2026, 10, 7, 16, 30);
  const at = (year: number, month: number, day: number) => new Date(year, month, day, 9, 5).getTime();
  const yesterday = (time: string) => `昨天 ${time}`;

  test('keeps locale and explicit 12h/24h preferences', () => {
    expect(formatTimeForLocale(now, '24h', 'zh-CN')).toBe('16:30');
    expect(formatTimeForLocale(now, '12h', 'en-US')).toBe('4:30 PM');
    expect(formatTimeForLocale(now, 'auto', 'en-US')).toBe('4:30 PM');
    expect(formatTimeForLocale(now, '24h', 'en-US', { precision: 'second', hour: '2-digit' })).toBe('16:30:00');
  });

  test('preserves today, yesterday, earlier year and cross-year Web labels', () => {
    expect(formatMessageTimestampForLocale(at(2026, 10, 7), '24h', 'en-US', yesterday, now)).toBe('09:05');
    expect(formatMessageTimestampForLocale(at(2026, 10, 6), '24h', 'en-US', yesterday, now)).toBe('昨天 09:05');
    expect(formatMessageTimestampForLocale(at(2026, 9, 20), '24h', 'en-US', yesterday, now)).toBe('Oct 20, 09:05');
    expect(formatMessageTimestampForLocale(at(2025, 9, 20), '24h', 'en-US', yesterday, now)).toBe('Oct 20, 2025, 09:05');
    const newYear = new Date(2026, 0, 1, 16);
    expect(formatMessageTimestampForLocale(at(2025, 11, 31), '24h', 'en-US', yesterday, newYear)).toBe('昨天 09:05');
  });

  test('invalid dates never become visible clock text', () => {
    for (const timestamp of [NaN, Infinity, -Infinity, 9e20]) {
      expect(formatTimeForLocale(timestamp, 'auto', 'en-US')).toBe('');
      expect(formatTimeForLocale(timestamp, 'auto', 'en-US', { fallback: '—' })).toBe('—');
      expect(formatMessageTimestampForLocale(timestamp, 'auto', 'en-US', yesterday, now)).toBe('');
    }
  });

  test('default and explicitly injected Web clock preserve every locale/preference/date branch', () => {
    for (const locale of ['en-US', 'en-GB', 'zh-CN', 'ja', 'zh-Hans-CN', 'ja-JP', 'fr-FR', 'ar-EG', 'en-US-u-hc-h23']) {
      for (const preference of ['auto', '12h', '24h'] as const) {
        for (const date of [new Date(2026, 10, 7, 0, 48), new Date(2026, 10, 7, 12), new Date(2026, 10, 7, 9, 5), new Date(2026, 10, 7, 23, 5), new Date(2026, 10, 6, 9, 5), new Date(2026, 9, 20, 9, 5), new Date(2025, 9, 20, 9, 5)]) {
          const sameDay = date.getDate() === 7 && date.getMonth() === 10 && date.getFullYear() === 2026;
          const previousDay = date.getDate() === 6 && date.getMonth() === 10 && date.getFullYear() === 2026;
          const clock = date.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit', hour12: preference === 'auto' ? undefined : preference === '12h' });
          const prefix = `${date.toLocaleString(locale, { month: 'short' })} ${date.getDate()}, ${date.getFullYear() === 2026 ? '' : date.getFullYear() + ', '}`;
          const expected = sameDay ? clock : previousDay ? yesterday(clock) : prefix + clock;
          expect(formatMessageTimestampForLocale(date.getTime(), preference, locale, yesterday, now)).toBe(expected);
          expect(formatMessageTimestampForLocale(date.getTime(), preference, locale, yesterday, now, formatTimeForLocale)).toBe(expected);
        }
      }
    }
  });

  test('injection changes only the clock, retaining shared date and yesterday composition', () => {
    const clock: typeof formatTimeForLocale = () => 'native-clock';
    expect(formatMessageTimestampForLocale(at(2026, 10, 7), 'auto', 'en-US', yesterday, now, clock)).toBe('native-clock');
    expect(formatMessageTimestampForLocale(at(2026, 10, 6), 'auto', 'en-US', yesterday, now, clock)).toBe('昨天 native-clock');
    expect(formatMessageTimestampForLocale(at(2025, 9, 20), 'auto', 'en-US', yesterday, now, clock)).toBe('Oct 20, 2025, native-clock');
  });
});
