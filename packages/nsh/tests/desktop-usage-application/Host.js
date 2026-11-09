import { createNavigationHost, isNavigationReadOnlyGoalRPC, navigationIdentity as identity } from '../desktop-application/NavigationHost.js';
import { QUOTA_PROVIDERS } from '../../../ui/src/lib/quota/providers/index.ts';
import { usageFixtureResult, usageResult, usageWindow } from '../../settings-usage-fixture-data.ts';

export { identity, isNavigationReadOnlyGoalRPC };
export const registeredProviderIDs = QUOTA_PROVIDERS.map(provider => provider.id);
const copy = value => JSON.parse(JSON.stringify(value));
const ok = body => ({ status: 200, body });

/** Strict native boundary extension only: the real App and every Settings owner remain untouched. */
export function createUsageApplicationHost() {
  const fixture = createNavigationHost(), read = fixture.handlers['runtime.request'];
  const requests = [], quotaReads = [], unsupported = [], rejected = [], audit = [];
  const nativeConfigurations = [];
  let failure = false, rotated = false;
  const selected = () => fixture.handlers['connection.list']({});
  function fail(message, input) { rejected.push({ message, input: copy(input) }); throw new Error(message); }
  function scope(input) {
    const expected = selected().runtimeScope;
    if (!input.expectedHost || Object.keys(input.expectedHost).sort().join(',') !== 'hostID,lease'
      || input.expectedHost.hostID !== expected.hostID || input.expectedHost.lease !== expected.lease) fail('Usage native request requires the exact current captured scope', input);
  }
  function google() {
    const result = usageFixtureResult();
    result.providerName = rotated ? 'Rotated Google' : 'Initial Google';
    for (const account of result.usage.accounts) for (const window of Object.values(account.windows)) window.resetAt = null;
    return result;
  }
  const settings = {
    usageAutoRefresh: false, usageRefreshIntervalMs: 60000, usageDisplayMode: 'usage', usageShowPredValues: false,
    usageSelectedModels: { google: [], 'magpie:usage-fixture': [] }, magpieUsageUrl: '',
  };
  fixture.handlers['runtime.request'] = input => {
    requests.push(copy(input));
    if (!input || typeof input.path !== 'string' || Object.keys(input).some(key => !['path', 'method', 'body', 'expectedHost'].includes(key))) return fail('Invalid native runtime request DTO', input);
    const path = input.path.split('?')[0];
    if (path === '/api/config/settings') {
      if (input.method !== 'GET' || input.body !== undefined || input.path !== path) return fail('Usage application test forbids settings writes or noncanonical settings reads', input);
      const response = read(input); return { ...response, body: { ...response.body, ...settings } };
    }
    if (!path.startsWith('/api/quota/')) return read(input);
    scope(input);
    if (input.method !== 'GET' || input.body !== undefined) return fail('Usage application test forbids quota mutation', input);
    quotaReads.push(copy(input));
    if (path === '/api/quota/magpie') {
      const query = input.path.split('?')[1] || '';
      const fields = query.split('&').map(pair => pair.split('=').map(decodeURIComponent));
      if (!fields.some(([key, value]) => key === 'refresh' && value === '1') || fields.some(([key, value]) => key !== 'refresh' && (key !== 'directory' || ![identity.directory, identity.decoy, identity.chosen].includes(value)))
        || new Set(fields.map(([key]) => key)).size !== fields.length) return fail('Invalid scoped Magpie aggregate request', input);
      return ok({ sources: [{ id: 'usage-source', name: 'Synthetic usage source', identified: true, results: [usageResult({ providerId: 'magpie:usage-fixture', providerName: 'Dynamic Usage Provider', source: 'magpie', sourceId: 'usage-source', usage: { windows: { balance: usageWindow({ valueLabel: '$5', disablePace: true }) } } })] }], incomplete: false });
    }
    const provider = path.slice('/api/quota/'.length);
    if (input.path !== path || !QUOTA_PROVIDERS.some(value => value.id === provider)) return fail('Unknown or noncanonical quota provider request', input);
    if (provider !== 'google') return ok(usageResult({ providerId: provider, providerName: QUOTA_PROVIDERS.find(value => value.id === provider).name, configured: false, ok: false, usage: null }));
    return failure ? { status: 503, body: { error: 'Synthetic provider unavailable' } } : ok(google());
  };
  for (const name of ['runtime.http.capabilities', 'runtime.stream.capabilities']) fixture.handlers[name] = input => {
    if (!input || Object.keys(input).length) return fail('Native discovery requires the empty public DTO', input);
    unsupported.push(name); throw new Error('Unsupported synthetic native capability');
  };
  fixture.handlers['desktop.ssh.capabilities'] = input => {
    if (!input || Object.keys(input).length) return fail('SSH discovery requires the empty public DTO', input);
    unsupported.push('desktop.ssh.capabilities');
    return { version: 1, connections: { supported: false, phase: 'unsupported', maxPending: 16 }, sync: { supported: false } };
  };
  fixture.handlers['notification.status'] = input => {
    if (!input || Object.keys(input).length) return fail('Notification status requires the empty public DTO', input);
    return { authorization: 'denied', alert: 'disabled', sound: 'disabled', badge: 'disabled', backgroundPush: false };
  };
  fixture.handlers['notification.configure'] = input => {
    if (!input || Object.keys(input).sort().join(',') !== 'enabled,events,hostID,language,mode' || input.hostID !== selected().runtimeScope.hostID || input.enabled !== false
      || input.mode !== 'hidden-only' || input.language !== 'en' || JSON.stringify(input.events) !== JSON.stringify(['completion', 'error', 'question', 'permission', 'schedule', 'assistant', 'goal'])) return fail('Invalid disabled native notification configuration DTO', input);
    nativeConfigurations.push(copy(input)); return { lease: 'usage-notification-' + nativeConfigurations.length };
  };
  fixture.handlers['usage.application.test'] = input => { audit.push(copy(input)); };
  return { ...fixture, requests, quotaReads, usageRejected: rejected, unsupported, audit, nativeConfigurations,
    failProvider(next) { failure = next; },
    rotateAuthorization() { fixture.rotateAuthorization(); rotated = true; },
  };
}
