import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { formatMessageTimestampForLocale, formatTimeForLocale, type DisplayTimePreference } from '../ui/src/lib/time-format-core';

function runQuickJS(steps: string[]) {
  const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'tests/transcript-time-app.tsx'], {
    cwd: path.dirname(fileURLToPath(import.meta.url)), encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
    input: steps.join('\n'),
  });
  expect(result.error, result.stdout + result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  return result.stdout + result.stderr;
}

test('actual QuickJS matches Web numeric zh-CN midnight hour width', () => {
  const expected = formatTimeForLocale(new Date(2026, 10, 7, 0, 48), 'auto', 'zh-CN');
  runQuickJS([`await app.waitFor("id:clock-midnight-probe"); expect(app.texts()).toContain(${JSON.stringify(expected)});`]);
}, 75_000);

test('actual QuickJS clock, parts and message/date boundaries match the Node Web oracle', () => {
  const stdout = runQuickJS(['await app.waitFor("id:clock-matrix");', 'console.log(app.texts().find(value => value.startsWith("clock-matrix:")));']);
  const line = stdout.split('\n').find(value => value.startsWith('clock-matrix:'));
  expect(line).toBeDefined();
  const rows = JSON.parse(line!.slice('clock-matrix:'.length)) as Array<{
    locale: string; preference: DisplayTimePreference; index: number; timestamp: number; offset: number; raw: string; format: string;
    parts: Intl.DateTimeFormatPart[]; resolved: Intl.ResolvedDateTimeFormatOptions;
    clock: string; padded: string; message: string; yearBoundary: string;
  }>;
  expect(rows).toHaveLength(6 * 3 * 7);
  const now = new Date(2026, 10, 7, 16, 30);
  const dates = [new Date(2026, 10, 7, 0, 48), new Date(2026, 10, 7, 12, 0), new Date(2026, 10, 7, 9, 5), new Date(2026, 10, 7, 23, 5), new Date(2026, 10, 6, 9, 5), new Date(2026, 9, 20, 9, 5), new Date(2025, 9, 20, 9, 5)];
  for (const row of rows) {
    const date = dates[row.index];
    const label = `${row.locale}/${row.preference}/${row.index}`;
    expect(row.timestamp, label + '/local-epoch').toBe(date.getTime());
    expect(row.offset, label + '/local-offset').toBe(date.getTimezoneOffset());
    expect(row.format, label).toBe(row.raw);
    expect(row.parts.map(part => part.value).join(''), label).toBe(row.raw);
    expect(row.clock, label).toBe(formatTimeForLocale(date, row.preference, row.locale));
    expect(row.padded, label + '/2-digit/seconds').toBe(formatTimeForLocale(date, row.preference, row.locale, { hour: '2-digit', precision: 'second' }));
    expect(row.message, label + '/message').toBe(formatMessageTimestampForLocale(date.getTime(), row.preference, row.locale, time => `yesterday ${time}`, now));
    expect(row.yearBoundary, label + '/year-boundary').toBe(formatMessageTimestampForLocale(new Date(2025, 11, 31, 9, 5).getTime(), row.preference, row.locale, time => `yesterday ${time}`, new Date(2026, 0, 1, 16)));
  }
  // Engine evidence: resolvedOptions alone cannot tell us the browser's width.
  const midnight = rows.find(row => row.locale === 'zh-CN' && row.preference === 'auto' && row.index === 0)!;
  expect(midnight.raw).toBe('00:48');
  expect(midnight.resolved.hour).toBe('numeric');
  expect(midnight.resolved.hourCycle).toBe('h23');
  expect(midnight.clock).toBe('0:48');
}, 75_000);

test('production user clock reacts to language, root preference snapshots and reused message props in actual QuickJS', () => {
  const stdout = runQuickJS([
      'await app.waitFor("id:message-timestamp");',
      'expect(app.texts()).toContain("9:05");',
      'expect(app.texts()).toContain("preference:null");',
      'await app.press("id:clock-switch-locale");',
      'await app.waitFor("text:9:05 AM");',
      'await app.press("id:clock-24h");',
      'await app.waitFor("text:09:05");',
      'expect(app.texts()).not.toContain("9:05 AM");',
      'await app.press("id:clock-12h");',
      'await app.waitFor("text:9:05 AM");',
      'await app.press("id:clock-british-locale");',
      'await app.waitFor("text:9:05 am");',
      'await app.press("id:clock-auto");',
      'await app.waitFor("text:9:05");',
      'expect(app.texts()).toContain("preference:auto");',
      'await app.press("id:clock-switch-locale");',
      'await app.waitFor("text:9:05 AM");',
      'await app.press("id:clock-reuse-message");',
      'await app.waitFor("text:2:05 PM");',
      'expect(app.texts()).not.toContain("9:05 AM");',
      'await app.press("id:clock-24h");',
      'await app.waitFor("text:14:05");',
      'await app.press("id:clock-unknown");',
      'await app.waitFor("text:2:05 PM");',
      'expect(app.texts()).toContain("preference:null");',
      'expect(app.texts()).toContain("invalid:");',
      'await app.press("id:clock-system-locale");',
      'console.log("system-readout:" + JSON.stringify(app.texts().filter(value => !value.startsWith("clock-matrix:") && !value.startsWith("clock-gaps:"))));',
      'await app.press("id:clock-yesterday");',
      'await app.waitFor("text:昨天 9:05");',
      'await app.press("id:clock-switch-locale");',
      'await app.waitFor("text:Yesterday 9:05 AM");',
  ]);
  const readout = JSON.parse(stdout.split('\n').find(value => value.startsWith('system-readout:'))!.slice('system-readout:'.length)) as string[];
  const systemLocale = readout.find(value => value.startsWith('system-locale:'))!.slice('system-locale:'.length);
  const date = new Date(); date.setHours(14, 5, 0, 0);
  expect(readout).toContain(formatTimeForLocale(date, 'auto', systemLocale));
}, 75_000);

test('records NSH 0.4 Intl limitations instead of pretending Unicode extensions or IANA zones work', () => {
  const stdout = runQuickJS(['console.log(app.texts().find(value => value.startsWith("clock-gaps:")));']);
  const gaps = JSON.parse(stdout.split('\n').find(value => value.startsWith('clock-gaps:'))!.slice('clock-gaps:'.length));
  expect(gaps.extensions[0].resolved.hourCycle).toBe('h12');
  expect(gaps.extensions[0].formatted).toBe('12:48 AM');
  expect(gaps.extensions[1].resolved.numberingSystem).toBe('latn');
  expect(gaps.zone).toBe('RangeError');
  for (const row of gaps.untouched) expect(row.native, row.locale).toBe(row.raw);
  for (const row of gaps.invalid) expect(row).toEqual({ clock: '', fallback: '—', message: '' });
}, 75_000);
