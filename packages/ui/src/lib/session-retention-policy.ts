/** Framework-neutral policy extracted from useSessionAutoCleanup/globalSessions; no runtime or SDK imports. */
export const RETENTION_MIN_DAYS = 1;
export const RETENTION_MAX_DAYS = 365;
export const RETENTION_DEFAULT_DAYS = 30;
export const RETENTION_KEEP_RECENT = 5;
export const RETENTION_DAY_MS = 24 * 60 * 60 * 1000;

type VisibilitySession = { title?: string; parentID?: string | null; metadata?: Record<string, unknown> | null };
type PolicySession = VisibilitySession & { id: string; share?: unknown; time?: { updated?: number; created?: number } };

const HIDDEN_SESSION_TITLES = new Set(['smartfetch-secondary']);
const BACKGROUND_SESSION_TITLE = /^\[(?:Scheduled|Assistant|yuri-llm)\]/;
const nonEmptySystemID = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/**
 * System sessions are isolated by authoritative Yuri metadata only.
 * Title prefixes are human-facing labels and never participate in this check.
 */
export const isSystemOwnedSession = (session: Pick<VisibilitySession, 'metadata'>): boolean => {
  const metadata = session.metadata;
  if (!metadata || typeof metadata !== 'object') return false;
  const yuri = metadata.yuri;
  if (!yuri || typeof yuri !== 'object') return false;
  const record = yuri as {
    assistant?: { assistantID?: unknown };
    assigned?: { from?: unknown };
    scheduledTask?: { taskID?: unknown };
    smallModel?: { purpose?: unknown };
    llm?: { purpose?: unknown };
  };
  if (record.assigned?.from === 'contact') return false;
  if (nonEmptySystemID(record.assistant?.assistantID)) return true;
  if (nonEmptySystemID(record.scheduledTask?.taskID)) return true;
  if (nonEmptySystemID(record.smallModel?.purpose)) return true;
  if (nonEmptySystemID(record.llm?.purpose)) return true;
  return false;
};

export const isVisibleGlobalSession = (session: VisibilitySession, options: { includeChildren?: boolean } = {}): boolean => {
  if (session.title && HIDDEN_SESSION_TITLES.has(session.title)) return false;
  if (session.title && BACKGROUND_SESSION_TITLE.test(session.title)) return false;
  // Subagent/child sessions never belong in the sidebar root catalog. They
  // load only when the user expands a parent tree node; promoting orphans
  // (parent archived, system-owned, or simply missing from this list) is how
  // scheduled-task subagents used to leak into the project list.
  if (!options.includeChildren && typeof session.parentID === 'string' && session.parentID.trim()) return false;
  return !isSystemOwnedSession(session);
};

const lastActivity = (session: PolicySession): number => session.time?.updated ?? session.time?.created ?? 0;

/** Identical Web selection: recency (not identity), global recent five, current/shared protection, strict cutoff. */
export const buildAutoDeleteCandidates = ({ sessions, currentSessionId, cutoffDays, keepRecent = RETENTION_KEEP_RECENT, now = Date.now() }: {
  sessions: readonly PolicySession[];
  currentSessionId: string | null;
  cutoffDays: number;
  keepRecent?: number;
  now?: number;
}): string[] => {
  if (!Array.isArray(sessions) || cutoffDays <= 0) return [];
  const cutoffTime = now - cutoffDays * RETENTION_DAY_MS;
  const sorted = [...sessions].sort((a, b) => lastActivity(b) - lastActivity(a));
  const protectedIds = new Set(sorted.slice(0, keepRecent).map(session => session.id));
  return sorted.filter(session => {
    if (!session?.id || protectedIds.has(session.id) || session.id === currentSessionId || session.share) return false;
    const activity = lastActivity(session);
    return !!activity && activity < cutoffTime;
  }).map(session => session.id);
};
