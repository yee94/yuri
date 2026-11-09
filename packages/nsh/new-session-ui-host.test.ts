import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { createProjectIdFromPath } from '../ui/src/lib/projectId';
import { newSessionUIScenarios } from './new-session-ui-steps';

type Input = { path: string; method?: string; body?: unknown; expectedHost?: unknown };
type Response = { status: number; body: unknown };
type Host = { call(name: string, input: Input): Response };
const directory = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tests');
function fixture() {
  const context = vm.createContext({});
  expect(vm.runInContext('typeof URL + ":" + typeof URLSearchParams', context)).toBe('undefined:undefined');
  function load(file: string): Record<string, unknown> {
    const exports = {};
    const source = ts.transpileModule(readFileSync(path.join(directory, file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    vm.runInContext(`(function(exports, require) { ${source}\n})`, context)(exports, (specifier: string) => {
      if (specifier !== './new-session-request.js') throw new Error(`Unexpected fixture dependency: ${specifier}`);
      return load('new-session-request.js');
    });
    return exports;
  }
  const host = (load('new-session-host.js').createHost as () => Host)();
  const scope = (host.call('connection.list', { path: '' }) as unknown as { runtimeScope: unknown }).runtimeScope;
  return (resource: string, method = 'GET', body?: unknown) => host.call('runtime.request', { path: resource, method, expectedHost: scope, ...(body === undefined ? {} : { body }) });
}
const canonical = `/fixture/home/.config/yuri/projects/${createProjectIdFromPath('/fixture/project')}.json`;
const readConfig = (file: string) => `/api/fs/read?path=${encodeURIComponent(file)}&optional=true`;

describe('new-session UI fake Host contracts, without engine/browser globals', () => {
  it('serves actual home and optional canonical/legacy text reads; unknown paths are not empty success', () => {
    const call = fixture();
    expect(call('/api/fs/home').body).toEqual({ home: '/fixture/home' });
    expect(call(readConfig(canonical))).toEqual({ status: 200, body: '' });
    expect(call(readConfig('/fixture/home/.config/yuri/projects/path__fixture_project.json'))).toEqual({ status: 200, body: '' });
    expect(call(readConfig('/fixture/project/.yuri/yuri.json'))).toEqual({ status: 200, body: '' });
    expect(call(`/api/fs/read?path=${encodeURIComponent(canonical)}`).status).toBe(404);
    expect(() => call(readConfig('/fixture/unknown.json'))).toThrow();
    expect(() => call('/api/path')).toThrow();
  });

  it('returns scoped command and skill catalogs with their real envelopes', () => {
    const call = fixture();
    expect(call('/api/config/commands/metadata?directory=%2Ffixture%2Fproject', 'POST', { catalog: true }).body).toMatchObject({ commands: [{ name: 'fixture-command', scope: 'user' }, { name: 'fixture-project-command', scope: 'project' }] });
    expect(call('/api/config/skills?summary=true&directory=%2Ffixture%2Fproject').body).toMatchObject({ skills: [{ name: 'fixture-review', scope: 'project' }] });
  });

  it('round-trips narrow settings patches without replacing unrelated settings, and isolates Host instances', () => {
    const call = fixture(), before = call('/api/config/settings').body;
    const pins = [{ type: 'command', name: 'explore' }];
    expect(call('/api/config/settings', 'PUT', { draftStarters: pins }).status).toBe(200);
    expect(call('/api/config/settings').body).toEqual({ ...before as object, draftStarters: pins });
    const favorites = [{ providerID: 'fixture', modelID: 'claude-model', variant: 'high' }];
    call('/api/config/settings', 'PUT', { favoriteModels: favorites });
    expect(call('/api/config/settings').body).toMatchObject({ draftStarters: pins, favoriteModels: favorites, recentModels: [{ modelID: 'claude-model' }] });
    expect(fixture()('/api/config/settings').body).toEqual(before);
    expect(call('/__fixture/new-session/stats').body).toMatchObject({ settingsWrites: [{ draftStarters: pins }, { favoriteModels: favorites }] });
  });

  it('round-trips the project root config after mkdir, retaining unrelated JSON fields', () => {
    const call = fixture();
    const content = JSON.stringify({ projectPath: '/fixture/project', version: 2, draftStarters: [{ type: 'skill', name: 'fixture-review' }], projectActions: [{ id: 'keep' }] });
    expect(() => call('/api/fs/write', 'POST', { path: canonical, content })).toThrow();
    expect(call('/api/fs/mkdir', 'POST', { path: '/fixture/home/.config/yuri/projects' }).body).toMatchObject({ success: true });
    expect(call('/api/fs/write', 'POST', { path: canonical, content }).body).toMatchObject({ success: true });
    expect(call(readConfig(canonical)).body).toBe(content);
    expect(call('/__fixture/new-session/stats').body).toMatchObject({ projectWrites: [{ path: canonical, content }] });
    expect(fixture()(readConfig(canonical)).body).toBe('');
  });

  it('rejects malformed/wrong-root project writes without replacing the last valid text', () => {
    const call = fixture(), content = JSON.stringify({ projectPath: '/fixture/project', draftStarters: [] });
    call('/api/fs/mkdir', 'POST', { path: '/fixture/home/.config/yuri/projects' });
    call('/api/fs/write', 'POST', { path: canonical, content });
    for (const invalid of ['{malformed', JSON.stringify({ projectPath: '/fixture/other', draftStarters: [] }), JSON.stringify({ projectPath: '/fixture/project', draftStarters: null })]) {
      expect(() => call('/api/fs/write', 'POST', { path: canonical, content: invalid })).toThrow();
      expect(call(readConfig(canonical)).body).toBe(content);
    }
    expect(call('/__fixture/new-session/stats').body).toMatchObject({ projectWrites: [{ path: canonical, content }] });
  });

  it.each([
    ['Send captured configuration', 'plan', { providerID: 'fixture', id: 'gpt-model', variant: 'high' }],
    ['Cycle primary catalog', 'plan', undefined],
    ['Long press preserves Build', 'build', undefined],
  ] as const)('admits %s only with the captured authoritative session selection', (text, agent, model) => {
    const call = fixture(), scope = '?directory=%2Ffixture%2Fproject';
    call('/api/session', 'POST', { location: { directory: '/fixture/project' } });
    const target = '/api/session/ses_draft_1';
    expect(() => call(target + '/prompt' + scope, 'POST', { id: 'input', text })).toThrow('captured selection mismatch');
    expect(call('/__fixture/new-session/stats').body).toMatchObject({ prompts: [] });
    call(target + '/agent' + scope, 'POST', { agent });
    if (model) call(target + '/model' + scope, 'POST', { model: { id: model.id, variant: model.variant, providerID: model.providerID } });
    expect(call(target + '/prompt' + scope, 'POST', { id: 'input', text }).status).toBe(200);
  });

  it('favorite scenario cannot admit a switched model/variant or unpersisted favorite changes', () => {
    const call = fixture(), scope = '?directory=%2Ffixture%2Fproject', target = '/api/session/ses_draft_1';
    call('/api/session', 'POST', { location: { directory: '/fixture/project' } });
    const submit = () => call(target + '/prompt' + scope, 'POST', { id: 'favorite-input', text: 'Favorites preserve captured selection' });
    call(target + '/model' + scope, 'POST', { model: { providerID: 'fixture', id: 'gpt-model', variant: 'high' } });
    expect(submit).toThrow('captured selection mismatch');
    call(target + '/model' + scope, 'POST', { model: { providerID: 'fixture', id: 'gpt-model', variant: 'low' } });
    expect(submit).toThrow('favorite persistence mismatch');
    const gpt = { providerID: 'fixture', modelID: 'gpt-model', variant: 'high' }, claude = { providerID: 'fixture', modelID: 'claude-model' };
    call('/api/config/settings', 'PUT', { recentModels: [{ ...gpt, variant: 'low' }], favoriteModels: [{ ...gpt, variant: 'low' }] });
    expect(submit).toThrow('favorite persistence mismatch');
    for (const favoriteModels of [[claude, gpt], [claude], [{ ...gpt, variant: 'low' }, claude]]) call('/api/config/settings', 'PUT', { favoriteModels });
    expect(submit().status).toBe(200);
    expect(call('/__fixture/new-session/stats').body).toMatchObject({ prompts: [{ text: 'Favorites preserve captured selection' }] });
  });

  it('parses every prepared engine script and retains the long-press Sheet readiness contract', () => {
    for (const steps of Object.values(newSessionUIScenarios)) {
      const result = ts.transpileModule(steps.join('\n'), { reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022 } });
      expect(result.diagnostics).toEqual([]);
    }
    const steps = newSessionUIScenarios.modelAgentVariant;
    const index = steps.indexOf('await app.longPress("id:new-session-agent");');
    expect(index).toBeGreaterThan(0);
    expect(steps[index + 1]).toBe('await app.waitFor("id:new-session-selection-search");');
    expect(steps.join('\n')).toContain('new-session-variant-favorite-fixture-gpt-model-high');
  });

  it.each([
    ['/api/fs/home?unknown=1', 'GET'], ['/api/fs/home', 'POST'],
    ['/api/fs/read?path=%2Ffixture%2Fproject%2F.yuri%2Fyuri.json&optional=false', 'GET'],
    ['/api/fs/read?optional=true', 'GET'], ['/api/fs/read?path=x&path=y&optional=true', 'GET'],
    ['/api/config/skills?directory=%2Ffixture%2Fproject', 'GET'],
    ['/api/config/skills?directory=%2Ffixture%2Fproject&summary=false', 'GET'],
    ['/api/config/skills?summary=true&directory=%2Ffixture%2Fproject&extra=1', 'GET'],
    ['/api/config/commands/metadata?directory=%2Ffixture%2Fproject', 'GET'],
    ['/api/config/commands/metadata?directory=%2Ffixture%2Fproject', 'POST', { catalog: false }],
    ['/api/config/commands/metadata?directory=%2Ffixture%2Fproject', 'POST', { catalog: true, extra: true }],
    ['/api/config/settings', 'PUT', {}], ['/api/config/settings', 'PUT', { unknown: [] }],
    ['/api/config/settings', 'PUT', { draftStarters: [{ type: 'unknown', name: 'x' }] }],
    ['/api/config/settings', 'PUT', { favoriteModels: [{ providerID: 'fixture' }] }],
    ['/api/fs/mkdir', 'POST', { path: '/outside' }],
    ['/api/fs/write', 'POST', { path: canonical, content: '{malformed' }],
  ] as const)('rejects wrong method/query/body instead of claiming empty success: %s %s', (resource, method, body?) => {
    expect(() => fixture()(resource, method, body)).toThrow();
  });
});
