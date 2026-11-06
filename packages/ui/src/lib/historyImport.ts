export type HistorySource = 'claude' | 'codex' | 'cursor' | 'dsh' | 'opencode';
export const historyPreviewLimit = 5;
export const historySources: { id: HistorySource; name: string }[] = [
  { id: 'claude', name: 'Claude Code' }, { id: 'codex', name: 'Codex' },
  { id: 'cursor', name: 'Cursor' }, { id: 'dsh', name: 'DeepSeek Harness' },
  { id: 'opencode', name: 'OpenCode' },
];
export type ImportSession = {
  key: string; source: HistorySource; id: string; title: string; directory: string;
  messages: number; warnings: string[]; updated?: number; excerpt?: string;
};
export type ImportScan = { id: string; sampled?: boolean; installations?: Partial<Record<HistorySource, boolean | null>>; counts?: Partial<Record<HistorySource, { value: number | null; approximate: boolean }>>; sessions: ImportSession[]; errors: { source: HistorySource; code: string; file?: string }[] };
export type ImportStates = { states: Record<string, 'imported' | 'available' | 'unknown'> };
export type ImportJob = {
  id: string; state: 'running' | 'completed' | 'partial' | 'cancelled' | 'interrupted';
  total: number; completed: number; created: number; resumable?: boolean; failures?: number;
  progress?: { phase: 'scanning' | 'validating' | 'importing'; completed: number; total: number; code?: string };
  results: { key: string; phase: 'scan' | 'validation' | 'session' | 'settings'; status: 'imported' | 'skipped' | 'failed'; code?: string; sessionID?: string; directory?: string; target?: string; project?: string; index?: string }[];
};

export const importJobProgress = (job: ImportJob) => job.progress ?? { phase: 'importing' as const, completed: job.completed, total: job.total };
