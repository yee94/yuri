import { afterEach, expect, it, vi } from 'vitest';
import { createDesktopHeaderQuotaPresentation } from './desktop-header-quota-presentation';
import { headerQuotaGroup, headerQuotaValue, type HeaderQuotaSnapshot } from './chat-header-quota';
import { formatTimeForLocale } from '../ui/src/lib/time-format-core';

afterEach(() => vi.useRealTimers());
const helpers = createDesktopHeaderQuotaPresentation(key => key, () => 'en-US');
const now = Date.UTC(2030, 0, 2, 12);
function fixture(windows: Record<string, unknown>, models = {}) {
  const group = headerQuotaGroup({ providerId: 'google', configured: true, ok: true, usage: { windows, models } }, {}, now)!;
  const snapshot: HeaderQuotaSnapshot = { loading: false, loaded: true, groups: [group], errors: [], displayMode: 'usage', timeFormat: '24h', showPredValues: true, lastUpdated: now };
  return { group, snapshot };
}
it('Web aggregate pace infers the key, not presentation label; expected marker is independent of prediction visibility and reverses remaining', () => {
  vi.useFakeTimers(); vi.setSystemTime(now);
  const { group, snapshot } = fixture({ weekly: { label: 'Not an identity', usedPercent: 25, remainingPercent: 75, resetAt: now + 604800000 * .75 } });
  const metric = helpers.row(group.rows[0], group, snapshot);
  expect(metric).toMatchObject({ value: '25%', expected: 25, showPace: true, pace: { status: 'on-track', predictText: '100%' } });
  expect(helpers.row(group.rows[0], group, { ...snapshot, showPredValues: false })).toMatchObject({ showPace: false, expected: 25 });
  expect(helpers.row(group.rows[0], group, { ...snapshot, displayMode: 'remaining' })).toMatchObject({ value: '75%', expected: 75, percent: 75 });
  expect(helpers.lastUpdated(snapshot)).toBe(formatTimeForLocale(now, '24h', 'en-US')); expect(helpers.lastUpdated({ ...snapshot, lastUpdated: null })).toBe('-');
});
it('unknown is blank only on desktop, infinite is retained, short windows have pace but no weekly allocation marker', () => {
  vi.useFakeTimers(); vi.setSystemTime(now);
  const { group, snapshot } = fixture({ unknown: {}, infinite: { valueLabel: '∞' }, '5h': { usedPercent: 100, remainingPercent: 0, resetAt: now + 3600000 } });
  expect(helpers.row(group.rows[0], group, snapshot)).toMatchObject({ value: '', percent: null, pace: null, expected: null });
  expect(headerQuotaValue(group.rows[0], 'usage')).toBe('—');
  expect(helpers.row(group.rows[1], group, snapshot).value).toBe('∞');
  expect(helpers.row(group.rows[2], group, snapshot)).toMatchObject({ expected: null, pace: { isExhausted: true, status: 'exhausted', remainingSeconds: 3600 } });
});
it('disablePace applies to aggregate as Web; family does not infer duration from window label and follows Header family pace call', () => {
  vi.useFakeTimers(); vi.setSystemTime(now);
  const window = { usedPercent: 20, remainingPercent: 80, resetAt: now + 300000000, disablePace: true };
  const { group, snapshot } = fixture({ weekly: window }, { 'gemini/one': { windows: { weekly: window } }, 'gemini/two': { windows: { weekly: { ...window, windowSeconds: 604800 } } } });
  expect(helpers.row(group.rows[0], group, snapshot).pace).toBeNull();
  const models = group.desktop!.families[0].models;
  expect(helpers.row(models[0].row, group, snapshot, true).pace).toBeNull();
  expect(helpers.row(models[1].row, group, snapshot, true).pace).not.toBeNull();
});
it('outer retained-owner group stale overlay fences desktop rows; expired data is never presented as a fresh forecast', () => {
  vi.useFakeTimers(); vi.setSystemTime(now);
  const { group, snapshot } = fixture({ weekly: { usedPercent: 30, resetAt: now + 200000000 } });
  const row = group.desktop!.entries[0]; expect(helpers.row(row, group, snapshot).pace).not.toBeNull();
  const stale = { ...group, stale: true, rows: group.rows.map(row => ({ ...row, stale: true })) };
  expect(row.stale).toBe(false); expect(helpers.row(row, stale, snapshot)).toMatchObject({ stale: true, pace: null, expected: null, showPace: false, value: '30%' });
  expect(helpers.row(row, { ...group, error: 'upstream failure' }, snapshot).pace).toBeNull();
  expect(helpers.row({ ...row, accountError: 'account failure' }, group, snapshot).pace).toBeNull();
  const expired = fixture({ weekly: { usedPercent: 60, resetAt: now - 1 } });
  expect(helpers.row(expired.group.desktop!.entries[0], expired.group, expired.snapshot)).toMatchObject({ value: '60%', pace: null, stale: true });
});
