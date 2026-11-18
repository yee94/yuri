import React from 'react';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import {
  calculatePace,
  clampPercent,
  formatQuotaResetClock,
  formatQuotaValueLabel,
  formatRemainingTime,
  getPaceStatusColor,
} from '@/lib/quota';
import { accountHeadingForWindows } from '@/lib/quota/accountGroups';
import type { TimeFormatPreference } from '@/stores/useUIStore';
import type { UsageWindow } from '@/types/quota';

export interface UsageRingItem {
  key: string;
  /** Short name under the ring. */
  label: string;
  /** Full name for the tooltip; defaults to `label`. */
  fullLabel?: string;
  window: UsageWindow;
  /** Raw window key, used to infer the window length for pace. */
  paceKey?: string;
}

interface UsageRingGridProps {
  items: ReadonlyArray<UsageRingItem>;
  displayMode: 'usage' | 'remaining';
  timeFormatPreference: TimeFormatPreference;
  showPace?: boolean;
  className?: string;
}

// Magpie's tray dial: 34px, a 3px ring, neutral until a window is nearly spent.
const RING_SIZE = 34;
const RING_STROKE = 3;
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
const RING_FULL_AT = 90;

const displayPercentOf = (window: UsageWindow, displayMode: 'usage' | 'remaining'): number | null =>
  clampPercent(displayMode === 'remaining' ? window.remainingPercent : window.usedPercent);

type Section = { heading: string | null; items: UsageRingItem[] };

const splitByAccount = (items: ReadonlyArray<UsageRingItem>): Section[] => {
  const windows = items.map((item) => item.window);
  const sections: Section[] = [];
  items.forEach((item, index) => {
    const heading = accountHeadingForWindows(windows, index);
    if (heading || sections.length === 0) {
      sections.push({ heading, items: [item] });
      return;
    }
    sections[sections.length - 1].items.push(item);
  });
  return sections;
};

// Magpie's shortWindow: "5 hours" as 5h, "7 days" as 7d; anything else is left to the caller.
const SPAN_UNITS: Record<string, string> = { minute: 'm', hour: 'h', day: 'd', week: 'w', month: 'mo' };
const shortWindow = (name: string): string | null => {
  const long = /^(\d+)\s*(minute|hour|day|week|month)s?$/i.exec(name);
  if (long) return `${long[1]}${SPAN_UNITS[long[2].toLowerCase()]}`;
  return /^\d+(m|h|d|w|mo)$/i.test(name) ? name : null;
};

// Magpie's poolWord: a pool's first word, with a version after it ("Gemini 4" for Gemini 4 Argon).
const poolWord = (pool: string): string => {
  const [first, second] = pool.split(/[ &]+/);
  return /^\d/.test(second ?? '') ? `${first} ${second}` : first;
};

/** A ring's short name: a pool's word over its span (Gemini 5h), else the span (5h, 7d), else the label. */
const ringName = (item: UsageRingItem): string => {
  if (item.fullLabel) return item.label;
  // a remote Magpie may already say "Gemini · 5 hours"; the span is the last part
  const tail = (item.window.label ?? item.paceKey ?? '').split(' · ').pop() ?? '';
  const span = shortWindow(tail);
  if (item.window.pool) return `${poolWord(item.window.pool)} ${span ?? tail}`.trim();
  return span ?? item.label;
};

// Magpie's cap, with a window that sums up the account (Cursor's "Total") ahead of the per-model ones.
const TOTAL_WINDOW = /\b(total|overall)\b|总计|合计|总量|整体/i;
const isTotalWindow = (item: UsageRingItem): boolean =>
  TOTAL_WINDOW.test(item.window.label ?? item.paceKey ?? item.label);
const totalsFirst = <T extends { item: UsageRingItem }>(rings: T[]): T[] => [
  ...rings.filter(({ item }) => isTotalWindow(item)),
  ...rings.filter(({ item }) => !isTotalWindow(item)),
];

// Magpie draws a card's first three windows as rings, and every pool's window when pools run past that.
const RINGS_SHOWN = 3;
const ringsShownFor = (rings: ReadonlyArray<{ item: UsageRingItem }>): number => {
  const pooled = rings.filter(({ item }) => item.window.pool).length;
  return pooled > 0 ? Math.max(RINGS_SHOWN + 1, pooled) : RINGS_SHOWN;
};

const UsageRing: React.FC<{
  item: UsageRingItem;
  percent: number;
  timeFormatPreference: TimeFormatPreference;
}> = ({ item, percent, timeFormatPreference }) => {
  const { t } = useI18n();
  const { window } = item;
  const fullLabel = item.fullLabel ?? item.label;
  const name = ringName(item);
  const metricLabel = formatQuotaValueLabel(window.valueLabel, percent);
  const resetLabel = window.resetAt ? formatQuotaResetClock(window.resetAt, timeFormatPreference) : '';
  const title = [`${fullLabel} · ${metricLabel === '-' ? `${percent}%` : metricLabel}`, resetLabel ? t('header.services.resetsAt', { when: resetLabel }) : '']
    .filter(Boolean)
    .join('\n');
  const full = (window.usedPercent ?? 0) >= RING_FULL_AT;
  const accent = full ? 'var(--status-warning)' : 'currentColor';
  const dash = (RING_CIRCUMFERENCE * percent) / 100;
  const center = RING_SIZE / 2;

  return (
    <div className="flex w-12 min-w-0 flex-col items-center gap-[3px]" title={title}>
      <div
        className="relative"
        style={{ width: RING_SIZE, height: RING_SIZE }}
        role="progressbar"
        aria-label={fullLabel}
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <svg viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`} className="size-full -rotate-90 text-foreground/60" aria-hidden="true">
          <circle
            cx={center}
            cy={center}
            r={RING_RADIUS}
            fill="none"
            stroke={full ? 'var(--status-warning)' : 'var(--interactive-border)'}
            strokeOpacity={full ? 0.18 : 1}
            strokeWidth={RING_STROKE}
          />
          {percent > 0 ? (
            <circle
              cx={center}
              cy={center}
              r={RING_RADIUS}
              fill="none"
              stroke={accent}
              strokeWidth={RING_STROKE}
              strokeDasharray={`${dash} ${RING_CIRCUMFERENCE}`}
              className="transition-[stroke-dasharray] duration-300"
            />
          ) : null}
        </svg>
        <span
          className={cn(
            'absolute inset-0 flex items-center justify-center text-[0.52rem] font-semibold tabular-nums',
            full ? 'text-foreground' : 'text-foreground/70',
          )}
        >
          {percent}%
        </span>
      </div>
      <span className="line-clamp-2 w-full break-words text-center text-[0.6rem] leading-tight text-muted-foreground">{name}</span>
    </div>
  );
};

/** Magpie's "Resets 14:26 · 7d Sun 05:59" line: the first reset bare, one more by name, and no repeats. */
const resetSummary = (
  items: ReadonlyArray<{ item: UsageRingItem; percent: number }>,
  timeFormatPreference: TimeFormatPreference,
  resetsAt: (when: string) => string,
): string => {
  const begun = items
    .filter(({ item }) => (item.window.usedPercent ?? 0) > 0 && (item.window.resetAt ?? 0) > Date.now())
    .map(({ item }) => ({ label: ringName(item), when: formatQuotaResetClock(item.window.resetAt as number, timeFormatPreference) }))
    .filter((entry, index, all) => entry.when && all.findIndex((other) => other.when === entry.when) === index)
    .slice(0, 2);
  if (begun.length === 0) return '';
  return [resetsAt(begun[0].when), ...begun.slice(1).map((entry) => `${entry.label} ${entry.when}`)].join(' · ');
};

/**
 * Magpie-style side-by-side quota rings. Windows without a percentage (balances, unlimited,
 * plain counters) have nothing to fill a ring with and fall back to a label/value line.
 */
export const UsageRingGrid: React.FC<UsageRingGridProps> = ({
  items,
  displayMode,
  timeFormatPreference,
  showPace = false,
  className,
}) => {
  const { t } = useI18n();
  const sections = splitByAccount(items);
  const resetsAt = (when: string) => t('header.services.resetsAt', { when });

  return (
    <div className={cn('space-y-3', className)}>
      {sections.map((section, sectionIndex) => {
        const rings: Array<{ item: UsageRingItem; percent: number }> = [];
        const lines: UsageRingItem[] = [];
        for (const item of section.items) {
          const percent = displayPercentOf(item.window, displayMode);
          if (percent === null) lines.push(item);
          else rings.push({ item, percent });
        }
        const ordered = totalsFirst(rings);
        const shown = ordered.slice(0, ringsShownFor(ordered));
        // what the rings leave out is said as a line of words under them, with the windows that have no share
        const rows: Array<{ item: UsageRingItem; percent: number | null }> = [
          ...ordered.slice(shown.length),
          ...lines.map((item) => ({ item, percent: null })),
        ];
        const reset = resetSummary(shown, timeFormatPreference, resetsAt);
        const paced = showPace
          ? shown
              .map(({ item }) => (item.window.disablePace
                ? null
                : calculatePace(item.window.usedPercent, item.window.resetAt, item.window.windowSeconds, item.paceKey)))
              .find((info) => info !== null) ?? null
          : null;
        return (
          <div
            key={section.items[0]?.key ?? sectionIndex}
            className={cn(
              'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2',
              section.heading && sectionIndex > 0 && 'border-t border-[var(--surface-subtle)] pt-3',
            )}
          >
            <div className="min-w-0 space-y-1.5">
              {section.heading ? (
                <div className="truncate text-xs text-foreground" title={section.heading}>{section.heading}</div>
              ) : null}
              {reset || paced ? (
                <div className="text-[0.7rem] leading-snug tabular-nums text-muted-foreground">
                  {reset}
                  {paced ? (
                    <span style={{ color: getPaceStatusColor(paced.status) }}>
                      {reset ? ' · ' : ''}{paced.isExhausted ? formatRemainingTime(paced.remainingSeconds) : paced.predictText}
                    </span>
                  ) : null}
                </div>
              ) : null}
            </div>
            {shown.length > 0 ? (
              <div className={cn('flex max-w-[15rem] flex-wrap items-start justify-end gap-y-2.5', shown.length > 4 ? 'gap-x-[7px]' : 'gap-x-3')}>
                {shown.map(({ item, percent }) => (
                  <UsageRing
                    key={item.key}
                    item={item}
                    percent={percent}
                    timeFormatPreference={timeFormatPreference}
                  />
                ))}
              </div>
            ) : null}
            {rows.map(({ item, percent }) => {
              const metricLabel = formatQuotaValueLabel(item.window.valueLabel, percent);
              return (
                <div key={item.key} className="col-span-full flex min-w-0 items-baseline justify-between gap-3">
                  <span className="truncate text-[0.7rem] text-muted-foreground" title={item.fullLabel ?? item.label}>
                    {item.fullLabel ?? item.label}
                  </span>
                  <span className="min-w-0 max-w-[55%] shrink-0 truncate text-[0.7rem] font-medium tabular-nums text-foreground/80">
                    {metricLabel === '-' ? '' : metricLabel}
                  </span>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
};
