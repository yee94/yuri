import { retentionActive, retentionCandidates, retentionObject, retentionSession, scanRetentionCatalog, type RetentionAction, type RetentionRequest } from './settings-retention-core';
import { RETENTION_DEFAULT_DAYS, RETENTION_MAX_DAYS, RETENTION_MIN_DAYS } from '../ui/src/lib/session-retention-policy';
import { createSettingsLaneOwner, type SettingsRequestLane } from './settings-protocol';

export type RetentionPreferences = { autoDeleteEnabled: boolean; autoDeleteAfterDays: number; sessionRetentionAction: RetentionAction };
export type RetentionResult = { id: string; directory: string; action: RetentionAction; status: 'uncertain' | 'ack' | 'completed' | 'failed' | 'skipped' };
export type RetentionPlan = Readonly<{ action: RetentionAction; count: number }>;
export type RetentionSnapshot = { ready: boolean; busy: boolean; count: number | null; preferences: RetentionPreferences; hostSynced: boolean; admission: 'server-atomic-required'; error: '' | 'load' | 'catalog' | 'save' | 'host-preferences' | 'journal' | 'admission'; results: readonly RetentionResult[]; lastRunAt: number | null };
export type RetentionStorage = { getItem: (key: string) => Promise<string | null>; setItem: (key: string, value: string) => Promise<void> };
const defaults: RetentionPreferences = { autoDeleteEnabled: false, autoDeleteAfterDays: RETENTION_DEFAULT_DAYS, sessionRetentionAction: 'archive' };
const deviceKey = 'yuri.session-retention.preferences';
const validPreferences = (value: unknown, fallback = defaults): RetentionPreferences => {
  const body = retentionObject(value);
  if (body.autoDeleteEnabled !== undefined && typeof body.autoDeleteEnabled !== 'boolean') throw new Error('invalid-preferences');
  if (body.autoDeleteAfterDays !== undefined && (typeof body.autoDeleteAfterDays !== 'number' || !Number.isFinite(body.autoDeleteAfterDays))) throw new Error('invalid-preferences');
  if (body.sessionRetentionAction !== undefined && body.sessionRetentionAction !== 'archive' && body.sessionRetentionAction !== 'delete') throw new Error('invalid-preferences');
  return {
    autoDeleteEnabled: typeof body.autoDeleteEnabled === 'boolean' ? body.autoDeleteEnabled : fallback.autoDeleteEnabled,
    autoDeleteAfterDays: typeof body.autoDeleteAfterDays === 'number' ? Math.max(RETENTION_MIN_DAYS, Math.min(RETENTION_MAX_DAYS, body.autoDeleteAfterDays)) : fallback.autoDeleteAfterDays,
    sessionRetentionAction: body.sessionRetentionAction === 'archive' || body.sessionRetentionAction === 'delete' ? body.sessionRetentionAction : fallback.sessionRetentionAction,
  };
};
const samePreferences = (a: RetentionPreferences, b: RetentionPreferences) => a.autoDeleteEnabled === b.autoDeleteEnabled && a.autoDeleteAfterDays === b.autoDeleteAfterDays && a.sessionRetentionAction === b.sessionRetentionAction;

/** One owner per captured Host generation. No timers, global stores, messages or input subscriptions. */
export function createRetentionController(options: { send: RetentionRequest; storage: RetentionStorage; scope: string; current: () => boolean; available?: () => boolean; protectedIDs: () => ReadonlySet<string>; now?: () => number }) {
  if (!options.scope.trim()) throw new Error('Missing retention scope');
  const now = options.now ?? Date.now, listeners = new Set<() => void>();
  const transport = createSettingsLaneOwner(options.send, options.current);
  const journalKey = `yuri.session-retention.journal:${encodeURIComponent(options.scope)}`;
  let state: RetentionSnapshot = { ready: false, busy: false, count: null, preferences: { ...defaults }, hostSynced: false, admission: 'server-atomic-required', error: '', results: [], lastRunAt: null };
  let ticket: { plan: RetentionPlan; preferences: RetentionPreferences } | null = null;
  let pendingSave: { preferences: RetentionPreferences; ack: boolean; attempted: boolean } | null = null;
  let loadFlight: Promise<void | null> | null = null;
  const settled = new Set<string>();
  const publish = (patch: Partial<RetentionSnapshot>) => { state = { ...state, ...patch }; listeners.forEach(listener => listener()); };
  const available = () => transport.capture()?.current() === true && (options.available?.() ?? true);
  const check = (lane: SettingsRequestLane) => { if (!lane.current() || !(options.available?.() ?? true)) throw new Error('inactive'); };
  async function persistJournal(lane: SettingsRequestLane) { await options.storage.setItem(journalKey, JSON.stringify(state.results.filter(item => !settled.has(item.id)))); check(lane); }
  async function persistDevice(lane: SettingsRequestLane, preferences = state.preferences, lastRunAt = state.lastRunAt) {
    await options.storage.setItem(deviceKey, JSON.stringify({ ...preferences, autoDeleteLastRunAt: lastRunAt })); check(lane);
  }
  async function exclusive<T>(work: (lane: SettingsRequestLane) => Promise<T>, error: RetentionSnapshot['error']): Promise<T | null> {
    const lane = transport.capture();
    if (state.busy || !lane || !available()) return null;
    publish({ busy: true, error: '' });
    try { return await work(lane); }
    catch { if (lane.current()) publish({ error, count: error === 'catalog' ? null : state.count }); return null; }
    finally { if (lane.current()) publish({ busy: false, error: state.error || (state.ready ? 'admission' : '') }); }
  }
  async function catalog(lane: SettingsRequestLane, action = state.preferences.sessionRetentionAction) {
    const sessions = await scanRetentionCatalog(lane.request, lane.current);
    const activeIDs = retentionActive(await lane.request('/api/session/active')); check(lane);
    // An active ID absent from this generation's catalog may have an unknown parent.
    const ids = new Set(sessions.map(item => item.id));
    if ([...activeIDs].some(id => !ids.has(id))) throw new Error('changing-catalog');
    const byID = new Map(sessions.map(item => [item.id, item]));
    let retired = false;
    for (const item of state.results) {
      if (item.status !== 'completed' || settled.has(item.id)) continue;
      const fresh = byID.get(item.id);
      if ((item.action === 'delete' && !fresh) || (item.action === 'archive' && fresh?.directory === item.directory && (fresh.time.archived ?? 0) > 0)) { settled.add(item.id); retired = true; }
    }
    // Only a full successful authoritative scan can retire replay tombstones.
    if (retired) await persistJournal(lane);
    const candidates = retentionCandidates(sessions, { days: state.preferences.autoDeleteAfterDays, now: now(), action, protectedIDs: options.protectedIDs(), activeIDs });
    const done = new Set(state.results.filter(item => !settled.has(item.id) && (item.status === 'completed' || item.status === 'ack' || item.status === 'uncertain')).map(item => item.id));
    const eligible = candidates.filter(item => !done.has(item.id));
    publish({ count: eligible.length });
    return { sessions, candidates: eligible };
  }
  async function result(lane: SettingsRequestLane, next: RetentionResult) {
    settled.delete(next.id);
    const results = [...state.results], index = results.findIndex(item => item.id === next.id);
    if (index < 0) results.push(next); else results[index] = next;
    publish({ results });
    await persistJournal(lane);
  }
  async function reconcile(lane: SettingsRequestLane, item: RetentionResult) {
    if (item.status === 'completed' || item.status === 'failed' || item.status === 'skipped') return;
    try {
      const response = retentionObject(await lane.request(`/api/session/${encodeURIComponent(item.id)}`)); check(lane);
      const fresh = retentionSession(response.data ?? response);
      if (fresh.id !== item.id || fresh.directory !== item.directory) throw new Error('identity-changed');
      if (item.status === 'ack' && item.action === 'archive' && (fresh.time.archived ?? 0) > 0) await result(lane, { ...item, status: 'completed' });
      // Unknown writes with a still-present target remain reconcile-only: the server has no idempotency receipt.
    } catch (failure) {
      check(lane);
      // Absence is not a receipt for an unknown write: another client may have deleted it.
      if (item.status === 'ack' && item.action === 'delete' && (failure as { status?: number }).status === 404) await result(lane, { ...item, status: 'completed' });
      else publish({ error: 'catalog' });
    }
  }
  // No implemented Host/upstream contract atomically checks eligibility, excludes all
  // OpenCode clients and commits a durable operation receipt. Neither a preference,
  // capability claim, local lease nor a confirmation can supply that authority.
  // Keep the legacy GET -> DELETE/PUT lane absent, including for manual retries.
  const requireServerAdmission = () => { publish({ error: 'admission' }); return null; };
  const api = {
    captureLane: transport.capture,
    replaceLane(next: SettingsRequestLane | null) { transport.replaceLane(next); ticket = null; loadFlight = null; publish({ busy: false }); },
    resume: () => exclusive(async lane => {
      const host = retentionObject(await lane.request('/api/config/settings')); check(lane);
      const verified = validPreferences(host, state.preferences);
      if (pendingSave && samePreferences(verified, pendingSave.preferences)) pendingSave = null;
      publish({ hostSynced: samePreferences(verified, state.preferences) });
    }, 'load'),
    snapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    load() {
      if (loadFlight) return loadFlight;
      const flight = exclusive(async lane => {
        const raw = await options.storage.getItem(deviceKey); check(lane);
        const device = raw === null ? {} : retentionObject(JSON.parse(raw));
        const preferences = validPreferences(device);
        const lastRun = device.autoDeleteLastRunAt;
        if (lastRun != null && (typeof lastRun !== 'number' || !Number.isFinite(lastRun) || lastRun < 0)) throw new Error('invalid-cooldown');
        const journal = await options.storage.getItem(journalKey); check(lane);
        const entries: unknown = journal === null ? [] : JSON.parse(journal);
        if (!Array.isArray(entries)) throw new Error('invalid-journal');
        const results: RetentionResult[] = entries.map(value => {
          const entry = retentionObject(value);
          if (typeof entry.id !== 'string' || !entry.id.trim() || typeof entry.directory !== 'string' || !entry.directory.trim() || !['archive', 'delete'].includes(String(entry.action)) || !['uncertain', 'ack', 'completed', 'failed', 'skipped'].includes(String(entry.status))) throw new Error('invalid-journal');
          return { id: entry.id, directory: entry.directory, action: entry.action as RetentionAction, status: entry.status as RetentionResult['status'] };
        });
        if (new Set(results.map(item => item.id)).size !== results.length) throw new Error('invalid-journal');
        settled.clear();
        publish({ preferences, count: samePreferences(preferences, state.preferences) ? state.count : null, lastRunAt: typeof lastRun === 'number' ? lastRun : null, results, hostSynced: false });
        const host = retentionObject(await lane.request('/api/config/settings')); check(lane);
        const merged = validPreferences(host, preferences);
        publish({ preferences: merged, count: samePreferences(merged, state.preferences) ? state.count : null, lastRunAt: typeof lastRun === 'number' ? lastRun : null, results, hostSynced: host.sessionRetentionAction === merged.sessionRetentionAction || (host.sessionRetentionAction === undefined && merged.sessionRetentionAction === 'archive') });
        await persistDevice(lane);
        publish({ ready: true });
      }, 'load').finally(() => { if (loadFlight === flight) loadFlight = null; });
      loadFlight = flight;
      return loadFlight;
    },
    async save(preferences: RetentionPreferences) {
      ticket = null;
      return exclusive(async lane => {
        if (!state.ready) throw new Error('not-ready');
        const normalized = validPreferences(preferences);
        if (!samePreferences(normalized, preferences)) throw new Error('invalid-days');
        if (!pendingSave || !samePreferences(pendingSave.preferences, normalized)) pendingSave = { preferences: normalized, ack: false, attempted: false };
        await persistDevice(lane, normalized);
        publish({ preferences: normalized, hostSynced: false, count: null });
        if (!pendingSave.attempted) { pendingSave.attempted = true; retentionObject(await lane.request('/api/config/settings', 'PUT', normalized)); check(lane); pendingSave.ack = true; }
        const host = retentionObject(await lane.request('/api/config/settings')); check(lane);
        const verified = validPreferences(host);
        if (!samePreferences(verified, normalized)) { publish({ error: 'host-preferences' }); return; }
        pendingSave = null;
        publish({ hostSynced: true });
      }, 'save');
    },
    scan: () => exclusive(async lane => { if (!state.ready) throw new Error('not-ready'); return catalog(lane); }, 'catalog'),
    prepare: () => exclusive(async (lane): Promise<RetentionPlan> => {
      if (!state.ready) throw new Error('not-ready');
      const { candidates } = await catalog(lane); check(lane);
      const plan = Object.freeze({ action: state.preferences.sessionRetentionAction, count: candidates.length });
      ticket = { plan, preferences: { ...state.preferences } };
      return plan;
    }, 'catalog'),
    cancel() { ticket = null; },
    confirm: (plan: RetentionPlan) => exclusive(async () => {
      const approved = ticket; ticket = null;
      if (!state.ready || !approved || approved.plan !== plan || !samePreferences(approved.preferences, state.preferences)) throw new Error('unconfirmed');
      return requireServerAdmission();
    }, 'catalog'),
    retry: (id: string) => exclusive(async lane => {
      if (!state.ready) throw new Error('not-ready');
      const item = state.results.find(entry => entry.id === id);
      if (!item || item.status === 'completed' || item.status === 'skipped') return;
      if (item.status !== 'failed') { await reconcile(lane, item); return; }
      return requireServerAdmission();
    }, 'catalog'),
    async autoRun() {
      if (!state.ready || state.busy || !state.hostSynced || !state.preferences.autoDeleteEnabled || (state.lastRunAt !== null && now() - state.lastRunAt < 86_400_000)) return;
      return requireServerAdmission();
    },
  };
  return api;
}
export type RetentionController = ReturnType<typeof createRetentionController>;
