import type { PageOperation } from './page-operations';
import { sameRuntimeScope, type RuntimeScope } from './runtime-scope';
import { gitHubAccountKey, gitHubStatus, type GitHubStatus, type GitSettingsRequest } from './settings-github-protocol';
import type { GitHubDependencies, GitHubState, GitHubStatusSnapshot } from './settings-github-core';

export type DesktopHeaderGitHubOperation = Pick<PageOperation, 'current' | 'request' | 'scope'>;
export type DesktopHeaderGitHubGuard = {
  current: () => boolean; active: () => boolean; interactive: () => boolean;
  directory: () => string;
  operation?: () => DesktopHeaderGitHubOperation | null;
};
export type DesktopHeaderGitHubAccount = { key: string; id: string; source: 'oauth' | 'gh-cli'; current: boolean; label: string; login: string; avatarUrl?: string };
export type DesktopHeaderGitHubProjection = { login: string | null; avatarUrl?: string; accounts: readonly DesktopHeaderGitHubAccount[] };
export type DesktopHeaderGitHubState = Readonly<{
  projection: DesktopHeaderGitHubProjection | null; reading: boolean; busy: boolean; stale: boolean;
  issue: null | 'read' | 'unknown' | 'identity' | 'settings'; pending: string | null;
}>;
export type DesktopHeaderGitHubResult = { status: 'accepted' | 'failed' | 'unknown' | 'stale' | 'unavailable' | 'identity' | 'noop' };
export type DesktopHeaderGitHubPort = {
  state(): DesktopHeaderGitHubState; available(): boolean; visible(): boolean; interactive(): boolean;
  ensure(): Promise<DesktopHeaderGitHubResult>; refresh(): Promise<DesktopHeaderGitHubResult>;
  select(key: string): Promise<DesktopHeaderGitHubResult>;
};

/** Reuse the Settings public-avatar whitelist, including its query/credential restrictions. */
export function desktopHeaderGitHubAvatar(value: unknown): string | undefined {
  return gitHubStatus({ connected: false, accounts: [], user: { login: '_', avatarUrl: value } }).user?.avatarUrl;
}
function parse(value: unknown): GitHubStatus {
  if (value && typeof value === 'object' && 'accounts' in value && Array.isArray(value.accounts) && value.accounts.length > 200) throw new Error('github_status_limit');
  // Web's public auth type makes accounts optional; missing means avatar-only, never invented accounts.
  const normalized = value && typeof value === 'object' && !Array.isArray(value) && !Object.hasOwn(value, 'accounts') ? { ...value, accounts: [] } : value;
  const status = gitHubStatus(normalized);
  // Refuse oversize/ambiguous data as a whole. Do not silently trim actual account choices.
  if ((status.user?.login.length ?? 0) > 256 || status.accounts.some(account => account.id.length > 1024 || account.user.login.length > 256 || (account.user.name?.length ?? 0) > 4096)) throw new Error('github_status_limit');
  return status;
}
function projection(status: GitHubStatus | null): DesktopHeaderGitHubProjection | null {
  if (!status?.connected) return null;
  return { login: status.user?.login ?? null, ...(status.user?.avatarUrl ? { avatarUrl: status.user.avatarUrl } : {}),
    accounts: status.accounts.map(account => ({ key: gitHubAccountKey(account), id: account.id, source: account.source, current: account.current,
      label: account.user.name?.trim() || account.user.login || 'GitHub', login: account.user.login, ...(account.user.avatarUrl ? { avatarUrl: account.user.avatarUrl } : {}) })),
  };
}
const sameTarget = (status: GitHubStatus, key: string) => status.connected && status.accounts.some(account => account.current && gitHubAccountKey(account) === key);

/** Root-owned shared status/selection lane. No OAuth engine, timer, globals, storage or implicit reads.
 * Both Header and Settings must use this instance; Settings keeps its existing OAuth controller. */
export function createDesktopHeaderGitHubSource(options: {
  scope: { host: RuntimeScope | null; directory: string; authorityKey: string };
  current: () => boolean; operation: () => DesktopHeaderGitHubOperation | null;
  changed?: (state: DesktopHeaderGitHubState) => void;
}) {
  const scope = { ...options.scope, host: options.scope.host && { ...options.scope.host } };
  let alive = true, retired = false, status: GitHubStatus | null = null, serial = 0, attempted = false;
  let state: DesktopHeaderGitHubState = { projection: null, reading: false, busy: false, stale: false, issue: null, pending: null };
  let reading: Promise<DesktopHeaderGitHubResult> | undefined, writing = false, externalWrites = 0, dirty = false;
  let mutationSettled: Promise<void> | undefined, finishMutation: (() => void) | undefined;
  const beginMutation = () => { mutationSettled ??= new Promise<void>(resolve => { finishMutation = resolve; }); };
  const endMutation = () => { if (writing || externalWrites) return; const finish = finishMutation; mutationSettled = undefined; finishMutation = undefined; finish?.(); };
  let settings: { token: object; locked: boolean; unknown: boolean } | undefined;
  const statusListeners = new Set<(value: GitHubStatusSnapshot) => void>();
  const current = () => { if (!alive || retired) return false; if (!options.current()) { retired = true; return false; } return true; };
  const publish = (patch: Partial<DesktopHeaderGitHubState>) => { state = { ...state, ...patch }; if (current()) options.changed?.(state); };
  const laneFor = (guard: DesktopHeaderGitHubGuard, requireActive = true) => {
    if (!current() || !guard.current() || guard.directory() !== scope.directory || requireActive && !guard.active()) return null;
    const lane = (guard.operation ?? options.operation)();
    return lane?.current() && sameRuntimeScope(scope.host, lane.scope) ? lane : null;
  };
  const laneCurrent = (lane: DesktopHeaderGitHubOperation, guard: DesktopHeaderGitHubGuard) => current() && guard.current() && guard.directory() === scope.directory
    && (guard.operation ?? options.operation)() === lane && lane.current() && sameRuntimeScope(scope.host, lane.scope);
  // Published activity, not the still-settling Promise slot, owns reactive availability.
  const mayWrite = (guard: DesktopHeaderGitHubGuard, token?: object) => !!laneFor(guard) && guard.interactive() && !writing && !externalWrites && !state.reading
    && !state.pending && !state.stale && !!status && (token !== undefined || status.connected) && (!settings || settings.token === token || !settings.locked && !settings.unknown);
  function adopt(value: GitHubStatus) {
    status = value; publish({ projection: projection(value), stale: false });
    if (current()) for (const listener of statusListeners) listener({ status: value, stale: false });
  }
  function read(guard: DesktopHeaderGitHubGuard, force: boolean): Promise<DesktopHeaderGitHubResult> {
    const lane = laneFor(guard);
    if (!lane || writing || externalWrites) return Promise.resolve({ status: 'unavailable' });
    if (reading) return reading;
    if (!force && !dirty && (status || attempted)) return Promise.resolve({ status: state.pending ? 'unknown' : status && !state.stale ? 'accepted' : 'failed' });
    attempted = true; dirty = false;
    const ticket = ++serial;
    reading = (async () => {
      publish({ reading: true });
      try {
        const value = parse(await lane.request('/api/github/auth/status', 'GET'));
        if (!laneCurrent(lane, guard) || !guard.active() || ticket !== serial) return { status: 'stale' } as const;
        adopt(value);
        const pending = state.pending;
        if (pending && sameTarget(value, pending)) publish({ pending: null, issue: null });
        else publish({ issue: pending ? 'unknown' : settings?.unknown ? 'settings' : null });
        return { status: state.pending ? 'unknown' : 'accepted' } as const;
      } catch {
        if (!laneCurrent(lane, guard) || ticket !== serial) return { status: 'stale' } as const;
        publish({ stale: true, issue: state.pending ? 'unknown' : 'read' }); return { status: state.pending ? 'unknown' : 'failed' } as const;
      } finally { if (alive && ticket === serial) publish({ reading: false }); }
    })().finally(() => { reading = undefined; });
    return reading;
  }
  async function select(key: string, guard: DesktopHeaderGitHubGuard, token?: object): Promise<DesktopHeaderGitHubResult> {
    if (!mayWrite(guard, token)) return { status: 'unavailable' };
    const account = status!.accounts.find(account => gitHubAccountKey(account) === key);
    if ((!status!.connected && token === undefined) || !account || status!.accounts.filter(item => item.id === account.id).length !== 1 || account.source === 'oauth' && account.id === 'gh-cli') { publish({ issue: 'identity' }); return { status: 'identity' }; }
    if (account.current) return { status: 'noop' };
    const lane = laneFor(guard)!; writing = true; beginMutation(); serial++;
    publish({ busy: true, pending: key, issue: null });
    try {
      const value = parse(await lane.request('/api/github/auth/activate', 'POST', { accountId: account.id }));
      if (!laneCurrent(lane, guard)) { publish({ issue: 'unknown', stale: true }); return { status: 'unknown' }; }
      if (!sameTarget(value, key)) throw new Error('github_activate_unconfirmed');
      adopt(value); publish({ pending: null, issue: null }); return { status: 'accepted' };
    } catch {
      // A rejected request or stale PageOperation is not proof the Host did not commit.
      publish({ issue: 'unknown', stale: true }); return { status: 'unknown' };
    } finally { writing = false; endMutation(); if (alive) publish({ busy: false }); }
  }
  function port(guard: DesktopHeaderGitHubGuard): DesktopHeaderGitHubPort {
    return { state: () => state, visible: () => current() && guard.current() && guard.directory() === scope.directory && !!state.projection,
      interactive: () => !!laneFor(guard) && guard.interactive(),
      available: () => mayWrite(guard), ensure: () => read(guard, false), refresh: () => read(guard, true), select: key => select(key, guard) };
  }
  return {
    scope: () => ({ ...scope, host: scope.host && { ...scope.host } }), state: () => state,
    header: port,
    /** Actual Host/owner destruction revokes callbacks even when an issued write remains unknown.
     * This is not permission to create a second writer for the same Host. */
    retire() { retired = true; serial++; statusListeners.clear(); },
    /** Exactly one Settings page controller may register. Inject its dependencies prop;
     * status/activate join this lane, other auth calls stay in the original OAuth engine. */
    settings(guard: DesktopHeaderGitHubGuard, open: GitHubDependencies['open']) {
      if (settings) throw new Error('github_settings_already_registered');
      const token = {}, registration = { token, locked: false, unknown: false }; settings = registration;
      const valid = () => settings === registration && !!laneFor(guard, false);
      const subscribers = new Set<(value: GitHubStatusSnapshot) => void>();
      const request: GitSettingsRequest = async (path, method = 'GET', body) => {
        if (!valid()) throw new Error('github_settings_stale');
        if (path === '/api/github/auth/status' && method === 'GET' && body === undefined) {
          if (mutationSettled) await mutationSettled;
          if (!valid() || !guard.active()) throw new Error('github_settings_stale');
          let result = await read(guard, true);
          // A modal may revoke the Header's earlier read lane. Hand off once to this page's real lane.
          if (result.status === 'stale' && valid() && guard.active()) result = await read(guard, true);
          if (!valid() || !status || state.stale || result.status !== 'accepted' && result.status !== 'unknown') throw new Error('github_status_unavailable');
          return status;
        }
        const cancellation = path === '/api/github/auth/cancel' && method === 'POST';
        if (!cancellation && (!guard.active() || !guard.interactive() || writing || externalWrites || state.reading || state.pending)) throw new Error('github_settings_busy');
        if (path === '/api/github/auth/activate' && method === 'POST' && body && typeof body === 'object' && !Array.isArray(body)
          && Object.keys(body).join(',') === 'accountId' && typeof (body as { accountId?: unknown }).accountId === 'string') {
          const matches = status?.accounts.filter(account => account.id === (body as { accountId: string }).accountId) ?? [];
          if (matches.length !== 1) throw new Error('github_account_identity');
          const result = await select(gitHubAccountKey(matches[0]), guard, token);
          if (result.status !== 'accepted' && result.status !== 'noop') throw new Error('github_activate_unconfirmed');
          return status;
        }
        const allowed = path === '/api/github/auth/start' && method === 'POST'
          || path === '/api/github/auth/complete' && method === 'POST' || path === '/api/github/auth/cancel' && method === 'POST'
          || path === '/api/github/auth/gh-cli' && method === 'POST' || path === '/api/github/auth' && method === 'DELETE';
        if (!allowed) throw new Error('github_settings_route');
        const lane = laneFor(guard, false)!; externalWrites++; beginMutation(); registration.locked = true; dirty = true;
        publish({ busy: true, stale: true });
        try {
          const result = await lane.request(path, method, body);
          if (!laneCurrent(lane, guard)) throw new Error('github_settings_stale');
          if (cancellation && result && typeof result === 'object' && (result as { cancelled?: unknown }).cancelled === true
            && (result as { status?: unknown }).status === 'cancelled' && (result as { providerRevoked?: unknown }).providerRevoked === false) {
            registration.locked = false; registration.unknown = false;
          }
          return result;
        }
        catch (cause) { registration.unknown = true; publish({ stale: true, issue: 'settings' }); throw cause; }
        finally { externalWrites--; endMutation(); publish({ busy: writing || externalWrites > 0 }); }
      };
      const dependencies: GitHubDependencies = { current: valid, request,
        sharedStatus: {
          snapshot: () => valid() ? { status, stale: state.stale } : null,
          subscribe(listener) {
            if (!valid()) return () => {};
            const receive = (value: GitHubStatusSnapshot) => { if (valid()) listener(value); };
            subscribers.add(receive); statusListeners.add(receive);
            return () => { subscribers.delete(receive); statusListeners.delete(receive); };
          },
        },
        open: async url => {
          if (!valid() || !guard.active() || !guard.interactive()) return false;
          const opened = await open(url); return valid() && guard.active() && guard.interactive() && opened;
        },
        changed(value: GitHubState) {
          if (!valid()) return;
          const locked = value.busy || value.refreshing || value.exchanging || value.needsReadback || !!value.pending || !!value.flow || value.cancellation === 'stopping';
          const unknown = !!value.pending || value.needsReadback || value.cancellation === 'unknown';
          const issue = unknown ? 'settings' : state.pending ? 'unknown' : state.issue === 'settings' ? null : state.issue;
          const changed = locked !== registration.locked || unknown !== registration.unknown || issue !== state.issue;
          registration.locked = locked; registration.unknown = unknown;
          if (changed) publish({ issue });
        },
      };
      return { dependencies,
        dispose() { if (settings !== registration) return true; if (registration.locked || registration.unknown || writing || externalWrites) return false; for (const receive of subscribers) statusListeners.delete(receive); subscribers.clear(); settings = undefined; return true; },
      };
    },
    dispose() { if (writing || externalWrites || state.pending || settings?.locked || settings?.unknown) return false; alive = false; serial++; status = null; statusListeners.clear(); return true; },
  };
}
export type DesktopHeaderGitHubSource = ReturnType<typeof createDesktopHeaderGitHubSource>;
