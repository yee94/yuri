import { useQuery } from '@tanstack/react-query';
import { queryClient } from '@/lib/queryRuntime';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeGeneration, getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import { historyPreviewLimit, historySources, isImportJobFinished, type HistorySource, type ImportJob, type ImportScan, type ImportStates } from '@/lib/historyImport';

const request = async <T>(route: string, body: unknown, signal: AbortSignal, transport: string): Promise<T> => {
  const generation = getRuntimeGeneration();
  if (transport !== getRuntimeTransportIdentity()) throw new Error('runtime_changed');
  const response = await runtimeFetch(`/api/yuri/history-import/${route}`, {
    ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), signal,
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(response.status === 404 || response.status === 501 ? 'history_import_unsupported' : error.code ?? 'import_failed');
  }
  const result = await response.json();
  if (transport !== getRuntimeTransportIdentity() || generation !== getRuntimeGeneration()) throw new Error('runtime_changed');
  return result as T;
};
export const importJobQueryOptions = (transport = getRuntimeTransportIdentity()) => ({
  queryKey: [transport, 'history-import', 'job'] as const,
  queryFn: ({ signal }: { signal: AbortSignal }) => request<ImportJob | null>('job', undefined, signal, transport),
  staleTime: 0, retry: 1,
  refetchInterval: (query: { state: { data: ImportJob | null | undefined } }) => query.state.data?.state === 'running' ? 1000 : false as const,
});
export const useImportJobQuery = (enabled = true) => useQuery({ ...importJobQueryOptions(), enabled });
export const importJobsQueryOptions = (transport = getRuntimeTransportIdentity()) => ({
  queryKey: [transport, 'history-import', 'jobs'] as const,
  queryFn: ({ signal }: { signal: AbortSignal }) => request<ImportJob[]>('jobs', undefined, signal, transport),
  staleTime: 0, retry: false as const,
});
function cacheImportJob(result: ImportJob, transport: string) {
  queryClient.setQueryData(importJobQueryOptions(transport).queryKey, result);
  queryClient.setQueryData<ImportJob[]>(importJobsQueryOptions(transport).queryKey, (previous) => {
    if (isImportJobFinished(result)) return previous?.filter((job) => job.id !== result.id);
    return previous?.some((job) => job.id === result.id)
      ? previous.map((job) => job.id === result.id ? result : job) : [...(previous ?? []), result];
  });
}
export const scanImportSources = (input: { sources: HistorySource[]; roots?: { source: HistorySource; path: string }[]; limitPerSource?: number; includeCounts?: boolean }, signal: AbortSignal, transport: string) =>
  request<ImportScan>('scan', input, signal, transport);
export const importSourcesQueryOptions = (transport = getRuntimeTransportIdentity()) => ({
  queryKey: [transport, 'history-import', 'sources', 'sample', historyPreviewLimit, 'counts'] as const,
  queryFn: ({ signal }: { signal: AbortSignal }) => scanImportSources({ sources: historySources.map((source) => source.id), limitPerSource: historyPreviewLimit, includeCounts: true }, signal, transport),
  staleTime: 60_000, gcTime: 5 * 60_000, retry: false as const, refetchOnWindowFocus: false,
});
export const useImportSourcesQuery = (enabled: boolean) => useQuery({ ...importSourcesQueryOptions(), enabled });
export const importStatesQueryOptions = (scanID: string | undefined, directory: string | null, revision: string, transport = getRuntimeTransportIdentity()) => ({
  queryKey: [transport, 'history-import', 'imported', scanID, directory, revision] as const,
  queryFn: ({ signal }: { signal: AbortSignal }) => request<ImportStates>('imported', { scanID, directory }, signal, transport),
  staleTime: 60_000, gcTime: 5 * 60_000, retry: false as const, refetchOnWindowFocus: false,
});
export const useImportStatesQuery = (scanID: string | undefined, directory: string | null, revision: string, enabled: boolean) =>
  useQuery({ ...importStatesQueryOptions(scanID, directory, revision), enabled: Boolean(scanID) && enabled });
export async function startSourceImport(sources: HistorySource[], directory: string | null, signal: AbortSignal, transport: string, generation: number) {
  if (generation !== getRuntimeGeneration()) throw new Error('runtime_changed');
  const result = await request<ImportJob>('start', { sources, directory, confirm: true }, signal, transport);
  if (generation !== getRuntimeGeneration()) throw new Error('runtime_changed');
  cacheImportJob(result, transport);
  return result;
}
export const cancelImport = (id: string, signal: AbortSignal, transport: string) => request<ImportJob>('cancel', { id }, signal, transport);
export async function resumeImport(id: string, transport: string, generation: number) {
  if (generation !== getRuntimeGeneration()) throw new Error('runtime_changed');
  const result = await request<ImportJob>('resume', { id, confirm: true }, new AbortController().signal, transport);
  if (generation !== getRuntimeGeneration()) throw new Error('runtime_changed');
  cacheImportJob(result, transport);
  return result;
}
export async function dismissImport(id: string, transport: string, generation: number) {
  if (generation !== getRuntimeGeneration()) throw new Error('runtime_changed');
  const result = await request<{ id: string }>('dismiss', { id }, new AbortController().signal, transport);
  await Promise.all([
    queryClient.cancelQueries({ queryKey: importJobsQueryOptions(transport).queryKey, exact: true }),
    queryClient.cancelQueries({ queryKey: importJobQueryOptions(transport).queryKey, exact: true }),
  ]);
  if (generation !== getRuntimeGeneration()) throw new Error('runtime_changed');
  queryClient.setQueryData<ImportJob[]>(importJobsQueryOptions(transport).queryKey, (previous) => previous?.filter((job) => job.id !== result.id));
  queryClient.setQueryData<ImportJob | null>(importJobQueryOptions(transport).queryKey, (previous) => previous?.id === result.id ? null : previous);
  return result;
}
