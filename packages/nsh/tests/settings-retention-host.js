/** Strict in-memory synthetic Host. No imports, filesystem, credentials, fetch, sockets or production forwarding. */
export function createHost() {
  const now = 200 * 86_400_000, directory = '/fixture/project';
  const row = (id, days, extra = {}) => ({ id, title: id, location: { directory }, time: { created: now - days * 86_400_000, updated: now - days * 86_400_000 }, ...extra });
  const rows = new Map([
    ...Array.from({ length: 505 }, (_, index) => row(`recent-${index}`, 1 + index / 1000)),
    row('expired-a', 60), row('expired-b', 61), row('shared', 70, { share: { url: 'https://example.invalid/shared' } }),
    row('system', 90, { metadata: { yuri: { assistant: { assistantID: 'fixture-bot' } } } }),
    row('child', 80, { parentID: 'recent-0' }),
  ].map(value => [value.id, value]));
  let mode = 'normal', archiveWrites = 0, deleteWrites = 0, catalogReads = 0, activeReads = 0, settingsWrites = 0, detailReads = 0;
  let preferences = { autoDeleteEnabled: false, autoDeleteAfterDays: 30, sessionRetentionAction: 'archive' };
  const requests = [], memory = new Map();
  const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const ok = body => ({ status: 200, body: clone(body) });
  const keys = (value, allowed) => { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new Error('Unexpected synthetic payload'); };
  return { call(name, input = {}) {
    if (name === 'retention.fixture.restore') {
      keys(input, ['id']);
      if (input.id !== 'expired-a') throw new Error('Unexpected fixture restore');
      const item = rows.get(input.id);
      if (!item) throw new Error('Missing fixture restore target');
      item.time.archived = 0; return true;
    }
    if (name === 'retention.fixture.scenario') {
      keys(input, ['mode']);
      if (!['normal', 'fail-one', 'partial', 'legacy', 'catalog-failed', 'active-failed', 'repeating', 'pref-dropped', 'pref-read-failed', 'unknown-delete', 'late-active', 'read-after-ack'].includes(input.mode)) throw new Error('Unknown retention scenario');
      mode = input.mode; return true;
    }
    if (name === 'retention.fixture.audit') { keys(input, []); return clone({ archiveWrites, deleteWrites, catalogReads, activeReads, detailReads, settingsWrites, requests, preferences }); }
    if (name === 'retention.fixture.storage') {
      keys(input, ['key', 'value']);
      if (typeof input.key !== 'string' || !input.key.startsWith('yuri.session-retention.')) throw new Error('Unexpected storage key');
      if ('value' in input) { if (typeof input.value !== 'string') throw new Error('Unexpected storage value'); memory.set(input.key, input.value); return null; }
      return memory.get(input.key) ?? null;
    }
    if (name !== 'runtime.request') throw new Error('Unexpected synthetic capability: ' + name);
    keys(input, ['path', 'method', 'body']);
    const { path, method } = input;
    if (typeof path !== 'string' || !['GET', 'PUT', 'DELETE'].includes(method)) throw new Error('Unexpected synthetic request');
    if (method === 'GET' && 'body' in input) throw new Error('Unexpected read body');
    if (path === '/api/config/settings') {
      if (method === 'GET') {
        requests.push({ path, method });
        if (mode === 'pref-read-failed' && settingsWrites) return { status: 503, body: {} };
        return ok(mode === 'pref-dropped' ? { autoDeleteEnabled: preferences.autoDeleteEnabled, autoDeleteAfterDays: preferences.autoDeleteAfterDays } : preferences);
      }
      if (method !== 'PUT') throw new Error('Unexpected settings method');
      keys(input.body, ['autoDeleteEnabled', 'autoDeleteAfterDays', 'sessionRetentionAction']);
      const body = input.body;
      if (Object.keys(body).length !== 3 || typeof body.autoDeleteEnabled !== 'boolean' || !Number.isFinite(body.autoDeleteAfterDays) || body.autoDeleteAfterDays < 1 || body.autoDeleteAfterDays > 365 || !['archive', 'delete'].includes(body.sessionRetentionAction)) throw new Error('Invalid retention preferences');
      preferences = clone(body); settingsWrites++; requests.push({ path, method, body: clone(body) }); return ok({ success: true });
    }
    if (path === '/api/session/active') {
      if (method !== 'GET') throw new Error('Unexpected active method');
      activeReads++; requests.push({ path, method });
      if (mode === 'active-failed') return { status: 503, body: {} };
      return ok({ data: mode === 'late-active' && activeReads > 1 ? { 'expired-a': { type: 'running' } } : {} });
    }
    if (path === '/api/session?limit=500' || path === '/api/session?limit=500&cursor=retention%2Fpage%2F%2B%3D') {
      if (method !== 'GET') throw new Error('Unexpected catalog method');
      catalogReads++; requests.push({ path, method });
      if (mode === 'catalog-failed' || (mode === 'read-after-ack' && (archiveWrites || deleteWrites))) return { status: 503, body: {} };
      const all = [...rows.values()], second = path.includes('&cursor=');
      const data = second ? all.slice(500) : all.slice(0, 500);
      if (mode === 'legacy') return ok(data);
      return ok({ data, ...(mode === 'partial' ? { partial: true } : {}), cursor: second && mode !== 'repeating' ? {} : { next: 'retention/page/+=' } });
    }
    const detail = /^\/api\/session\/(expired-[ab]|recent-\d+|shared|system|child)$/.exec(path);
    if (detail) {
      const id = detail[1];
      if (method === 'GET') { detailReads++; requests.push({ path, method }); return rows.has(id) ? ok({ data: rows.get(id) }) : { status: 404, body: {} }; }
      if (method !== 'DELETE' || 'body' in input || !/^expired-[ab]$/.test(id)) throw new Error('Unexpected synthetic delete');
      deleteWrites++; requests.push({ path, method }); rows.delete(id);
      if (mode === 'unknown-delete') throw new Error('Synthetic response lost after delete');
      return { status: 204, body: null };
    }
    const archive = /^\/api\/yuri\/sessions\/(expired-[ab])\/archive$/.exec(path);
    if (archive) {
      if (method !== 'PUT') throw new Error('Unexpected archive method');
      keys(input.body, ['archivedAt', 'directory']);
      if (Object.keys(input.body).length !== 2 || input.body.directory !== directory || !Number.isFinite(input.body.archivedAt) || input.body.archivedAt <= 0) throw new Error('Unexpected archive body');
      archiveWrites++; requests.push({ path, method, body: clone(input.body) });
      if (mode === 'fail-one' && archive[1] === 'expired-a') return { status: 409, body: {} };
      const item = rows.get(archive[1]);
      if (!item) return { status: 404, body: {} };
      item.time.archived = input.body.archivedAt; return ok({ session: item });
    }
    throw new Error('Unexpected synthetic path: ' + path);
  } };
}
