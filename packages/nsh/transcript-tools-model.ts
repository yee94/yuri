import { list, record, text, type Row } from './model';
import { projectionToolOutput, projectionToolTime } from '../ui/src/sync/session-tool-content';
import { isToolPartActive } from '../ui/src/components/chat/message/parts/toolRenderUtils';
import {
  isTaskToolName, normalizeTaskToolName, normalizeTaskSummaryEntries,
  prepareTaskOutputForDisplay, readTaskSessionIdFromOutput, readTaskSessionIdFromRecord,
  resolveTaskAgentName,
} from '../ui/src/components/chat/message/parts/taskToolModel';

export type NativeToolFile = { path: string; patch: string; before?: string; after?: string; additions?: number; deletions?: number; status?: 'added' | 'deleted' | 'modified' | 'renamed' };
export type NativeToolField = { key: string; value: string };

/** Same seconds/minutes display as Web ToolPart; absent terminal time is not fabricated. */
export function nativeToolDuration(start: number | undefined, end: number | undefined, now?: number): string {
  if (start === undefined || !Number.isFinite(start)) return '';
  const finish = end ?? now;
  if (finish === undefined || !Number.isFinite(finish)) return '';
  const seconds = Math.max(0, finish - start) / 1000;
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
  return `${(seconds < 0.05 && end !== undefined ? 0.1 : seconds).toFixed(1)}s`;
}

/** Typed leaves preserve unknown plugin inputs without replacing the tool UI with JSON. */
function fields(value: unknown, prefix = ''): NativeToolField[] {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return [{ key: prefix, value: String(value) }];
  if (Array.isArray(value)) return value.flatMap((item, index) => fields(item, `${prefix}[${index}]`));
  return Object.entries(record(value)).flatMap(([key, item]) => fields(item, prefix ? `${prefix}.${key}` : key));
}
function inputFrom(value: unknown): Row {
  if (typeof value !== 'string') return record(value);
  try { return record(JSON.parse(value)); } catch { return {}; }
}
function patchText(value: unknown) { return text(value) || text(record(value).patch); }
function fileStatus(value: unknown): NativeToolFile['status'] {
  return value === 'added' || value === 'deleted' || value === 'modified' || value === 'renamed' ? value : undefined;
}
export function nativeToolDetails(tool: Row) {
  const state = record(tool.state), metadata = record(state.metadata ?? tool.metadata);
  const normalized = normalizeTaskToolName(tool.name || tool.tool);
  const name = normalized === 'patch' ? 'apply_patch' : normalized;
  const input = inputFrom(state.input), output = projectionToolOutput(state) ?? '';
  const clock = tool.time === undefined ? record(state.time) : projectionToolTime(tool.time);
  const task = isTaskToolName(name);
  const sessionID = task ? readTaskSessionIdFromRecord(metadata) ?? readTaskSessionIdFromRecord(state) ?? readTaskSessionIdFromRecord(input) ?? readTaskSessionIdFromRecord(tool.metadata) ?? readTaskSessionIdFromOutput(output) : undefined;
  const fileDiff = record(metadata.filediff);
  const path = text(fileDiff.file) || text(input.path) || text(input.filePath) || text(input.file_path) || text(metadata.filePath) || text(metadata.file_path) || text(metadata.path);
  const files: NativeToolFile[] = list(metadata.files).flatMap(file => {
    const path = text(file.movePath) || text(file.relativePath) || text(file.filePath) || text(file.file);
    const status = fileStatus(file.status);
    return path ? [{ path, patch: patchText(file.patch) || patchText(file.diff), ...(typeof file.before === 'string' ? { before: file.before } : {}), ...(typeof file.after === 'string' ? { after: file.after } : {}), ...(typeof file.additions === 'number' ? { additions: file.additions } : {}), ...(typeof file.deletions === 'number' ? { deletions: file.deletions } : {}), ...(status ? { status } : {}) }] : [];
  });
  if (path && !files.length) {
    const diff = patchText(fileDiff.patch) || patchText(fileDiff.diff) || patchText(metadata.patch) || patchText(metadata.diff);
    const status = fileStatus(fileDiff.status);
    files.push({ path, patch: diff,
      ...(status ? { status } : {}),
      ...(typeof fileDiff.before === 'string' ? { before: fileDiff.before } : name === 'edit' && typeof input.oldString === 'string' ? { before: input.oldString } : {}),
      ...(typeof fileDiff.after === 'string' ? { after: fileDiff.after } : name === 'edit' && typeof input.newString === 'string' ? { after: input.newString } : name === 'write' && typeof input.content === 'string' ? { after: input.content } : {}),
      ...(typeof fileDiff.additions === 'number' ? { additions: fileDiff.additions } : {}), ...(typeof fileDiff.deletions === 'number' ? { deletions: fileDiff.deletions } : {}),
    });
  }
  const todos = ['todowrite', 'todoread'].includes(name) ? list(input.todos ?? metadata.todos) : [];
  return {
    name, task, slim: tool.slim === true, status: text(state.status), title: text(state.title), description: text(input.description) || text(metadata.description) || text(state.title), input, path,
    active: isToolPartActive({ state: { status: state.status, time: clock } }),
    // Preserve raw incomplete streamed input rather than pretending it is parsed.
    streamingInput: typeof state.input === 'string' && !Object.keys(input).length ? state.input : '',
    command: ['shell', 'bash', 'cmd', 'terminal'].includes(name) ? text(input.command) : '',
    fields: fields(input), files, todos, sessionID,
    agent: task ? resolveTaskAgentName(input, metadata, tool.metadata) : undefined,
    summary: task ? normalizeTaskSummaryEntries(metadata.summary ?? metadata.entries ?? metadata.tools ?? metadata.calls) : [],
    output: task ? prepareTaskOutputForDisplay(output) : output,
    error: text(state.error) || text(record(state.error).message),
    start: typeof clock.start === 'number' && Number.isFinite(clock.start) ? clock.start : undefined,
    end: typeof clock.end === 'number' && Number.isFinite(clock.end) ? clock.end : undefined,
  };
}

/** Display-only shortening never changes the source path passed to navigation. */
export function nativeToolDescription(details: ReturnType<typeof nativeToolDetails>, directory: string): string {
  const path = details.path || (details.files.length === 1 ? details.files[0].path : '');
  if (path) {
    const normalized = path.replace(/\\/g, '/'), root = directory.replace(/\\/g, '/').replace(/\/$/, '');
    return normalized === root ? '.' : root && normalized.startsWith(root + '/') ? normalized.slice(root.length + 1) : normalized;
  }
  if (details.command) return details.command.split('\n')[0].slice(0, 100);
  return details.task ? details.description.slice(0, 80) : details.description;
}

export type NativeMultiFileEntry = { path: string; name: string; added: number | null; removed: number | null };

function displayCount(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : null;
}
function combineCount(base: number | null, incoming: number | null): number | null {
  if (base === null) return incoming;
  if (incoming === null) return base;
  return base + incoming;
}

/** Same per-file basename row as Web `getMultiFileDescription`. Empty means the single-line description and total stay. */
export function nativeMultiFileEntries(details: ReturnType<typeof nativeToolDetails>): NativeMultiFileEntry[] {
  if (details.name !== 'apply_patch' || details.files.length <= 1) return [];
  const entries = new Map<string, NativeMultiFileEntry>();
  for (const file of details.files) {
    if (!file.path) continue;
    const added = displayCount(file.additions), removed = displayCount(file.deletions);
    const existing = entries.get(file.path);
    if (existing) {
      existing.added = combineCount(existing.added, added);
      existing.removed = combineCount(existing.removed, removed);
      continue;
    }
    const name = file.path.replace(/\\/g, '/').split('/').pop();
    entries.set(file.path, { path: file.path, name: name || file.path, added, removed });
  }
  return [...entries.values()];
}
