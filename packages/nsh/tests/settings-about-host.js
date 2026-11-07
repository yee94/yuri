/** Explicit --web-host synthetic boundary. No fetch, sockets, filesystem or credentials. */
import { createSettingsFixtureScope } from './settings-raw-fixture-scope.mjs';
export function createHost() {
  const authority = createSettingsFixtureScope('synthetic-about-host');
  let mode = 'normal', enabled = false, reads = 0, exports = 0, submissions = 0, operation = null;
  let recordingLease = 0;
  const events = [];
  const plan = () => ({ version: '2.4.0', releaseNotes: 'Synthetic release notes', planId: operation?.status === 'failed' ? 'synthetic-plan-2' : 'synthetic-plan-1', kind: 'cli-package', rollback: false, restartRequired: true });
  const status = () => ({ schemaVersion: 2, enabled, mode: 'event-recorder', recordingLease: enabled ? `synthetic-recorder-${recordingLease}` : null });
  const keys = (value, allowed) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== [...allowed].sort().join(',')) throw new Error('Unexpected About fixture payload');
  };
  let safeSnapshot = null;
  const ok = body => ({ status: 200, body });
  return { call(name, input = {}) {
    if (name === 'connection.list') return authority.snapshot(input);
    if (name === 'about.fixture.scope') return authority.control(input);
    if (name === 'runtime.request') authority.admit(input);
    if (name === 'about.fixture.scenario') {
      keys(input, ['mode']);
      if (['downloading', 'installing', 'restarting', 'succeeded', 'update-failed'].includes(input.mode)) {
        if (!operation) throw new Error('Missing synthetic operation');
        operation = { ...operation, status: input.mode === 'update-failed' ? 'failed' : input.mode, progress: input.mode === 'downloading' ? 40 : null };
        return true;
      }
      if (!['normal', 'fail-info', 'missing', 'failed', 'cancelled', 'shared', 'gap', 'reject-update'].includes(input.mode)) throw new Error('Invalid About fixture scenario');
      mode = input.mode; return true;
    }
    if (name === 'about.fixture.audit') { keys(input, []); return { reads, exports, enabled, safeSnapshot, submissions, operation, events: [...events], scope: authority.audit() }; }
    if (name === 'native.clientMetadata') { keys(input, []); return { schemaVersion: 1, version: mode === 'missing' ? null : '0.8.1', build: mode === 'missing' ? null : '42', updates: { status: 'unsupported' } }; }
    if (name === 'native.diagnostics.status') { keys(input, []); return status(); }
    if (name === 'native.diagnostics.setEnabled') {
      if (Object.keys(input).join(',') !== 'enabled' || typeof input.enabled !== 'boolean') throw new Error('Invalid About fixture preference');
      enabled = input.enabled; recordingLease++; events.length = 0; return status();
    }
    if (name === 'native.diagnostics.append') {
      keys(input, ['hostID', 'lease', 'events', 'dropped']);
      if (!enabled || input.hostID !== 'synthetic-about-host' || input.lease !== status().recordingLease || !Array.isArray(input.events) || input.events.length > 32 || !Number.isInteger(input.dropped) || input.dropped < 0) throw new Error('Invalid About fixture append');
      for (const event of input.events) {
        keys(event, ['at', 'feat', 'kind', 'sessionID', 'source', 'sseType', 'surfaceKind']);
        if (event.feat !== 'transcript' || event.kind !== 'sse-event' || event.source !== 'sse' || !['global', 'chat'].includes(event.surfaceKind) || !/^session-\d{1,3}$/.test(event.sessionID) || event.sseType !== 'session.status' || !Number.isFinite(event.at)) throw new Error('Invalid About fixture event');
      }
      events.push(...input.events); if (events.length > 500) events.splice(0, events.length - 500);
      return { accepted: true };
    }
    if (name === 'native.diagnostics.export') {
      if (!enabled || input.hostID !== 'synthetic-about-host' || Object.keys(input).sort().join(',') !== 'hostID,snapshot') throw new Error('Invalid About fixture export');
      const source = JSON.stringify(input.snapshot);
      if (/private|token|message|serverId|guidance|pid|startedAt/.test(source)) throw new Error('Unsafe fixture snapshot');
      safeSnapshot = input.snapshot; exports++;
      return { outcome: ['failed', 'cancelled'].includes(mode) ? mode : 'shared', eventCount: events.length };
    }
    if (name === 'runtime.request' && input.method === 'POST' && input.path === '/api/system/update') {
      keys(input, ['path', 'method', 'body', 'expectedHost']); keys(input.body, ['version', 'channel', 'planId', 'allowDowngrade']);
      const candidate = plan();
      if (input.body.version !== candidate.version || input.body.channel !== 'stable' || input.body.planId !== candidate.planId || input.body.allowDowngrade !== false) throw new Error('Unexpected About fixture update plan');
      if (mode === 'reject-update') return { status: 409, body: { error: 'update_plan_changed' } };
      if (operation && !['succeeded', 'failed'].includes(operation.status)) throw new Error('Unexpected duplicate synthetic admission');
      submissions++;
      operation = { id: `synthetic-operation-${submissions}`, version: candidate.version, channel: 'stable', kind: candidate.kind, status: 'checking', progress: null };
      return { status: 202, body: { operation } };
    }
    if (name !== 'runtime.request' || input.method !== 'GET' || input.body !== undefined) throw new Error('Unexpected About fixture mutation');
    keys(input, ['path', 'method', 'expectedHost']);
    reads++;
    if (input.path === '/api/system/info') return mode === 'fail-info' ? { status: 503, body: { error: 'private-fixture-error' } }
      : ok({ yuriVersion: mode === 'missing' ? null : '2.3.0', runtime: 'node', pid: 9, startedAt: 'private-start' });
    if (input.path === '/api/opencode/upgrade-status') return ok({ serveVersion: mode === 'missing' ? null : '2.1.7', cliVersion: '9.9.9', management: 'manual-external', canManage: false, guidance: 'private-guidance' });
    if (['/api/system/update', '/api/system/update?channel=stable'].includes(input.path)) {
      if (mode === 'gap') return { status: 404 };
      return ok({ serverId: 'private-server', host: 'cli', currentVersion: operation?.status === 'succeeded' ? '2.4.0' : '2.3.0', supported: true, available: !operation || operation.status === 'failed', channel: 'stable', update: !operation || operation.status === 'failed' ? plan() : null, operation, checkError: null });
    }
    throw new Error('Unexpected About fixture path');
  } };
}
