import { fixtureRequest } from './new-session-request.js';

/** Strict synthetic Host. Accepts only literal fixture markers; never network/disk or real credentials. */
export function createHost() {
  const providers = ['opencode-go', 'ollama-cloud', 'cursor'];
  const configured = new Map(providers.map(id => [id, true]));
  const counts = { reads: 0, saves: 0, validates: 0, imports: 0, deletes: 0 };
  let mode = 'ok';
  const status = id => ({ configured: configured.get(id), ...(id === 'opencode-go' && configured.get(id) ? { workspaceId: 'wrk_fixture' } : {}) });
  return { call(name, input = {}) {
    if (name === 'quota.fixture.audit') {
      if (Object.keys(input).length) throw new Error('Unexpected audit input');
      return { ...counts };
    }
    if (name === 'quota.fixture.scenario') {
      if (Object.keys(input).length !== 1 || !['ok', 'read-fail', 'reject', 'lost-ack', 'invalid-ack', 'invalid-validation'].includes(input.mode)) throw new Error('Unexpected scenario');
      mode = input.mode; return {};
    }
    if (name !== 'runtime.request' || Object.keys(input).some(key => !['path', 'method', 'body'].includes(key))) throw new Error('Unexpected quota bridge');
    const route = fixtureRequest(input), match = /^\/api\/quota\/credentials\/(opencode-go|ollama-cloud|cursor)(?:\/(validate|import))?$/.exec(route.path);
    if (!match || route.params.size || input.path.includes('?')) throw new Error('Unexpected quota route or directory query');
    const id = match[1], action = match[2], method = input.method;
    const ok = body => ({ status: 200, body });
    const fail = () => ({ status: 400, body: { error: 'synthetic rejection' } });
    if (method === 'GET' && !action) {
      if (input.body !== undefined) throw new Error('Unexpected read body');
      counts.reads++; return mode === 'read-fail' ? { status: 502, body: {} } : ok(status(id));
    }
    if (method === 'PUT' && !action) {
      const fields = id === 'opencode-go' ? ['workspaceId', 'authCookie'] : id === 'ollama-cloud' ? ['cookie'] : ['accessToken', 'refreshToken'];
      if (!input.body || typeof input.body !== 'object' || Array.isArray(input.body) || Object.keys(input.body).length !== fields.length
        || fields.some(key => !Object.hasOwn(input.body, key) || input.body[key] !== (key === 'workspaceId' ? 'wrk_fixture' : key === 'refreshToken' ? '' : 'fixture-only-input'))) throw new Error('Only synthetic quota form values allowed');
      counts.saves++;
      if (mode === 'reject') return fail();
      configured.set(id, true);
      if (mode === 'lost-ack') throw new Error('Synthetic lost ACK');
      return ok(mode === 'invalid-ack' ? {} : status(id));
    }
    if (input.body !== undefined) throw new Error('Unexpected credential action body');
    if (method === 'POST' && action === 'validate') {
      counts.validates++;
      if (!configured.get(id) || mode === 'reject') return fail();
      return ok({ valid: mode !== 'invalid-validation' });
    }
    if (method === 'POST' && action === 'import' && id === 'cursor') {
      counts.imports++; if (mode === 'reject') return fail();
      configured.set(id, true);
      if (mode === 'lost-ack') throw new Error('Synthetic lost ACK');
      return ok(status(id));
    }
    if (method === 'DELETE' && !action) {
      counts.deletes++; if (mode === 'reject') return fail();
      configured.set(id, false);
      if (mode === 'lost-ack') throw new Error('Synthetic lost ACK');
      return ok({ configured: false });
    }
    throw new Error('Unexpected quota method/action');
  } };
}
