import type { ProviderResult, UsageWindow } from '../ui/src/types/quota';
import { usageAccountRows, usageModelGroups } from './settings-usage-core';

type Account = ReturnType<typeof usageAccountRows>[number];
type Family = ReturnType<typeof usageModelGroups>[number];
export type DesktopUsageRow =
  | { id: string; kind: 'account'; account: Account }
  | { id: string; kind: 'window'; title: string; window: UsageWindow }
  | { id: string; kind: 'models' }
  | { id: string; kind: 'family'; family: Family }
  | { id: string; kind: 'model'; model: Family['models'][number] };

/** Metadata only. Native List owns materialization, including accounts with many windows. */
export function desktopUsageRows(accounts: Account[], groups: Family[], collapsed: Record<string, boolean>): DesktopUsageRow[] {
  const rows: DesktopUsageRow[] = [];
  for (const account of accounts) {
    if (account.account) rows.push({ id: `account:${account.id}`, kind: 'account', account });
    for (const [key, window] of account.windows) rows.push({ id: `${account.id}:${key}`, kind: 'window', title: account.account ? window.label ?? key : key, window });
  }
  if (groups.length) rows.push({ id: 'models', kind: 'models' });
  for (const family of groups) {
    rows.push({ id: `family:${family.id}`, kind: 'family', family });
    if (!collapsed[family.id]) for (const model of family.models) rows.push({ id: model.id, kind: 'model', model });
  }
  return rows;
}

/** A missing result after a failed read is unknown, not an authoritative empty quota. */
export function desktopUsageReadFailed(result: ProviderResult | undefined, errors: Record<string, true>, provider: string | null) {
  return !!(result?.configured && !result.ok || provider && errors[provider] || result?.sourceId && errors[result.sourceId] || result?.source === 'magpie' && errors.magpie);
}
