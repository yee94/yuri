import { gitHubAccountKey, gitHubComplete, gitHubCurrentSelection, gitHubFlow, gitHubRemovalRejected, gitHubSelection, gitHubStatus, gitObject, type GitHubAccount, type GitHubFlow, type GitHubSelection, type GitHubStatus, type GitSettingsRequest } from './settings-github-protocol';

type GitHubIssue = 'read' | 'start' | 'expired' | 'denied' | 'unknown' | 'open' | 'identity' | 'unsupported' | null;
type Pending = { kind: 'connect' } | { kind: 'activate'; key: string } | { kind: 'remove'; key: string } | { kind: 'cli'; disabled: boolean };
export type GitHubState = {
  status: GitHubStatus | null; refreshing: boolean; busy: boolean; issue: GitHubIssue;
  flow: { userCode: string; url: string; cancellable: boolean } | null; removal: GitHubAccount | null;
  cancellation: 'stopping' | 'cancelled' | 'unknown' | 'unsupported' | null;
  pending: Pending | null; reconciled: boolean; connected: boolean; exchanging: boolean; needsReadback: boolean;
};
export type GitHubDependencies = { request: GitSettingsRequest; current: () => boolean; open: (url: string) => Promise<boolean>; changed?: (state: GitHubState) => void };

/** One captured Host generation. No storage, credentials, runtime globals, or automatic write retry. */
export function createSettingsGitHub(deps: GitHubDependencies) {
  let lane = createGitHubLane(deps);
  return {
    state: () => lane.state(), refresh: () => lane.refresh(), connect: () => lane.connect(),
    open: () => lane.open(), cancel: () => lane.cancel(),
    activate: (...args: Parameters<typeof lane.activate>) => lane.activate(...args),
    requestRemoval: (...args: Parameters<typeof lane.requestRemoval>) => lane.requestRemoval(...args),
    confirmRemoval: () => lane.confirmRemoval(), cancelRemoval: () => lane.cancelRemoval(),
    setCliDisabled: (value: boolean) => lane.setCliDisabled(value),
    acknowledgeUnknown: () => lane.acknowledgeUnknown(), setActive: (value: boolean) => lane.setActive(value),
    dispose: () => lane.dispose(),
    replaceLane(next: GitHubDependencies) {
      const retained = lane.retain(); lane.dispose(false); lane = createGitHubLane(next, retained);
      next.changed?.(lane.state());
    },
  };
}
function createGitHubLane(deps: GitHubDependencies, retained?: { state: GitHubState; removalExpected: GitHubSelection | null }) {
  let state: GitHubState = { status: null, refreshing: false, busy: false, issue: null, flow: null, removal: null, cancellation: null, pending: null, reconciled: false, connected: false, exchanging: false, needsReadback: false };
  let active = false, disposed = false, revision = 0, readVersion = 0;
  let lease: { wire: GitHubFlow; deadline: number; interval: number; polls: number; revision: number } | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined, expiry: ReturnType<typeof setTimeout> | undefined;
  let completing = false;
  let cancellationVersion = 0, removalExpected: GitHubSelection | null = null;
  if (retained) { state = retained.state; removalExpected = retained.removalExpected; }
  const current = () => !disposed && deps.current();
  const available = () => current() && active;
  const publish = (patch: Partial<GitHubState>) => { state = { ...state, ...patch }; if (current()) deps.changed?.(state); };
  function invalidateReads() { readVersion++; publish({ refreshing: false }); }
  function timers() { clearTimeout(timer); clearTimeout(expiry); timer = undefined; expiry = undefined; }
  function clearLease() { timers(); if (lease) { lease.wire.deviceCode = ''; lease.wire.userCode = ''; } lease = null; revision++; publish({ flow: null }); }
  const cancellationWire = () => lease ? { deviceCode: lease.wire.deviceCode, cancellable: lease.wire.cancellable } : null;
  async function stopOnHost(wire: { deviceCode: string; cancellable: boolean } | null, notify = true) {
    if (!wire) return;
    const version = ++cancellationVersion;
    if (!wire.cancellable) { if (notify && current()) publish({ cancellation: 'unsupported' }); return; }
    // Destruction may release a lease on the same Host, never on a replacement Host.
    if (!deps.current()) return;
    if (notify && current()) publish({ cancellation: 'stopping', pending: { kind: 'connect' }, reconciled: false });
    try {
      const result = gitObject(await deps.request('/api/github/auth/cancel', 'POST', { deviceCode: wire.deviceCode }));
      if (!notify || !current() || version !== cancellationVersion) return;
      if (result.cancelled !== true || result.status !== 'cancelled' || result.providerRevoked !== false) throw new Error('Unconfirmed Host cancellation');
      publish({ cancellation: 'cancelled', ...(state.pending?.kind === 'connect' ? { pending: null, reconciled: false, issue: state.issue === 'unknown' ? null : state.issue } : {}) });
    } catch { if (notify && current() && version === cancellationVersion) { invalidateReads(); publish({ cancellation: 'unknown', pending: { kind: 'connect' }, issue: 'unknown', reconciled: false }); } }
  }
  function expireLease() {
    const wire = cancellationWire();
    const unknown = completing; clearLease(); if (unknown) invalidateReads();
    publish(unknown ? { pending: { kind: 'connect' }, issue: 'unknown', reconciled: false } : { issue: 'expired' });
    void stopOnHost(wire);
  }
  function pendingResolved(value: GitHubStatus) {
    const pending = state.pending;
    if (!pending) return false;
    if (pending.kind === 'activate') return value.accounts.some(account => account.current && gitHubAccountKey(account) === pending.key);
    if (pending.kind === 'remove') return !value.accounts.some(account => gitHubAccountKey(account) === pending.key);
    return pending.kind === 'cli' && value.ghCli?.disabled === pending.disabled;
  }
  async function refresh() {
    if (!available() || state.refreshing) return;
    const version = ++readVersion;
    publish({ refreshing: true });
    try {
      const value = gitHubStatus(await deps.request('/api/github/auth/status'));
      if (!available() || version !== readVersion) return;
      const resolved = pendingResolved(value);
      publish({ status: value, needsReadback: false, reconciled: !!state.pending, ...(resolved ? { pending: null } : {}), issue: state.pending && !resolved ? 'unknown' : !resolved && (state.issue === 'expired' || state.issue === 'denied') ? state.issue : null });
    } catch { if (available() && version === readVersion) publish({ issue: state.pending ? 'unknown' : 'read' }); }
    finally { if (current() && version === readVersion) publish({ refreshing: false }); }
  }
  function schedule() {
    timers();
    if (!available() || !lease) return;
    const remaining = lease.deadline - Date.now();
    if (remaining <= 0 || lease.polls >= 1800) { expireLease(); return; }
    expiry = setTimeout(expireLease, remaining);
    timer = setTimeout(() => { void poll(); }, Math.min(lease.interval, remaining));
  }
  async function poll() {
    const captured = lease;
    if (!available() || !captured || completing) return;
    if (Date.now() >= captured.deadline) { clearLease(); publish({ issue: 'expired' }); return; }
    captured.polls++; completing = true; publish({ exchanging: true });
    try {
      const result = gitHubComplete(await deps.request('/api/github/auth/complete', 'POST', { deviceCode: captured.wire.deviceCode }));
      if (!current() || lease !== captured) return;
      if (result === 'connected') {
        invalidateReads();
        clearLease(); publish({ connected: true, needsReadback: true, issue: null });
        if (available()) await refresh();
        return;
      }
      if (result === 'expired_token' || result === 'access_denied') { clearLease(); publish({ issue: result === 'expired_token' ? 'expired' : 'denied' }); return; }
      if (result === 'slow_down') captured.interval += 5000;
    } catch {
      if (current() && lease === captured) { const wire = cancellationWire(); clearLease(); invalidateReads(); publish({ pending: { kind: 'connect' }, reconciled: false, issue: 'unknown' }); await stopOnHost(wire); }
    } finally {
      completing = false;
      if (current()) publish({ exchanging: false, ...(lease !== captured && state.pending?.kind === 'connect' ? { reconciled: false } : {}) });
      if (lease === captured) schedule();
    }
  }
  async function open() {
    if (!available() || !lease) return;
    const captured = lease;
    try { const opened = await deps.open(captured.wire.url); if (available() && lease === captured) { if (!opened) publish({ issue: 'open' }); else if (state.issue === 'open') publish({ issue: null }); } }
    catch { if (available() && lease === captured) publish({ issue: 'open' }); }
  }
  async function connect() {
    if (!available() || state.busy || state.refreshing || state.pending || state.needsReadback || !state.status || lease || completing) return;
    const ticket = ++revision;
    cancellationVersion++;
    publish({ busy: true, issue: null, connected: false, cancellation: null });
    publish({ pending: { kind: 'connect' } });
    try {
      const wire = gitHubFlow(await deps.request('/api/github/auth/start', 'POST', {}));
      if (!available() || ticket !== revision) { await stopOnHost(wire, !disposed); wire.deviceCode = ''; return; }
      lease = { wire, deadline: Date.now() + wire.expiresIn * 1000, interval: wire.interval * 1000, polls: 0, revision: ticket };
      publish({ pending: null, flow: { userCode: wire.userCode, url: wire.url, cancellable: wire.cancellable } }); schedule(); await open();
    } catch { if (available() && ticket === revision) publish({ pending: null, issue: 'start' }); }
    finally { if (current()) publish({ busy: false }); }
  }
  async function cancel() {
    if (!available()) return;
    const wire = cancellationWire(), unknown = completing || state.pending?.kind === 'connect';
    clearLease(); if (unknown) invalidateReads(); publish({ removal: null, ...(unknown ? { pending: { kind: 'connect' }, reconciled: false, issue: 'unknown' } : { issue: null }) });
    await stopOnHost(wire);
  }
  async function mutate(pending: Pending, path: string, method: string, body: unknown, validate: (result: unknown) => void) {
    if (!available() || state.busy || state.refreshing || state.pending || state.needsReadback || !state.status || lease || completing) return;
    publish({ busy: true, issue: null, reconciled: false, pending });
    try {
      const value = await deps.request(path, method, body);
      if (!current()) return;
      invalidateReads();
      validate(value);
      if (!current()) return;
      publish({ pending: null, removal: null, needsReadback: true });
      // An acknowledged mutation is never repeated, even if its read-back fails.
      if (available()) await refresh();
    } catch (error) {
      if (current()) {
        invalidateReads();
        if (pending.kind === 'remove' && gitHubRemovalRejected(error)) {
          publish({ pending: null, removal: null, reconciled: false, issue: 'identity' });
          if (available()) await refresh();
          if (current()) publish({ issue: 'identity' });
        } else publish({ pending, issue: 'unknown', removal: null, reconciled: false });
      }
    }
    finally { if (current()) publish({ busy: false }); }
  }
  async function activate(account: GitHubAccount) {
    if (!available()) return;
    const found = state.status?.accounts.find(item => gitHubAccountKey(item) === gitHubAccountKey(account));
    // The backend accepts id alone. Never send an ambiguous id shared by sources.
    if (!found || found.current || found.source === 'oauth' && found.id === 'gh-cli' || state.status?.accounts.filter(item => item.id === account.id).length !== 1) { publish({ issue: 'identity' }); return; }
    await mutate({ kind: 'activate', key: gitHubAccountKey(account) }, '/api/github/auth/activate', 'POST', { accountId: account.id }, result => { const next = gitHubStatus(result); if (current()) publish({ status: next }); });
  }
  function requestRemoval(account: GitHubAccount) {
    if (!available() || state.busy || state.pending || state.needsReadback || lease || completing) return;
    if (!state.status?.capabilities?.exactAccountRemoval) { publish({ issue: 'unsupported' }); return; }
    const found = state.status.accounts.find(item => item.source === 'oauth' && gitHubAccountKey(item) === gitHubAccountKey(account));
    const expected = gitHubCurrentSelection(state.status);
    if (!found || state.status.connected && !expected) { publish({ issue: 'identity' }); return; }
    removalExpected = expected;
    publish({ removal: found });
  }
  async function confirmRemoval() {
    const account = state.removal, expectedCurrent = removalExpected;
    if (!account || !available() || state.busy || state.refreshing || state.pending) return;
    // Preserve the confirmation's current selection; the server rechecks it atomically at commit.
    publish({ busy: true });
    try {
      const value = gitHubStatus(await deps.request('/api/github/auth/status'));
      if (!available()) return;
      publish({ status: value });
      if (!value.capabilities?.exactAccountRemoval) { publish({ issue: 'unsupported', removal: null }); return; }
      const currentSelection = gitHubCurrentSelection(value);
      if (currentSelection?.source !== expectedCurrent?.source || currentSelection?.accountId !== expectedCurrent?.accountId || !value.accounts.some(item => gitHubAccountKey(item) === gitHubAccountKey(account))) { publish({ issue: 'identity', removal: null }); return; }
    } catch { if (current()) publish({ issue: 'read' }); return; }
    finally { if (current()) publish({ busy: false }); }
    if (!available() || state.removal !== account) return;
    const selection = gitHubSelection(account);
    await mutate({ kind: 'remove', key: gitHubAccountKey(account) }, '/api/github/auth', 'DELETE', { selection, expectedCurrent }, result => {
      const row = gitObject(result), selected = gitObject(row.selection);
      const disconnected = expectedCurrent?.source === selection.source && expectedCurrent?.accountId === selection.accountId;
      if (row.success !== true || row.removed !== true || selected.source !== selection.source || selected.accountId !== selection.accountId || row.disconnected !== disconnected) throw new Error('Unconfirmed exact removal');
    });
  }
  return {
    retain: () => ({ state: { ...state, busy: false, refreshing: false, exchanging: false, flow: null,
      ...(lease ? { pending: { kind: 'connect' } as Pending, issue: 'unknown' as const, reconciled: false, cancellation: 'unknown' as const } : {}) }, removalExpected }),
    state: () => state, refresh, connect, open, cancel, activate, requestRemoval, confirmRemoval,
    cancelRemoval: () => { if (!available()) return; removalExpected = null; publish({ removal: null }); },
    setCliDisabled: async (disabled: boolean) => { if (!state.status?.ghCli?.available) return; await mutate({ kind: 'cli', disabled }, '/api/github/auth/gh-cli', 'POST', { disabled }, result => { if (gitObject(result).disabled !== disabled) throw new Error('Unconfirmed CLI preference'); }); },
    acknowledgeUnknown: () => { if (available() && state.pending && state.reconciled && !state.busy && !state.refreshing && !completing) publish({ pending: null, reconciled: false, issue: null }); },
    async setActive(next: boolean) {
      if (disposed || next === active) return;
      active = next; timers();
      if (!next) { readVersion++; publish({ refreshing: false, removal: null }); return; }
      if (!current()) { clearLease(); return; }
      schedule(); await refresh();
    },
    dispose(release = true) { const wire = cancellationWire(); timers(); if (lease) { lease.wire.deviceCode = ''; lease.wire.userCode = ''; } lease = null; revision++; readVersion++; active = false; disposed = true; state = { ...state, flow: null, removal: null }; if (release) void stopOnHost(wire, false); },
  };
}
