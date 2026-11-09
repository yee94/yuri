import { record } from './model';
import { cldrWeekStart } from './features-week-data';
export type EditorWeekPreference = 'auto' | 'monday' | 'sunday';
export function editorWeekPreference(value: unknown): EditorWeekPreference {
  const row = record(value);
  if (!value || typeof value !== 'object' || Array.isArray(value) || row.failed === true || row.partial === true || row.ok === false || row.success === false || row.complete === false) throw new Error('invalid-calendar-preferences');
  if (row.weekStartPreference === undefined) return 'auto';
  if (row.weekStartPreference === 'auto' || row.weekStartPreference === 'monday' || row.weekStartPreference === 'sunday') return row.weekStartPreference;
  throw new Error('invalid-calendar-preferences');
}
export function editorCalendarPreferences(appearance: unknown, locale: string, weekFallback?: EditorWeekPreference | null): { hourCycle: 'h12' | 'h23'; weekStartsOn: number } {
  const row = record(appearance);
  const week = row.weekStartPreference ?? weekFallback;
  let use24 = true;
  try { const options = new Intl.DateTimeFormat(locale, { hour: 'numeric' }).resolvedOptions(); use24 = options.hour12 === undefined ? options.hourCycle === 'h23' || options.hourCycle === 'h24' : !options.hour12; } catch { /* Same locale fallback as Web. */ }
  return { hourCycle: row.timeFormatPreference === '24h' || row.timeFormatPreference !== '12h' && use24 ? 'h23' : 'h12', weekStartsOn: week === 'monday' ? 1 : week === 'sunday' ? 0 : cldrWeekStart(locale) };
}
export const localEditorDate = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
export function editorDateLabel(value: string, locale: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return value;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (localEditorDate(date) !== value) return value;
  return new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric' }).format(date);
}
