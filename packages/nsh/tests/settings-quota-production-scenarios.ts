import type { App } from '../.nsh/types/nsh/test';
import type { RuntimeScope } from '../runtime-scope';

type QuotaProductionRequest = { hostID: string; runtimeScope: RuntimeScope; expectedHost?: RuntimeScope; path: string; resource: string; method: string };
export type QuotaProductionAudit = {
  selected: string; runtimeScope: RuntimeScope | null;
  requests: QuotaProductionRequest[];
  writes: Array<QuotaProductionRequest & { fields: string[]; accepted: boolean }>;
  rejected: unknown[]; nativeCounts: Record<string, number>; configurations: unknown[];
  statuses: Record<string, Record<string, boolean>>;
  actions: { validates: number; imports: number; deletes: number };
  foreground: boolean;
  streams: Record<string, { path: string; expectedHost: RuntimeScope }>;
  streamCalls: Array<{ name: string; key: string; expectedHost: RuntimeScope; accepted?: boolean; released?: boolean }>;
};
type Check = (value: unknown) => { toBe(value: unknown): void; toEqual(value: unknown): void; toHaveLength(value: number): void };
type Audit = () => QuotaProductionAudit;
type Scenario = (mode: 'ok' | 'reject' | 'read-fail') => void;

export async function openQuotaProvider(app: App, provider: string, quota: string) {
  await app.waitFor('id:settings-search');
  await app.press('text:Providers');
  await app.waitFor('text:' + provider);
  await app.press('text:' + provider);
  await app.waitUntil(() => app.enabled('id:quota-' + quota + '-manage'));
  await app.waitFor('id:integration-api-key');
}

/** A single native Back must return to the real detail, never to a duplicate form wrapper. */
export async function quotaRoundTrip(app: App, audit: Audit, check: Check, scenario: Scenario, provider: string, quota: string) {
  await openQuotaProvider(app, provider, quota);
  const field = quota === 'opencode-go' ? 'authCookie' : quota === 'ollama-cloud' ? 'cookie' : 'accessToken';
  const resource = '/api/quota/credentials/' + quota;
  check(app.shows('text:Optional')).toBe(true);
  // The production integration key input exists, but must not seed usage credentials or be submitted by their Save.
  await app.type('id:integration-api-key', 'synthetic-model-access-only');
  const before = audit();
  await app.press('id:quota-' + quota + '-manage');
  await app.waitUntil(() => app.shows('id:quota-field-' + field) && app.enabled('id:quota-field-' + field));
  check(app.count('id:quota-field-' + field)).toBe(1);
  check(app.value('id:quota-field-' + field)).toBe('');
  if (quota === 'cursor') check(app.value('id:quota-field-refreshToken')).toBe('');
  await app.press('id:quota-form-save');
  await app.waitFor('id:quota-form-error');
  check(audit().writes).toEqual(before.writes);
  await app.type('id:quota-field-' + field, 'fixture-only-input');
  if (quota === 'opencode-go') check(app.value('id:quota-field-workspaceId')).toBe('wrk_fixture');
  await app.back();
  await app.waitFor('id:quota-field-' + field, { state: 'gone' });
  await app.waitUntil(() => app.enabled('id:quota-' + quota + '-manage'));
  check(audit().writes).toEqual(before.writes);
  await app.press('id:quota-' + quota + '-manage');
  await app.waitUntil(() => app.shows('id:quota-field-' + field) && app.enabled('id:quota-field-' + field));
  check(app.value('id:quota-field-' + field)).toBe('');
  await app.type('id:quota-field-' + field, 'fixture-only-input');
  scenario('reject');
  await app.press('id:quota-form-save');
  await app.waitFor('id:quota-form-error');
  check(app.value('id:quota-field-' + field)).toBe('fixture-only-input');
  check(audit().writes.slice(before.writes.length).map(row => row.accepted)).toEqual([false]);
  scenario('ok');
  await app.press('id:quota-form-save');
  await app.waitFor('id:quota-field-' + field, { state: 'gone' });
  await app.waitUntil(() => app.enabled('id:quota-' + quota + '-manage') && app.shows('text:Configured'));
  const saved = audit();
  check(saved.writes.slice(before.writes.length).map(row => [row.path, row.accepted])).toEqual([[resource, false], [resource, true]]);
  const lastWrite = saved.requests.map(row => row.method === 'PUT' && row.path === resource).lastIndexOf(true);
  check(saved.requests.slice(lastWrite + 1).some(row => row.path === resource && row.method === 'GET' && row.hostID === saved.selected)).toBe(true);
  check(saved.requests.filter(row => row.path.startsWith('/api/quota/credentials/')).every(row => row.resource === row.path)).toBe(true);
  for (const row of saved.requests.filter(row => row.path.startsWith('/api/quota/credentials/'))) check(row.expectedHost).toEqual(row.runtimeScope);
  check(saved.requests.filter(row => row.method !== 'GET').every(row => row.path.startsWith('/api/quota/credentials/'))).toBe(true);
  check(saved.rejected).toEqual([]);
  check(JSON.stringify(app.storage()).includes('fixture-only-input')).toBe(false);
  check(JSON.stringify(app.storage()).includes('synthetic-model-access-only')).toBe(false);
  await app.press('id:quota-' + quota + '-manage');
  await app.waitUntil(() => app.shows('id:quota-field-' + field) && app.enabled('id:quota-field-' + field));
  check(app.value('id:quota-field-' + field)).toBe('');
  await app.back();
  await app.waitFor('id:settings-provider-filter');
  await app.back();
  await app.waitFor('text:' + provider);
  await app.back();
  await app.waitFor('id:settings-search');
  check(audit().writes).toEqual(saved.writes);
}

/** Cover and Host changes travel through the actual connection.link listener and Connect's saved-Host action. */
export async function quotaVisibilityAndHost(app: App, audit: Audit, check: Check, setForeground: (active: boolean) => void) {
  await openQuotaProvider(app, 'Cursor', 'cursor');
  await app.press('id:quota-cursor-manage');
  await app.waitUntil(() => app.shows('id:quota-field-accessToken') && app.enabled('id:quota-field-accessToken'));
  await app.type('id:quota-field-accessToken', 'fixture-only-input');
  const before = audit();
  await app.host.send('connection.link', { url: 'synthetic-quota-cover-only' });
  await app.waitFor('id:pairing-link');
  check(app.shows('id:quota-field-accessToken')).toBe(false);
  await app.back();
  await app.waitUntil(() => app.shows('id:quota-field-accessToken') && app.enabled('id:quota-field-accessToken'));
  check(app.value('id:quota-field-accessToken')).toBe('');
  check(audit().writes).toEqual(before.writes);
  check(audit().requests.filter(row => row.path === '/api/quota/credentials/cursor').length > before.requests.filter(row => row.path === '/api/quota/credentials/cursor').length).toBe(true);
  await app.type('id:quota-field-accessToken', 'fixture-only-input');
  await app.setLifecycle('background');
  setForeground(false);
  check(audit().runtimeScope).toBe(null);
  setForeground(true);
  await app.setLifecycle('active');
  await app.waitUntil(() => app.shows('id:quota-field-accessToken') && app.enabled('id:quota-field-accessToken'));
  check(app.value('id:quota-field-accessToken')).toBe('');
  await app.type('id:quota-field-accessToken', 'fixture-only-input');
  await app.host.send('connection.link', { url: 'synthetic-quota-switch-only' });
  await app.waitFor('text:Secondary synthetic quota Host');
  await app.press('text:Secondary synthetic quota Host');
  await app.waitFor('id:settings-search');
  check(audit().selected).toBe('quota-production-secondary');
  check(app.shows('id:quota-field-accessToken')).toBe(false);
  await openQuotaProvider(app, 'Cursor', 'cursor');
  check(app.shows('text:Optional')).toBe(true);
  await app.press('id:quota-cursor-manage');
  await app.waitUntil(() => app.shows('id:quota-field-accessToken') && app.enabled('id:quota-field-accessToken'));
  check(app.value('id:quota-field-accessToken')).toBe('');
  await app.press('id:quota-form-save');
  await app.waitFor('id:quota-form-error');
  check(audit().writes).toEqual(before.writes);
  await app.type('id:quota-field-accessToken', 'fixture-only-input');
  await app.press('id:quota-form-save');
  await app.waitUntil(() => app.enabled('id:quota-cursor-manage') && app.shows('text:Configured'));
  check(audit().writes.map(row => row.hostID)).toEqual(['quota-production-secondary']);
  check(audit().statuses['settings-navigation-production'].cursor).toBe(false);
  check(audit().statuses['quota-production-secondary'].cursor).toBe(true);
  check(audit().nativeCounts['connection.connect'] ?? 0).toBe(0);
  check(audit().actions).toEqual({ validates: 0, imports: 0, deletes: 0 });
  const secondary = audit();
  await app.host.send('connection.link', { url: 'synthetic-quota-return-only' });
  await app.waitFor('text:Primary synthetic quota Host');
  await app.press('text:Primary synthetic quota Host');
  await app.waitFor('id:settings-search');
  check(audit().runtimeScope?.hostID).toBe(before.runtimeScope?.hostID);
  check(audit().runtimeScope?.lease === before.runtimeScope?.lease).toBe(false);
  await openQuotaProvider(app, 'Cursor', 'cursor');
  check(app.shows('text:Optional')).toBe(true);
  await app.press('id:quota-cursor-manage');
  await app.waitUntil(() => app.shows('id:quota-field-accessToken') && app.enabled('id:quota-field-accessToken'));
  check(app.value('id:quota-field-accessToken')).toBe('');
  check(audit().writes).toEqual(secondary.writes);
  for (const row of audit().requests.filter(row => row.path.startsWith('/api/quota/credentials/'))) check(row.expectedHost).toEqual(row.runtimeScope);
  check(audit().streams.global?.expectedHost).toEqual(audit().runtimeScope);
  check(audit().rejected).toEqual([]);
}

/** Public Chat -> Web's mod+p shortcut -> scoped Search -> Settings Home -> Providers -> detail -> quota route. */
export async function quotaScopedSettings(app: App, audit: Audit, check: Check, scenario: Scenario) {
  await app.waitFor('id:project-worktree-/fixture/second/.worktrees/topic');
  await app.press('id:project-worktree-/fixture/second/.worktrees/topic');
  await app.waitFor('id:project-session-ses_actual');
  await app.press('id:project-session-ses_actual');
  await app.waitFor('id:composer');
  await app.type('id:composer', 'Untouched non-first worktree draft');
  await app.keyboard.press('mod+p');
  await app.waitFor('id:projects-global-search');
  await app.type('id:projects-global-search', 'Open Settings');
  await app.waitFor('id:projects-search-command:open-settings');
  await app.press('id:projects-search-command:open-settings');
  await app.waitFor('id:settings-search');
  const before = audit().requests.length;
  await quotaRoundTrip(app, audit, check, scenario, 'Ollama', 'ollama-cloud');
  const requests = audit().requests.slice(before);
  for (const [path, query] of [['/api/config/catalog/providers', '?directory='], ['/api/integration/ollama', '?location%5Bdirectory%5D='], ['/api/provider', '?location%5Bdirectory%5D='], ['/api/integration', '?location%5Bdirectory%5D='], ['/api/config/providers/sources', '?directory=']]) {
    const calls = requests.filter(row => row.path === path);
    check(calls.length > 0).toBe(true);
    check(calls.every(row => row.resource === path + query + encodeURIComponent('/fixture/second/.worktrees/topic'))).toBe(true);
  }
  check(requests.filter(row => row.path === '/api/quota/credentials/ollama-cloud').every(row => row.resource === row.path)).toBe(true);
  await app.back();
  await app.waitFor('id:composer');
  check(app.value('id:composer')).toBe('Untouched non-first worktree draft');
}
