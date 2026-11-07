import { accountHeadingForWindows, tagWindowsWithAccount } from '../ui/src/lib/quota/accountGroups';
import { QUOTA_PROVIDERS } from '../ui/src/lib/quota/providers';
import { getDisplayModelName } from '../ui/src/lib/quota/model-families';
import type { UsageWindow } from '../ui/src/types/quota';
import { record, text, type Row } from './model';

export type HeaderQuotaRow = { key: string; label: string; subtitle?: string; window: UsageWindow; accountHeading?: string; stale?: boolean; accountError?: string };
export type HeaderQuotaGroup = { id: string; name: string; logoID: string; sourceId?: string; rows: HeaderQuotaRow[]; error?: string; stale?: boolean; fetchedAt?: number };
export type HeaderQuotaSnapshot = { loading: boolean; groups: HeaderQuotaGroup[]; errors: string[]; displayMode: 'usage' | 'remaining'; timeFormat: 'auto' | '12h' | '24h'; loaded?: boolean };
const knownProviders = new Map(QUOTA_PROVIDERS.map(provider => [provider.id as string, provider.name]));
const finite = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

function windowFrom(value: unknown): UsageWindow {
  const row = record(value);
  return { usedPercent: finite(row.usedPercent), remainingPercent: finite(row.remainingPercent), windowSeconds: finite(row.windowSeconds), resetAfterSeconds: finite(row.resetAfterSeconds), resetAt: finite(row.resetAt), resetAtFormatted: text(row.resetAtFormatted) || null, resetAfterFormatted: text(row.resetAfterFormatted) || null, ...(typeof row.valueLabel === 'string' ? { valueLabel: row.valueLabel } : {}), ...(text(row.label) ? { label: text(row.label) } : {}), ...(text(row.accountName) ? { accountName: text(row.accountName) } : {}) };
}

/** Keep only presentation fields in memory. No credentials, account payload dump, storage or logs. */
export function headerQuotaGroup(payload: unknown, selectedModels: Row = {}, now = Date.now()): HeaderQuotaGroup | null {
  const result = record(payload);
  if (!text(result.providerId) || typeof result.configured !== 'boolean' || typeof result.ok !== 'boolean') throw new Error('Invalid quota response');
  if (!result.configured) return null;
  const usage = record(result.usage), accounts = Array.isArray(usage.accounts) ? usage.accounts.map(record).slice(0, 200) : [];
  const entries: [string, UsageWindow][] = Object.entries(record(usage.windows)).slice(0, 1000).map(([key, value]) => [key, windowFrom(value)]);
  const rows: HeaderQuotaRow[] = tagWindowsWithAccount(entries, accounts.map(account => ({ name: text(account.name) }))).map(([key, window]) => ({ key, label: window.label || key, window }));
  const selected = selectedModels[text(result.providerId)];
  for (const [name, value] of Object.entries(record(usage.models)).slice(0, 500)) {
    if (Array.isArray(selected) && selected.length && !selected.includes(name)) continue;
    const first = Object.entries(record(record(value).windows))[0];
    if (first) { const window = windowFrom(first[1]); rows.push({ key: `model:${name}:${first[0]}`, label: window.label || first[0], subtitle: getDisplayModelName(name), window }); }
  }
  const windows = rows.map(row => row.window);
  rows.forEach((row, index) => {
    row.accountHeading = accountHeadingForWindows(windows, index) || undefined;
    const account = accounts.find(entry => row.window.accountName ? entry.name === row.window.accountName : accounts.length === 1);
    row.stale = account?.stale === true || (row.window.resetAt !== null && row.window.resetAt <= now);
    row.accountError = text(account?.error) || undefined;
  });
  return { id: text(result.providerId), name: text(result.providerName) || text(result.providerId), logoID: text(result.upstreamProviderId) || text(result.providerId), ...(text(result.sourceId) ? { sourceId: text(result.sourceId) } : {}), rows, stale: rows.some(row => row.stale), ...(result.ok === false ? { error: text(result.error) || 'Unable to refresh quota' } : {}), fetchedAt: finite(result.fetchedAt) ?? undefined };
}

function quotaPreferences(payload: unknown): Row {
  const value = record(payload), models: Row = {};
  for (const [id, entries] of Object.entries(record(value.usageSelectedModels)).slice(0, 200)) if (Array.isArray(entries)) models[id] = entries.filter(item => typeof item === 'string').slice(0, 500);
  return {
    usageDisplayMode: value.usageDisplayMode === 'remaining' ? 'remaining' : 'usage',
    timeFormatPreference: value.timeFormatPreference === '12h' || value.timeFormatPreference === '24h' ? value.timeFormatPreference : 'auto',
    usageSelectedModels: models,
    ...(Array.isArray(value.usageDropdownProviders) ? { usageDropdownProviders: value.usageDropdownProviders.filter(item => typeof item === 'string').slice(0, 200) } : {}),
    magpieHiddenProviders: Array.isArray(value.magpieHiddenProviders) ? value.magpieHiddenProviders.filter(item => typeof item === 'string').slice(0, 200) : [],
  };
}

export function createHeaderQuotas(options: { directory: string; read: (path: string) => Promise<unknown>; current: () => boolean; changed: (snapshot: HeaderQuotaSnapshot) => void; now?: () => number }) {
  let alive = true, serial = 0, flight: Promise<void> | undefined;
  let snapshot: HeaderQuotaSnapshot = { loading: false, groups: [], errors: [], displayMode: 'usage', timeFormat: 'auto' };
  let preferences: Row = {};
  const valid = (revision: number) => alive && revision === serial && options.current();
  const publish = (value: HeaderQuotaSnapshot) => { snapshot = value; options.changed(value); };
  async function refresh(force = false) {
    if (flight || !alive || !options.current()) return flight;
    const revision = ++serial;
    publish({ ...snapshot, loading: true, errors: [] });
    const work = (async () => {
      const [settings, configured, magpie] = await Promise.allSettled([
        options.read('/api/config/settings'),
        options.read('/api/quota/providers'),
        options.read(`/api/quota/magpie?directory=${encodeURIComponent(options.directory)}${force ? '&refresh=1' : ''}`),
      ]);
      if (!valid(revision)) return;
      const errors: string[] = [];
      if (settings.status === 'fulfilled') preferences = quotaPreferences(settings.value);
      else errors.push(errorText(settings.reason));
      const dropdown = Array.isArray(preferences.usageDropdownProviders) ? preferences.usageDropdownProviders.filter(value => typeof value === 'string') : [...knownProviders.keys()];
      const hidden = Array.isArray(preferences.magpieHiddenProviders) ? preferences.magpieHiddenProviders : [];
      const next = new Map(snapshot.groups.map(group => [group.id, group]));
      let ids: string[] = [];
      if (configured.status === 'fulfilled' && Array.isArray(record(configured.value).providers)) {
        const configuredIDs = record(configured.value).providers as unknown[];
        ids = [...knownProviders.keys()].filter(id => configuredIDs.includes(id) && dropdown.includes(id)).slice(0, 32);
        for (const [id, group] of next) if (!group.sourceId && !ids.includes(id)) next.delete(id);
      } else {
        const error = configured.status === 'rejected' ? errorText(configured.reason) : 'Invalid quota providers';
        errors.push(error);
        for (const [id, group] of next) if (!group.sourceId) next.set(id, { ...group, stale: true, error });
      }
      // Bounded four-wide provider reads; dynamic Magpie providers use one Host aggregate.
      for (let start = 0; start < ids.length; start += 4) {
        const batch = ids.slice(start, start + 4);
        const results = await Promise.allSettled(batch.map(id => options.read(`/api/quota/${encodeURIComponent(id)}`)));
        if (!valid(revision)) return;
        results.forEach((result, index) => {
          const id = batch[index];
          try {
            if (result.status === 'rejected') throw result.reason;
            if (record(result.value).providerId !== id) throw new Error('Invalid quota provider identity');
            if (record(result.value).ok === false && record(result.value).configured === false && text(record(result.value).error)) throw new Error(text(record(result.value).error));
            const group = headerQuotaGroup(result.value, record(preferences.usageSelectedModels), options.now?.());
            if (group) next.set(id, group); else next.delete(id);
          } catch (cause) {
            const previous = next.get(id);
            next.set(id, { ...(previous || { id, name: knownProviders.get(id) || id, logoID: id, rows: [] }), stale: true, error: errorText(cause) });
          }
        });
      }
      if (magpie.status === 'fulfilled' && Array.isArray(record(magpie.value).sources)) {
        const body = record(magpie.value), reported = new Set<string>();
        let incomplete = body.incomplete === true;
        if (incomplete) errors.push('Magpie discovery is incomplete');
        if ((body.sources as unknown[]).length > 32) { incomplete = true; errors.push('Quota source limit exceeded'); }
        for (const raw of (body.sources as unknown[]).slice(0, 32)) {
          const source = record(raw), sourceId = text(source.id);
          if (!sourceId || !Array.isArray(source.results)) { incomplete = true; errors.push('Invalid Magpie quota source'); continue; }
          reported.add(sourceId);
          const failed = !!source.error && source.clearPrevious !== true && source.results.length === 0;
          const staged: HeaderQuotaGroup[] = [], sourceErrors: string[] = [];
          if (source.results.length > 200) sourceErrors.push('Quota provider limit exceeded');
          for (const result of source.results.slice(0, 200)) {
            try {
              const item = record(result);
              if (item.source !== 'magpie' || item.sourceId !== sourceId || !text(item.providerId).startsWith(`magpie:${sourceId}:`)) throw new Error('Invalid Magpie quota identity');
              if (hidden.includes(item.providerId)) continue;
              const group = headerQuotaGroup(item, record(preferences.usageSelectedModels), options.now?.());
              if (group) staged.push(group);
            } catch (cause) { sourceErrors.push(errorText(cause)); }
          }
          for (const [id, group] of next) if (group.sourceId === sourceId) {
            if (failed || sourceErrors.length) next.set(id, { ...group, error: text(source.error) || sourceErrors[0], stale: true }); else next.delete(id);
          }
          if (text(source.error)) errors.push(text(source.error));
          errors.push(...sourceErrors);
          for (const group of staged) next.set(group.id, group);
        }
        for (const [id, group] of next) if (group.sourceId && !reported.has(group.sourceId)) {
          if (incomplete) next.set(id, { ...group, stale: true, error: 'Magpie discovery is incomplete' }); else next.delete(id);
        }
      } else {
        errors.push(magpie.status === 'rejected' ? errorText(magpie.reason) : 'Invalid Magpie quota response');
        for (const [id, group] of next) if (group.sourceId) next.set(id, { ...group, stale: true });
      }
      for (const [id] of next) if (hidden.includes(id)) next.delete(id);
      if (!valid(revision)) return;
      publish({ loading: false, loaded: true, groups: [...next.values()], errors, displayMode: preferences.usageDisplayMode === 'remaining' ? 'remaining' : 'usage', timeFormat: preferences.timeFormatPreference === '12h' || preferences.timeFormatPreference === '24h' ? preferences.timeFormatPreference : 'auto' });
    })();
    flight = work;
    try { await work; } finally { if (flight === work) flight = undefined; }
  }
  return { refresh, cancel() { serial++; flight = undefined; }, dispose() { alive = false; serial++; flight = undefined; preferences = {}; snapshot = { loading: false, groups: [], errors: [], displayMode: 'usage', timeFormat: 'auto' }; } };
}

export function headerQuotaValue(row: HeaderQuotaRow, mode: 'usage' | 'remaining') {
  const value = mode === 'remaining' ? row.window.remainingPercent : row.window.usedPercent;
  return row.window.valueLabel ?? (value === null ? '—' : `${Math.round(value)}%`);
}

export function headerQuotaReset(window: UsageWindow, timeFormat: 'auto' | '12h' | '24h', now = Date.now(), locale?: string) {
  const fallback = window.resetAfterFormatted || window.resetAtFormatted || '';
  if (!window.resetAt) return fallback;
  const date = new Date(window.resetAt);
  if (!Number.isFinite(date.getTime())) return fallback;
  try {
    const today = date.toDateString() === new Date(now).toDateString();
    return new Intl.DateTimeFormat(locale, { ...(today ? {} : { month: 'short', day: 'numeric', weekday: 'short' }), hour: 'numeric', minute: '2-digit', ...(timeFormat === 'auto' ? {} : { hour12: timeFormat === '12h' }) }).format(date);
  } catch { return fallback; }
}
