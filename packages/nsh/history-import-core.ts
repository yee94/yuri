import type { SettingsRequest } from './settings-protocol';
import type { SetupTourLane } from './setup-tour-operation';
import { historyImportError, historyPreviewLimit, historySources, importRoute, isHistorySource, isImportJobFinished, parseNativeImportJob, parseNativeImportJobs, parseNativeImportScan, parseNativeImportStates, readImportReceipt, type HistorySource, type ImportScan, type ImportStates, type NativeImportJob } from './history-import-protocol';

type Action = 'start' | 'cancel' | 'resume' | 'dismiss';
type Pending = { action: Action; id: string | null; acknowledged: boolean; receipt: NativeImportJob | null; sources: readonly HistorySource[]; directory: string | null };
export type HistoryImportState = {
  selected: readonly HistorySource[]; scan: ImportScan | null; badges: ImportStates | null; badgeScanID: string | null;
  job: NativeImportJob | null; jobs: readonly NativeImportJob[] | null; acceptedID: string | null;
  receipts: Readonly<Record<string, NativeImportJob>>;
  jobReady: boolean; jobsReady: boolean;
  errors: Readonly<Partial<Record<'job' | 'jobs' | 'scan' | 'badges' | 'mutation' | 'receipt' | 'projects', string>>>;
  loading: boolean; scanning: boolean; writing: boolean; pending: Readonly<Pending> | null;
  pendingActions: readonly Readonly<Pending>[];
  removeActions: readonly string[]; cancelRequested: readonly string[];
};
export type HistoryImportClock = { schedule: (work: () => void, ms: number) => unknown; cancel: (handle: unknown) => void };
export type HistoryImportTask = { job: NativeImportJob; stale: boolean; failed: boolean; removeAction: boolean; busy: boolean };

/** A single captured-sender owner serves Tour, task entry and task detail.
 * Discovery follows Web's job-success/non-running query admission and cache;
 * start/resume/cancel/dismiss remain explicit. One timer owns polling. */
export function createHistoryImport(input: {
  send: SettingsRequest; current: () => boolean; directory?: string;
  clock?: HistoryImportClock; onComplete?: () => void; onJobsSettled?: (ids: readonly string[]) => void;
  now?: () => number;
}) {
  const directory = input.directory ?? null;
  let lane: SetupTourLane = { send: input.send, current: input.current }, laneTicket = 0, recoveryReadOnly = false, discoveryAfterRecovery = false;
  let state: HistoryImportState = { selected: [], scan: null, badges: null, badgeScanID: null, job: null, jobs: null, receipts: {}, acceptedID: null, jobReady: false, jobsReady: false, errors: {}, loading: false, scanning: false, writing: false, pending: null, pendingActions: [], removeActions: [], cancelRequested: [] };
  let disposed = false, generation = 0, readFlight: Promise<void> | null = null, readGeneration = -1, scanFlight = false, writeFlight = false;
  let readKinds = 0;
  let timer: unknown;
  let badgeRevision = '';
  const now = input.now ?? Date.now;
  let scanUpdatedAt: number | null = null, scanInactiveAt: number | null = null, scanEpoch = 0, autoAttempted = false;
  let scanPromise: Promise<void> | null = null;
  const demands = new Map<string, 'tour' | 'tasks'>(), listeners = new Set<(state: HistoryImportState) => void>();
  const completions = new Set<() => void>();
  const inspections = new Map<string, Promise<void>>();
  const journals = new Map<string, Pending>();
  const projectRefreshIDs = new Set<string>();
  if (input.onComplete) completions.add(input.onComplete);
  const current = () => !disposed && lane.current();
  const visible = () => current() && demands.size > 0;
  const tourVisible = () => current() && [...demands.values()].includes('tour');
  const tasksVisible = () => current() && [...demands.values()].includes('tasks');
  const valid = (turn: number) => visible() && generation === turn;
  const publish = (patch: Partial<HistoryImportState>) => { if (!current()) return; state = { ...state, ...patch }; for (const listener of listeners) listener(state); };
  const error = (key: keyof HistoryImportState['errors'], cause?: unknown) => { const errors = { ...state.errors }; if (cause === undefined) delete errors[key]; else errors[key] = historyImportError(cause); publish({ errors }); };
  function publishJournals() {
    publish({ pending: journals.get('start') ?? journals.values().next().value ?? null, pendingActions: [...journals.values()] });
  }
  const check = (turn: number) => { if (!valid(turn)) throw new Error('import_owner_retired'); };
  const stopTimer = () => { if (timer !== undefined) { input.clock?.cancel(timer); timer = undefined; } };
  async function refreshProjects(turn: number) {
    if (!input.onJobsSettled || !projectRefreshIDs.size || !valid(turn)) return;
    const ids = [...projectRefreshIDs];
    try { await input.onJobsSettled(ids); if (valid(turn)) { for (const id of ids) projectRefreshIDs.delete(id); error('projects'); } }
    catch (cause) { if (valid(turn)) error('projects', cause); }
  }
  function schedule() {
    stopTimer();
    if (!visible() || !input.clock || scanFlight || writeFlight) return;
    if ((!tourVisible() || state.errors.job === 'history_import_unsupported') && (!tasksVisible() || state.errors.jobs === 'history_import_unsupported')) return;
    const running = tourVisible() && state.job?.state === 'running' || tasksVisible() && state.jobs?.some(job => job.state === 'running');
    // Like Web: job 1s while running; background catalog 15s while mounted.
    if (!running && ![...demands.values()].includes('tasks')) return;
    timer = input.clock.schedule(() => { timer = undefined; if (visible()) void refresh(); }, running ? 1000 : 15_000);
  }
  function retainReceipt(job: NativeImportJob) {
    const receipts = Object.fromEntries([...Object.entries(state.receipts).filter(([id]) => id !== job.id), [job.id, job]].slice(-16));
    publish({ receipts });
  }
  function adoptJob(job: NativeImportJob | null, currentJob = true) {
    if (currentJob) publish({ job });
    if (job) retainReceipt(job);
    if (job && state.jobs) {
      const prior = state.jobs.find(item => item.id === job.id);
      const jobs = isImportJobFinished(job) || job.dismissed ? state.jobs.filter(item => item.id !== job.id)
        : prior ? state.jobs.map(item => item.id === job.id ? job : item) : [...state.jobs, job].sort((left, right) => left.created - right.created);
      publish({ jobs });
    }
    if (job && job.state !== 'running' && state.cancelRequested.includes(job.id)) publish({ cancelRequested: state.cancelRequested.filter(id => id !== job.id) });
  }
  function settlePending(receipt: NativeImportJob | null) {
    if (!receipt) return;
    for (const [key, pending] of journals) {
      if (!pending.id || receipt.id !== pending.id) continue;
      if (pending.action === 'dismiss') {
        if (!receipt.dismissed) continue;
        journals.delete(key); publish({ jobs: state.jobs?.filter(job => job.id !== receipt.id) ?? null, job: state.job?.id === receipt.id ? null : state.job });
        continue;
      }
      const confirmed = pending.acknowledged || pending.action === 'resume' && (receipt.state === 'running' || isImportJobFinished(receipt))
        || pending.action === 'cancel' && receipt.state !== 'running';
      if (!confirmed) continue;
      if (pending.action === 'start') publish({ acceptedID: receipt.id });
      if (pending.action === 'cancel' && receipt.state === 'running') publish({ cancelRequested: [...new Set([...state.cancelRequested, receipt.id])] });
      journals.delete(key);
    }
    publishJournals();
    if (!journals.size) error('mutation');
  }
  async function reconcile(turn: number, pending: Pending | undefined) {
    const send = lane.send;
    if (!pending) return;
    // A lost source-start response has no public request identity. Never infer
    // our job from latest/list, counts, directory or wall clock.
    if (!pending.id) { error('mutation', new Error('import_result_unknown')); return; }
    const receipt = await readImportReceipt(send, pending.id); check(turn);
    if (receipt) adoptJob(receipt, pending.action === 'start' || state.job?.id === receipt.id);
    settlePending(receipt);
    if (journals.size) error('mutation', new Error('import_result_unknown'));
  }
  function refresh(only = 3): Promise<void> {
    if (!visible() || writeFlight || scanFlight) return Promise.resolve();
    const requested = ((tourVisible() ? 1 : 0) | (tasksVisible() ? 2 : 0)) & only;
    if (!requested) return Promise.resolve();
    if (readFlight && readGeneration === generation) {
      const missing = requested & ~readKinds;
      return missing ? readFlight.then(() => refresh(missing)) : readFlight;
    }
    readKinds = requested;
    const turn = generation, ticket = laneTicket, send = lane.send; readGeneration = turn; stopTimer(); publish({ loading: true });
    const work = (async () => {
      try {
        // Independent GETs keep unrelated valid resources when one fails.
        await Promise.all([
          requested & 1 ? (async () => {
            try {
              const id = journals.get('start')?.id ?? state.acceptedID;
              const job = await readImportReceipt(send, id || undefined); check(turn);
              if (id && !job) throw new Error('job_missing');
              const wasRunning = state.job?.state === 'running';
              adoptJob(job); publish({ jobReady: true }); error('job');
              if (job?.state === 'running' || wasRunning) autoAttempted = false;
              await ensureScan();
            } catch (cause) { if (valid(turn)) error('job', cause); }
          })() : Promise.resolve(),
          requested & 2 ? (async () => {
            try {
              const jobs = parseNativeImportJobs(await send(importRoute('jobs'))); check(turn);
              const previous = state.jobs;
              publish({ jobs, jobsReady: true }); error('jobs');
              const ended = previous?.filter(job => job.state === 'running' && !jobs.some(next => next.id === job.id && next.state === 'running')).map(job => job.id) ?? [];
              if (ended.length && input.onJobsSettled) {
                for (const id of ended) projectRefreshIDs.add(id);
                await refreshProjects(turn);
              }
            } catch (cause) { if (valid(turn)) error('jobs', cause); }
          })() : Promise.resolve(),
        ]);
        if (valid(turn) && journals.size) {
          // The normal exact-job GET already carries a full receipt. Avoid a
          // second identical read unless the pending target is not that job.
          if (requested & 1 && state.job && !state.errors.job) settlePending(state.job);
          // A pending task has its own exact read lane. A failed task cannot
          // erase/block another task's receipt or grant it mutation authority.
          for (const pending of [...journals.values()]) {
            if (!valid(turn)) break;
            if (pending.id && (!(requested & 1) || pending.id !== state.job?.id)) {
              try { await reconcile(turn, pending); }
              catch (cause) { if (valid(turn)) error('mutation', cause); }
            }
          }
          if (journals.get('start')?.id === null) error('mutation', new Error('import_result_unknown'));
        }
        const revision = `${state.job?.id ?? ''}:${state.job?.state ?? ''}`;
        if (tourVisible() && valid(turn) && !recoveryReadOnly && !state.pending && !state.errors.job && state.job?.state !== 'running' && state.scan && badgeRevision !== revision) await badges(turn, state.scan);
      } finally {
        const admitDiscovery = ticket === laneTicket && discoveryAfterRecovery;
        if (ticket === laneTicket) { recoveryReadOnly = false; discoveryAfterRecovery = false; }
        if (valid(turn)) { publish({ loading: false }); schedule(); }
        if (admitDiscovery && valid(turn)) { autoAttempted = false; void ensureScan(); }
        if (readGeneration === turn) readFlight = null;
      }
    })();
    readFlight = work; return work;
  }
  function ensureScan(): Promise<void> {
    if (!tourVisible() || recoveryReadOnly || !state.jobReady || state.errors.job || state.job?.state === 'running' || writeFlight || autoAttempted) return Promise.resolve();
    if (scanFlight) return scanPromise ?? Promise.resolve();
    autoAttempted = true;
    if (state.scan && scanUpdatedAt !== null && now() - scanUpdatedAt < 60_000 && !state.errors.scan) return Promise.resolve();
    return scan();
  }
  function scan(): Promise<void> {
    if (!visible() || !state.jobReady || writeFlight || state.job?.state === 'running' || state.errors.job) return Promise.resolve();
    if (scanFlight) return scanPromise ?? Promise.resolve();
    const turn = generation, surface = scanEpoch, ticket = laneTicket, send = lane.send; scanFlight = true; autoAttempted = true; stopTimer(); publish({ scanning: true }); error('scan');
    const work = (async () => { try {
      const snapshot = parseNativeImportScan(await send(importRoute('scan'), 'POST', { sources: historySources.map(source => source.id), limitPerSource: historyPreviewLimit, includeCounts: true })); check(turn);
      if (surface !== scanEpoch) return;
      scanUpdatedAt = now();
      publish({ scan: snapshot, badges: null, badgeScanID: null });
      await badges(turn, snapshot);
    } catch (cause) { if (valid(turn) && surface === scanEpoch) error('scan', cause); }
    finally {
      if (ticket === laneTicket) { scanFlight = false; scanPromise = null; if (current()) publish({ scanning: false }); }
      if (ticket === laneTicket && surface !== scanEpoch && tourVisible()) void ensureScan();
      if (valid(turn)) schedule();
    } })();
    scanPromise = work; return work;
  }
  async function badges(turn: number, snapshot: ImportScan) {
    const send = lane.send;
    const surface = scanEpoch;
    const revision = `${state.job?.id ?? ''}:${state.job?.state ?? ''}`;
    badgeRevision = revision;
    try {
      const value = parseNativeImportStates(await send(importRoute('imported'), 'POST', { scanID: snapshot.id, directory }), snapshot); check(turn);
      if (surface === scanEpoch && state.scan?.id === snapshot.id) { publish({ badges: value, badgeScanID: snapshot.id }); error('badges'); }
    } catch (cause) { if (valid(turn) && surface === scanEpoch) error('badges', cause); }
  }
  async function mutate(action: Action, id: string | null = null) {
    if (!visible() || writeFlight || scanFlight) return;
    const turn = ++generation, ticket = laneTicket, send = lane.send; writeFlight = true; stopTimer(); publish({ writing: true, loading: false });
    try {
      const key = action === 'start' ? 'start' : id || '';
      if (journals.has(key)) { await reconcile(turn, journals.get(key)); return; }
      if (action === 'start') {
        if (!state.scan || state.errors.scan || state.errors.job || !state.selected.length || state.job?.state === 'running') return;
      } else {
        const job = state.jobs?.find(job => job.id === id) ?? (state.job?.id === id ? state.job : null);
        if (!job || !id || action !== 'cancel' && job.state === 'running' || action === 'cancel' && (job.state !== 'running' || state.cancelRequested.includes(id))) return;
        if (action === 'resume' && (isImportJobFinished(job) || job.dismissed)) return;
      }
      error('mutation');
      const transaction: Pending = { action, id, acknowledged: false, receipt: null, sources: [...state.selected], directory };
      journals.set(key, transaction); publishJournals();
      const body = action === 'start' ? { sources: [...transaction.sources], directory: transaction.directory, confirm: true }
        : action === 'resume' ? { id, confirm: true } : { id };
      let response: unknown;
      try { response = await send(importRoute(action), 'POST', body); }
      catch (cause) {
        const status = (cause as { status?: number } | null)?.status;
        if (ticket === laneTicket && current() && typeof status === 'number' && status >= 400 && status < 500) {
          journals.delete(key); publishJournals();
          if (action === 'resume' && id) publish({ removeActions: [...new Set([...state.removeActions, id])] });
        }
        throw cause;
      }
      // Capture valid ACK before visibility checks: a background transition
      // cannot erase it or grant the next foreground a fresh POST.
      if (ticket !== laneTicket || disposed) return;
      if (action === 'dismiss') {
        if (!response || typeof response !== 'object' || Array.isArray(response) || (response as Record<string, unknown>).id !== id) throw new Error('invalid_import_response');
        transaction.acknowledged = true;
      } else {
        const receipt = parseNativeImportJob(response);
        if (id && receipt.id !== id) throw new Error('invalid_import_response');
        transaction.id = receipt.id; transaction.receipt = receipt; transaction.acknowledged = true;
      }
      if (!current()) return;
      publishJournals();
      if (transaction.receipt) adoptJob(transaction.receipt, action === 'start' || state.job?.id === transaction.id);
      if (action === 'start' && transaction.id) publish({ acceptedID: transaction.id });
      if (!valid(turn)) return;
      await reconcile(turn, transaction);
    } catch (cause) {
      if (ticket === laneTicket && current()) error('mutation', cause);
    } finally {
      if (ticket === laneTicket) { writeFlight = false; if (current()) publish({ writing: false }); }
      if (valid(turn)) schedule();
    }
  }
  const finished = () => !!state.acceptedID && state.job?.id === state.acceptedID && isImportJobFinished(state.job);
  const primary = () => ({ disabled: !visible() || state.writing || journals.has('start') || !state.jobReady || !(state.job?.state === 'running' || finished()) && (state.scanning || !state.scan || !!state.errors.scan || !!state.errors.job), background: state.job?.state === 'running' });
  return {
    current, directory, snapshot: () => state,
    subscribe(listener: (state: HistoryImportState) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    observeCompletion(listener: () => void) { completions.add(listener); return () => { completions.delete(listener); }; },
    demand(key: string, value: boolean, kind: 'tour' | 'tasks' = 'tour') {
      if (value ? demands.get(key) === kind : !demands.has(key)) return;
      const was = visible(), wasTour = tourVisible(), wasTasks = tasksVisible(); if (value) demands.set(key, kind); else demands.delete(key);
      if (!current()) { stopTimer(); return; }
      if (wasTour !== tourVisible()) {
        scanEpoch++;
        if (!tourVisible()) scanInactiveAt = now();
        else {
          if (scanInactiveAt !== null && now() - scanInactiveAt >= 300_000) {
            scanUpdatedAt = null; publish({ scan: null, badges: null, badgeScanID: null }); error('scan'); error('badges');
          }
          scanInactiveAt = null; autoAttempted = recoveryReadOnly || !!state.errors.scan;
        }
      }
      if (was !== visible()) { generation++; stopTimer(); publish({ loading: false }); if (visible()) void refresh(); }
      else if (!wasTour && tourVisible() || !wasTasks && tasksVisible()) void refresh((!wasTour && tourVisible() ? 1 : 0) | (!wasTasks && tasksVisible() ? 2 : 0));
      else { if (tourVisible()) void ensureScan(); schedule(); }
    },
    refresh: () => refresh(), scan,
    ensureDiscovery(): Promise<void> {
      if (recoveryReadOnly) { discoveryAfterRecovery = true; return Promise.resolve(); }
      if (!tourVisible() || state.errors.scan) return Promise.resolve();
      autoAttempted = false; return ensureScan();
    },
    async replaceLane(next: SetupTourLane): Promise<boolean> {
      if (disposed || !next.current()) return false;
      lane = { send: next.send, current: next.current }; laneTicket++; generation++; scanEpoch++; stopTimer();
      readFlight = null; readGeneration = -1; scanFlight = false; scanPromise = null; writeFlight = false;
      recoveryReadOnly = true; discoveryAfterRecovery = false; autoAttempted = true;
      publish({ loading: false, scanning: false, writing: false });
      if (visible()) await refresh(); return current();
    },
    async refreshBadges() { if (visible() && state.scan && !scanFlight && !writeFlight && !journals.has('start') && state.job?.state !== 'running') await badges(generation, state.scan); },
    select(source: HistorySource, selected: boolean) {
      if (!visible() || writeFlight || journals.has('start') || state.job?.state === 'running' || !isHistorySource(source)) return;
      publish({ selected: selected ? state.selected.includes(source) ? state.selected : [...state.selected, source] : state.selected.filter(value => value !== source) });
    },
    primary,
    async proceed() {
      if (primary().disabled) return;
      if (state.job?.state === 'running' || finished() || !state.selected.length) { for (const listener of completions) listener(); return; }
      await mutate('start');
    },
    cancel: (id: string) => mutate('cancel', id), resume: (id: string) => mutate('resume', id), dismiss: (id: string) => mutate('dismiss', id),
    async retry() {
      const retryScan = !!state.errors.scan, retryBadges = !!state.errors.badges;
      await refresh();
      if (tourVisible() && state.jobReady && state.job?.state !== 'running' && !state.errors.job) {
        if (retryScan) await scan(); else if (retryBadges && state.scan) await badges(generation, state.scan);
      }
      if (visible() && !writeFlight && !scanFlight) await refreshProjects(generation);
    },
    headerJob: () => state.job && !isImportJobFinished(state.job) && (state.job.state === 'running' || state.acceptedID === state.job.id) ? state.job : null,
    inspect(id: string): Promise<void> {
      if (!visible() || writeFlight || scanFlight) return Promise.resolve();
      const turn = generation, key = `${turn}:${id}`, send = lane.send;
      const existing = inspections.get(key); if (existing) return existing;
      const work = (async () => {
        try { const receipt = await readImportReceipt(send, id); check(turn); if (!receipt) throw new Error('job_missing'); retainReceipt(receipt); error('receipt'); }
        catch (cause) { if (valid(turn)) error('receipt', cause); }
        finally { inspections.delete(key); }
      })();
      inspections.set(key, work); return work;
    },
    tasks(): HistoryImportTask[] { return (state.jobs ?? []).filter(job => !isImportJobFinished(job) && !job.dismissed).map(job => ({ job, stale: !!state.errors.jobs, failed: job.state !== 'running', removeAction: state.removeActions.includes(job.id), busy: state.writing || journals.has(job.id) })); },
    pollBudget: () => ({ scheduled: timer !== undefined, consumers: demands.size }),
    dispose() { disposed = true; generation++; stopTimer(); listeners.clear(); completions.clear(); inspections.clear(); journals.clear(); },
  };
}
export type HistoryImportController = ReturnType<typeof createHistoryImport>;
