import type { DisplayTimePreference } from '../ui/src/lib/time-format-core';
export { derivePartsLabel, deriveUserSnippet, formatAssistantTokensWithTps, formatMessagePreviewTime } from '../ui/src/components/layout/rawMessagePreview';

export const contextUsageNumber = (value: number, locale: string) => value.toLocaleString(locale);
export function contextUsageMoney(value: number, locale: string): string {
  const amount = Number.isFinite(value) && value > 0 ? value : 0;
  const digits = amount > 0 && amount < .01 ? 4 : 2;
  return new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(amount);
}
export function contextUsageDate(timestamp: number | null, preference: DisplayTimePreference, locale: string): string {
  if (!timestamp || !Number.isFinite(timestamp)) return '-';
  return new Date(timestamp).toLocaleString(locale, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: preference === '12h' ? true : preference === '24h' ? false : undefined });
}
