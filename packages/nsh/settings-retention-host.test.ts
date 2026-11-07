import { expect, test } from 'vitest';
import { createHost } from './tests/settings-retention-host.js';
import { createRetentionController, type RetentionResult } from './settings-retention-controller';

function fixture(settingsResponse?: (body: unknown) => unknown) {
  const host = createHost();
  const storage = new Map<string, string>();
  let active = true;
  const protectedIDs = new Set<string>();
  const controller = createRetentionController({
    send: async (path, method = 'GET', body) => {
      const response = host.call('runtime.request', { path, method, ...(body === undefined ? {} : { body }) });
      if (response.status >= 400) throw Object.assign(new Error('fixture'), { status: response.status });
      return path === '/api/config/settings' && method === 'GET' && settingsResponse ? settingsResponse(response.body) : response.body;
    },
    scope: 'synthetic', current: () => true, available: () => active, protectedIDs: () => protectedIDs, now: () => 200 * 86_400_000,
    storage: { getItem: async key => storage.get(key) ?? null, setItem: async (key, value) => { storage.set(key, value); } },
  });
  return { host, controller, protectedIDs, storage, pause: () => { active = false; }, resume: () => { active = true; } };
}

test.each(['archive', 'delete'] as const)('manual %s confirmation consumes its ticket but cannot bypass required server admission', async action => {
  const f = fixture();
  await f.controller.load();
  await f.controller.save({ autoDeleteEnabled: false, autoDeleteAfterDays: 30, sessionRetentionAction: action });
  const plan = await f.controller.prepare();
  expect(plan?.count).toBe(2);
  expect(await f.controller.confirm(plan!)).toBeNull();
  expect(f.controller.snapshot()).toMatchObject({ admission: 'server-atomic-required', error: 'admission', count: 2, results: [], lastRunAt: null });
  await f.controller.confirm(plan!);
  await f.controller.retry('expired-a');
  expect(f.host.call('retention.fixture.audit')).toMatchObject({ archiveWrites: 0, deleteWrites: 0, detailReads: 0 });
  expect(f.storage.has('yuri.session-retention.journal:synthetic')).toBe(false);
});

test('synthetic Host rejects every path/method/body outside its retention allowlist', () => {
  const { host } = fixture();
  for (const path of ['/api/yuri/session-index', '/api/session?limit=100', '/api/session?limit=500&directory=%2Ffixture', '/api/session?limit=500#x', 'https://example.invalid/api/session', '//example.invalid/api/session', '/api/session?limit=500&cursor=%ZZ']) expect(() => host.call('runtime.request', { path, method: 'GET' })).toThrow();
  expect(() => host.call('runtime.request', { path: '/api/config/settings', method: 'PUT', body: { projects: [] } })).toThrow();
  expect(() => host.call('runtime.request', { path: '/api/session/expired-a', method: 'POST' })).toThrow();
  expect(() => host.call('runtime.request', { path: '/api/yuri/sessions/expired-a/archive', method: 'PUT', body: { archivedAt: 1, directory: '/other' } })).toThrow();
  expect(() => host.call('connection.select', {})).toThrow();
});

test.each(['partial', 'legacy', 'catalog-failed', 'active-failed', 'repeating'])('a %s scan shows unknown and admits no cleanup', async mode => {
  const f = fixture(); await f.controller.load();
  f.host.call('retention.fixture.scenario', { mode });
  expect(await f.controller.prepare()).toBeNull();
  expect(f.controller.snapshot().count).toBeNull();
  expect(f.host.call('retention.fixture.audit').archiveWrites).toBe(0);
});

test('forged and repeated confirmation tickets never authorize cleanup', async () => {
  const f = fixture(); await f.controller.load();
  await f.controller.confirm({ action: 'archive', count: 2 });
  expect(f.host.call('retention.fixture.audit').archiveWrites).toBe(0);
  const plan = await f.controller.prepare();
  f.protectedIDs.add('expired-b');
  f.host.call('retention.fixture.scenario', { mode: 'late-active' });
  await f.controller.confirm(plan!);
  await f.controller.confirm(plan!);
  expect(f.host.call('retention.fixture.audit').archiveWrites).toBe(0);
  expect(f.controller.snapshot().results).toEqual([]);
});

test('device and Host preferences round trip only the three owned fields; dropped action is not saved success', async () => {
  const f = fixture(); await f.controller.load();
  const next = { autoDeleteEnabled: true, autoDeleteAfterDays: 60, sessionRetentionAction: 'delete' as const };
  f.host.call('retention.fixture.scenario', { mode: 'pref-dropped' });
  await f.controller.save(next);
  expect(f.controller.snapshot()).toMatchObject({ preferences: next, hostSynced: false, error: 'host-preferences' });
  expect(JSON.parse(f.storage.get('yuri.session-retention.preferences')!)).toMatchObject(next);
  await f.controller.autoRun();
  expect(f.host.call('retention.fixture.audit').deleteWrites).toBe(0);
  f.host.call('retention.fixture.scenario', { mode: 'normal' });
  await f.controller.save(next);
  expect(f.controller.snapshot().hostSynced).toBe(true);
  expect(f.host.call('retention.fixture.audit').settingsWrites).toBe(1);
});

test('settings ACK plus read failure retries only the read; hidden owners do no work and can resume', async () => {
  const f = fixture(); await f.controller.load();
  f.host.call('retention.fixture.scenario', { mode: 'pref-read-failed' });
  const next = { autoDeleteEnabled: false, autoDeleteAfterDays: 50, sessionRetentionAction: 'delete' as const };
  await f.controller.save(next);
  expect(f.controller.snapshot().hostSynced).toBe(false);
  f.host.call('retention.fixture.scenario', { mode: 'normal' });
  await f.controller.save(next);
  expect(f.host.call('retention.fixture.audit').settingsWrites).toBe(1);
  f.pause(); await f.controller.scan();
  expect(f.host.call('retention.fixture.audit').catalogReads).toBe(0);
  f.resume(); await f.controller.scan();
  expect(f.controller.snapshot().count).toBe(2);
});

test('saved auto enablement is a preference, not atomic admission or a completed cleanup cooldown', async () => {
  const f = fixture(); await f.controller.load();
  await f.controller.save({ autoDeleteEnabled: true, autoDeleteAfterDays: 30, sessionRetentionAction: 'delete' });
  await f.controller.scan();
  await f.controller.autoRun();
  expect(f.controller.snapshot()).toMatchObject({ count: 2, error: 'admission', lastRunAt: null, results: [] });
  await f.controller.retry('expired-a'); await f.controller.autoRun();
  const audit = f.host.call('retention.fixture.audit');
  expect(audit.deleteWrites).toBe(0);
  expect(audit.preferences.autoDeleteLastRunAt).toBeUndefined();
  expect(JSON.parse(f.storage.get('yuri.session-retention.preferences')!).autoDeleteLastRunAt).toBeNull();
});

test('a failed refresh invalidates a previous count rather than reporting an empty catalog', async () => {
  const f = fixture(); await f.controller.load(); await f.controller.scan();
  expect(f.controller.snapshot().count).toBe(2);
  f.host.call('retention.fixture.scenario', { mode: 'catalog-failed' });
  await f.controller.scan();
  expect(f.controller.snapshot()).toMatchObject({ count: null, error: 'catalog' });
  f.host.call('retention.fixture.scenario', { mode: 'normal' });
  const plan = await f.controller.prepare(); await f.controller.confirm(plan!);
  expect(f.controller.snapshot().count).toBe(2);
});

test('changing preferences invalidates confirmation; neither disabling nor enabling auto cleanup bypasses manual admission', async () => {
  const f = fixture(); await f.controller.load();
  const oldPlan = await f.controller.prepare();
  await f.controller.save({ autoDeleteEnabled: false, autoDeleteAfterDays: 365, sessionRetentionAction: 'delete' });
  await f.controller.confirm(oldPlan!);
  expect(f.host.call('retention.fixture.audit').archiveWrites).toBe(0);
  await f.controller.save({ autoDeleteEnabled: false, autoDeleteAfterDays: 30, sessionRetentionAction: 'archive' });
  await f.controller.autoRun();
  expect(f.host.call('retention.fixture.audit').archiveWrites).toBe(0);
  const plan = await f.controller.prepare(); await f.controller.confirm(plan!);
  expect(f.host.call('retention.fixture.audit').archiveWrites).toBe(0);
  expect(f.controller.snapshot().error).toBe('admission');
});

test('authoritative archived state retires a completed tombstone, but later explicit restoration still needs admission', async () => {
  const f = fixture(); await f.controller.load();
  f.storage.set('yuri.session-retention.journal:synthetic', JSON.stringify([{ id: 'expired-a', directory: '/fixture/project', action: 'archive', status: 'completed' }]));
  f.host.call('runtime.request', { path: '/api/yuri/sessions/expired-a/archive', method: 'PUT', body: { archivedAt: 1, directory: '/fixture/project' } });
  await f.controller.load(); await f.controller.scan();
  expect(JSON.parse(f.storage.get('yuri.session-retention.journal:synthetic')!)).toEqual([]);
  f.host.call('retention.fixture.restore', { id: 'expired-a' });
  const later = await f.controller.prepare();
  expect(later?.count).toBe(2);
  await f.controller.confirm(later!);
  expect(f.host.call('retention.fixture.audit').archiveWrites).toBe(1);
});

test('automatic cleanup does no check-then-mutate work even when another client changes its preferences', async () => {
  const f = fixture(); await f.controller.load();
  await f.controller.save({ autoDeleteEnabled: true, autoDeleteAfterDays: 30, sessionRetentionAction: 'archive' });
  f.host.call('runtime.request', { path: '/api/config/settings', method: 'PUT', body: { autoDeleteEnabled: false, autoDeleteAfterDays: 30, sessionRetentionAction: 'archive' } });
  await f.controller.autoRun();
  const audit = f.host.call('retention.fixture.audit');
  expect(audit.archiveWrites).toBe(0);
  expect(audit.catalogReads).toBe(0);
  expect(f.controller.snapshot().error).toBe('admission');
  await f.controller.load();
  expect(f.controller.snapshot().preferences.autoDeleteEnabled).toBe(false);
});

test('read-only candidate protection remains available while all destructive lanes are blocked', async () => {
  const f = fixture(); await f.controller.load();
  f.protectedIDs.add('expired-a');
  const plan = await f.controller.prepare(); await f.controller.confirm(plan!);
  expect(plan?.count).toBe(1);
  expect(f.host.call('retention.fixture.audit').archiveWrites).toBe(0);
  expect(f.controller.snapshot()).toMatchObject({ count: 1, results: [], error: 'admission' });
});

test.each([
  {},
  { executionAllowed: true },
  { capabilities: { retention: true, atomic: true, admission: true } },
  { sessionRetentionAdmission: { supported: true, version: 1, atomic: true, receipts: true } },
])('missing or claimed Host support is not an implemented atomic contract: %j', async claim => {
  const f = fixture(body => ({ ...(body as object), ...claim }));
  f.host.call('runtime.request', { path: '/api/config/settings', method: 'PUT', body: { autoDeleteEnabled: true, autoDeleteAfterDays: 30, sessionRetentionAction: 'delete' } });
  await f.controller.load(); await f.controller.scan();
  const plan = await f.controller.prepare();
  await f.controller.confirm(plan!); await f.controller.autoRun();
  expect(f.controller.snapshot()).toMatchObject({ ready: true, hostSynced: true, admission: 'server-atomic-required', error: 'admission', count: 2, lastRunAt: null, results: [] });
  expect(f.host.call('retention.fixture.audit')).toMatchObject({ archiveWrites: 0, deleteWrites: 0, detailReads: 0 });
});

const journalKey = 'yuri.session-retention.journal:synthetic';
const saved = (status: RetentionResult['status'], action: RetentionResult['action'] = 'delete'): RetentionResult => ({ id: 'expired-a', directory: '/fixture/project', action, status });

test.each([{ partial: true }, { error: 'unsupported-admission' }, { autoDeleteEnabled: 'true' }])('Host error/malformed support keeps recovered intent and is not success: %j', async invalid => {
  let fail = true;
  const f = fixture(body => fail ? { ...(body as object), ...invalid } : body);
  const original = JSON.stringify([saved('uncertain'), { ...saved('ack', 'archive'), id: 'expired-b' }]);
  f.storage.set(journalKey, original);
  f.storage.set('yuri.session-retention.preferences', JSON.stringify({ autoDeleteEnabled: true, autoDeleteAfterDays: 60, sessionRetentionAction: 'delete', autoDeleteLastRunAt: 1 }));
  await f.controller.load();
  expect(f.controller.snapshot()).toMatchObject({ ready: false, error: 'load', lastRunAt: 1, results: JSON.parse(original), preferences: { autoDeleteAfterDays: 60 } });
  expect(f.storage.get(journalKey)).toBe(original);
  await f.controller.autoRun();
  fail = false;
  f.pause(); await f.controller.load(); f.resume(); await f.controller.load(); await f.controller.scan();
  expect(f.controller.snapshot()).toMatchObject({ ready: true, admission: 'server-atomic-required', error: 'admission', results: JSON.parse(original), count: 0, lastRunAt: 1 });
  expect(f.storage.get(journalKey)).toBe(original);
  expect(f.host.call('retention.fixture.audit')).toMatchObject({ archiveWrites: 0, deleteWrites: 0 });
});

test('failed legacy entries remain retryable-but-blocked, preserving count, journal and old cooldown across reconnect', async () => {
  const f = fixture(), original = JSON.stringify([saved('failed')]);
  f.storage.set(journalKey, original);
  f.storage.set('yuri.session-retention.preferences', JSON.stringify({ autoDeleteLastRunAt: 1 }));
  await f.controller.load(); await f.controller.scan(); await f.controller.retry('expired-a');
  f.pause(); await f.controller.retry('expired-a'); f.resume(); await f.controller.load(); await f.controller.retry('expired-a');
  expect(f.controller.snapshot()).toMatchObject({ count: 2, error: 'admission', results: [saved('failed')], lastRunAt: 1 });
  expect(f.storage.get(journalKey)).toBe(original);
  expect(f.host.call('retention.fixture.audit')).toMatchObject({ archiveWrites: 0, deleteWrites: 0, detailReads: 0 });
});

test.each(['uncertain', 'ack'] as const)('restored %s delete is read-only; missing target settles ACK only, never invents an unknown operation receipt', async status => {
  const f = fixture(), original = JSON.stringify([saved(status)]);
  f.storage.set(journalKey, original);
  f.host.call('runtime.request', { path: '/api/session/expired-a', method: 'DELETE' });
  await f.controller.load(); await f.controller.retry('expired-a'); await f.controller.scan();
  expect(f.controller.snapshot().results).toEqual([saved(status === 'ack' ? 'completed' : 'uncertain')]);
  if (status === 'uncertain') expect(f.storage.get(journalKey)).toBe(original);
  await f.controller.retry('expired-a'); await f.controller.load(); await f.controller.autoRun();
  expect(f.host.call('retention.fixture.audit').deleteWrites).toBe(1);
});

test.each(['uncertain', 'ack'] as const)('restored %s archive verifies state without replay or fabricated receipt', async status => {
  const f = fixture(), original = JSON.stringify([saved(status, 'archive')]);
  f.storage.set(journalKey, original);
  f.host.call('runtime.request', { path: '/api/yuri/sessions/expired-a/archive', method: 'PUT', body: { archivedAt: 1, directory: '/fixture/project' } });
  await f.controller.load(); await f.controller.retry('expired-a');
  expect(f.controller.snapshot().results).toEqual([saved(status === 'ack' ? 'completed' : 'uncertain', 'archive')]);
  await f.controller.retry('expired-a');
  if (status === 'uncertain') expect(f.storage.get(journalKey)).toBe(original);
  expect(f.host.call('retention.fixture.audit').archiveWrites).toBe(1);
});

test('Host connection failure preserves prior candidate count and journal; reconnect never upgrades admission', async () => {
  let disconnected = false;
  const f = fixture(body => {
    if (disconnected) throw Object.assign(new Error('disconnected'), { status: 503 });
    return body;
  });
  const original = JSON.stringify([saved('failed')]); f.storage.set(journalKey, original);
  await f.controller.load(); await f.controller.scan();
  disconnected = true; await f.controller.load(); await f.controller.autoRun();
  expect(f.controller.snapshot()).toMatchObject({ count: 2, hostSynced: false, error: 'load', admission: 'server-atomic-required', results: [saved('failed')] });
  expect(f.storage.get(journalKey)).toBe(original);
  disconnected = false; await f.controller.load();
  expect(f.controller.snapshot()).toMatchObject({ count: 2, hostSynced: true, error: 'admission', admission: 'server-atomic-required' });
  expect(f.host.call('retention.fixture.audit')).toMatchObject({ archiveWrites: 0, deleteWrites: 0 });
});

test('late capability response from a retired generation cannot upgrade admission or write into another Host journal', async () => {
  const memory = new Map([[journalKey, JSON.stringify([saved('uncertain')])]]);
  let current = true, finish!: (value: unknown) => void, started!: () => void, requests = 0;
  const reading = new Promise<void>(resolve => { started = resolve; });
  const storage = { getItem: async (key: string) => memory.get(key) ?? null, setItem: async (key: string, value: string) => { memory.set(key, value); } };
  const old = createRetentionController({ scope: 'synthetic', current: () => current, protectedIDs: () => new Set(), storage,
    send: async () => { requests++; started(); return new Promise(resolve => { finish = resolve; }); },
  });
  const loading = old.load(); await reading;
  current = false;
  let publications = 0; old.subscribe(() => { publications++; });
  finish({ autoDeleteEnabled: true, sessionRetentionAction: 'delete', sessionRetentionAdmission: { atomic: true, supported: true } });
  await loading; await old.autoRun();
  expect(publications).toBe(0);
  expect(old.snapshot()).toMatchObject({ ready: false, admission: 'server-atomic-required', results: [saved('uncertain')] });
  const next = createRetentionController({ scope: 'other-host', current: () => true, protectedIDs: () => new Set(), storage, send: async () => ({ autoDeleteEnabled: true, sessionRetentionAction: 'delete' }) });
  await next.load(); await next.autoRun();
  expect(next.snapshot()).toMatchObject({ ready: true, admission: 'server-atomic-required', error: 'admission', results: [] });
  expect(memory.get(journalKey)).toBe(JSON.stringify([saved('uncertain')]));
  expect(memory.has('yuri.session-retention.journal:other-host')).toBe(false);
  expect(requests).toBe(1);
});
