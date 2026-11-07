import { record, rowsFrom, text, type RuntimeEvent } from './model';

type Domain = 'questions' | 'permissions';
export type ProjectsBlockingDomain = {
  known: boolean;
  unknownSessions: ReadonlySet<string>;
  bySession: Readonly<Record<string, readonly string[]>>;
};
type ProjectsBlockingDirectory = Record<Domain, ProjectsBlockingDomain>;
export type ProjectsBlockingSnapshot = Readonly<Record<string, ProjectsBlockingDirectory>>;
export type ProjectsAttentionRequest = (path: string) => Promise<unknown>;
const unknownDomain: ProjectsBlockingDomain = { known: false, unknownSessions: new Set(), bySession: {} };
const emptyDirectory: ProjectsBlockingDirectory = { questions: unknownDomain, permissions: unknownDomain };
const domains: Domain[] = ['questions', 'permissions'];
const projectsAttentionDirectory = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '') || '/';
const blockingEvents = new Set(['form.created', 'form.replied', 'form.cancelled', 'question.asked', 'question.replied', 'question.rejected', 'permission.asked', 'permission.replied', 'session.moved', 'location.shutdown', 'server.instance.disposed']);
export const isProjectsBlockingEvent = (event: RuntimeEvent) => event.key === 'global' && blockingEvents.has(event.type);
export const isProjectsBlockingRefreshEvent = (event: RuntimeEvent) => event.key === 'global' && ['reconnected', 'server.connected', 'global.disposed'].includes(event.type);
export const projectsBlockingSessionID = (event: RuntimeEvent) => text(record(event.body.form ?? event.body).sessionID) || text(record(event.body.form ?? event.body).sessionId);

export function readProjectsBlocking(snapshot: ProjectsBlockingSnapshot, directory: string, sessionID: string) {
  const value = snapshot[projectsAttentionDirectory(directory)] ?? emptyDirectory;
  return {
    hasPendingQuestion: (value.questions.bySession[sessionID]?.length ?? 0) > 0,
    hasPendingPermission: (value.permissions.bySession[sessionID]?.length ?? 0) > 0,
    questionsKnown: value.questions.known && !value.questions.unknownSessions.has(sessionID),
    permissionsKnown: value.permissions.known && !value.permissions.unknownSessions.has(sessionID),
  };
}

/** Location-level authority, independent of the bounded session catalog and viewed/unread state. */
export function createProjectsBlocking(changed: (snapshot: ProjectsBlockingSnapshot) => void) {
  let snapshot: ProjectsBlockingSnapshot = {}, revision = 0, epoch = 0;
  let flight: Promise<void> | undefined, again = false;
  const touched = new Map<string, number>(), sessionDirectories = new Map<string, string>();
  const moveRevisions = new Map<string, number>(), directoryClocks = new Map<string, number>(), shutdownClocks = new Map<string, number>();
  const eventClocks = new Map<string, number>();
  const seenEvents = new Set<string>();
  const resolvedRequests = new Set<string>();
  const requestChanges = new Map<string, Map<string, { sessionID: string; id: string; pending: boolean; revision: number }>>();
  const stamp = (directory: string, domain: Domain, sessionID: string) => JSON.stringify([directory, domain, sessionID]);
  const publish = (next: ProjectsBlockingSnapshot) => { if (next !== snapshot) { snapshot = next; changed(next); } };
  function put(directory: string, domain: Domain, value: ProjectsBlockingDomain) {
    const old = snapshot[directory] ?? emptyDirectory;
    if (value === old[domain]) return;
    publish({ ...snapshot, [directory]: { ...old, [domain]: value } });
  }
  function touch(directory: string, domain: Domain, sessionID: string) { touched.set(stamp(directory, domain, sessionID), ++revision); }
  function invalidateDirectory(directory: string) {
    for (const domain of domains) touch(directory, domain, '*');
  }
  function removeDirectory(directory: string) {
    invalidateDirectory(directory);
    if (!snapshot[directory]) return;
    const next = { ...snapshot }; delete next[directory]; publish(next);
  }
  function moveSession(sessionID: string, destination: string) {
    sessionDirectories.set(sessionID, destination);
    moveRevisions.set(sessionID, ++revision);
    for (const [directory, bucket] of Object.entries(snapshot)) {
      if (directory === destination) continue;
      for (const domain of domains) {
        // This fence also rejects an old in-flight read that has not seen the session yet.
        touch(directory, domain, sessionID);
        const ids = bucket[domain].bySession[sessionID];
        if (!ids) continue;
        const bySession = { ...bucket[domain].bySession }; delete bySession[sessionID];
        put(directory, domain, { ...bucket[domain], bySession });
        const target = snapshot[destination]?.[domain] ?? unknownDomain;
        put(destination, domain, { ...target, bySession: { ...target.bySession, [sessionID]: [...new Set([...(target.bySession[sessionID] ?? []), ...ids])] } });
        touch(destination, domain, sessionID);
      }
    }
  }
  function accept(event: RuntimeEvent, knownDirectory?: string) {
    if (!isProjectsBlockingEvent(event)) return;
    if (event.id && seenEvents.has(event.id)) return;
    const remember = () => { if (event.id) { seenEvents.add(event.id); if (seenEvents.size > 1000) seenEvents.delete(seenEvents.values().next().value!); } };
    const body = record(event.body.form ?? event.body);
    const sessionID = text(body.sessionID) || text(body.sessionId);
    if (event.type === 'session.moved') {
      const destination = text(record(event.body.location).directory);
      const oldClock = eventClocks.get(`move:${sessionID}`);
      if (event.created !== undefined && oldClock !== undefined && event.created <= oldClock) return;
      if (sessionID && destination) {
        remember();
        if (event.created !== undefined) eventClocks.set(`move:${sessionID}`, event.created);
        moveSession(sessionID, projectsAttentionDirectory(destination));
      }
      return;
    }
    const rawDirectory = event.directory || text(body.directory) || knownDirectory;
    if (!rawDirectory) return;
    const directory = projectsAttentionDirectory(rawDirectory);
    if (['location.shutdown', 'server.instance.disposed'].includes(event.type)) {
      if (event.created !== undefined && event.created < (directoryClocks.get(directory) ?? -Infinity)) return;
      remember();
      if (event.created !== undefined) shutdownClocks.set(directory, event.created);
      removeDirectory(directory); return;
    }
    if (!sessionID || directory !== (sessionDirectories.get(sessionID) ?? (knownDirectory ? projectsAttentionDirectory(knownDirectory) : directory))) return;
    if (event.created !== undefined && event.created <= (shutdownClocks.get(directory) ?? -Infinity)) return;
    const domain: Domain = event.type.startsWith('permission.') ? 'permissions' : 'questions';
    const created = ['form.created', 'question.asked', 'permission.asked'].includes(event.type);
    const id = created ? text(body.id) : text(body.requestID) || text(body.id);
    if (!id) return;
    if (event.type === 'form.created' && record(body.metadata).kind !== 'question') return;
    const requestKey = JSON.stringify([domain, sessionID, id]);
    if (created && resolvedRequests.has(requestKey)) return;
    const clockKey = JSON.stringify([directory, domain, sessionID, id]), oldClock = eventClocks.get(clockKey);
    if (event.created !== undefined && oldClock !== undefined && event.created < oldClock) return;
    if (event.created !== undefined) eventClocks.set(clockKey, event.created);
    if (event.created !== undefined) directoryClocks.set(directory, Math.max(event.created, directoryClocks.get(directory) ?? -Infinity));
    const changesKey = JSON.stringify([directory, domain]), changes = requestChanges.get(changesKey) ?? new Map();
    // Request IDs are unique. An out-of-order creation cannot resurrect a resolved request.
    if (created && changes.get(clockKey)?.pending === false) return;
    remember();
    if (!created) resolvedRequests.add(requestKey);
    sessionDirectories.set(sessionID, directory);
    const old = snapshot[directory]?.[domain] ?? unknownDomain, previous = old.bySession[sessionID] ?? [];
    // Tombstones fence a snapshot even when the resolved ID was not locally observed.
    touch(directory, domain, sessionID);
    changes.set(clockKey, { sessionID, id, pending: created, revision }); requestChanges.set(changesKey, changes);
    const ids = created ? previous.includes(id) ? previous : [...previous, id] : previous.filter(item => item !== id);
    if (ids === previous || ids.length === previous.length && ids.every((item, index) => item === previous[index])) return;
    const bySession = { ...old.bySession };
    if (ids.length) bySession[sessionID] = ids; else delete bySession[sessionID];
    put(directory, domain, { ...old, bySession });
  }
  function apply(directory: string, domain: Domain, payload: unknown, started: number) {
    if ((touched.get(stamp(directory, domain, '*')) ?? 0) > started) return;
    const bySession: Record<string, string[]> = {}, unknownSessions = new Set<string>();
    for (const row of rowsFrom(payload)) {
      const sessionID = text(row.sessionID) || text(row.sessionId);
      if (!sessionID) throw new Error('Invalid pending request session');
      if (!text(row.id)) { unknownSessions.add(sessionID); continue; }
      const rowDirectory = text(record(row.location).directory) || text(row.directory);
      if (rowDirectory && projectsAttentionDirectory(rowDirectory) !== directory) { unknownSessions.add(sessionID); continue; }
      if (domain === 'questions' && record(row.metadata).kind !== 'question') continue;
      if (resolvedRequests.has(JSON.stringify([domain, sessionID, text(row.id)]))) continue;
      if (sessionDirectories.has(sessionID) && sessionDirectories.get(sessionID) !== directory) {
        if ((moveRevisions.get(sessionID) ?? 0) > started) continue;
        // A later Location snapshot recovers a move missed while hidden/disconnected.
        moveSession(sessionID, directory);
      } else sessionDirectories.set(sessionID, directory);
      const ids = bySession[sessionID] ?? (bySession[sessionID] = []);
      if (!ids.includes(text(row.id))) ids.push(text(row.id));
    }
    const old = snapshot[directory]?.[domain] ?? unknownDomain;
    const candidates = new Set([...Object.keys(bySession), ...Object.keys(old.bySession), ...unknownSessions]);
    for (const sessionID of candidates) {
      if (unknownSessions.has(sessionID)) {
        const prior = old.bySession[sessionID];
        if (prior) bySession[sessionID] = [...prior]; else delete bySession[sessionID];
        if (old.unknownSessions.has(sessionID)) unknownSessions.add(sessionID);
      }
    }
    // Overlay only the exact IDs changed during this read, never the whole session.
    for (const change of requestChanges.get(JSON.stringify([directory, domain]))?.values() ?? []) {
      if (change.revision <= started && !unknownSessions.has(change.sessionID) && !bySession[change.sessionID]?.includes(change.id)) {
        change.pending = false;
        if (sessionDirectories.get(change.sessionID) === directory) resolvedRequests.add(JSON.stringify([domain, change.sessionID, change.id]));
      }
      if (change.pending && change.revision <= started || unknownSessions.has(change.sessionID)) continue;
      if (sessionDirectories.has(change.sessionID) && sessionDirectories.get(change.sessionID) !== directory) { delete bySession[change.sessionID]; continue; }
      const ids = bySession[change.sessionID] ?? [];
      const next = change.pending ? [...new Set([...ids, change.id])] : ids.filter(id => id !== change.id);
      if (next.length) bySession[change.sessionID] = next; else delete bySession[change.sessionID];
    }
    const same = old.known && unknownSessions.size === old.unknownSessions.size && [...unknownSessions].every(id => old.unknownSessions.has(id))
      && Object.keys(bySession).length === Object.keys(old.bySession).length
      && Object.entries(bySession).every(([id, ids]) => ids.length === old.bySession[id]?.length && ids.every(item => old.bySession[id]!.includes(item)));
    if (!same) put(directory, domain, { known: true, unknownSessions, bySession });
  }
  function failed(directory: string, domain: Domain, started: number) {
    if ((touched.get(stamp(directory, domain, '*')) ?? 0) > started) return;
    const old = snapshot[directory]?.[domain] ?? unknownDomain;
    if (old.known) put(directory, domain, { ...old, known: false });
  }
  async function refresh(send: ProjectsAttentionRequest, current: () => boolean) {
    if (!current()) return;
    if (flight) { again = true; return flight; }
    const captured = epoch;
    const valid = () => captured === epoch && current();
    const next = (async () => {
      do {
        again = false;
        const inventoryStarted = revision;
        let directories: string[];
        try {
          const result = await send('/api/debug/location');
          if (!valid()) return;
          // debug.location.list is a raw array, unlike domain list { data } envelopes.
          if (!Array.isArray(result) || result.some(row => !text(record(row).directory))) throw new Error('Invalid live Location inventory');
          directories = [...new Set(result.map(row => projectsAttentionDirectory(text(record(row).directory))))];
        } catch {
          if (valid()) for (const directory of Object.keys(snapshot)) for (const domain of domains) failed(directory, domain, inventoryStarted);
          return;
        }
        const live = new Set(directories);
        for (const directory of Object.keys(snapshot)) {
          if (!live.has(directory) && domains.every(domain => (touched.get(stamp(directory, domain, '*')) ?? 0) <= inventoryStarted
            && Object.keys(snapshot[directory]![domain].bySession).every(id => (touched.get(stamp(directory, domain, id)) ?? 0) <= inventoryStarted))) removeDirectory(directory);
        }
        let position = 0;
        const worker = async () => {
          while (position < directories.length && valid()) {
            const directory = directories[position++]!;
            if (domains.some(domain => (touched.get(stamp(directory, domain, '*')) ?? 0) > inventoryStarted)) continue;
            await Promise.all(domains.map(async domain => {
              const started = revision;
              const route = domain === 'questions' ? '/api/form' : '/api/permission/request';
              try {
                const result = await send(`${route}?location%5Bdirectory%5D=${encodeURIComponent(directory)}`);
                if (valid()) apply(directory, domain, result, started);
              } catch { if (valid()) failed(directory, domain, started); }
            }));
          }
        };
        await Promise.all([worker(), worker()]);
      } while (again && valid());
    })();
    flight = next;
    try { await next; } finally { if (flight === next) flight = undefined; }
  }
  function pause() { epoch++; flight = undefined; again = false; }
  function dispose() { pause(); touched.clear(); sessionDirectories.clear(); moveRevisions.clear(); directoryClocks.clear(); shutdownClocks.clear(); eventClocks.clear(); seenEvents.clear(); resolvedRequests.clear(); requestChanges.clear(); publish({}); }
  return { snapshot: () => snapshot, accept, refresh, pause, dispose };
}
