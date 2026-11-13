import { queryOptions } from '@tanstack/react-query';
import type { ProviderResult, QuotaProviderId } from '@/types';
import type { HostRuntimeEntry } from '@/lib/remote-projects/registry';
import { captureProjectScope } from '@/lib/api/project-scope';
import { QUOTA_PROVIDERS } from '@/lib/quota';
import { isProviderResult } from '@/lib/queryRuntime';
import type { MagpieSource } from '@/lib/quota/magpieQueries';

const options = <T>(entry: HostRuntimeEntry, resource: string, load: (signal: AbortSignal) => Promise<T>) => queryOptions({
  queryKey: [...entry.queryScope, 'mobile-session-metadata', resource],
  staleTime: 30_000,
  gcTime: Infinity,
  retry: false,
  queryFn: ({ signal }) => load(signal),
});

export function remoteMobileGitOptions(entry: HostRuntimeEntry) {
  const scope = captureProjectScope(entry);
  return options(entry, 'git', async (signal) => {
    const init = { signal, query: { directory: entry.location.directory }, headers: { 'x-opencode-directory': entry.location.directory } };
    const check = await scope.json<{ isGitRepository: boolean }>('/api/git/check', init);
    if (!check.isGitRepository) return { isGitRepository: false, current: null };
    const status = await scope.json<{ current: string | null }>('/api/git/status', { ...init, query: { ...init.query, mode: 'light' } });
    return { isGitRepository: true, current: status.current };
  });
}

export function remoteMobileQuotaSettingsOptions(entry: HostRuntimeEntry) {
  const scope = captureProjectScope(entry);
  return options(entry, 'quota-settings', async (signal) => {
    const data = await scope.json<Record<string, unknown>>('/api/config/settings', { signal });
    const known = QUOTA_PROVIDERS.map((provider) => provider.id);
    const providerIds = Array.isArray(data.usageDropdownProviders)
      ? data.usageDropdownProviders.filter((id): id is QuotaProviderId => typeof id === 'string' && (id.startsWith('magpie:') || known.includes(id as QuotaProviderId)))
      : known;
    const selectedModels: Record<string, string[]> = {};
    if (data.usageSelectedModels && typeof data.usageSelectedModels === 'object') {
      for (const [id, values] of Object.entries(data.usageSelectedModels)) {
        if (Array.isArray(values)) selectedModels[id] = values.filter((value): value is string => typeof value === 'string');
      }
    }
    return { providerIds, selectedModels, displayMode: data.usageDisplayMode === 'remaining' ? 'remaining' as const : 'usage' as const,
      autoRefresh: data.usageAutoRefresh === true,
      refreshIntervalMs: typeof data.usageRefreshIntervalMs === 'number' && Number.isFinite(data.usageRefreshIntervalMs)
        ? Math.max(30_000, Math.min(300_000, Math.round(data.usageRefreshIntervalMs))) : 60_000 };
  });
}

export function remoteMobileQuotaOptions(entry: HostRuntimeEntry, id: QuotaProviderId) {
  const scope = captureProjectScope(entry);
  return options(entry, `quota:${id}`, async (signal) => {
    const result = await scope.json<unknown>(`/api/quota/${encodeURIComponent(id)}`, { signal });
    if (!isProviderResult(result) || result.providerId !== id) throw new Error('Invalid quota response');
    return result;
  });
}

export function remoteMobileMagpieOptions(entry: HostRuntimeEntry) {
  const scope = captureProjectScope(entry);
  return options(entry, 'magpie', async (signal): Promise<ProviderResult[]> => {
    const data = await scope.json<{ sources: MagpieSource[] }>('/api/quota/magpie', { signal, query: { directory: entry.location.directory } });
    if (!Array.isArray(data.sources) || !data.sources.every((source) => source && typeof source.id === 'string' && Array.isArray(source.results)
      && source.results.every((result) => isProviderResult(result) && result.source === 'magpie' && result.sourceId === source.id && result.providerId.startsWith(`magpie:${source.id}:`)))) {
      throw new Error('Invalid Magpie quota response');
    }
    return data.sources.flatMap((source) => source.results);
  });
}
