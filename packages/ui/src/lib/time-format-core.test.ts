import { afterEach, describe, expect, test, vi } from 'vitest';
import { formatMessageTimestampForLocale, formatRelativeShort, formatTimeForLocale } from './time-format-core';

describe('shared mobile compact activity label', () => {
  const minute = 60_000, hour = 60 * minute, day = 24 * hour;
  const now = new Date(2026, 10, 7, 12).getTime();
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  test.each([
    [0, 'now'], [minute - 1, 'now'], [minute, '1m'], [2 * minute - 1, '1m'],
    [hour - 1, '59m'], [hour, '1h'], [2 * hour - 1, '1h'],
    [day - 1, '23h'], [day, '1d'], [2 * day - 1, '1d'], [7 * day - 1, '6d'],
  ])('keeps the Web elapsed-time boundary at %i milliseconds: %s', (elapsed, expected) => {
    expect(formatRelativeShort(now - elapsed, 'en-US', now)).toBe(expected);
  });
  test('switches to a localized month/day exactly at seven elapsed days, without adding a year', () => {
    for (const timestamp of [now - 7 * day, new Date(2025, 0, 3, 12).getTime(), 1000]) {
      expect(formatRelativeShort(timestamp, 'en-US', now)).toBe(new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(timestamp));
      expect(formatRelativeShort(timestamp, 'en-US', now)).not.toMatch(/\d+d$|2025|1970/);
    }
    expect(formatRelativeShort(new Date(2025, 0, 3, 12).getTime(), 'en-US', now)).toBe('Jan 3');
  });
  test.each([1, minute, day, 8 * day, 365 * day])('keeps a valid future timestamp as now (+%i ms), never a negative duration', delta => {
    expect(formatRelativeShort(now + delta, 'en-US', now)).toBe('now');
  });
  test.each([0, -1, NaN, Infinity, -Infinity, 8_640_000_000_000_001, Number.MAX_VALUE])('returns no label for unknown or invalid Date input %s', timestamp => {
    expect(formatRelativeShort(timestamp, 'en-US', now)).toBe('');
  });
  test('does not accidentally reject the final valid JavaScript Date or classify an invalid clock', () => {
    expect(formatRelativeShort(8_640_000_000_000_000, 'en-US', now)).toBe('now');
    expect(formatRelativeShort(now, 'en-US', NaN)).toBe('');
  });
  test.each([
    ['en-US', 'Jan 3'], ['en-GB', '3 Jan'], ['zh-CN', '1月3日'], ['ja-JP', '1月3日'],
  ])('uses the requested %s date order and month name: %s', (locale, expected) => {
    expect(formatRelativeShort(new Date(2026, 0, 3, 12).getTime(), locale, now)).toBe(expected);
    expect(formatRelativeShort(now - hour, locale, now)).toBe('1h');
  });
  test('retains Intl default locale when omitted and observes the call-time clock', () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const timestamp = now - 7 * day;
    expect(formatRelativeShort(timestamp)).toBe(new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(timestamp));
    expect(formatRelativeShort(now - minute)).toBe('1m');
    vi.setSystemTime(now + hour); expect(formatRelativeShort(now - minute)).toBe('1h');
  });
  test('retains Intl locale validation only on the date branch, without silently changing locale', () => {
    expect(() => formatRelativeShort(now - 7 * day, 'en_US', now)).toThrow(RangeError);
    expect(formatRelativeShort(now, 'en_US', now)).toBe('now');
    expect(formatRelativeShort(NaN, 'en_US', now)).toBe('');
  });
  test('does not construct a date formatter for recent, future or invalid timestamps', () => {
    const original = Intl.DateTimeFormat;
    const formatter = vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function (...args: ConstructorParameters<typeof Intl.DateTimeFormat>) { return new original(...args); });
    for (const timestamp of [now, now + day, now - minute, now - hour, now - day, now - 7 * day + 1, NaN, 0]) formatRelativeShort(timestamp, 'en-US', now);
    expect(formatter).not.toHaveBeenCalled();
    formatRelativeShort(now - 7 * day, 'en-US', now); expect(formatter).toHaveBeenCalledOnce();
  });
});

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
