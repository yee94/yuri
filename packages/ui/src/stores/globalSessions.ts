import type { OpenCodeClient, Session, SessionInfo } from '@/lib/opencode/v2-types';
import { projectSession } from "@/lib/opencode/v2-types";
import { retry } from "@/sync/retry";
import { stripSessionListDetails } from "@/sync/sanitize";
import { isVisibleGlobalSession } from '@/lib/session-retention-policy';
export { isVisibleGlobalSession, isSystemOwnedSession } from '@/lib/session-retention-policy';

export type GlobalSessionRecord = Session & {
    project?: {
        id: string;
        name?: string;
        worktree?: string;
    } | null;
};

const sessionUpdatedAt = (session: { time?: { updated?: number } }): number => {
    const updated = session.time?.updated;
    return typeof updated === "number" && Number.isFinite(updated) ? updated : 0;
};

/** Positive `time.archived` only — Host unarchive uses 0 which must stay active. */
const isArchivedSession = (session: { time?: { archived?: number } }): boolean => {
    const archived = session.time?.archived;
    return typeof archived === "number" && Number.isFinite(archived) && archived > 0;
};

/** Project a v2 list row and keep a directory fallback for fixture/legacy rows. */
const projectListedSession = (info: SessionInfo & { directory?: string }): GlobalSessionRecord => {
    const projected = projectSession(info);
    return stripSessionListDetails({
        ...projected,
        directory: projected.directory || info.directory,
    }) as GlobalSessionRecord;
};

export async function listGlobalSessionPages(
    apiClient: OpenCodeClient,
    options: {
        directory?: string;
        archived: boolean;
        roots?: boolean;
        /** Include only sessions updated at or after this timestamp. */
        start?: number;
        cursor?: number;
        pageSize: number;
        /** Stop after collecting this many sessions. Omit for a full paginated load. */
        maxItems?: number;
        /** Per-page request budget. The proxy's generic timeout is intentionally much longer. */
        timeoutMs?: number;
        /** Bounded retry budget for this page. Directory cold-start loads use two attempts. */
        retryAttempts?: number;
        signal?: AbortSignal;
        onPage?: (sessions: GlobalSessionRecord[]) => void;
    },
): Promise<GlobalSessionRecord[]> {
    const all: GlobalSessionRecord[] = [];
    const seenIds = new Set<string>();
    const beforeUpdated = options.cursor;
    let v2Cursor: string | undefined;

    while (true) {
        const remaining = options.maxItems === undefined
            ? options.pageSize
            : Math.max(0, options.maxItems - all.length);
        if (remaining === 0) break;
        const requestLimit = Math.min(options.pageSize, remaining);
        const page = await retry(async () => {
            const timeoutSignal = options.timeoutMs === undefined
                ? undefined
                : AbortSignal.timeout(options.timeoutMs);
            const requestSignal = options.signal && timeoutSignal
                ? AbortSignal.any([options.signal, timeoutSignal])
                : options.signal ?? timeoutSignal;
            const result = await apiClient.session.list({
                ...(options.directory ? { directory: options.directory } : {}),
                ...(options.roots === true ? { parentID: null } : {}),
                limit: requestLimit,
                ...(v2Cursor ? { cursor: v2Cursor } : {}),
            }, requestSignal ? { signal: requestSignal } : undefined);
            if (!result || !Array.isArray(result.data)) {
                const error = new Error("session.list returned no data");
                (error as Error & { status?: number }).status = 503;
                throw error;
            }
            return result;
        }, { attempts: options.retryAttempts ?? 3, delay: 500 });

        const raw = page.data.map((session) => projectListedSession(session));

        const payload = raw.filter((session) => {
            if (options.archived ? !isArchivedSession(session) : isArchivedSession(session)) {
                return false;
            }
            if (options.start !== undefined && sessionUpdatedAt(session) < options.start) {
                return false;
            }
            if (beforeUpdated !== undefined && sessionUpdatedAt(session) >= beforeUpdated) {
                return false;
            }
            return isVisibleGlobalSession(session);
        });

        let appended = 0;
        for (const session of payload) {
            if (!session?.id || seenIds.has(session.id)) continue;
            seenIds.add(session.id);
            all.push(session);
            appended += 1;
        }
        if (appended > 0) {
            options.onPage?.(payload);
        }
        if (options.maxItems !== undefined && all.length >= options.maxItems) break;

        // Filtered-empty pages are not exhausted — keep walking the raw cursor.
        const nextCursor = typeof page.cursor?.next === "string" && page.cursor.next.length > 0
            ? page.cursor.next
            : undefined;
        if (!nextCursor || nextCursor === v2Cursor) break;
        v2Cursor = nextCursor;
    }

    return all;
}
