import { gitObject, gitString, type GitSettingsRequest } from './settings-github-protocol';

export type DiscoveredGitCredential = { host: string; username: string };
export type GitCredentialProfile = { id: string; host?: string | null; authType?: 'ssh' | 'token'; name?: string; userName?: string; userEmail?: string; sshKey?: string | null; signCommits?: boolean; signingKey?: string | null; color?: string; icon?: string };
export type GitCredentialDraft = { id: string; host: string | null; userName: string; userEmail: string; name: string; authType: 'ssh' | 'token'; sshKey: string | null; signCommits: boolean; signingKey: string | null; color: string; icon: string };
type Resource<T> = { value: T | null; failed: boolean };
export type GitCredentialsState = { credentials: Resource<DiscoveredGitCredential[]>; profiles: Resource<GitCredentialProfile[]>; refreshing: boolean; busy: boolean; draft: GitCredentialDraft | null; pending: GitCredentialDraft | null; inspected: boolean; issue: 'required' | 'host' | 'signing' | 'read' | 'unknown' | 'duplicate' | 'source' | null; saved: boolean };
export type GitCredentialsDependencies = { request: GitSettingsRequest; current: () => boolean; id: () => string; changed?: (state: GitCredentialsState) => void; onSaved?: () => void };
const gitCredentialKey = (value: DiscoveredGitCredential) => JSON.stringify([value.host, value.username]);
export function discoveredGitCredentials(value: unknown): DiscoveredGitCredential[] {
  if (!Array.isArray(value)) throw new Error('Invalid discovered credentials');
  const result = value.map(item => { const row = gitObject(item); return { host: gitString(row.host), username: gitString(row.username) }; });
  return result.filter((item, index) => result.findIndex(other => gitCredentialKey(other) === gitCredentialKey(item)) === index);
}
function gitCredentialProfiles(value: unknown): GitCredentialProfile[] {
  if (!Array.isArray(value)) throw new Error('Invalid identity profiles');
  const profiles = value.map(item => {
    const row = gitObject(item);
    if (row.authType !== undefined && row.authType !== 'token' && row.authType !== 'ssh') throw new Error('Invalid profile authentication');
    if (['name', 'userName', 'userEmail', 'color', 'icon'].some(key => row[key] !== undefined && typeof row[key] !== 'string') || ['host', 'sshKey', 'signingKey'].some(key => row[key] !== undefined && row[key] !== null && typeof row[key] !== 'string') || row.signCommits !== undefined && typeof row.signCommits !== 'boolean') throw new Error('Invalid identity metadata');
    const profile: GitCredentialProfile = { id: gitString(row.id) };
    for (const key of ['name', 'userName', 'userEmail', 'color', 'icon'] as const) if (typeof row[key] === 'string') profile[key] = row[key];
    for (const key of ['host', 'sshKey', 'signingKey'] as const) if (typeof row[key] === 'string' || row[key] === null) profile[key] = row[key];
    if (typeof row.signCommits === 'boolean') profile.signCommits = row.signCommits;
    if (row.authType) profile.authType = row.authType;
    return profile;
  });
  if (new Set(profiles.map(profile => profile.id)).size !== profiles.length) throw new Error('Ambiguous identity profiles');
  return profiles;
}
/** Match the Web contract: an existing token profile imports the entire exact host, not one username. */
export function unimportedGitCredentials(credentials: DiscoveredGitCredential[], profiles: GitCredentialProfile[]) {
  return credentials.filter(credential => !profiles.some(profile => profile.authType === 'token' && profile.host === credential.host));
}
export function createSettingsGitCredentials(deps: GitCredentialsDependencies) {
  let lane = createCredentialsLane(deps);
  return {
    state: () => lane.state(), candidates: () => lane.candidates(),
    refresh: () => lane.refresh(), begin: (...args: Parameters<typeof lane.begin>) => lane.begin(...args),
    save: () => lane.save(), edit: (...args: Parameters<typeof lane.edit>) => lane.edit(...args),
    setSignCommits: (value: boolean) => lane.setSignCommits(value), cancel: () => lane.cancel(),
    acknowledgeUnknown: () => lane.acknowledgeUnknown(), setActive: (value: boolean) => lane.setActive(value),
    dispose: () => lane.dispose(),
    replaceLane(next: GitCredentialsDependencies) {
      const retained = lane.retain(); lane.dispose(); lane = createCredentialsLane(next, retained);
      next.changed?.(lane.state());
    },
  };
}
function createCredentialsLane(deps: GitCredentialsDependencies, retained?: { state: GitCredentialsState; selected: DiscoveredGitCredential | null }) {
  let state: GitCredentialsState = { credentials: { value: null, failed: false }, profiles: { value: null, failed: false }, refreshing: false, busy: false, draft: null, pending: null, inspected: false, issue: null, saved: false };
  let active = false, disposed = false, readVersion = 0;
  let selected: DiscoveredGitCredential | null = null;
  if (retained) { state = retained.state; selected = retained.selected; }
  const current = () => !disposed && deps.current();
  const available = () => active && current();
  const publish = (patch: Partial<GitCredentialsState>) => { state = { ...state, ...patch }; if (current()) deps.changed?.(state); };
  function invalidateReads() { readVersion++; publish({ refreshing: false }); }
  const sameImport = (profile: GitCredentialProfile, draft: GitCredentialDraft) => (Object.keys(draft) as Array<keyof GitCredentialDraft>).every(key => profile[key] === draft[key]);
  function saved() {
    selected = null; publish({ pending: null, draft: null, issue: null, saved: true });
    // A parent refresh/navigation failure cannot turn an acknowledged write into an unknown write.
    if (current()) { try { deps.onSaved?.(); } catch { publish({ issue: 'read' }); } }
  }
  async function refresh() {
    if (!available() || state.refreshing) return;
    const ticket = ++readVersion; publish({ refreshing: true });
    const results = await Promise.allSettled([
      deps.request('/api/git/discover-credentials').then(discoveredGitCredentials),
      deps.request('/api/git/identities').then(gitCredentialProfiles),
    ]);
    if (!available() || ticket !== readVersion) return;
    const credentials = results[0], profiles = results[1];
    publish({
      credentials: credentials.status === 'fulfilled' ? { value: credentials.value, failed: false } : { ...state.credentials, failed: true },
      profiles: profiles.status === 'fulfilled' ? { value: profiles.value, failed: false } : { ...state.profiles, failed: true },
      refreshing: false,
      inspected: !!state.pending && profiles.status === 'fulfilled',
      issue: state.pending ? 'unknown' : results.some(result => result.status === 'rejected') ? 'read' : null,
    });
    if (state.pending && profiles.status === 'fulfilled' && profiles.value.some(profile => sameImport(profile, state.pending!))) saved();
  }
  function candidates() { return state.credentials.value && state.profiles.value ? unimportedGitCredentials(state.credentials.value, state.profiles.value) : []; }
  function begin(credential: DiscoveredGitCredential) {
    if (!available() || state.busy || state.refreshing || state.pending || state.draft || state.credentials.failed || state.profiles.failed) return;
    const found = candidates().find(item => gitCredentialKey(item) === gitCredentialKey(credential));
    if (!found) { publish({ issue: 'source' }); return; }
    selected = { ...found };
    const parts = found.host.split('/');
    publish({ saved: false, issue: null, draft: { id: deps.id(), host: found.host, userName: found.username, userEmail: '', name: parts.length >= 3 ? parts[parts.length - 1] : found.host, authType: 'token', sshKey: null, signCommits: false, signingKey: null, color: 'string', icon: 'code' } });
  }
  async function save() {
    if (!available() || state.busy || state.refreshing || state.pending || !state.draft || !selected) return;
    const draft: GitCredentialDraft = { ...state.draft, name: state.draft.name.trim() || state.draft.userName.trim(), userName: state.draft.userName.trim(), userEmail: state.draft.userEmail.trim(), host: state.draft.authType === 'token' ? state.draft.host?.trim() || null : null, sshKey: state.draft.authType === 'ssh' ? state.draft.sshKey?.trim() || null : null, signingKey: state.draft.signingKey?.trim() || null };
    if (!draft.userName || !draft.userEmail) { publish({ issue: 'required' }); return; }
    if (draft.authType === 'token' && !draft.host) { publish({ issue: 'host' }); return; }
    if (draft.signCommits && !draft.signingKey) { publish({ issue: 'signing' }); return; }
    publish({ busy: true, issue: null });
    // Preflight is read-only; its failure must not turn an unknown collection into empty success.
    try {
      const profiles = gitCredentialProfiles(await deps.request('/api/git/identities'));
      if (!available()) return;
      publish({ profiles: { value: profiles, failed: false } });
      if (profiles.some(profile => profile.id === draft.id || draft.authType === 'token' && profile.authType === 'token' && profile.host === draft.host)) { publish({ issue: 'duplicate' }); return; }
      try {
        publish({ pending: draft, inspected: false });
        const response = gitObject(await deps.request('/api/git/identities', 'POST', draft));
        if (!current()) return;
        invalidateReads();
        const profile = gitCredentialProfiles([response])[0];
        if (!sameImport(profile, draft)) throw new Error('Unconfirmed import');
        if (current()) { saved(); if (available()) await refresh(); }
      } catch { if (current()) { invalidateReads(); publish({ pending: draft, inspected: false, issue: 'unknown' }); } }
    } catch { if (current()) publish({ issue: 'read' }); }
    finally { if (current()) publish({ busy: false }); }
  }
  return {
    retain: () => ({ state: { ...state, busy: false, refreshing: false }, selected }),
    state: () => state, candidates, refresh, begin, save,
    edit(key: 'name' | 'userName' | 'userEmail' | 'host' | 'authType' | 'sshKey' | 'signingKey' | 'color' | 'icon', value: string) {
      if (key === 'authType' && value !== 'ssh' && value !== 'token') return;
      if (available() && state.draft && !state.busy && !state.pending) publish({ draft: { ...state.draft, [key]: value } });
    },
    setSignCommits(value: boolean) { if (available() && state.draft && !state.busy && !state.pending) publish({ draft: { ...state.draft, signCommits: value } }); },
    cancel() { if (!available() || state.busy || state.pending) return; selected = null; publish({ draft: null, issue: null }); },
    acknowledgeUnknown() { if (available() && state.pending && state.inspected && !state.busy && !state.refreshing) { selected = null; publish({ pending: null, draft: null, inspected: false, issue: null }); } },
    async setActive(next: boolean) { if (disposed || active === next) return; active = next; if (!next) { readVersion++; publish({ refreshing: false }); return; } await refresh(); },
    dispose() { disposed = true; active = false; readVersion++; selected = null; state = { ...state, draft: null, pending: null }; },
  };
}
