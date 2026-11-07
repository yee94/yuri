/** About uses the serving Host's validated update plans; never commands or artifact URLs. */
const aboutManagement = ['manual-global', 'manual-external', 'bundled', 'in-app', 'none'] as const;
type AboutManagement = typeof aboutManagement[number];
const aboutOperationStates = ['checking', 'downloading', 'installing', 'restarting', 'succeeded', 'failed'] as const;
export type AboutClient = { version: string | null; build: string | null; update: 'unsupported' };
export type AboutHost = { version: string | null };
export type AboutOpenCode = { version: string | null; management: AboutManagement | null; canManage: boolean | null };
type AboutUpdatePlan = { version: string; kind: 'ota' | 'installer' | 'cli-package'; planId: string; rollback: boolean; restartRequired: boolean; releaseNotes: string | null };
type AboutUpdateOperation = { id: string; status: typeof aboutOperationStates[number]; version: string; channel: 'stable' | 'beta'; kind: AboutUpdatePlan['kind']; progress: number | null };
export type AboutHostUpdate = { supported: boolean; currentVersion: string | null; available: boolean | null; availableVersion: string | null; operation: typeof aboutOperationStates[number] | null; checkFailed: boolean;
  serverId?: string; channel?: 'stable' | 'beta'; plan?: AboutUpdatePlan | null; task?: AboutUpdateOperation | null };
type AboutDiagnostics = { enabled: boolean; mode: 'event-recorder' };
export type AboutResource<T> = { value: T | null; status: 'unknown' | 'ready' | 'failed'; refreshing: boolean };
export type AboutState = {
  client: AboutResource<AboutClient>; host: AboutResource<AboutHost>; opencode: AboutResource<AboutOpenCode>;
  hostUpdate: AboutResource<AboutHostUpdate>; diagnostics: AboutResource<AboutDiagnostics>;
  exporting: boolean; diagnosticsBusy: boolean; exportOutcome: 'shared' | 'cancelled' | 'failed' | null;
  diagnosticsFailed: boolean;
  exportEventCount: number | null;
  updateBusy: boolean; updateConfirm: AboutHostUpdate | null; updateFailed: boolean; updateUncertain: boolean;
};
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('about_invalid_snapshot');
  return value as Record<string, unknown>;
}
/** Opaque strings (URLs, paths, exception messages) never become diagnostic versions. */
export function aboutVersion(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text.length <= 96 && /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(text) ? text : null;
}
export function aboutBuild(value: unknown): string | null {
  return typeof value === 'string' && value.trim() === value && /^\d{1,18}(?:\.\d{1,6}){0,2}$/.test(value) ? value : null;
}
export function parseAboutClient(value: unknown): AboutClient {
  const row = object(value), updates = object(row.updates);
  if (row.schemaVersion !== 1 || updates.status !== 'unsupported') throw new Error('about_invalid_metadata');
  return { version: aboutVersion(row.version), build: aboutBuild(row.build), update: 'unsupported' };
}
export function parseAboutHost(value: unknown): AboutHost { return { version: aboutVersion(object(value).yuriVersion) }; }
export function parseAboutOpenCode(value: unknown): AboutOpenCode {
  const row = object(value);
  return { version: aboutVersion(row.serveVersion) ?? aboutVersion(row.currentVersion),
    management: aboutManagement.find(entry => entry === row.management) ?? null,
    canManage: typeof row.canManage === 'boolean' ? row.canManage : null };
}
export function parseAboutHostUpdate(value: unknown): AboutHostUpdate {
  const row = object(value);
  if (typeof row.supported !== 'boolean' || !['cli', 'electron'].includes(String(row.host)) || typeof row.serverId !== 'string' || !row.serverId || row.serverId.length > 512) throw new Error('about_invalid_host_update');
  if (!Object.hasOwn(row, 'update') || !Object.hasOwn(row, 'operation') || !Object.hasOwn(row, 'checkError')) throw new Error('about_incomplete_host_update');
  const update = row.update == null ? null : object(row.update), operation = row.operation == null ? null : object(row.operation);
  const status = operation ? aboutOperationStates.find(entry => entry === operation.status) : null;
  if (operation && !status) throw new Error('about_invalid_operation');
  const channel = row.channel === 'stable' || row.channel === 'beta' ? row.channel : undefined;
  const plan = update && channel && aboutVersion(update.version) && ['ota', 'installer', 'cli-package'].includes(String(update.kind)) &&
    typeof update.planId === 'string' && update.planId.length > 0 && update.planId.length <= 512 && typeof update.rollback === 'boolean' && typeof update.restartRequired === 'boolean'
    ? { version: aboutVersion(update.version)!, kind: update.kind as AboutUpdatePlan['kind'], planId: update.planId, rollback: update.rollback, restartRequired: update.restartRequired,
      releaseNotes: typeof update.releaseNotes === 'string' ? update.releaseNotes.slice(0, 16_384) : null } : null;
  return { supported: row.supported, currentVersion: aboutVersion(row.currentVersion), availableVersion: row.supported ? aboutVersion(update?.version) : null,
    serverId: row.serverId, channel, plan, task: operation ? parseAboutUpdateOperation(operation) : null,
    available: typeof row.available === 'boolean' ? row.available : null,
    operation: status ?? null, checkFailed: row.checkFailed === true || (row.checkError !== null && row.checkError !== undefined && row.checkError !== '') || (row.available === true && !aboutVersion(update?.version) && !operation) };
}
function parseAboutUpdateOperation(value: unknown): AboutUpdateOperation {
  const row = object(value), status = aboutOperationStates.find(state => state === row.status), version = aboutVersion(row.version);
  if (!status || !version || typeof row.id !== 'string' || !row.id || row.id.length > 512 || !['stable', 'beta'].includes(String(row.channel)) || !['ota', 'installer', 'cli-package'].includes(String(row.kind))) throw new Error('about_invalid_operation');
  return { id: row.id, status, version, channel: row.channel as 'stable' | 'beta', kind: row.kind as AboutUpdatePlan['kind'],
    progress: typeof row.progress === 'number' && Number.isFinite(row.progress) && row.progress >= 0 && row.progress <= 100 ? row.progress : null };
}
export const aboutUpdateActive = (value: AboutHostUpdate | null) => !!value?.operation && !['succeeded', 'failed'].includes(value.operation);
export function aboutReadResponse(path: string, value: unknown): unknown {
  const row = object(value), status = row.status;
  if (typeof status !== 'number' || !Number.isInteger(status)) throw new Error('about_invalid_response');
  if (path === '/api/system/update' && status === 502) return { ...object(row.body), checkFailed: true };
  if (status < 200 || status >= 300) {
    const failure = new Error('about_read_failed') as Error & { status: number };
    failure.status = status; throw failure;
  }
  return row.body;
}
export function aboutSubmitResponse(value: unknown): unknown {
  const row = object(value);
  if (typeof row.status !== 'number' || !Number.isInteger(row.status) || row.status < 200 || row.status >= 300) throw new Error('about_update_not_accepted');
  return row.body;
}
async function aboutDeadline<T>(work: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work(), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('about_update_timeout')), 8_000); })]); }
  finally { if (timer) clearTimeout(timer); }
}
function parseAboutDiagnostics(value: unknown): AboutDiagnostics {
  const row = object(value);
  if (row.schemaVersion !== 2 || row.mode !== 'event-recorder' || typeof row.enabled !== 'boolean') throw new Error('about_invalid_diagnostics');
  return { enabled: row.enabled, mode: 'event-recorder' };
}
/** Closed projection, never a recursive redactor over private server objects. */
export function aboutSafeSnapshot(state: AboutState) {
  return { schemaVersion: 1, host: { version: aboutVersion(state.host.value?.version), status: state.host.status },
    opencode: { version: aboutVersion(state.opencode.value?.version), status: state.opencode.status,
      management: aboutManagement.find(entry => entry === state.opencode.value?.management) ?? null,
      canManage: state.opencode.value?.canManage ?? null },
    hostUpdate: { status: state.hostUpdate.status, supported: state.hostUpdate.value?.supported ?? null,
      operation: state.hostUpdate.value?.operation ?? null, checkFailed: state.hostUpdate.value?.checkFailed ?? null } };
}
export type AboutDependencies = {
  read: (path: '/api/system/info' | '/api/opencode/upgrade-status' | '/api/system/update' | '/api/system/update?channel=stable' | '/api/system/update?channel=beta') => Promise<unknown>;
  /** Exact existing CGI. Injected separately so a read-only fixture cannot execute by accident. */
  submitUpdate?: (body: { version: string; channel: 'stable' | 'beta'; planId: string; allowDowngrade: boolean }) => Promise<unknown>;
  call: (name: string, input?: Record<string, unknown>) => Promise<unknown>;
  current: () => boolean; hostID: string | null; changed?: (state: AboutState) => void;
};
export function createSettingsAbout(deps: AboutDependencies) {
  let lane = createAboutLane(deps);
  return {
    state: () => lane.state(), client: () => lane.client(), host: () => lane.host(),
    opencode: () => lane.opencode(), hostUpdate: () => lane.hostUpdate(), diagnostics: () => lane.diagnostics(),
    refresh: () => lane.refresh(), cancelUpdate: () => lane.cancelUpdate(), prepareUpdate: () => lane.prepareUpdate(),
    confirmUpdate: () => lane.confirmUpdate(), reconcileUpdate: () => lane.reconcileUpdate(),
    setDiagnostics: (value: boolean) => lane.setDiagnostics(value), exportDiagnostics: () => lane.exportDiagnostics(),
    replaceLane(next: AboutDependencies) { const retained = lane.retain(); lane.dispose(); lane = createAboutLane(next, retained); next.changed?.(lane.state()); },
    dispose: () => lane.dispose(),
  };
}
function createAboutLane(input: AboutDependencies, retained?: AboutState) {
  let alive = true;
  const deps = { ...input, current: () => alive && input.current() };
  const empty = <T>(): AboutResource<T> => ({ value: null, status: 'unknown', refreshing: false });
  let state: AboutState = { client: empty(), host: empty(), opencode: empty(), hostUpdate: empty(), diagnostics: empty(), exporting: false, diagnosticsBusy: false, exportOutcome: null, exportEventCount: null, diagnosticsFailed: false,
    updateBusy: false, updateConfirm: null, updateFailed: false, updateUncertain: false };
  if (retained) state = retained;
  const set = (next: AboutState) => { if (deps.current()) { state = next; deps.changed?.(state); } };
  async function load<K extends 'client' | 'host' | 'opencode' | 'hostUpdate' | 'diagnostics'>(key: K, read: () => Promise<unknown>, parse: (value: unknown) => NonNullable<AboutState[K]['value']>) {
    if (!deps.current() || state[key].refreshing) return;
    if (key === 'hostUpdate' && state.updateBusy) return;
    if (key === 'diagnostics' && (state.diagnosticsBusy || state.exporting)) return;
    set({ ...state, [key]: { ...state[key], refreshing: true } });
    try { const value = parse(await read()); set({ ...state, [key]: { value, status: 'ready', refreshing: false } }); }
    catch (failure) {
      const status = failure && typeof failure === 'object' && 'status' in failure ? failure.status : null;
      if (key === 'hostUpdate' && [404, 501].includes(Number(status)) && !state.hostUpdate.value?.operation) {
        set({ ...state, hostUpdate: { value: { supported: false, currentVersion: null, available: null, availableVersion: null, operation: null, checkFailed: false }, status: 'ready', refreshing: false } });
      } else set({ ...state, [key]: { ...state[key], status: 'failed', refreshing: false } });
    }
  }
  const client = () => load('client', () => deps.call('native.clientMetadata'), parseAboutClient);
  const host = () => load('host', () => deps.read('/api/system/info'), parseAboutHost);
  const opencode = () => load('opencode', () => deps.read('/api/opencode/upgrade-status'), parseAboutOpenCode);
  const hostUpdate = () => load('hostUpdate', () => aboutDeadline(() => deps.read('/api/system/update')), parseAboutHostUpdate);
  const diagnostics = () => load('diagnostics', () => deps.call('native.diagnostics.status'), parseAboutDiagnostics);
  const canUpdate = (value: AboutHostUpdate | null) => value?.supported && value.currentVersion && value.plan && value.channel && !value.checkFailed && !aboutUpdateActive(value);
  return {
    retain: (): AboutState => ({ ...state, client: { ...state.client, refreshing: false }, host: { ...state.host, refreshing: false },
      opencode: { ...state.opencode, refreshing: false }, hostUpdate: { ...state.hostUpdate, refreshing: false }, diagnostics: { ...state.diagnostics, refreshing: false },
      updateBusy: false, updateConfirm: null, diagnosticsBusy: false, exporting: false }),
    dispose: () => { alive = false; },
    state: () => state, client, host, opencode, hostUpdate, diagnostics,
    refresh: () => Promise.all([client(), host(), opencode(), hostUpdate(), diagnostics()]),
    cancelUpdate() { if (!state.updateBusy) set({ ...state, updateConfirm: null }); },
    async prepareUpdate() {
      if (!deps.current() || state.updateBusy || state.hostUpdate.refreshing || state.updateUncertain || aboutUpdateActive(state.hostUpdate.value)) return;
      const previous = state.hostUpdate.value?.task;
      set({ ...state, updateBusy: true, updateConfirm: null, updateFailed: false });
      try {
        // Failed tasks must obtain a fresh plan in their ORIGINAL channel.
        const next = parseAboutHostUpdate(await aboutDeadline(() => deps.read(previous?.status === 'failed' ? `/api/system/update?channel=${previous.channel}` : '/api/system/update')));
        if (!deps.current()) return;
        set({ ...state, hostUpdate: { value: next, status: 'ready', refreshing: false } });
        if (!canUpdate(next) || (previous?.status === 'failed' && (next.plan?.version !== previous.version || next.plan.kind !== previous.kind || next.channel !== previous.channel))) throw new Error('about_plan_changed');
        set({ ...state, updateConfirm: next });
      } catch { set({ ...state, updateFailed: true }); }
      finally { set({ ...state, updateBusy: false }); }
    },
    async confirmUpdate() {
      const captured = state.updateConfirm;
      if (!deps.current() || !deps.submitUpdate || state.updateBusy || state.hostUpdate.refreshing || !canUpdate(captured) || !captured?.plan || !captured.channel) return;
      // Confirmation belongs to this exact server/plan, not any later refresh.
      if (state.hostUpdate.status !== 'ready' || !canUpdate(state.hostUpdate.value) || state.hostUpdate.value?.serverId !== captured.serverId || state.hostUpdate.value?.plan?.planId !== captured.plan.planId) { set({ ...state, updateConfirm: null, updateFailed: true }); return; }
      set({ ...state, updateBusy: true, updateConfirm: null, updateFailed: false });
      try {
        const submit = deps.submitUpdate;
        set({ ...state, updateUncertain: true });
        const result = object(await aboutDeadline(() => submit({ version: captured.plan!.version, channel: captured.channel!, planId: captured.plan!.planId, allowDowngrade: captured.plan!.rollback })));
        if (!deps.current()) return;
        const task = parseAboutUpdateOperation(result.operation);
        if (task.version !== captured.plan.version || task.channel !== captured.channel || task.kind !== captured.plan.kind) throw new Error('about_unexpected_task');
        set({ ...state, hostUpdate: { value: { ...captured, task, operation: task.status, plan: null }, status: 'ready', refreshing: false }, updateUncertain: false });
      } catch {
        // Lost POST response may already have admitted work. Never auto-replay it.
        set({ ...state, updateFailed: true, updateUncertain: true });
      } finally { set({ ...state, updateBusy: false }); }
    },
    async reconcileUpdate() {
      if (state.updateBusy || state.hostUpdate.refreshing || !deps.current()) return;
      await hostUpdate();
      if (state.hostUpdate.status === 'ready' && !state.hostUpdate.value?.checkFailed) set({ ...state, updateUncertain: false, updateFailed: false });
    },
    async setDiagnostics(enabled: boolean) {
      if (!deps.current() || state.diagnosticsBusy || state.exporting || state.diagnostics.refreshing) return;
      set({ ...state, diagnosticsBusy: true, diagnosticsFailed: false, exportOutcome: null });
      try {
        const value = parseAboutDiagnostics(await deps.call('native.diagnostics.setEnabled', { enabled }));
        if (value.enabled !== enabled) throw new Error('about_preference_not_saved');
        set({ ...state, diagnostics: { value, status: 'ready', refreshing: false } });
      } catch { set({ ...state, diagnosticsFailed: true }); }
      finally { set({ ...state, diagnosticsBusy: false }); }
    },
    async exportDiagnostics() {
      if (!deps.current() || !state.diagnostics.value?.enabled || state.diagnosticsBusy || state.exporting || !deps.hostID) return;
      set({ ...state, exporting: true, exportOutcome: null, exportEventCount: null });
      try {
        const result = object(await deps.call('native.diagnostics.export', { hostID: deps.hostID, snapshot: aboutSafeSnapshot(state) }));
        const outcome = result.outcome;
        if (!['shared', 'cancelled', 'failed'].includes(String(outcome))) throw new Error('about_invalid_export');
        set({ ...state, exportOutcome: outcome as 'shared' | 'cancelled' | 'failed', exportEventCount: typeof result.eventCount === 'number' && Number.isInteger(result.eventCount) && result.eventCount >= 0 && result.eventCount <= 500 ? result.eventCount : null });
      } catch { set({ ...state, exportOutcome: 'failed' }); }
      finally { set({ ...state, exporting: false }); }
    },
  };
}
