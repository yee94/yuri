import { signal } from 'nsh';
import { list, record, request, textOf } from '../core/host';
import { t } from '../core/i18n';

export type Schedule = {
  kind: 'daily' | 'weekly' | 'once' | 'cron';
  times: string[];
  time: string;
  date: string;
  weekdays: number[];
  cron: string;
  timezone: string;
};

export type ScheduledTask = {
  id: string;
  name: string;
  enabled: boolean;
  schedule: Schedule;
  prompt: string;
  providerID: string;
  modelID: string;
  agent: string;
  lastStatus: 'idle' | 'running' | 'success' | 'error';
  lastError: string;
  lastDurationMs: number;
  nextRunAt: number;
  updatedAt: number;
};

export type TaskEntry = { projectId: string; task: ScheduledTask };

export type Run = {
  id: string;
  projectId: string;
  taskId: string;
  taskName: string;
  trigger: 'scheduled' | 'manual';
  status: 'running' | 'success' | 'error';
  sessionId: string | null;
  directory: string | null;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
  durationMs: number | null;
};

export type RunsFilter = { projectId?: string; taskId?: string };

const timePattern = /^([01]\d|2[0-3]):([0-5]\d)$/;

const scheduleOf = (value: unknown): Schedule => {
  const row = record(value);
  const times = Array.isArray(row.times)
    ? row.times.map(textOf).filter((time) => timePattern.test(time))
    : timePattern.test(textOf(row.time))
      ? [textOf(row.time)]
      : [];
  const kind = textOf(row.kind);
  return {
    kind: kind === 'weekly' || kind === 'once' || kind === 'cron' ? kind : 'daily',
    times,
    time: textOf(row.time),
    date: textOf(row.date),
    weekdays: Array.isArray(row.weekdays)
      ? row.weekdays.map((day) => Number(day)).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
      : [],
    cron: textOf(row.cron),
    timezone: textOf(row.timezone),
  };
};

const statusOf = (value: unknown): ScheduledTask['lastStatus'] => {
  const status = textOf(value);
  return status === 'running' || status === 'success' || status === 'error' ? status : 'idle';
};

const parseTask = (value: unknown): ScheduledTask | null => {
  const row = record(value);
  const id = textOf(row.id);
  const state = record(row.state);
  const execution = record(row.execution);
  if (!id) return null;
  return {
    id,
    name: textOf(row.name) || id,
    enabled: row.enabled !== false,
    schedule: scheduleOf(row.schedule),
    prompt: textOf(execution.prompt),
    providerID: textOf(execution.providerID),
    modelID: textOf(execution.modelID),
    agent: textOf(execution.agent),
    lastStatus: statusOf(state.lastStatus),
    lastError: textOf(state.lastError),
    lastDurationMs: Number(state.lastDurationMs) || 0,
    nextRunAt: Number(state.nextRunAt) || 0,
    updatedAt: Number(state.updatedAt) || 0,
  };
};

const parseEntry = (value: unknown): TaskEntry | null => {
  const row = record(value);
  const task = parseTask(row.task);
  const projectId = textOf(row.projectId) || textOf(row.projectID);
  return task && projectId ? { projectId, task } : null;
};

const parseRun = (value: unknown): Run | null => {
  const row = record(value);
  const id = textOf(row.id);
  if (!id) return null;
  const status = textOf(row.status);
  return {
    id,
    projectId: textOf(row.projectId),
    taskId: textOf(row.taskId),
    taskName: textOf(row.taskName) || textOf(row.taskId),
    trigger: textOf(row.trigger) === 'manual' ? 'manual' : 'scheduled',
    status: status === 'running' || status === 'error' ? status : 'success',
    sessionId: textOf(row.sessionId) || null,
    directory: textOf(row.directory) || null,
    error: textOf(row.error) || null,
    startedAt: Number(row.startedAt) || 0,
    finishedAt: typeof row.finishedAt === 'number' ? row.finishedAt : null,
    durationMs: typeof row.durationMs === 'number' ? row.durationMs : null,
  };
};

const state = {
  tasks: signal<TaskEntry[]>([]),
  failedProjects: signal<string[]>([]),
  loading: signal(false),
  error: signal(''),
  loaded: signal(false),
  mutating: signal(''),
  runs: signal<Run[]>([]),
  runsLoading: signal(false),
  runsError: signal(''),
  runsCursor: signal<string | null>(null),
  runsComplete: signal(true),
  runsLoaded: signal(false),
  runsScope: signal(''),
};

export const scheduledTasks = () => state.tasks();
export const scheduledFailedProjects = () => state.failedProjects();
export const scheduledLoading = () => state.loading();
export const scheduledError = () => state.error();
export const scheduledMutating = () => state.mutating();
export const scheduledRuns = () => state.runs();
export const scheduledRunsLoading = () => state.runsLoading();
export const scheduledRunsError = () => state.runsError();
export const scheduledRunsComplete = () => state.runsComplete();

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
export const taskKey = (projectId: string, taskId: string) => `${projectId}:${taskId}`;

export async function loadTasks(force = false): Promise<void> {
  if (!force && state.loaded()) return;
  state.loading.set(true);
  state.error.set('');
  try {
    const value = record(await request('/api/yuri/scheduled-tasks'));
    const tasks = list(value.tasks)
      .map(parseEntry)
      .filter((entry): entry is TaskEntry => !!entry)
      .sort((left, right) => {
        if (left.task.enabled !== right.task.enabled) return left.task.enabled ? -1 : 1;
        return left.task.name.localeCompare(right.task.name);
      });
    state.tasks.set(tasks);
    state.failedProjects.set(
      Array.isArray(value.failedProjectIds) ? value.failedProjectIds.map(textOf).filter(Boolean) : [],
    );
    state.loaded.set(true);
  } catch (error) {
    state.error.set(errorText(error));
  } finally {
    state.loading.set(false);
  }
}

export async function loadRuns(filter: RunsFilter, reset = false): Promise<void> {
  if (state.runsLoading()) return;
  const scope = `${filter.projectId ?? ''}:${filter.taskId ?? ''}`;
  if (state.runsScope() !== scope) {
    reset = true;
    state.runsScope.set(scope);
  }
  if (reset) {
    state.runs.set([]);
    state.runsCursor.set(null);
    state.runsComplete.set(true);
  }
  state.runsLoading.set(true);
  state.runsError.set('');
  try {
    const params = new URLSearchParams({ limit: '20' });
    if (filter.projectId) params.set('projectId', filter.projectId);
    if (filter.taskId) params.set('taskId', filter.taskId);
    const cursor = reset ? null : state.runsCursor();
    if (cursor) params.set('before', cursor);
    const value = record(await request(`/api/yuri/scheduled-task-runs?${params}`));
    const rows = list(value.runs)
      .map(parseRun)
      .filter((run): run is Run => !!run);
    const known = new Set(state.runs().map((run) => run.id));
    state.runs.set([...state.runs(), ...rows.filter((run) => !known.has(run.id))]);
    state.runsCursor.set(textOf(value.nextCursor) || null);
    state.runsComplete.set(value.complete === true || !textOf(value.nextCursor));
    state.runsLoaded.set(true);
  } catch (error) {
    state.runsError.set(errorText(error));
  } finally {
    state.runsLoading.set(false);
  }
}

function replaceProject(projectId: string, tasks: ScheduledTask[]) {
  const kept = state.tasks().filter((entry) => entry.projectId !== projectId);
  state.tasks.set(
    [...kept, ...tasks.map((task) => ({ projectId, task }))].sort((left, right) => {
      if (left.task.enabled !== right.task.enabled) return left.task.enabled ? -1 : 1;
      return left.task.name.localeCompare(right.task.name);
    }),
  );
  state.failedProjects.set(state.failedProjects().filter((id) => id !== projectId));
}

function tasksFrom(value: unknown): ScheduledTask[] {
  return list(record(value).tasks)
    .map(parseTask)
    .filter((task): task is ScheduledTask => !!task);
}

export async function saveTask(projectId: string, draft: Partial<ScheduledTask>): Promise<ScheduledTask[]> {
  const value = await request(`/api/projects/${encodeURIComponent(projectId)}/scheduled-tasks`, 'PUT', { task: draft });
  const tasks = tasksFrom(value);
  replaceProject(projectId, tasks);
  return tasks;
}

export async function deleteTask(projectId: string, taskId: string): Promise<void> {
  const key = taskKey(projectId, taskId);
  state.mutating.set(key);
  try {
    const value = await request(
      `/api/projects/${encodeURIComponent(projectId)}/scheduled-tasks/${encodeURIComponent(taskId)}`,
      'DELETE',
    );
    replaceProject(projectId, tasksFrom(value));
  } finally {
    state.mutating.set('');
  }
}

export async function toggleTask(entry: TaskEntry): Promise<void> {
  const key = taskKey(entry.projectId, entry.task.id);
  state.mutating.set(key);
  try {
    await saveTask(entry.projectId, { ...entry.task, enabled: !entry.task.enabled });
  } finally {
    state.mutating.set('');
  }
}

export async function runTaskNow(entry: TaskEntry): Promise<void> {
  const key = taskKey(entry.projectId, entry.task.id);
  state.mutating.set(key);
  try {
    await request(
      `/api/projects/${encodeURIComponent(entry.projectId)}/scheduled-tasks/${encodeURIComponent(entry.task.id)}/run`,
      'POST',
    );
    await loadTasks(true);
  } finally {
    state.mutating.set('');
  }
}

// --- labels ---

const weekdayKey = (value: number) => {
  switch (value) {
    case 0:
      return t('sessions.scheduledTasks.dialog.schedule.weekdayShort.sun');
    case 1:
      return t('sessions.scheduledTasks.dialog.schedule.weekdayShort.mon');
    case 2:
      return t('sessions.scheduledTasks.dialog.schedule.weekdayShort.tue');
    case 3:
      return t('sessions.scheduledTasks.dialog.schedule.weekdayShort.wed');
    case 4:
      return t('sessions.scheduledTasks.dialog.schedule.weekdayShort.thu');
    case 5:
      return t('sessions.scheduledTasks.dialog.schedule.weekdayShort.fri');
    case 6:
      return t('sessions.scheduledTasks.dialog.schedule.weekdayShort.sat');
    default:
      return t('sessions.scheduledTasks.dialog.schedule.weekdayShort.unknown');
  }
};

/** The card's schedule line; the phone never shows the timezone. */
export function formatSchedule(task: ScheduledTask): string {
  const times = task.schedule.times.join(', ') || task.schedule.time || '--:--';
  if (task.schedule.kind === 'daily') return t('sessions.scheduledTasks.dialog.schedule.daily', { time: times });
  if (task.schedule.kind === 'weekly') {
    const days = task.schedule.weekdays.map(weekdayKey).join(', ');
    return t('sessions.scheduledTasks.dialog.schedule.weekly', { days, time: times });
  }
  if (task.schedule.kind === 'once') {
    return t('sessions.scheduledTasks.dialog.schedule.once', {
      date: task.schedule.date.trim() || t('sessions.scheduledTasks.dialog.schedule.unknownDate'),
      time: task.schedule.time.trim() || '--:--',
    });
  }
  return t('sessions.scheduledTasks.dialog.schedule.cron', { cron: task.schedule.cron });
}

export function formatRelative(value: number): string {
  if (!value || !Number.isFinite(value)) return '';
  const diff = value - Date.now();
  const abs = Math.abs(diff);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const future = diff >= 0;
  if (abs < minute) {
    return future
      ? t('sessions.scheduledTasks.dialog.relativeTime.inLessThanOneMinute')
      : t('sessions.scheduledTasks.dialog.relativeTime.justNow');
  }
  if (abs < hour) {
    const minutes = Math.round(abs / minute);
    return future
      ? t('sessions.scheduledTasks.dialog.relativeTime.inMinutes', { count: minutes })
      : t('sessions.scheduledTasks.dialog.relativeTime.minutesAgo', { count: minutes });
  }
  if (abs < day) {
    const hours = Math.floor(abs / hour);
    const minutes = Math.round((abs % hour) / minute);
    const body = minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
    return future
      ? t('sessions.scheduledTasks.dialog.relativeTime.inDuration', { duration: body })
      : t('sessions.scheduledTasks.dialog.relativeTime.durationAgo', { duration: body });
  }
  const days = Math.floor(abs / day);
  const hours = Math.round((abs % day) / hour);
  const body = hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  return future
    ? t('sessions.scheduledTasks.dialog.relativeTime.inDuration', { duration: body })
    : t('sessions.scheduledTasks.dialog.relativeTime.durationAgo', { duration: body });
}

export function formatRunTime(value: number): string {
  if (!value) return '';
  const date = new Date(value);
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${month}/${day} ${hours}:${minutes}`;
}

export function formatDuration(value: number): string {
  if (!value || value < 0) return '';
  if (value < 60_000) return `${Math.max(1, Math.round(value / 1000))}s`;
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1000);
  if (minutes < 60) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function statusLabel(status: string): string {
  if (status === 'running') return t('sessions.scheduledTasks.dialog.status.running');
  if (status === 'success') return t('sessions.scheduledTasks.dialog.status.success');
  if (status === 'error') return t('sessions.scheduledTasks.dialog.status.error');
  return t('sessions.scheduledTasks.dialog.status.idle');
}
