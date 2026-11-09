/** Local native SSH service only. No default bridge, Electron IPC, credential or Storage fallback. */
export type DesktopSshInstance = Readonly<{
  id: string; label: string; host: string; user: string; port: number;
  remotePort: number; localPort: number; managed: boolean;
}>;
export const desktopSshPhases = ['idle', 'auth_check', 'remote_probe', 'checked', 'installing', 'updating', 'server_detecting', 'forwarding', 'ready', 'reconnecting', 'error'] as const;
export type DesktopSshStatus = Readonly<{
  id: string; attempt: number; requestID: string; phase: typeof desktopSshPhases[number];
  error: string | null; retry: number; running: boolean; connectionID: string | null;
}>;
export type DesktopSshSnapshot = Readonly<{ revision: number; saving: boolean; instances: readonly DesktopSshInstance[]; statuses: readonly DesktopSshStatus[]; receipts: readonly string[] }>;
export type DesktopSshSelections = Readonly<{ fileGroups: readonly boolean[]; singleFiles: readonly boolean[]; directories: readonly boolean[]; agentsRoot: boolean; providerCredentials: boolean; magpie: boolean }>;
export const desktopSshDirectories = ['agents', 'commands', 'skills', 'snippet', 'snippets', 'plugins'] as const;
export function desktopSshDefaultSelections(): DesktopSshSelections { return { fileGroups: [true], singleFiles: [true, true], directories: desktopSshDirectories.map(() => true), agentsRoot: true, providerCredentials: false, magpie: false }; }
type Count = Readonly<{ fileCount: number; bytes: number }>;
export type DesktopSshPreview = Readonly<{ runID: string; phase: 'review'; direction: 'push' | 'pull'; files: readonly { name: string; bytes: number }[]; directories: readonly (Count & { name: string })[]; agentsRoot: Count | null; deletes: readonly string[] }>;
export type DesktopSshHistory = Readonly<{ direction: 'push' | 'pull'; runs: readonly Readonly<{ schema: 1; runID: string; phase: 'prepared' | 'applying' | 'unknown' | 'success' | 'failure'; startedAt: string; endedAt: string | null; files: number; bytes: number; applied: number }>[] }>;
export type DesktopSshSyncStatus = Readonly<{ runID: string; phase: 'review' | 'applying' | 'unknown' | 'success' | 'failure' }>;
export type DesktopRemoteConnectionsPort = Readonly<{
  /** Native actor lifetime, NOT the active remote Host or the currently selected UI page. */
  current(): boolean;
  /** Operation readiness is separate from the monotonic native owner lifetime. */
  ready?(): boolean;
  refreshCapabilities?(): Promise<void>;
  newID(): string;
  read(): Promise<unknown>;
  save(input: { requestID: string; revision: number; instance: DesktopSshInstance }): Promise<unknown>;
  remove(input: { requestID: string; revision: number; id: string }): Promise<unknown>;
  start(input: { requestID: string; id: string; intent: 'connect' | 'restore' | 'check' }): Promise<unknown>;
  cancel(input: { id: string; attempt: number }): Promise<unknown>;
 } & ({ readonly syncSupported: false } | {
   readonly syncSupported?: true;
   /** Adapter binds sync to this exact SSH attempt/committed receipt; never resolve current Host. */
   syncPreview(input: { id: string; attempt: number; runID: string; direction: 'push' | 'pull'; selections: DesktopSshSelections }): Promise<unknown>;
  syncApply(input: { id: string; attempt: number; runID: string }): Promise<unknown>;
   syncStatus(input: { id: string; attempt: number; runID: string }): Promise<unknown>;
   syncHistory(input: { id: string; attempt: number; direction: 'push' | 'pull' }): Promise<unknown>;
})>;
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('ssh_invalid');
  return value as Record<string, unknown>;
}
function exact(value: unknown, keys: readonly string[]) {
  const row = object(value);
  if (Object.keys(row).length !== keys.length || keys.some(key => !(key in row))) throw new Error('ssh_invalid');
  return row;
}
function integer(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error('ssh_invalid');
  return value;
}
function text(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || !value.length || value.length > maximum || /[\u0000-\u001f\u007f-\u009f]/.test(value)) throw new Error('ssh_invalid');
  let bytes = 0;
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff) throw new Error('ssh_invalid');
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  if (bytes > maximum) throw new Error('ssh_invalid');
  return value;
}
function id(value: unknown): string { if (!identifier(value)) throw new Error('ssh_invalid'); return value; }
function boolean(value: unknown): boolean { if (typeof value !== 'boolean') throw new Error('ssh_invalid'); return value; }
function array(value: unknown, maximum: number): unknown[] { if (!Array.isArray(value) || value.length > maximum) throw new Error('ssh_invalid'); return value; }
const errorCodes = ['ssh_invalid', 'ssh_stale', 'ssh_busy', 'ssh_storage', 'ssh_commit_unknown', 'ssh_unavailable', 'ssh_cancelled', 'ssh_transport', 'ssh_runtime', 'ssh_bootstrap', 'ssh_authentication', 'ssh_sync_unknown'] as const;
export function desktopSshInstance(value: unknown): DesktopSshInstance {
  const row = exact(value, ['id', 'label', 'host', 'user', 'port', 'remotePort', 'localPort', 'managed']);
  const host = text(row.host, 253), user = text(row.user, 64);
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(host) || !/^[A-Za-z0-9._][A-Za-z0-9._-]*$/.test(user)) throw new Error('ssh_invalid');
  return Object.freeze({ id: id(row.id), label: text(row.label, 240), host, user, port: integer(row.port, 1, 65535), remotePort: integer(row.remotePort, 1, 65535), localPort: integer(row.localPort, 0, 65535), managed: boolean(row.managed) });
}
export function desktopSshSnapshot(value: unknown): DesktopSshSnapshot {
  const row = exact(value, ['revision', 'saving', 'instances', 'statuses', 'receipts']);
  const instances = array(row.instances, 32).map(desktopSshInstance), seen = new Set(instances.map(row => row.id));
  if (seen.size !== instances.length) throw new Error('ssh_invalid');
  const statuses = array(row.statuses, 32).map(value => {
    const row = exact(value, ['id', 'attempt', 'requestID', 'phase', 'error', 'retry', 'running', 'connectionID']);
    const phase = desktopSshPhases.find(phase => phase === row.phase);
    if (!phase || row.error !== null && !errorCodes.some(code => code === row.error) || !seen.has(id(row.id))) throw new Error('ssh_invalid');
    const error = row.error === null ? null : text(row.error, 40), connectionID = row.connectionID === null ? null : text(row.connectionID, 256);
    if (phase === 'ready' && !connectionID || phase !== 'ready' && connectionID !== null) throw new Error('ssh_invalid');
    return Object.freeze({ id: id(row.id), attempt: integer(row.attempt, 1, Number.MAX_SAFE_INTEGER), requestID: id(row.requestID), phase, error, retry: integer(row.retry, 0, 5), running: boolean(row.running), connectionID });
  });
  if (new Set(statuses.map(row => row.id)).size !== statuses.length) throw new Error('ssh_invalid');
  return Object.freeze({ revision: integer(row.revision, 0, Number.MAX_SAFE_INTEGER), saving: boolean(row.saving), instances: Object.freeze(instances), statuses: Object.freeze(statuses), receipts: Object.freeze(array(row.receipts, 4096).map(id)) });
}
const configNames = ['config.json', 'opencode.json', 'opencode.jsonc'];
const fileNames = [...configNames, 'AGENTS.md', 'cursor-models.json'];
const deleteNames = [...configNames, ...desktopSshDirectories, 'agent', 'command', 'skill'];
const maxBytes = 512 * 1024 * 1024;
function member(value: unknown, names: readonly string[]): string { if (typeof value !== 'string' || !names.includes(value)) throw new Error('ssh_invalid'); return value; }
function unique(names: readonly string[]) { if (new Set(names).size !== names.length) throw new Error('ssh_invalid'); }
export function desktopSshSelections(value: unknown): DesktopSshSelections {
  const row = exact(value, ['fileGroups', 'singleFiles', 'directories', 'agentsRoot', 'providerCredentials', 'magpie']);
  function flags(value: unknown, count: number) { const items = array(value, count); if (items.length !== count) throw new Error('ssh_invalid'); return Object.freeze(items.map(boolean)); }
  return Object.freeze({ fileGroups: flags(row.fileGroups, 1), singleFiles: flags(row.singleFiles, 2), directories: flags(row.directories, 6), agentsRoot: boolean(row.agentsRoot), providerCredentials: boolean(row.providerCredentials), magpie: boolean(row.magpie) });
}
export function desktopSshPreview(value: unknown): DesktopSshPreview {
  const row = exact(value, ['runID', 'phase', 'direction', 'files', 'directories', 'agentsRoot', 'deletes']);
  if (row.phase !== 'review' || row.direction !== 'push' && row.direction !== 'pull') throw new Error('ssh_invalid');
  const files = array(row.files, 3).map(value => { const row = exact(value, ['name', 'bytes']); return { name: member(row.name, fileNames), bytes: integer(row.bytes, 0, maxBytes) }; });
  const count = (row: Record<string, unknown>): Count => ({ fileCount: integer(row.fileCount, 0, 20000), bytes: integer(row.bytes, 0, maxBytes) });
  const directories = array(row.directories, 6).map(value => { const row = exact(value, ['name', 'fileCount', 'bytes']); return { name: member(row.name, desktopSshDirectories), ...count(row) }; });
  const agentsRoot = row.agentsRoot === null ? null : count(exact(row.agentsRoot, ['fileCount', 'bytes']));
  const deletes = array(row.deletes, deleteNames.length).map(value => member(value, deleteNames));
  unique(files.map(v => v.name)); unique(directories.map(v => v.name)); unique(deletes);
  if (files.filter(v => configNames.includes(v.name)).length > 1 || files.reduce((n, v) => n + v.bytes, 0) + directories.reduce((n, v) => n + v.bytes, 0) + (agentsRoot?.bytes ?? 0) > maxBytes) throw new Error('ssh_invalid');
  return { runID: id(row.runID), phase: row.phase, direction: row.direction, files, directories, agentsRoot, deletes };
}
export function desktopSshHistory(value: unknown): DesktopSshHistory {
  const row = exact(value, ['direction', 'runs']);
  if (row.direction !== 'push' && row.direction !== 'pull') throw new Error('ssh_invalid');
  const timestamp = (value: unknown) => { if (typeof value !== 'string' || !/^\d{20,39}$/.test(value)) throw new Error('ssh_invalid'); return value; };
  const runs = array(row.runs, 4096).map(value => {
    const v = exact(value, ['schema', 'runID', 'phase', 'startedAt', 'endedAt', 'files', 'bytes', 'applied']);
    const phase = (['prepared', 'applying', 'unknown', 'success', 'failure'] as const).find(phase => phase === v.phase);
    if (v.schema !== 1 || !phase) throw new Error('ssh_invalid');
    return { schema: 1 as const, runID: id(v.runID), phase, startedAt: timestamp(v.startedAt), endedAt: v.endedAt === null ? null : timestamp(v.endedAt), files: integer(v.files, 0, 20000), bytes: integer(v.bytes, 0, maxBytes), applied: integer(v.applied, 0, 40000) };
  });
  unique(runs.map(v => v.runID)); return { direction: row.direction, runs };
}
export function desktopSshSyncStatus(value: unknown): DesktopSshSyncStatus {
  const row = exact(value, ['runID', 'phase']);
  const phase = (['review', 'applying', 'unknown', 'success', 'failure'] as const).find(phase => phase === row.phase);
  if (!phase) throw new Error('ssh_invalid');
  return { runID: id(row.runID), phase };
}
/** Only the native adapter may classify a negative acknowledgement as definitely not committed. */
export class DesktopSshDenied extends Error {
  constructor(code: 'ssh_invalid' | 'ssh_stale' | 'ssh_busy' | 'ssh_storage' | 'ssh_authentication') { super(code); }
}
/** Local preflight proof; never inferred from an arbitrary transport error. */
export class DesktopSshNotDispatched extends Error { constructor() { super('ssh_unavailable'); } }
export type DesktopRemoteConnectionsState = Readonly<{
  snapshot: DesktopSshSnapshot | null; ready: boolean; reading: boolean; busy: boolean; failed: boolean;
   unknown: string | null; preview: DesktopSshPreview | null; sync: DesktopSshSyncStatus | null; history: DesktopSshHistory | null;
}>;
export type DesktopSshConnectionResult = Readonly<{ status: 'accepted' | 'failed' | 'stale' | 'unsupported' | 'unknown' }>;
export type DesktopSshConnectionDemand = Readonly<{ source: 'header' | 'settings'; current(): boolean }>;
export type DesktopSshConnectionOperation = Readonly<{
  requestID: string; target: DesktopSshInstance; intent: 'connect' | 'restore'; source: DesktopSshConnectionDemand['source'];
  dispatched: boolean; phase: 'admitting' | 'dispatching' | 'running' | 'unknown' | 'settled';
  attempt: number | null; outcome: 'ready' | 'error' | 'idle' | 'denied' | 'not-dispatched' | null; connectionID: string | null;
}>;
export type DesktopSshConnectionAdmission = (mutation: Readonly<{
  target: DesktopSshInstance; intent: 'connect' | 'restore'; source: DesktopSshConnectionDemand['source']; requestID: string;
  current(): boolean;
  /** Excludes ONLY this exact pre-dispatch reservation, not another pending/unknown operation. */
  canLeave(): boolean;
  /** Main must prepare all owners and await old-writer release ACK BEFORE invoking this once. */
  dispatch(): Promise<DesktopSshConnectionResult>;
}>) => Promise<DesktopSshConnectionResult>;
export type DesktopRemoteConnectionsOptions = Readonly<{
  connectionMutation?: DesktopSshConnectionAdmission;
  connectionAvailable?(source: DesktopSshConnectionDemand['source']): boolean;
}>;
const sameInstance = (a: DesktopSshInstance, b: DesktopSshInstance) => a.id === b.id && a.label === b.label && a.host === b.host && a.user === b.user && a.port === b.port && a.remotePort === b.remotePort && a.localPort === b.localPort && a.managed === b.managed;
export function createDesktopRemoteConnectionsController(port: DesktopRemoteConnectionsPort, options: DesktopRemoteConnectionsOptions = {}) {
  let state: DesktopRemoteConnectionsState = { snapshot: null, ready: false, reading: false, busy: false, failed: false, unknown: null, preview: null, sync: null, history: null };
  const listeners = new Set<() => void>();
  let active = false, live = true, generation = 0, reading = false;
  let proof: ((snapshot: DesktopSshSnapshot) => boolean) | null = null;
  let syncTarget: { id: string; attempt: number; runID: string } | null = null;
  let admission: object | null = null, connection: DesktopSshConnectionOperation | null = null, nativePending = false;
  let preparationCurrent: (() => boolean) | null = null;
  const connectionBlocked = () => !!connection && connection.phase !== 'settled';
  const otherwiseCanLeave = () => !state.busy && !state.unknown && state.sync?.phase !== 'applying' && state.sync?.phase !== 'unknown' && !state.snapshot?.saving && !nativePending;
  const canLeave = () => !admission && !connectionBlocked() && otherwiseCanLeave();
  const connectionAvailable = (source: DesktopSshConnectionDemand['source']) => !!options.connectionMutation && (options.connectionAvailable?.(source) ?? true);
  function connectionPatch(patch: Partial<DesktopSshConnectionOperation>) { if (connection) connection = Object.freeze({ ...connection, ...patch }); }
  const current = () => live && port.current();
  const ready = () => current() && (port.ready?.() ?? true);
  function publish(patch: Partial<DesktopRemoteConnectionsState>) { if (!live) return; state = { ...state, ...patch }; for (const listener of listeners) { try { listener(); } catch { /* One retired view cannot block other subscribers. */ } } }
  function newID() { return id(port.newID()); }
  function accept(value: unknown) {
    const snapshot = desktopSshSnapshot(value);
    if (state.snapshot && snapshot.revision < state.snapshot.revision) throw new Error('ssh_stale');
    const confirmed = proof?.(snapshot) === true;
    if (confirmed) proof = null;
    nativePending = snapshot.statuses.some(row => row.running || !['idle', 'checked', 'ready', 'error'].includes(row.phase));
    if (connection?.dispatched && connection.phase !== 'settled') {
      const status = snapshot.statuses.find(row => row.id === connection!.target.id && row.requestID === connection!.requestID && (connection!.attempt === null || row.attempt === connection!.attempt));
      const row = snapshot.instances.find(row => row.id === connection!.target.id);
      if (status && row && sameInstance(row, connection.target) && snapshot.receipts.includes(connection.requestID)) {
        const terminal = !status.running && (status.phase === 'ready' || status.phase === 'error' || status.phase === 'idle');
        connectionPatch({ attempt: status.attempt, phase: terminal ? 'settled' : 'running', outcome: terminal ? status.phase as 'ready' | 'error' | 'idle' : null, connectionID: terminal ? status.connectionID : null });
      }
    }
    const resolved = confirmed || connection?.phase === 'settled' && state.unknown === connection.requestID;
    publish({ snapshot, ...(resolved ? { unknown: connection?.phase === 'unknown' ? connection.requestID : null } : {}) });
    return confirmed;
  }
  async function refreshCapabilities() {
    if (!current()) return false;
    try {
      await port.refreshCapabilities?.();
      if (!current()) return false;
      const available = ready(); publish({ ready: available }); return available;
    } catch { if (current()) publish({ ready: false, failed: true }); return false; }
  }
  async function refresh(explicit = false) {
    if (!current() || !active && !explicit || reading || state.busy) return;
    reading = true; const turn = generation;
    publish({ reading: true });
    try {
      if (port.refreshCapabilities) {
        if (!await refreshCapabilities() || !current() || !active && !explicit || turn !== generation) return;
      } else { publish({ ready: ready() }); if (!ready()) return; }
      const result = await port.read();
      if (current() && (active || explicit) && turn === generation) { accept(result); publish({ failed: false }); }
    } catch { if (current() && (active || explicit) && turn === generation) publish({ failed: true, ready: ready() }); }
    finally {
      reading = false; publish({ reading: false });
      if (!explicit && current() && active && turn !== generation) void refresh();
    }
  }
  async function mutate(request: string, invoke: () => Promise<unknown>, confirmed: (snapshot: DesktopSshSnapshot) => boolean, connecting = false, cancelling = false) {
    if (!ready() || !connecting && (!active || !!admission || connectionBlocked() && !cancelling) || state.busy || state.unknown || state.sync?.phase === 'unknown' || !state.snapshot || state.snapshot.saving) return false;
    ++generation; publish({ busy: true, failed: false }); proof = confirmed;
    try {
      const result = await invoke();
      if (!current()) throw new Error('ssh_unknown');
      if (!accept(result)) throw new Error('ssh_unconfirmed');
      return true;
    } catch (error) {
      const denied = current() && (error instanceof DesktopSshDenied || error instanceof DesktopSshNotDispatched);
      if (connecting) connectionPatch(denied ? { phase: 'settled', outcome: 'denied' } : { phase: 'unknown', outcome: null });
      if (denied) { proof = null; publish({ failed: true }); } else publish({ failed: true, unknown: request });
      return false;
    } finally { publish({ busy: false }); }
  }
  function target(id: string) {
    const status = state.snapshot?.statuses.find(row => row.id === id);
    if (!status || status.phase !== 'ready' || status.running) throw new Error('ssh_stale');
    return { id, attempt: status.attempt };
  }
  async function connect(target: DesktopSshInstance, demand: DesktopSshConnectionDemand, intent: 'connect' | 'restore' = 'connect'): Promise<DesktopSshConnectionResult> {
    if (!connectionAvailable(demand.source)) return { status: 'unsupported' };
    if (!canLeave() || !ready() || !state.ready || state.failed || !state.snapshot) return { status: 'stale' };
    const captured = desktopSshInstance(target), before = state.snapshot.statuses.find(row => row.id === captured.id);
    const ticket = {}, requestID = newID();
    let accepting = true, flight: Promise<DesktopSshConnectionResult> | undefined;
    const exactTarget = () => {
      const row = state.snapshot?.instances.find(row => row.id === captured.id), status = state.snapshot?.statuses.find(row => row.id === captured.id);
      return !!row && sameInstance(row, captured) && (!status || !status.running && status.phase !== 'ready' && status.phase !== 'reconnecting')
        && before?.attempt === status?.attempt && before?.requestID === status?.requestID && before?.phase === status?.phase;
    };
    const exact = () => accepting && admission === ticket && current() && ready() && state.ready && !state.failed && demand.current() && otherwiseCanLeave() && exactTarget();
    if (!demand.current() || !exactTarget()) return { status: 'stale' };
    admission = ticket;
    connection = Object.freeze({ requestID, target: captured, intent, source: demand.source, dispatched: false, phase: 'admitting', attempt: null, outcome: null, connectionID: null });
    preparationCurrent = exact;
    publish({});
    const mutation = Object.freeze({ target: captured, intent, source: demand.source, requestID, current: exact,
      canLeave: () => exact(),
      dispatch(): Promise<DesktopSshConnectionResult> {
        if (flight || !exact()) return Promise.resolve({ status: 'stale' });
        connectionPatch({ dispatched: true, phase: 'dispatching' });
        flight = (async () => {
          const accepted = await mutate(requestID, () => port.start({ requestID, id: captured.id, intent }), snapshot => snapshot.receipts.includes(requestID), true);
          if (connection?.requestID === requestID && connection.phase === 'dispatching') { connectionPatch({ phase: 'unknown' }); publish({ unknown: requestID }); }
          return { status: connection?.phase === 'unknown' ? 'unknown' : accepted ? 'accepted' : 'failed' };
        })();
        return flight;
      },
    });
    try {
      const result = await options.connectionMutation!(mutation);
      // The callback is not a native receipt. An already-dispatched flight must settle even if its UI closed or callback threw.
      if (flight) return await flight;
      return { status: result?.status === 'accepted' ? 'unsupported' : result?.status === 'unknown' ? 'failed' : result?.status ?? 'failed' };
    } catch { return flight ? await flight : { status: 'failed' }; }
    finally {
      accepting = false;
      if (admission === ticket) { admission = null; preparationCurrent = null; }
      if (connection?.requestID === requestID && !connection.dispatched) connectionPatch({ phase: 'settled', outcome: 'not-dispatched' });
      publish({});
    }
  }
  return {
    state: () => state, current, ready, refreshCapabilities, newID, refresh: () => refresh(), readConnectionResult: () => refresh(true), syncSupported: () => port.syncSupported !== false,
    canLeave, connectionAvailable, connect, connectionOperation: () => connection,
    /** Settings may prepare its SAME clean target under its own confirmation.
     * The window/root guard still vetoes; this is never a native dispatch grant. */
    canPrepareConnection(target: DesktopSshInstance) {
      return canLeave() || !!admission && connection?.source === 'settings' && connection.phase === 'admitting' && sameInstance(connection.target, target) && preparationCurrent?.() === true;
    },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    setActive(value: boolean) { if (active === value) return; active = value; ++generation; if (value) void refresh(); },
    save(instance: DesktopSshInstance, revision = state.snapshot?.revision ?? -1) { const row = desktopSshInstance(instance), requestID = newID(); return mutate(requestID, () => port.save({ requestID, revision, instance: row }), snapshot => snapshot.receipts.includes(requestID)); },
    remove(id: string, revision = state.snapshot?.revision ?? -1) { const requestID = newID(); return mutate(requestID, () => port.remove({ requestID, revision, id }), snapshot => snapshot.receipts.includes(requestID)); },
    start(id: string, intent: 'connect' | 'restore' | 'check', demand: DesktopSshConnectionDemand = { source: 'settings', current: () => active }) {
      if (intent !== 'check') { const row = state.snapshot?.instances.find(row => row.id === id); return row ? connect(row, demand, intent).then(result => result.status === 'accepted') : Promise.resolve(false); }
      const requestID = newID(); return mutate(requestID, () => port.start({ requestID, id, intent }), snapshot => snapshot.receipts.includes(requestID));
    },
    cancel(id: string, attempt: number) { return mutate(`cancel-${attempt}`, () => port.cancel({ id, attempt }), snapshot => snapshot.statuses.some(row => row.id === id && row.attempt === attempt && row.phase === 'idle'), false, connection?.phase === 'running' && connection.target.id === id && connection.attempt === attempt); },
    async preview(id: string, direction: 'push' | 'pull', selections: DesktopSshSelections = desktopSshDefaultSelections()) {
      if (port.syncSupported === false || !ready() || !active || admission || connectionBlocked() || state.busy || state.unknown || state.sync?.phase === 'unknown') return false;
      let captured: { id: string; attempt: number; runID: string };
      try { captured = { ...target(id), runID: newID() }; } catch { publish({ failed: true }); return false; }
      const turn = ++generation;
      syncTarget = captured; publish({ busy: true, preview: null, sync: null, failed: false });
      try {
        const preview = desktopSshPreview(await port.syncPreview({ ...captured, direction, selections: desktopSshSelections(selections) }));
        if (!current() || !active || generation !== turn) return false;
        if (preview.runID !== captured.runID || preview.direction !== direction) throw new Error('ssh_invalid');
        publish({ preview }); return true;
      } catch { if (current() && generation === turn) publish({ failed: true }); return false; }
      finally { publish({ busy: false }); }
    },
    async apply() {
      if (port.syncSupported === false || !ready() || !active || admission || connectionBlocked() || state.busy || !state.preview || !syncTarget || state.sync || state.unknown) return false;
      const captured = syncTarget;
      let capturedTarget: { id: string; attempt: number };
      try { capturedTarget = target(captured.id); } catch { publish({ failed: true }); return false; }
      if (capturedTarget.attempt !== captured.attempt) return false;
      publish({ busy: true, failed: false, sync: { runID: captured.runID, phase: 'applying' } });
      try {
        const result = desktopSshSyncStatus(await port.syncApply(captured));
        if (!current()) return false;
        if (result.runID !== captured.runID) throw new Error('ssh_invalid');
        publish({ sync: result }); return result.phase === 'success';
      } catch (error) { if (current()) publish({ failed: true, sync: { runID: captured.runID, phase: error instanceof DesktopSshDenied ? 'failure' : 'unknown' } }); return false; }
      finally { publish({ busy: false }); }
    },
    async refreshSync() {
      if (port.syncSupported === false || !ready() || !active || !syncTarget || state.busy) return;
      const captured = syncTarget, turn = generation;
      publish({ busy: true });
      try { const result = desktopSshSyncStatus(await port.syncStatus(captured)); if (result.runID !== captured.runID) throw new Error('ssh_invalid'); if (current() && active && turn === generation) publish({ sync: result }); }
      catch { if (current() && turn === generation) publish({ failed: true }); }
      finally { publish({ busy: false }); }
    },
    async history(id: string, direction: 'push' | 'pull') {
      if (port.syncSupported === false || !ready() || !active || state.busy) return false;
      let captured: { id: string; attempt: number };
      try { captured = target(id); } catch { publish({ failed: true }); return false; }
      const turn = ++generation; publish({ busy: true, failed: false });
      try { const history = desktopSshHistory(await port.syncHistory({ ...captured, direction })); if (history.direction !== direction) throw new Error('ssh_invalid'); if (!current() || !active || turn !== generation) return false; publish({ history }); return true; }
      catch { if (current() && turn === generation) publish({ failed: true }); return false; }
      finally { publish({ busy: false }); }
    },
    clearPreview() { if (!state.busy && state.sync?.phase !== 'unknown') { ++generation; syncTarget = null; publish({ preview: null, sync: null, history: null }); } },
    dispose() { live = false; active = false; ++generation; listeners.clear(); },
  };
}
export type DesktopRemoteConnectionsController = ReturnType<typeof createDesktopRemoteConnectionsController>;
