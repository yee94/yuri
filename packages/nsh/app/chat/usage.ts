import { request, record, textOf } from '../core/host';
import { remotePath } from '../core/remote';
import { t, type I18nKey } from '../core/i18n';

/** One rate-limit window as Web's metadata panel lists it. */
export type UsageRow = { key: string; label: string; percent: number | null; reset: string };

export type UsageGroup = { providerId: string; name: string; rows: UsageRow[]; status: string };

export type UsageSnapshot = { groups: UsageGroup[]; displayMode: 'usage' | 'remaining' };

const WINDOW_LABELS: Record<string, I18nKey> = {
  '5h': 'quota.window.5h',
  '7d': 'quota.window.7d',
  '7d-sonnet': 'quota.window.7dSonnet',
  '7d-opus': 'quota.window.7dOpus',
  weekly: 'quota.window.weekly',
  daily: 'quota.window.daily',
  monthly: 'quota.window.monthly',
  credits: 'quota.window.credits',
  credits_balance: 'quota.window.creditsBalance',
  billing_cycle: 'quota.window.billingCycle',
  auto: 'quota.window.auto',
  api: 'quota.window.api',
  plan_limit: 'quota.window.planLimit',
  on_demand: 'quota.window.onDemand',
  session: 'quota.window.session',
  premium: 'quota.window.premium',
  chat: 'quota.window.chat',
  completions: 'quota.window.completions',
  premium_interactions: 'quota.window.premiumInteractions',
};

const windowLabel = (label: string): string => {
  const key = WINDOW_LABELS[label];
  return key ? t(key) : label;
};

const percentOf = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : null;

function rowOf(key: string, label: string, window: unknown): UsageRow {
  const value = record(window);
  const reset = textOf(value.resetAfterFormatted) || textOf(value.resetAtFormatted);
  return {
    key,
    label: windowLabel(textOf(value.label) || label),
    percent: percentOf(value.usedPercent) ?? percentOf(value.remainingPercent),
    reset,
  };
}

/** `/api/config/settings` + `/api/quota/<provider>` — the same reads Web's panel makes. */
export async function readUsage(directory: string, hostId: string | null = null): Promise<UsageSnapshot> {
  const scoped = (path: string) => (hostId ? remotePath(hostId, path) : path);
  let settings: Record<string, unknown> = {};
  try {
    settings = record(await request(scoped('/api/config/settings')));
  } catch {
    // Defaults below match Web's unconfigured quota settings.
  }
  const displayMode = textOf(settings.usageDisplayMode) === 'remaining' ? 'remaining' : 'usage';
  const configured = Array.isArray(settings.usageDropdownProviders)
    ? (settings.usageDropdownProviders as unknown[]).map(textOf).filter((id) => !!id && !id.startsWith('magpie:'))
    : ['claude', 'codex', 'cursor', 'github-copilot', 'google'];
  const selected = record(settings.usageSelectedModels);
  const results = await Promise.allSettled(
    configured.map((providerId) => request(scoped(`/api/quota/${encodeURIComponent(providerId)}?${directory ? `directory=${encodeURIComponent(directory)}` : ''}`))),
  );
  const groups: UsageGroup[] = [];
  results.forEach((result, index) => {
    const providerId = configured[index]!;
    if (result.status === 'rejected') return;
    const value = record(result.value);
    const usage = record(value.usage);
    if (value.configured === false) return;
    const rows: UsageRow[] = [];
    for (const [label, window] of Object.entries(record(usage.windows))) rows.push(rowOf(`window-${label}`, label, window));
    const wanted = Array.isArray(selected[providerId]) ? (selected[providerId] as unknown[]).map(textOf) : [];
    for (const [model, modelUsage] of Object.entries(record(usage.models))) {
      if (wanted.length && !wanted.includes(model)) continue;
      const first = Object.entries(record(record(modelUsage).windows))[0];
      if (!first) continue;
      rows.push({ ...rowOf(`model-${model}-${first[0]}`, first[0], first[1]), label: `${model} · ${windowLabel(textOf(record(first[1]).label) || first[0])}` });
    }
    const name = textOf(value.providerName) || providerId;
    const error = !value.ok && textOf(value.error) ? textOf(value.error) : rows.length === 0 ? t('header.services.noRateLimitsReported') : '';
    groups.push({ providerId, name, rows, status: error });
  });
  return { groups, displayMode };
}
