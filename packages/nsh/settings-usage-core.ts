import type { ProviderResult, QuotaProviderId, UsageWindow } from '../ui/src/types/quota';
import { QUOTA_PROVIDERS } from '../ui/src/lib/quota/providers';
import { getAllModelFamilies, getDisplayModelName, getDefaultModels, groupModelsByFamilyWithGetter, sortModelFamilies } from '../ui/src/lib/quota/model-families';
import { createUsageQuotaHelpers } from './settings-usage-quota';
import { createSettingsLaneOwner, scopedSettingsPath, settingsObject, type SettingsRequest, type SettingsRequestLane } from './settings-protocol';
import { defaultUsageSelectedModels, toggleUsageSelectedModel } from '../ui/src/lib/quota/model-selection-core.js';

const valueHelpers = createUsageQuotaHelpers({ t: key => key, formatTimeForPreference: () => '', formatDateTimeForPreference: () => '' });
export function usageAccountRows(result: ProviderResult) {
  const usage = result.usage;
  if (!usage) return [];
  if (usage.accounts) return usage.accounts.map(account => ({ ...account, windows: Object.entries(account.windows), account: true }));
  return Object.keys(usage.windows ?? {}).length ? [{ id: result.providerId, name: '', user: '', plan: '', kind: '', from: '', balance: '', readAt: null, stale: false, error: '', windows: Object.entries(usage.windows), account: false }] : [];
}
export function usageValueLabel(window: UsageWindow, mode: 'usage' | 'remaining' = 'usage'): string {
  const raw = mode === 'remaining' ? window.remainingPercent : window.usedPercent;
  const percent = typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
  return window.disablePace && window.valueLabel && percent !== null
    ? `${valueHelpers.formatQuotaValueLabel(null, percent)} · ${window.valueLabel}`
    : valueHelpers.formatQuotaValueLabel(window.valueLabel, percent);
}
type UsageSettings = Record<string, unknown> & { usageSelectedModels?: Record<string, string[]> };
export function usageModelPatch(settings: UsageSettings, provider: string, model: string, enabled: boolean) {
  return toggleUsageSelectedModel(settings.usageSelectedModels ?? {}, provider, model, enabled);
}
export function usageHeaderProviders(settings: UsageSettings, results: ProviderResult[]): string[] {
  const hidden = Array.isArray(settings.magpieHiddenProviders) ? settings.magpieHiddenProviders : [];
  const saved = Array.isArray(settings.usageDropdownProviders) ? settings.usageDropdownProviders.filter((id): id is string => typeof id === 'string') : QUOTA_PROVIDERS.map(provider => provider.id);
  return [...new Set([...saved.filter(id => !id.startsWith('magpie:')), ...results.filter(result => result.source === 'magpie' && !hidden.includes(result.providerId)).map(result => result.providerId)])];
}
function usageHeaderPatch(settings: UsageSettings, results: ProviderResult[], provider: string, enabled: boolean) {
  const prior = usageHeaderProviders(settings, results), hidden = Array.isArray(settings.magpieHiddenProviders) ? settings.magpieHiddenProviders.filter((id): id is string => typeof id === 'string') : [];
  return { usageDropdownProviders: enabled ? [...new Set([...prior, provider])] : prior.filter(id => id !== provider), ...(provider.startsWith('magpie:') ? { magpieHiddenProviders: enabled ? hidden.filter(id => id !== provider) : [...new Set([...hidden, provider])] } : {}) };
}
export function usageModelGroups(result: ProviderResult) {
  const models = Object.entries(result.usage?.models ?? {}).filter(([, model]) => Object.keys(model.windows).length).map(([id, model]) => ({ id, name: getDisplayModelName(id), windows: Object.entries(model.windows) }));
  const grouped = groupModelsByFamilyWithGetter(models, model => model.id, result.providerId);
  return [...sortModelFamilies(getAllModelFamilies(result.providerId)).map(family => ({ id: family.id, label: family.label, models: grouped.get(family.id) ?? [] })), { id: 'other', label: null, models: grouped.get(null) ?? [] }].filter(group => group.models.length);
}
export function usageModelSelection(settings: UsageSettings, result: ProviderResult): string[] {
  if (Object.prototype.hasOwnProperty.call(settings.usageSelectedModels ?? {}, result.providerId)) return settings.usageSelectedModels?.[result.providerId] ?? [];
  return getDefaultModels(result.providerId, Object.entries(result.usage?.models ?? {}).filter(([, model]) => Object.keys(model.windows).length).map(([id]) => id));
}
function usageSettingsFrom(value: unknown): UsageSettings {
  const settings = settingsObject(value);
  if (settings.usageSelectedModels !== undefined) {
    const selected = settingsObject(settings.usageSelectedModels);
    for (const models of Object.values(selected)) if (!Array.isArray(models) || models.some(model => typeof model !== 'string')) throw new Error('Invalid usage model selections');
  }
  return settings as UsageSettings;
}
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid usage response');
  return value as Record<string, unknown>;
};
export function usageResultFrom(value: unknown, expectedID?: string): ProviderResult {
  const result = object(value);
  if (typeof result.providerId !== 'string' || !result.providerId || expectedID && result.providerId !== expectedID || typeof result.providerName !== 'string' || typeof result.configured !== 'boolean' || typeof result.ok !== 'boolean' || typeof result.fetchedAt !== 'number' || !Number.isFinite(result.fetchedAt)) throw new Error('Invalid usage provider');
  const checkWindows = (value: unknown) => {
    for (const raw of Object.values(object(value))) {
      const window = object(raw);
      for (const field of ['usedPercent', 'remainingPercent', 'windowSeconds', 'resetAfterSeconds', 'resetAt']) if (window[field] !== null && window[field] !== undefined && (typeof window[field] !== 'number' || !Number.isFinite(window[field]))) throw new Error('Invalid quota window');
      for (const field of ['label', 'valueLabel', 'resetAfterFormatted', 'resetAtFormatted']) if (window[field] !== null && window[field] !== undefined && typeof window[field] !== 'string') throw new Error('Invalid quota label');
      if (window.disablePace !== undefined && typeof window.disablePace !== 'boolean') throw new Error('Invalid quota pace flag');
    }
  };
  if (result.usage !== null) {
    const usage = object(result.usage);
    if (usage.windows !== undefined) checkWindows(usage.windows);
    if (usage.accounts !== undefined) {
      if (!Array.isArray(usage.accounts)) throw new Error('Invalid quota accounts');
      for (const value of usage.accounts) {
        const account = object(value);
        if (typeof account.id !== 'string' || !account.id || typeof account.name !== 'string') throw new Error('Invalid quota account');
        for (const field of ['user', 'plan', 'from', 'error']) if (account[field] !== undefined && typeof account[field] !== 'string') throw new Error('Invalid quota account detail');
        if (account.readAt !== null && account.readAt !== undefined && (typeof account.readAt !== 'number' || !Number.isFinite(account.readAt))) throw new Error('Invalid quota read timestamp');
        if (account.stale !== undefined && typeof account.stale !== 'boolean') throw new Error('Invalid quota cache status');
        checkWindows(account.windows);
      }
    }
    if (usage.models !== undefined) for (const model of Object.values(object(usage.models))) checkWindows(object(model).windows);
  }
  return result as unknown as ProviderResult;
}

export type UsageState = {
  settings: UsageSettings | null; results: ProviderResult[]; errors: Record<string, true>;
  refreshing: boolean; writing: boolean; settingsFailed: boolean; preferenceFailed: boolean;
  draft: Record<string, unknown> | null; recovery: boolean;
  now: number; selectedProviderId: QuotaProviderId | null;
  magpieSources: Array<{ id: string; identified: boolean; error: boolean; resultCount: number }>;
};
export type UsagePreferencePatch = { usageAutoRefresh?: boolean; usageRefreshIntervalMs?: number; usageDisplayMode?: 'usage' | 'remaining'; usageShowPredValues?: boolean; magpieUsageUrl?: string };
type UsageIntent = { model: string; provider: QuotaProviderId; enabled: boolean } | { header: QuotaProviderId; enabled: boolean } | { defaults: QuotaProviderId; models: string[] } | { preference: UsagePreferencePatch };
type UsageDependencies = { send: SettingsRequest; current: () => boolean; changed?: (value: UsageState) => void; directory?: string; providers?: readonly QuotaProviderId[]; selectedProviderId?: string | null; defaultsEnabled?: boolean; displayClock?: boolean; onSelectedProvider?: (provider: QuotaProviderId) => void };

export function usageRefreshInterval(settings: UsageSettings | null): number {
  const interval = settings?.usageRefreshIntervalMs;
  return typeof interval === 'number' && Number.isFinite(interval) ? Math.max(30000, Math.min(300000, Math.round(interval))) : 60000;
}
export function usageProviderChoice(prior: string | null, results: ProviderResult[]): QuotaProviderId | null {
  if (prior && (QUOTA_PROVIDERS.some(provider => provider.id === prior) || results.some(result => result.providerId === prior))) return prior as QuotaProviderId;
  return results.length ? results.find(result => result.configured)?.providerId ?? QUOTA_PROVIDERS[0]?.id ?? null : null;
}

/** One page owner. No row owns a request/timer. A write attempt is never replayed by refresh/re-entry. */
export function createSettingsUsage(dependencies: UsageDependencies) {
  const transport = createSettingsLaneOwner(dependencies.send, dependencies.current);
  const lanes = new Map<number, SettingsRequestLane>();
  let resumed = false;
  const request = (token: number, path: string, method?: string, body?: unknown) => {
    const lane = lanes.get(token);
    if (!lane?.current()) return Promise.reject(new Error('settings_operation_stale'));
    return lane.request(path, method, body);
  };
  let state: UsageState = { settings: null, results: [], errors: {}, refreshing: false, writing: false, settingsFailed: false, preferenceFailed: false, draft: null, recovery: false, now: Date.now(), selectedProviderId: usageProviderChoice(dependencies.selectedProviderId ?? null, []), magpieSources: [] };
  let active = false, disposed = false, revision = 0, queued = false, pending: Promise<void> | null = null;
  let intent: UsageIntent | null = null;
  const defaultAttempts = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined, autoKey = '', nextAuto = Infinity, nextClock = Infinity;
  function schedule() {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (!active || disposed || !transport.capture()?.current()) { autoKey = ''; nextAuto = nextClock = Infinity; return; }
    const now = Date.now(), interval = usageRefreshInterval(state.settings), key = `${state.settings?.usageAutoRefresh === true}:${interval}`;
    if (autoKey !== key) { autoKey = key; nextAuto = state.settings?.usageAutoRefresh === true ? now + interval : Infinity; }
    const countdown = dependencies.displayClock !== false && state.results.some(result => usageAccountRows(result).some(account => account.windows.some(([, window]) => window.disablePace && !!window.resetAt)) || Object.values(result.usage?.models ?? {}).some(model => Object.values(model.windows).some(window => window.disablePace && !!window.resetAt)));
    nextClock = countdown ? Number.isFinite(nextClock) ? nextClock : now + 30000 : Infinity;
    const deadline = Math.min(nextClock, nextAuto);
    if (!Number.isFinite(deadline)) return;
    const scheduledRevision = revision, scheduledLane = transport.capture();
    timer = setTimeout(() => {
      if (revision !== scheduledRevision || !scheduledLane?.current() || !active || disposed) return;
      timer = undefined;
      const now = Date.now(), refreshDue = now >= nextAuto;
      if (refreshDue) nextAuto = now + usageRefreshInterval(state.settings);
      if (now >= nextClock) nextClock = now + 30000;
      publish({ now });
      if (refreshDue) void refresh(false);
    }, Math.max(0, deadline - now));
  }
  const publish = (patch: Partial<UsageState>) => { if (disposed || !transport.capture()?.current()) return; state = { ...state, ...patch }; dependencies.changed?.(state); schedule(); };
  const current = (token: number) => !disposed && active && token === revision && lanes.get(token)?.current() === true;
  const readSettings = async (token: number) => {
    const settings = usageSettingsFrom(await request(token, '/api/config/settings'));
    if (!current(token)) return;
    let draft = state.draft;
    if (intent && matches(settings, intent)) { if ('defaults' in intent) defaultAttempts.delete(intent.defaults); draft = null; intent = null; }
    publish({ settings, settingsFailed: false, draft, recovery: false, preferenceFailed: draft !== null });
  };
  const matches = (settings: UsageSettings, desired: UsageIntent) => {
    if ('header' in desired) return usageHeaderProviders(settings, state.results).includes(desired.header) === desired.enabled;
    if ('preference' in desired) return Object.entries(desired.preference).every(([key, value]) => settings[key] === value);
    const provider = 'model' in desired ? desired.provider : desired.defaults;
    const requested = (state.draft?.usageSelectedModels as Record<string, string[]> | undefined)?.[provider];
    const confirmed = settings.usageSelectedModels?.[provider];
    // Absence is not a durable empty selection: Web reapplies defaults on the next open.
    return !!requested && !!confirmed && requested.length === confirmed.length && requested.every((id, index) => id === confirmed[index]);
  };
  const start = (work: (token: number) => Promise<void>) => {
    const token = revision;
    const lane = transport.capture(); if (!lane) return Promise.resolve(); lanes.set(token, lane);
    let flight!: Promise<void>;
    flight = (async () => { try { await work(token); } finally { const own = pending === flight, valid = current(token); if (lanes.get(token) === lane && (own || token !== revision)) lanes.delete(token); if (own) { pending = null; if (valid) publish({ refreshing: false, writing: false }); if (queued && active && !disposed && transport.capture()?.current()) { queued = false; void refresh(); } } } })();
    pending = flight;
    return pending;
  };
  async function readMagpie(token: number) {
    const prior = state.results, builtins = prior.filter(result => result.source !== 'magpie');
    try {
      const aggregate = object(await request(token, scopedSettingsPath('/api/quota/magpie?refresh=1', dependencies.directory)));
      if (!Array.isArray(aggregate.sources)) throw new Error('Invalid Magpie sources');
      let incomplete = aggregate.incomplete === true;
      const sources: Array<{ id: string; identified: boolean; error: boolean; clearPrevious: boolean; malformed: boolean; results: ProviderResult[] }> = [];
      for (const value of aggregate.sources) {
        let source: Record<string, unknown>;
        try { source = object(value); if (typeof source.id !== 'string' || !source.id) throw new Error('Invalid Magpie source identity'); }
        catch { incomplete = true; continue; }
        const projected = { id: String(source.id), identified: source.identified === true, error: !!source.error, clearPrevious: source.clearPrevious === true, malformed: !Array.isArray(source.results), results: [] as ProviderResult[] };
        if (Array.isArray(source.results)) for (const value of source.results) {
          try { const result = usageResultFrom(value); if (result.source !== 'magpie' || result.sourceId !== source.id || !result.providerId.startsWith('magpie:')) throw new Error('Invalid Magpie identity'); projected.results.push(result); }
          catch { projected.malformed = true; }
        }
        projected.error ||= projected.malformed; sources.push(projected);
      }
      if (!current(token)) return;
      const incoming: ProviderResult[] = [], nextErrors = Object.fromEntries(Object.entries(state.errors).filter(([id]) => QUOTA_PROVIDERS.some(provider => provider.id === id)));
      for (const source of sources) {
        if (source.error && !source.clearPrevious && (!source.results.length || source.malformed)) {
          nextErrors[source.id] = true;
          const retained = prior.filter(result => result.sourceId === source.id);
          for (const result of source.results) { const index = retained.findIndex(prior => prior.providerId === result.providerId); if (index < 0) retained.push(result); else retained[index] = result; }
          incoming.push(...retained);
        }
        else { if (source.error) nextErrors[source.id] = true; incoming.push(...source.results); }
      }
      if (incomplete) for (const result of prior.filter(result => result.source === 'magpie' && !sources.some(source => source.id === result.sourceId))) { incoming.push(result); nextErrors[result.sourceId ?? 'magpie'] = true; }
      if (incomplete && aggregate.incomplete !== true) nextErrors.magpie = true;
      publish({ results: [...builtins, ...incoming], errors: nextErrors, magpieSources: sources.map(source => ({ id: source.id, identified: source.identified, error: source.error, resultCount: source.results.length })) });
    } catch { if (current(token)) publish({ errors: { ...state.errors, magpie: true } }); }
  }
  async function refresh(reloadSettings = true) {
    if (!active || disposed || !transport.capture()?.current()) return;
    if (pending) return pending;
    return start(async token => {
      publish({ refreshing: true });
      if (reloadSettings || state.recovery || state.draft) { try { await readSettings(token); } catch { if (current(token)) publish({ settingsFailed: true }); } }
      if (!current(token)) return;
      const ids = dependencies.providers ?? QUOTA_PROVIDERS.map(provider => provider.id);
      const outcomes = new Map<string, ProviderResult>(), errors = { ...state.errors };
      const publishProviders = () => {
        if (!current(token)) return;
        const prior = state.results;
        publish({ results: [...ids.flatMap(id => { const result = outcomes.get(id) ?? prior.find(result => result.providerId === id); return result ? [result] : []; }), ...prior.filter(result => result.source === 'magpie')], errors: { ...errors } });
      };
      let index = 0;
      // At most four read requests in flight; one failed provider cannot erase its previous snapshot.
      await Promise.all(Array.from({ length: Math.min(4, ids.length) }, async () => {
        while (index < ids.length && current(token)) {
          const id = ids[index++];
          try { outcomes.set(id, usageResultFrom(await request(token, `/api/quota/${encodeURIComponent(id)}`), id)); delete errors[id]; }
          catch { errors[id] = true; }
          publishProviders();
        }
      }));
      if (!current(token)) return;
      const prior = state.results;
      const builtins = ids.flatMap(id => { const result = outcomes.get(id) ?? prior.find(result => result.providerId === id); return result ? [result] : []; });
      publish({ results: [...builtins, ...prior.filter(result => result.source === 'magpie')], errors });
      await readMagpie(token);
      if (!current(token)) return;
      const selected = usageProviderChoice(state.selectedProviderId ?? dependencies.selectedProviderId ?? null, state.results);
      if (selected !== state.selectedProviderId) publish({ selectedProviderId: selected });
      if (selected) dependencies.onSelectedProvider?.(selected);
      const result = state.results.find(result => result.providerId === selected);
      if (!resumed && dependencies.defaultsEnabled && state.settings && !state.settingsFailed && !state.draft && !intent && result?.ok && !state.errors[result.providerId] && !state.errors[result.sourceId ?? result.providerId] && !defaultAttempts.has(result.providerId)) {
        const models = Object.entries(result.usage?.models ?? {}).filter(([, model]) => Object.keys(model.windows).length).map(([id]) => id);
        const patch = defaultUsageSelectedModels(state.settings.usageSelectedModels ?? {}, result.providerId, getDefaultModels(result.providerId, models));
        if (patch) { defaultAttempts.add(result.providerId); await commit({ defaults: result.providerId, models }, token); }
      }
    });
  }
  function patchFor(settings: UsageSettings, desired: UsageIntent): Record<string, unknown> | null {
    if ('defaults' in desired) return defaultUsageSelectedModels(settings.usageSelectedModels ?? {}, desired.defaults, getDefaultModels(desired.defaults, desired.models));
    if ('preference' in desired) return desired.preference;
    if ('header' in desired) return usageHeaderPatch(settings, state.results, desired.header, desired.enabled);
    return usageModelPatch({ ...settings, usageSelectedModels: { ...settings.usageSelectedModels, [desired.provider]: settings.usageSelectedModels?.[desired.provider] ?? usageModelSelection(settings, state.results.find(result => result.providerId === desired.provider)!) } }, desired.provider, desired.model, desired.enabled);
  }
  async function commit(desired: UsageIntent, token: number) {
    if (!state.settings || !current(token)) return;
    intent = desired;
    publish({ draft: patchFor(state.settings, desired), writing: true, preferenceFailed: false });
    let attempted = false, readAttempted = false;
    try {
      const fresh = usageSettingsFrom(await request(token, '/api/config/settings'));
      if (!current(token)) return;
      const patch = patchFor(fresh, desired);
      if (!patch) { if ('defaults' in desired) defaultAttempts.delete(desired.defaults); intent = null; publish({ settings: fresh, draft: null }); return; }
      publish({ draft: patch, recovery: true });
      attempted = true;
      settingsObject(await request(token, '/api/config/settings', 'PUT', patch));
      if (!current(token)) return;
      readAttempted = true;
      await readSettings(token);
    } catch {
      if (!current(token)) return;
      // An ambiguous transport/ACK failure permits GET reconciliation only.
      if (attempted && !readAttempted) { try { await readSettings(token); } catch { if (current(token)) publish({ recovery: true }); } }
      if (intent && current(token)) publish({ preferenceFailed: true });
    }
    if (current(token) && !state.draft && 'preference' in desired && desired.preference.magpieUsageUrl !== undefined) {
      publish({ results: state.results.filter(result => result.source !== 'magpie'), magpieSources: [] });
      await readMagpie(token);
    }
  }
  async function write(desired: UsageIntent) {
    if (!active || disposed || !transport.capture()?.current() || pending || !state.settings || state.recovery) return;
    return start(token => commit(desired, token));
  }
  return {
    replaceLane(next: SettingsRequestLane | null) {
      transport.replaceLane(next); resumed = true; revision++; active = false; queued = false; pending = null;
      state = { ...state, refreshing: false, writing: false }; dependencies.changed?.(state); schedule();
    },
    state: () => state, refresh,
    setActive(next: boolean) { if (disposed || active === next) return; active = next; revision++; if (active) publish({ now: Date.now() }); else schedule(); if (!active) { queued = false; return; } if (pending) queued = true; else void refresh(); },
    selectProvider(provider: QuotaProviderId) { if (!QUOTA_PROVIDERS.some(item => item.id === provider) && !state.results.some(result => result.providerId === provider)) return; publish({ selectedProviderId: provider }); dependencies.onSelectedProvider?.(provider); },
    selectModel(provider: QuotaProviderId, model: string, enabled: boolean) { const result = state.results.find(result => result.providerId === provider); if (!result || !Object.prototype.hasOwnProperty.call(result.usage?.models ?? {}, model)) return Promise.resolve(); return write({ provider, model, enabled }); },
    selectHeader(header: QuotaProviderId, enabled: boolean) { if (!state.results.some(result => result.providerId === header)) return Promise.resolve(); return write({ header, enabled }); },
    setPreference(patch: UsagePreferencePatch) {
      if (!Object.keys(patch).length || Object.entries(patch).some(([key, value]) => !['usageAutoRefresh', 'usageRefreshIntervalMs', 'usageDisplayMode', 'usageShowPredValues', 'magpieUsageUrl'].includes(key) || ['usageAutoRefresh', 'usageShowPredValues'].includes(key) && typeof value !== 'boolean' || key === 'usageRefreshIntervalMs' && (typeof value !== 'number' || !Number.isFinite(value)) || key === 'usageDisplayMode' && value !== 'usage' && value !== 'remaining' || key === 'magpieUsageUrl' && typeof value !== 'string')) return Promise.resolve();
      const normalized = { ...patch, ...(patch.usageRefreshIntervalMs !== undefined ? { usageRefreshIntervalMs: usageRefreshInterval(patch) } : {}), ...(patch.magpieUsageUrl !== undefined ? { magpieUsageUrl: patch.magpieUsageUrl.trim() } : {}) };
      if (normalized.magpieUsageUrl) {
        try { const url = new URL(normalized.magpieUsageUrl); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid Magpie URL'); }
        catch { publish({ draft: normalized, preferenceFailed: true }); return Promise.resolve(); }
      }
      return write({ preference: normalized });
    },
    dispose() { disposed = true; active = false; queued = false; revision++; schedule(); },
  };
}
