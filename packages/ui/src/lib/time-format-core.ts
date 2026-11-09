export type DisplayTimePreference = 'auto' | '12h' | '24h';
type TimeOptions = { precision?: 'minute' | 'second'; hour?: 'numeric' | '2-digit'; fallback?: string };

/** Same short relative labels as MobileSessionsSheet. */
export function formatRelativeShort(timestamp: number, locale?: string, now = Date.now()): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0 || timestamp > 8_640_000_000_000_000 || !Number.isFinite(now)) return '';
  const diffMs = now - timestamp;
  if (diffMs < 60_000) return 'now';
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(new Date(timestamp));
}

export function formatTimeForLocale(timestamp: number | Date, preference: DisplayTimePreference, locale: string, options: TimeOptions = {}): string {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return options.fallback ?? '';
  return date.toLocaleTimeString(locale, {
    hour: options.hour ?? 'numeric', minute: '2-digit',
    second: options.precision === 'second' ? '2-digit' : undefined,
    hour12: preference === '12h' ? true : preference === '24h' ? false : undefined,
  });
}

/** Native engines may adapt the clock without duplicating date labels; Web callers retain the default Intl path. */
export function formatMessageTimestampForLocale(timestamp: number, preference: DisplayTimePreference, locale: string, yesterdayWithTime: (time: string) => string, now = new Date(), formatClock: typeof formatTimeForLocale = formatTimeForLocale): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return '';
  const sameDay = (other: Date) => date.getFullYear() === other.getFullYear() && date.getMonth() === other.getMonth() && date.getDate() === other.getDate();
  const time = formatClock(date, preference, locale);
  if (sameDay(now)) return time;
  const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
  if (sameDay(yesterday)) return yesterdayWithTime(time);
  const month = date.toLocaleString(locale, { month: 'short' });
  const datePart = `${month} ${date.getDate()}`;
  return date.getFullYear() === now.getFullYear() ? `${datePart}, ${time}` : `${datePart}, ${date.getFullYear()}, ${time}`;
}
