import { expect, it } from 'vitest';
import { editorCalendarPreferences, editorDateLabel, editorWeekPreference, localEditorDate } from './features-calendar';
import { cldrWeekStart } from './features-week-data';

it('uses actual native 12/24h and week preference before locale defaults', () => {
  expect(editorCalendarPreferences({ timeFormatPreference: '12h', weekStartPreference: 'monday' }, 'zh-CN')).toEqual({ hourCycle: 'h12', weekStartsOn: 1 });
  expect(editorCalendarPreferences({ timeFormatPreference: '24h', weekStartPreference: 'sunday' }, 'en-US')).toEqual({ hourCycle: 'h23', weekStartsOn: 0 });
  expect(editorCalendarPreferences({ timeFormatPreference: 'auto', weekStartPreference: 'auto' }, 'en-US').hourCycle).toBe('h12');
  expect(editorWeekPreference({ weekStartPreference: 'monday' })).toBe('monday');
  expect(() => editorWeekPreference({ failed: true })).toThrow();
});
it('uses captured ICU/CLDR rules without requiring platform weekInfo or getWeekInfo', () => {
  for (const [locale, expected] of [['en-US', 0], ['en-GB', 1], ['zh-CN', 1], ['zh-TW', 0], ['zh-Hant', 0], ['ja-JP', 0], ['fr-FR', 1], ['es-ES', 1], ['ko-KR', 0], ['pl-PL', 1], ['pt-BR', 0], ['uk-UA', 1], ['ar-EG', 6], ['dv-MV', 5], ['en-US-u-fw-mon', 1], ['en-US-u-rg-gbzzzz', 1]] as const) expect(cldrWeekStart(locale)).toBe(expected);
});
it('still resolves all app languages when Intl.Locale is entirely absent in NSH', () => {
  const original = Reflect.get(Intl, 'Locale'); Reflect.set(Intl, 'Locale', undefined);
  try {
    for (const [tag, expected] of [['en', 0], ['fr', 1], ['es', 1], ['pl', 1], ['pt-BR', 0], ['ja', 0], ['ko', 0], ['uk', 1], ['zh-CN', 1], ['zh-TW', 0], ['zh-Hant', 0]] as const) expect(cldrWeekStart(tag)).toBe(expected);
  } finally { Reflect.set(Intl, 'Locale', original); }
});
it('formats real calendar days without UTC shifts or accepting impossible dates', () => {
  expect(localEditorDate(new Date(2026, 10, 7, 23, 59))).toBe('2026-11-07');
  expect(editorDateLabel('2026-11-07', 'en-US')).toContain('2026');
  expect(editorDateLabel('2026-02-30', 'en-US')).toBe('2026-02-30');
});
