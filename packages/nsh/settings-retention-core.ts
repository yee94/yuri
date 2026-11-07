import { buildAutoDeleteCandidates, isVisibleGlobalSession, RETENTION_MAX_DAYS, RETENTION_MIN_DAYS } from '../ui/src/lib/session-retention-policy';
/** Native SDK-gap snapshot checks; selection/visibility policy is shared with Web, not atomic mutation admission. */
export type RetentionRequest = (path: string, method?: string, body?: unknown) => Promise<unknown>;
type ObjectValue = Record<string, unknown>;
export const retentionObject = (value: unknown): ObjectValue => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid-response');
  const object = value as ObjectValue;
  if (object.ok === false || object.success === false || object.partial === true || object.failed === true || object.error || (Array.isArray(object.errors) && object.errors.length)) throw new Error('incomplete-response');
  return object;
};
const nested = (value: unknown): ObjectValue => value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {};
export type RetentionSession = { id: string; directory: string; title: string; parentID?: string; metadata: ObjectValue; time: { created?: number; updated?: number; archived?: number }; share?: unknown };
export type RetentionAction = 'archive' | 'delete';
export function retentionSession(value: unknown): RetentionSession {
  const item = retentionObject(value), location = nested(item.location), time = retentionObject(item.time);
  const directory = location.directory ?? item.directory;
  if (typeof item.id !== 'string' || !item.id.trim() || typeof directory !== 'string' || !directory.trim() || typeof item.title !== 'string') throw new Error('invalid-session');
  if (item.parentID != null && typeof item.parentID !== 'string') throw new Error('invalid-session');
  for (const key of ['created', 'updated', 'archived']) if (time[key] != null && (typeof time[key] !== 'number' || !Number.isFinite(time[key]) || Number(time[key]) < 0)) throw new Error('invalid-session');
  if (item.metadata != null) retentionObject(item.metadata);
  return { id: item.id, directory, title: item.title, parentID: typeof item.parentID === 'string' ? item.parentID : undefined, metadata: nested(item.metadata), time, share: item.share };
}
export async function scanRetentionCatalog(send: RetentionRequest, current: () => boolean = () => true): Promise<RetentionSession[]> {
  const all = new Map<string, RetentionSession>(), cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    if (!current()) throw new Error('inactive');
    const page = retentionObject(await send(`/api/session?limit=500${cursor === undefined ? '' : `&cursor=${encodeURIComponent(cursor)}`}`));
    if (!current()) throw new Error('inactive');
    // Only the v2 cursor envelope proves exhaustion. Legacy arrays and bounded indexes do not.
    const pagination = retentionObject(page.cursor);
    if (!Array.isArray(page.data)) throw new Error('invalid-catalog');
    for (const value of page.data) {
      const item = retentionSession(value);
      if (all.has(item.id)) throw new Error('changing-catalog');
      all.set(item.id, item);
    }
    if (pagination.next != null && (typeof pagination.next !== 'string' || !pagination.next.length)) throw new Error('invalid-cursor');
    cursor = typeof pagination.next === 'string' ? pagination.next : undefined;
    if (cursor !== undefined) {
      if (cursors.has(cursor)) throw new Error('repeating-cursor');
      cursors.add(cursor);
    }
  } while (cursor !== undefined);
  return [...all.values()];
}
function retentionVisible(item: RetentionSession) {
  return (item.time.archived ?? 0) <= 0 && isVisibleGlobalSession(item);
}
export function retentionCandidates(catalog: readonly RetentionSession[], options: { days: number; now: number; action: RetentionAction; protectedIDs: ReadonlySet<string>; activeIDs: ReadonlySet<string> }): RetentionSession[] {
  if (!Number.isFinite(options.days) || options.days < RETENTION_MIN_DAYS || options.days > RETENTION_MAX_DAYS) throw new Error('invalid-days');
  const visible = catalog.filter(retentionVisible);
  const candidates = buildAutoDeleteCandidates({ sessions: visible, currentSessionId: null, cutoffDays: options.days, now: options.now });
  const protectedIDs = new Set([...options.protectedIDs, ...options.activeIDs]);
  const byID = new Map(catalog.map(item => [item.id, item]));
  // Running descendants protect every ancestor. Delete must not cascade into any child at all.
  if (options.action === 'delete') for (const item of catalog) if (item.parentID) protectedIDs.add(item.parentID);
  for (const id of [...protectedIDs]) {
    const visited = new Set<string>();
    let parent = byID.get(id)?.parentID;
    while (parent && !visited.has(parent)) { visited.add(parent); protectedIDs.add(parent); parent = byID.get(parent)?.parentID; }
  }
  return candidates.filter(id => !protectedIDs.has(id)).map(id => byID.get(id)!);
}
export function retentionActive(value: unknown): Set<string> {
  const envelope = retentionObject(value), entries = envelope.data === undefined ? envelope : retentionObject(envelope.data);
  const result = new Set<string>();
  for (const [id, entry] of Object.entries(entries)) {
    if (retentionObject(entry).type !== 'running') throw new Error('invalid-active');
    result.add(id);
  }
  return result;
}

/** Snapshot-only eligibility check; cannot authorize a mutation across other clients' concurrent writes. */
export function createRetentionRecheck(catalog: readonly RetentionSession[], options: { action: RetentionAction; days: number; now: number }) {
  const byID = new Map(catalog.map(item => [item.id, item]));
  const candidates = new Set(retentionCandidates(catalog, { ...options, activeIDs: new Set(), protectedIDs: new Set() }).map(item => item.id));
  return (fresh: RetentionSession, live: { activeIDs: ReadonlySet<string>; protectedIDs: ReadonlySet<string>; now: number }) => {
    if (!candidates.has(fresh.id) || byID.get(fresh.id)?.directory !== fresh.directory || !retentionVisible(fresh)) return false;
    if ([...live.activeIDs].some(id => !byID.has(id))) throw new Error('changing-catalog');
    const protectedIDs = new Set([...live.activeIDs, ...live.protectedIDs]);
    for (const id of [...protectedIDs]) {
      let parent = byID.get(id)?.parentID;
      const visited = new Set<string>();
      while (parent && !visited.has(parent)) { visited.add(parent); protectedIDs.add(parent); parent = byID.get(parent)?.parentID; }
    }
    if (protectedIDs.has(fresh.id)) return false;
    return buildAutoDeleteCandidates({ sessions: [fresh], keepRecent: 0, currentSessionId: null, cutoffDays: options.days, now: live.now }).length === 1;
  };
}
