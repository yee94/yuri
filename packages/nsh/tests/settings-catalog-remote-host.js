/** Explicit synthetic --web-host only; no network, credentials, or real Host. */
export function createHost() {
  const scope = { hostID: 'catalog-remote-fixture', lease: 'synthetic-only-lease' };
  const client = { id: 'desktop', label: 'Synthetic desktop', createdAt: '2026-01-01T00:00:00Z', lastUsedAt: null, revokedAt: null, connected: true };
  const old = { ...client, id: 'revoked', label: 'Revoked device', connected: false, revokedAt: '2026-01-01T00:00:00Z' };
  let clients = [client, old], pending = [{ id: 'old-pending', label: 'Pending phone', expiresAt: '2099-01-01T00:00:00Z' }];
  let catalogs = [{ id: 'custom:other', label: 'Existing source', source: 'https://example.invalid/other/repo', retained: 7 }];
  const audit = { installs: [], scans: [], settingsWrites: 0, names: [], revokes: [], cancels: [], pairings: [], clientReads: 0 };
  const flags = new Set(); let release = null, pageReads = 0;
  const item = { sourceId: 'curated', repoSource: 'https://example.invalid/team/skills', skillDir: 'tools/fixture', skillName: 'fixture-skill', description: 'Synthetic skill', installable: true, gitIdentityId: 'metadata-only', installed: { isInstalled: false } };
  function answer(input) {
    const [pathname, rawQuery = ''] = input.path.split('?'), query = {};
    for (const field of rawQuery.split('&').filter(Boolean)) { const i = field.indexOf('='); query[decodeURIComponent(field.slice(0, i))] = decodeURIComponent(field.slice(i + 1)); }
    const url = { pathname, searchParams: { get: key => query[key] ?? null } }, method = input.method ?? 'GET', body = input.body ?? {};
    const ok = body => ({ status: 200, body });
    const fail = () => ({ status: 503, body: { error: 'Synthetic service unavailable' } });
    if (method !== 'GET' && flags.delete('write-fail')) return fail();
    if (url.pathname === '/api/config/settings') {
      if (method === 'PUT') { audit.settingsWrites++; if (Object.keys(body).join() !== 'skillCatalogs') throw new Error('Unexpected settings patch'); catalogs = body.skillCatalogs; }
      return ok({ projects: [{ id: 'selected', path: '/fixture/selected', label: 'Selected workspace' }, { id: 'other', path: '/fixture/other', label: 'Other workspace' }], skillCatalogs: catalogs });
    }
    if (url.pathname === '/api/config/skills/catalog') return ok({ ok: true, sources: [{ id: 'curated', label: 'Synthetic source', source: item.repoSource }, ...catalogs], itemsBySource: {}, pageInfoBySource: {} });
    if (url.pathname === '/api/config/skills/catalog/source') {
      pageReads++;
      const id = url.searchParams.get('sourceId');
      const more = url.searchParams.get('cursor');
      if (more && more !== 'opaque/+=&cursor') throw new Error('Cursor was not opaque');
      return ok({ ok: true, items: [{ ...item, sourceId: id }, ...(more ? [{ ...item, sourceId: id, skillDir: 'second', skillName: 'second-skill' }] : [])], nextCursor: more ? null : 'opaque/+=&cursor' });
    }
    if (url.pathname === '/api/config/skills/scan' && method === 'POST') {
      audit.scans.push(body);
      if (!body.gitIdentityId) return { status: 401, body: { ok: false, error: { kind: 'authRequired', identities: [{ id: 'team-identity', name: 'Team identity' }] } } };
      return ok({ ok: true, items: [{ skillDir: 'tools/fixture', skillName: 'fixture-skill', installable: true }] });
    }
    if (url.pathname === '/api/config/skills/install' && method === 'POST') {
      audit.installs.push({ path: input.path, body });
      if (flags.delete('install-unknown')) throw new Error('Synthetic lost install ACK');
      if (body.scope === 'project' && url.searchParams.get('directory') !== '/fixture/other') throw new Error('Wrong selected project');
      if (!body.conflictDecisions) return { status: 409, body: { ok: false, error: { kind: 'conflicts', conflicts: [{ skillName: 'fixture-skill', scope: body.scope, source: body.targetSource }, { skillName: 'sibling', scope: body.scope, source: body.targetSource }] } } };
      return ok({ ok: true, installed: [{ skillName: 'fixture-skill', scope: body.scope, source: body.targetSource }], skipped: [{ skillName: 'sibling', reason: 'skippedByUser' }], requiresReload: false });
    }
    if (url.pathname === '/api/client-auth/clients') {
      if (method === 'GET') { audit.clientReads++; return flags.delete('clients-fail') ? fail() : ok({ clients, currentClientId: 'desktop' }); }
      if (method === 'DELETE') { const purged = clients.filter(row => row.revokedAt).length; clients = clients.filter(row => !row.revokedAt); return ok({ purged }); }
    }
    if (url.pathname.startsWith('/api/client-auth/clients/')) {
      const id = decodeURIComponent(url.pathname.split('/').pop()), found = clients.find(row => row.id === id);
      if (!found) throw new Error('Unknown synthetic client');
      if (method === 'PATCH') { audit.names.push(body.label); found.label = body.label; return ok({ client: found }); }
      if (method === 'DELETE') { audit.revokes.push(id); found.revokedAt = '2026-01-02T00:00:00Z'; found.connected = false; return ok({ revoked: true, client: found }); }
    }
    if (url.pathname === '/api/client-auth/pairing/transports') return flags.delete('transports-fail') ? fail() : ok({ serverName: 'Synthetic server', local: 'http://localhost:3000', lan: 'http://192.0.2.10:3000', relayAvailable: false, relayUrl: null });
    if (url.pathname === '/api/client-auth/pairing/sessions') {
      if (method === 'GET') return flags.delete('pending-fail') ? fail() : ok({ pending });
      if (method === 'POST') {
        audit.pairings.push(body);
        if (flags.delete('pair-unknown')) throw new Error('Synthetic lost pairing ACK');
        pending.push({ id: 'created-pair', label: body.label, expiresAt: '2099-01-01T00:00:00Z' });
        return ok({ pairing: { id: 'created-pair', secret: 'synthetic-once', expiresAt: '2099-01-01T00:00:00Z' }, server: { candidates: [{ type: 'lan', url: body.serverUrl }] } });
      }
    }
    if (url.pathname.startsWith('/api/client-auth/pairing/sessions/') && method === 'DELETE') {
      const id = decodeURIComponent(url.pathname.split('/').pop()); audit.cancels.push(id); pending = pending.filter(row => row.id !== id); return ok({ cancelled: true });
    }
    throw new Error('Unexpected synthetic route: ' + method + ' ' + url.pathname);
  }
  return { call(name, input = {}) {
    if (name === 'connection.list') return { selected: scope.hostID, runtimeScope: scope, connections: [{ id: scope.hostID, label: 'Synthetic Host', url: 'https://settings.example.invalid', lastUsedAt: 0 }] };
    if (name === 'catalogRemote.fixture.audit') return { ...audit, pageReads, catalogs };
    if (name === 'catalogRemote.fixture.scenario') {
      if (input.mode === 'release') { if (!release) throw new Error('No held request'); const finish = release; release = null; finish(); }
      else flags.add(input.mode);
      return null;
    }
    if (name !== 'runtime.request') throw new Error('Unexpected synthetic native call');
    if (input.expectedHost?.hostID !== scope.hostID || input.expectedHost?.lease !== scope.lease) throw new Error('Unadmitted synthetic scope');
    if (input.method !== 'GET' && flags.delete('hold')) return new Promise(resolve => { release = () => resolve(answer(input)); });
    return answer(input);
  } };
}
