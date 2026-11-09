import { formatTimeForLocale } from '../ui/src/lib/time-format-core';
import type { I18nKey } from '../ui/src/lib/i18n/messages/en';
import type { HeaderQuotaGroup, HeaderQuotaRow, HeaderQuotaSnapshot } from './chat-header-quota';
import { createUsageQuotaHelpers } from './settings-usage-quota';

/** Formatting and Web quota math only. No Settings controller, transport, cache or clock owner. */
export function createDesktopHeaderQuotaPresentation(t: (key: I18nKey) => string, locale: () => string) {
  const helpers = createUsageQuotaHelpers({ t,
    formatTimeForPreference: (time, preference, options) => formatTimeForLocale(time, preference, locale(), options),
    formatDateTimeForPreference: (time, preference, options) => new Intl.DateTimeFormat(locale(), { ...options, ...(preference === 'auto' ? {} : { hour12: preference === '12h' }) }).format(time),
  });
  return { ...helpers,
    lastUpdated(snapshot?: HeaderQuotaSnapshot) {
      if (!snapshot?.lastUpdated || !Number.isFinite(snapshot.lastUpdated)) return '-';
      try { return formatTimeForLocale(snapshot.lastUpdated, snapshot.timeFormat, locale(), { fallback: '-' }); }
      catch { return '-'; }
    },
    row(row: HeaderQuotaRow, group: HeaderQuotaGroup, snapshot: HeaderQuotaSnapshot | undefined, model = false) {
      const percent = snapshot?.displayMode === 'remaining' ? row.window.remainingPercent : row.window.usedPercent;
      const value = helpers.formatQuotaValueLabel(row.window.valueLabel, percent);
      // The retained owner overlays group/legacy rows as stale without rewriting desktop metadata.
      const stale = !!group.stale || !!group.error || !!row.stale || !!row.accountError || row.window.resetAt !== null && row.window.resetAt <= Date.now();
      const pace = stale || (!model && row.window.disablePace) ? null
        : helpers.calculatePace(row.window.usedPercent, row.window.resetAt, row.window.windowSeconds, model ? undefined : row.key);
      const expected = pace?.dailyAllocationPercent != null ? helpers.calculateExpectedUsagePercent(pace.elapsedRatio) : null;
      return {
        label: helpers.formatWindowLabel(row.window.label ?? row.label),
        value: value === '-' ? '' : value,
        percent: helpers.clampPercent(percent), tone: helpers.resolveUsageTone(row.window.usedPercent ?? percent),
        reset: model ? '' : helpers.formatQuotaResetLabel(row.window.resetAt, row.window.resetAfterFormatted ?? row.window.resetAtFormatted, snapshot?.timeFormat ?? 'auto'),
        pace, stale, showPace: !!pace && snapshot?.showPredValues === true,
        expected: expected === null ? null : snapshot?.displayMode === 'remaining' ? 100 - expected : expected,
      };
    },
  };
}
