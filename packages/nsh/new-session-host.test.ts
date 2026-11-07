import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

type Request = { path: string; method?: string; body?: Record<string, unknown> };
type Host = { call: (name: string, input: Request) => unknown };
const directory = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tests');

/** Match the QuickJS Host's missing browser URL APIs, without starting any engine. */
function isolatedModule(file: string): Record<string, unknown> {
  const context = vm.createContext({});
  expect(vm.runInContext('typeof URL + ":" + typeof URLSearchParams', context)).toBe('undefined:undefined');
  const modules = new Map<string, Record<string, unknown>>();
  function load(filename: string): Record<string, unknown> {
    const cached = modules.get(filename); if (cached) return cached;
    const exports: Record<string, unknown> = {}; modules.set(filename, exports);
    const source = ts.transpileModule(readFileSync(path.join(directory, filename), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const evaluate = vm.runInContext(`(function(exports, require) { ${source}\n})`, context);
    evaluate(exports, (specifier: string) => {
      if (!/^\.\/new-session-[a-z-]+\.js$/.test(specifier)) throw new Error(`Unexpected fixture import: ${specifier}`);
      return load(specifier.slice(2));
    });
    return exports;
  }
  return load(file);
}
const isolatedHost = (file: string) => (isolatedModule(file).createHost as () => Host)();
const read = (host: Host, resource: string) => {
  const result = host.call('runtime.request', { path: resource, method: 'GET' });
  if (!result || typeof result !== 'object' || !('body' in result) || !('status' in result)) throw new Error('Invalid fixture response');
  return result;
};

describe('new-session fake Host without browser URL globals', () => {
  it('serves the exact model catalog and preference requests used by the real picker', () => {
    const host = isolatedHost('new-session-host.js');
    expect(read(host, '/api/config/catalog/providers?directory=%2Ffixture%2Fproject').body).toMatchObject({ providers: [{ models: { 'gpt-model': { variants: { low: {}, high: {} } } } }] });
    expect(read(host, '/api/config/settings').body).toMatchObject({ favoriteModels: [{ providerID: 'fixture', modelID: 'gpt-model', variant: 'high' }] });
    expect(read(host, '/api/agent?location%5Bdirectory%5D=%2Ffixture%2Fproject').body).toMatchObject({ data: [{ name: 'build' }, { name: 'plan' }, { name: 'explore' }] });
  });

  it('loses creation only once and preserves the exact target for recovery/configuration/admission', () => {
    const host = isolatedHost('new-session-host.js'); read(host, '/__fixture/new-session/lose-create');
    expect(() => host.call('runtime.request', { path: '/api/session', method: 'POST', body: { location: { directory: '/fixture/project' } } })).toThrow('lost session creation response');
    const target = '/api/session/ses_draft_1', scope = '?directory=%2Ffixture%2Fproject';
    expect(read(host, '/api/yuri/session-index').body).toMatchObject({ directories: [{ sessions: [{ id: 'ses_draft_1' }] }] });
    expect(read(host, `${target}${scope}`).body).toMatchObject({ data: { location: { directory: '/fixture/project' } } });
    expect(read(host, `${target}/message${scope}&limit=1`).body).toEqual({ data: [] });
    expect(read(host, `${target}/inbox${scope}`).body).toEqual([]);
    host.call('runtime.request', { path: `${target}/model${scope}`, method: 'POST', body: { model: { providerID: 'fixture', id: 'gpt-model', variant: 'high' } } });
    host.call('runtime.request', { path: `${target}/agent${scope}`, method: 'POST', body: { agent: 'plan' } });
    expect(read(host, `${target}${scope}`).body).toMatchObject({ data: { agent: 'plan', model: { providerID: 'fixture', id: 'gpt-model', variant: 'high' } } });
    host.call('runtime.request', { path: `${target}/prompt${scope}`, method: 'POST', body: { id: 'stable-input', text: 'Captured draft', delivery: 'steer' } });
    expect(read(host, `${target}/inbox${scope}`).body).toMatchObject([{ id: 'stable-input' }]);
    expect(read(host, '/__fixture/new-session/stats').body).toMatchObject({ creates: 1, prompts: [{ id: 'stable-input' }] });
  });

  it('serves production Projects and exposes a real write audit with no browser globals', () => {
    const host = isolatedHost('new-session-production-host.js');
    expect(host.call('connection.list', { path: '' })).toMatchObject({ selected: 'new-session-production' });
    expect(read(host, '/api/config/settings').body).toMatchObject({ projects: [{ path: '/fixture/project' }] });
    expect(read(host, '/api/yuri/message-queue/worktrees/order?projectDirectory=%2Ffixture%2Fproject').body).toMatchObject({ projectDirectory: '/fixture/project' });
    expect(read(host, '/api/git/check?directory=%2Ffixture%2Fproject').body).toMatchObject({ isGitRepository: false });
    expect(read(host, '/__fixture/new-session-production/audit').body).toEqual({ writes: 0, creates: 0, prompts: 0 });
  });

  it('decodes bracketed keys, Unicode, plus and encoded separators with a query parser, not browser APIs', () => {
    const parse = isolatedModule('new-session-request.js').fixtureRequest as (input: Request) => { path: string; params: Map<string, string> };
    const route = parse({ path: '/api/fs/find?location%5Bdirectory%5D=%2Ffixture%2F%E4%B8%AD%E6%96%87&query=a+b%26c%3Dd&type=directory&limit=12' });
    expect(route.path).toBe('/api/fs/find');
    expect(Object.fromEntries(route.params)).toEqual({ 'location[directory]': '/fixture/中文', query: 'a b&c=d', type: 'directory', limit: '12' });
    const host = isolatedHost('new-session-host.js');
    expect(read(host, '/api/fs/find?location%5Bdirectory%5D=%2Ffixture%2F%E4%B8%AD%E6%96%87&query=a+b%26c%3Dd&type=directory&limit=12').body).toMatchObject({ data: [{ type: 'directory' }] });
  });

  it.each([
    '/api/config/settings/extra', '/api/config/settings?unknown=1', '/api/config/settings?directory=%ZZ',
    'https://host.example/api/config/settings', '//host.example/api/config/settings', '/api/config/settings#ignored',
    '/api/fs/find?location%5Bdirectory%5D=%2Ffixture&query=x&type=file&type=directory&limit=12',
    '/api/fs/find?location%5Bdirectory%5D=%2Ffixture&query=x&type=file&%74ype=directory&limit=12',
    '/api/session/unknown/not-a-route?directory=%2Ffixture%2Fproject',
  ])('rejects unexpected/malformed route or query instead of returning a success: %s', resource => {
    const host = isolatedHost('new-session-production-host.js');
    expect(() => read(host, resource)).toThrow();
  });

  it.each([
    '/api/config/catalog/providers', '/api/agent?directory=%2Ffixture%2Fproject',
    '/api/fs/find?location%5Bdirectory%5D=%2Ffixture&type=file&limit=12',
    '/api/fs/find?location%5Bdirectory%5D=%2Ffixture&query=x&type=socket&limit=12',
    '/api/fs/find?location%5Bdirectory%5D=%2Ffixture&query=x&type=file&limit=0',
    '/api/session?order=asc', '/api/git/check?directory=',
    '/api/yuri/message-queue/worktrees/order?projectDirectory=%2Ffixture&projectDirectory=%2Fother',
  ])('rejects missing or invalid endpoint-specific query contracts: %s', resource => {
    expect(() => read(isolatedHost('new-session-production-host.js'), resource)).toThrow();
  });

  it('rejects wrong methods and scope, and unknown routes remain errors rather than blanket 404 success', () => {
    const host = isolatedHost('new-session-host.js');
    expect(() => host.call('runtime.request', { path: '/__fixture/new-session/lose-create', method: 'POST' })).toThrow();
    host.call('runtime.request', { path: '/api/session', method: 'POST', body: { location: { directory: '/fixture/project' } } });
    expect(() => read(host, '/api/session/ses_draft_1/prompt?directory=%2Ffixture%2Fproject')).toThrow();
    expect(() => host.call('runtime.request', { path: '/api/session/ses_draft_1/prompt', method: 'POST', body: { id: 'missing-scope', text: 'must not enter' } })).toThrow();
    expect(() => host.call('runtime.request', { path: '/api/session/ses_draft_1/prompt?directory=%2Fother', method: 'POST', body: { id: 'wrong-host-scope', text: 'must not enter' } })).toThrow();
    expect(read(host, '/__fixture/new-session/stats').body).toMatchObject({ prompts: [] });
    expect(read(host, '/api/session/absent/inbox?directory=%2Ffixture%2Fproject').status).toBe(404);
  });

  it.each(['/api/config/settings', '/api/config/themes', '/api/git/check?directory=%2Ffixture%2Fproject', '/__fixture/new-session-production/audit'])('production wrapper does not turn the wrong method into read success: %s', resource => {
    expect(() => isolatedHost('new-session-production-host.js').call('runtime.request', { path: resource, method: 'POST' })).toThrow();
  });
});
