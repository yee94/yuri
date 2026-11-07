import { createHost as productionHost } from './new-session-production-host.js';
import { fixtureRequest } from './new-session-request.js';

/** Read-only, in-memory bridge for the real YuriNativeApp navigation fixture. */
export function createHost() {
  const base = productionHost(), directory = '/fixture/other';
  const requests = [], rejected = [], configDirectories = [], catalogDirectories = [];
  let mutations = 0, bootstrapReads = 0;
  const clone = value => JSON.parse(JSON.stringify(value));
  const ok = body => ({ status: 200, body: clone(body) });
  return { call(name, input) {
    try {
      if (name !== 'runtime.request') {
        if (!['connection.list', 'appearance.reset', 'appearance.apply', 'runtime.stream', 'runtime.stop'].includes(name)) throw new Error('Unexpected Bot context native call: ' + name);
        return base.call(name, input);
      }
      requests.push({ path: input.path, method: input.method ?? 'GET' });
      if (input.path.endsWith('?') || input.path.indexOf('?') !== input.path.lastIndexOf('?')) throw new Error('Invalid Bot context query');
      const route = fixtureRequest(input), { path, method, params } = route;
      // This POST is a catalog read; every actual mutation is forbidden, even
      // if production catches its error and otherwise leaves the UI looking OK.
      if (method !== 'GET' && !(path === '/api/config/commands/metadata' && method === 'POST')) {
        mutations++;
        throw new Error('Bot context fixture must not mutate Host: ' + path);
      }
      for (const key of ['directory', 'location[directory]', 'projectDirectory']) {
        if (params.has(key) && params.get(key) !== directory) throw new Error('Wrong Bot context directory: ' + params.get(key));
      }
      if (path === '/__fixture/bot-context-production/audit') {
        route.expect('GET');
        const stats = base.call(name, { path: '/__fixture/new-session-production/audit', method: 'GET' }).body;
        return ok({ mutations, creates: stats.creates, prompts: stats.prompts, bootstrapReads, configDirectories, catalogDirectories, rejected, requests });
      }
      if (path === '/api/config/settings/bootstrap') {
        route.expect('GET'); bootstrapReads++;
        // Deliberately no defaultModel/defaultVariant: current selection wins.
        return ok({ schemaVersion: 1 });
      }
      if (path === '/api/config') {
        route.expect('GET', ['location[directory]'], ['location[directory]']);
        configDirectories.push(params.get('location[directory]'));
        return ok([{ type: 'document', info: { model: 'fixture/config-decoy#low' } }]);
      }
      if (path === '/api/config/settings') {
        route.expect('GET');
        return ok({ ...base.call(name, input).body, projects: [{ id: 'actual-project', name: 'Actual context project', path: directory }] });
      }
      if (path === '/api/config/catalog/providers') {
        route.expect('GET', ['directory']);
        catalogDirectories.push(params.get('directory') ?? null);
        const catalog = clone(base.call(name, { path: '/api/config/catalog/providers?directory=%2Ffixture%2Fother', method: 'GET' }).body);
        catalog.providers[0].models['config-decoy'] = { id: 'config-decoy', name: 'Configuration decoy', variants: { low: {} } };
        return ok(catalog);
      }
      if (path === '/api/yuri/assistants/capability') { route.expect('GET'); return ok({ supported: true, enabled: true }); }
      if (path === '/api/yuri/assistants/snapshot') { route.expect('GET'); return ok({ enabled: true, revision: 1, assistants: [] }); }
      return base.call(name, input);
    } catch (error) {
      rejected.push({ name, path: input?.path, message: String(error instanceof Error ? error.message : error) });
      throw error;
    }
  } };
}
