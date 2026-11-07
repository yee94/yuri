import { historySources, type HistorySource, type ImportJob, type ImportScan, type ImportSession, type ImportStates } from '../ui/src/lib/historyImport';
import { settingsObject, settingsRows, type SettingsRequest } from './settings-protocol';
export { historySources, historyPreviewLimit, importJobProgress, isImportJobFinished } from '../ui/src/lib/historyImport';
export type { HistorySource, ImportJob, ImportScan, ImportSession, ImportStates } from '../ui/src/lib/historyImport';

export type NativeImportJob = ImportJob & { dismissed?: boolean };
const fail = (): never => { throw new Error('invalid_import_response'); };
const string = (value: unknown): string => typeof value === 'string' ? value : fail();
const identity = (value: unknown): string => string(value).trim() ? string(value) : fail();
const count = (value: unknown): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fail();
const bool = (value: unknown): boolean => typeof value === 'boolean' ? value : fail();
const member = <T extends string>(value: unknown, choices: readonly T[]): T => choices.find(choice => choice === value) ?? fail();
const optionalString = (row: Record<string, unknown>, key: string) => row[key] === undefined ? {} : { [key]: string(row[key]) };
export const isHistorySource = (value: unknown): value is HistorySource => historySources.some(source => source.id === value);

/** No public runtime parser exists in Web (its query casts JSON). These narrow
 * boundary validators produce the SAME public types, without another protocol. */
export function parseNativeImportJob(value: unknown): NativeImportJob {
  const row = settingsObject(value);
  const progress = row.progress === undefined ? undefined : settingsObject(row.progress);
  const result: NativeImportJob = {
    id: identity(row.id), state: member(row.state, ['running', 'completed', 'partial', 'cancelled', 'interrupted']),
    total: count(row.total), completed: count(row.completed), created: count(row.created),
    results: settingsRows(row.results).map(item => ({
      key: string(item.key), phase: member(item.phase, ['scan', 'validation', 'session', 'settings']),
      status: member(item.status, ['imported', 'skipped', 'failed']),
      ...optionalString(item, 'code'), ...optionalString(item, 'sessionID'), ...optionalString(item, 'directory'), ...optionalString(item, 'target'),
      ...optionalString(item, 'project'), ...optionalString(item, 'index'),
    })),
    ...(row.resumable === undefined ? {} : { resumable: bool(row.resumable) }),
    ...(row.dismissed === undefined ? {} : { dismissed: bool(row.dismissed) }),
    ...(row.failures === undefined ? {} : { failures: count(row.failures) }),
    ...(progress ? { progress: { phase: member(progress.phase, ['scanning', 'validating', 'importing']), completed: count(progress.completed), total: count(progress.total), ...optionalString(progress, 'code') } } : {}),
  };
  return result;
}
export function parseNativeImportJobs(value: unknown): NativeImportJob[] {
  const rows = settingsRows(value).map(parseNativeImportJob);
  if (new Set(rows.map(row => row.id)).size !== rows.length) fail();
  return rows;
}
export function parseNativeImportScan(value: unknown): ImportScan {
  const row = settingsObject(value);
  const sessions: ImportSession[] = settingsRows(row.sessions).map(item => {
    if (!isHistorySource(item.source) || !Array.isArray(item.warnings) || item.warnings.some(warning => typeof warning !== 'string')) fail();
    return { key: identity(item.key), source: member(item.source, historySources.map(source => source.id)), id: identity(item.id), title: string(item.title), directory: string(item.directory), messages: count(item.messages), warnings: item.warnings as string[],
      ...(item.updated === undefined ? {} : { updated: count(item.updated) }), ...optionalString(item, 'excerpt') };
  });
  if (new Set(sessions.map(session => session.key)).size !== sessions.length) fail();
  const installations: NonNullable<ImportScan['installations']> = {}, counts: NonNullable<ImportScan['counts']> = {};
  if (row.installations !== undefined) for (const [source, value] of Object.entries(settingsObject(row.installations))) {
    if (!isHistorySource(source)) fail(); installations[source as HistorySource] = value === null ? null : bool(value);
  }
  if (row.counts !== undefined) for (const [source, value] of Object.entries(settingsObject(row.counts))) {
    if (!isHistorySource(source)) fail(); const entry = settingsObject(value);
    counts[source as HistorySource] = { value: entry.value === null ? null : count(entry.value), approximate: bool(entry.approximate) };
  }
  return { id: identity(row.id), sessions, errors: settingsRows(row.errors).map(item => ({ source: member(item.source, historySources.map(source => source.id)), code: string(item.code), ...optionalString(item, 'file') })),
    ...(row.sampled === undefined ? {} : { sampled: bool(row.sampled) }), installations, counts };
}
export function parseNativeImportStates(value: unknown, scan: ImportScan): ImportStates {
  const row = settingsObject(settingsObject(value).states), states: ImportStates['states'] = {};
  for (const [key, value] of Object.entries(row)) {
    if (!scan.sessions.some(session => session.key === key)) fail();
    states[key] = member(value, ['imported', 'available', 'unknown']);
  }
  return { states };
}
export class NativeHistoryImportError extends Error {
  constructor(readonly code: string, readonly status?: number) { super(code); }
}
export function historyImportError(error: unknown): string {
  const value = error as { code?: unknown; message?: unknown; status?: unknown } | null;
  if (value?.status === 404 || value?.status === 501) return 'history_import_unsupported';
  const code = typeof value?.code === 'string' ? value.code : value?.message;
  return typeof code === 'string' && /^[a-z_]+$/.test(code) ? code : 'import_failed';
}
export const importRoute = (route: string) => `/api/yuri/history-import/${route}`;
export async function readImportReceipt(send: SettingsRequest, id?: string): Promise<NativeImportJob | null> {
  const value = await send(importRoute(id ? `job?id=${encodeURIComponent(id)}` : 'job'));
  if (value === null) return null;
  const job = parseNativeImportJob(value);
  if (id && job.id !== id) fail();
  return job;
}
