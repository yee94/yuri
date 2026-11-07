import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBotCreationContext, readBotCreationDefaults } from './features-bot-defaults';

const directory = path.dirname(fileURLToPath(import.meta.url));
const fixtureDirectory = path.join(directory, 'tests/bot-context-production');
type Reply = { status: number; body: unknown };
type Host = { call(name: string, input?: Record<string, unknown>): unknown };
type Audit = { mutations: number; creates: number; prompts: number; bootstrapReads: number; configDirectories: string[]; catalogDirectories: Array<string | null>; rejected: unknown[]; requests: Array<{ path: string; method: string }> };
let temporary: string, hostBundle: string, hostSource: string;

beforeAll(() => {
  const parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true });
  temporary = mkdtempSync(path.join(parent, 'nsh-bot-context-production-'));
  hostBundle = path.join(temporary, 'host.js');
  const result = spawnSync('bun', ['build', 'tests/bot-context-production-host.js', '--target=browser', '--format=cjs', '--outfile', hostBundle], { cwd: directory, encoding: 'utf8', timeout: 30_000 });
  expect(result.error, result.stdout + result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(path.isAbsolute(hostBundle)).toBe(true);
  hostSource = readFileSync(hostBundle, 'utf8');
});
afterAll(() => { if (temporary) rmSync(temporary, { recursive: true, force: true }); });

function fixtureHost() {
  const context = vm.createContext({ URL: undefined, URLSearchParams: undefined, module: { exports: {} } });
  expect(vm.runInContext('typeof URL + ":" + typeof URLSearchParams', context)).toBe('undefined:undefined');
  vm.runInContext(hostSource, context, { filename: hostBundle });
  const host = vm.runInContext('module.exports.createHost()', context) as Host;
  const send = (resource: string, method = 'GET', body?: unknown) => host.call('runtime.request', { path: resource, method, ...(body === undefined ? {} : { body }) }) as Reply;
  const audit = () => send('/__fixture/bot-context-production/audit').body as Audit;
  return { host, send, audit };
}

describe('Bot context production synthetic Host (Node/VM, not NSH)', () => {
  it('starts with bootstrap schemaVersion 1 but no configured default, plus two plausible decoys', () => {
    const { send, audit } = fixtureHost();
    expect(send('/api/config/settings/bootstrap').body).toEqual({ schemaVersion: 1 });
    expect(send('/api/config?location%5Bdirectory%5D=%2Ffixture%2Fother').body).toEqual([{ type: 'document', info: { model: 'fixture/config-decoy#low' } }]);
    const catalog = send('/api/config/catalog/providers?directory=%2Ffixture%2Fother').body as { providers: Array<{ models: Record<string, unknown> }> };
    expect(Object.keys(catalog.providers[0].models)).toEqual(['gpt-model', 'claude-model', 'config-decoy']);
    expect(audit()).toMatchObject({ mutations: 0, creates: 0, prompts: 0, rejected: [], configDirectories: ['/fixture/other'] });
  });

  it('real default reader keeps the captured model/variant ahead of config and catalog-first guesses', async () => {
    const { send, audit } = fixtureHost();
    const context = createBotCreationContext(() => 1);
    context.update('/fixture/other', { providerID: 'fixture', modelID: 'claude-model', variant: 'high' });
    const result = await readBotCreationDefaults(async resource => send(resource).body, context.snapshot());
    expect(result).toEqual({ name: 'Yuri', model: { providerID: 'fixture', modelID: 'claude-model', variant: 'high' } });
    expect(audit()).toMatchObject({ bootstrapReads: 1, configDirectories: ['/fixture/other'], catalogDirectories: ['/fixture/other'], mutations: 0, rejected: [] });
  });

  it('the config decoy is a real parsed fallback, not an invalid value that cannot compete', async () => {
    const { send } = fixtureHost();
    const result = await readBotCreationDefaults(async resource => send(resource).body, { directory: '/fixture/other' });
    expect(result.model).toEqual({ providerID: 'fixture', modelID: 'config-decoy', variant: 'low' });
  });

  it('rejects malformed resources, query/method/body mismatches and guessed directories', () => {
    const { send } = fixtureHost();
    for (const resource of [
      'https://host.example/api/config/settings/bootstrap', '//host.example/api/config',
      '/api/config/settings/bootstrap?', '/api/config/settings/bootstrap?x=1', '/api/config/settings/bootstrap#x',
      '/api/config?directory=%2Ffixture%2Fother', '/api/config',
      '/api/config?location%5Bdirectory%5D=%2Ffixture%2Fproject',
      '/api/config?location%5Bdirectory%5D=%ZZ',
      '/api/config?location%5Bdirectory%5D=%2Ffixture%2Fother&location%5Bdirectory%5D=%2Ffixture%2Fother',
      '/api/config?location%5Bdirectory%5D=%2Ffixture%2Fother?x=1',
      '/api/config/catalog/providers?directory=%2Ffixture%2Fproject',
      '/api/config/catalog/providers?directory=', '/api/config/catalog/providers?directory',
    ]) expect(() => send(resource), resource).toThrow();
    expect(() => send('/api/config/commands/metadata?directory=%2Ffixture%2Fother', 'POST', { catalog: false })).toThrow();
    expect(() => send('/api/yuri/assistants/capability', 'PUT', {})).toThrow();
  });

  it('forbids saving Bots/config/sessions/prompts, while allowing only the exact read-only metadata POST', () => {
    const { send, audit } = fixtureHost();
    expect(send('/api/config/commands/metadata?directory=%2Ffixture%2Fother', 'POST', { catalog: true }).status).toBe(200);
    for (const [resource, method] of [
      ['/api/yuri/assistants', 'POST'], ['/api/config/settings', 'PUT'], ['/api/session', 'POST'],
      ['/api/session/anything/prompt?directory=%2Ffixture%2Fother', 'POST'], ['/api/fs/write', 'POST'],
    ]) expect(() => send(resource, method, {})).toThrow('must not mutate Host');
    expect(audit()).toMatchObject({ mutations: 5, creates: 0, prompts: 0 });
    expect(audit().rejected).toHaveLength(5);
    expect(fixtureHost().audit()).toMatchObject({ mutations: 0, creates: 0, prompts: 0, rejected: [] });
  });
});

it('production fixture metadata contains no runtime aliases or browser React graph (no engine)', () => {
  type Dependency = { path: string; original?: string; external?: boolean };
  type Metafile = { inputs: Record<string, { imports: Dependency[] }>; outputs: Record<string, { imports: Dependency[] }> };
  const output = path.join(temporary, 'metadata'), metadata = path.join(output, 'graph.json');
  const result = spawnSync('bun', ['build', 'fixture.tsx', '--target=browser', '--external=nsh', '--external=nsh/*', '--metafile=' + metadata, '--outdir', output], { cwd: fixtureDirectory, encoding: 'utf8', timeout: 30_000 });
  expect(result.error, result.stdout + result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  const graph = JSON.parse(readFileSync(metadata, 'utf8')) as Metafile;
  const aliases = Object.entries(graph.inputs).flatMap(([file, details]) => details.imports.filter(item => item.original?.startsWith('@/')).map(item => ({ file, imported: item.original })));
  // Bun can resolve these, but NSH 0.4 leaves them as runtime imports. Preserve
  // the source module seam rather than feeding Bun-transformed JSX to NSH.
  expect(aliases).toEqual([]);
  const externals = Object.values(graph.outputs).flatMap(details => details.imports.filter(item => item.external && item.path !== 'nsh' && !item.path.startsWith('nsh/')));
  expect(externals).toEqual([]);
  const browserRuntime = Object.keys(graph.inputs).filter(file => /\/node_modules\/(?:\.bun\/)?(?:react(?:-dom)?(?:@|\/)|zustand(?:@|\/)|@tanstack\/react-query\/)/.test(file));
  expect(browserRuntime).toEqual([]);
  expect(Object.keys(graph.inputs)).toContain('../../application.tsx');
  const config = JSON.parse(readFileSync(path.join(fixtureDirectory, 'tsconfig.json'), 'utf8')) as { extends: string };
  expect(path.resolve(fixtureDirectory, config.extends)).toBe(path.join(directory, 'tsconfig.json'));
});

it.skipIf(process.env.NSH_BOT_CONTEXT_PRODUCTION_BUNDLE !== '1')('production fixture ownbuild resolves all aliases before QuickJS bytecode compilation (no engine)', () => {
  const result = spawnSync(process.env.NSH_BIN || 'nsh', ['build', 'fixture.tsx', '--out', path.join(temporary, 'ownbuild')], { cwd: fixtureDirectory, encoding: 'utf8', timeout: 60_000 });
  expect(result.error, result.stdout + result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
}, 75_000);

// Only main may opt in during its serialized engine window. This worker runs
// the Node/VM cases above and never invokes NSH unless explicitly requested.
it.skipIf(process.env.NSH_BOT_CONTEXT_PRODUCTION_ENGINE !== '1')('public Projects → local selection → Back → Bots create preserves actual model/variant/directory without saving', () => {
  const steps = [
    'await app.waitFor("text:Actual context project");',
    'app.onDialog(() => "New Session");',
    'await app.press("label:Project menu");',
    'await app.waitFor("id:new-session-composer");',
    'await app.press("id:new-session-model");',
    'await app.waitFor("id:new-session-effort-recent-fixture-claude-model");',
    'await app.press("id:new-session-effort-recent-fixture-claude-model");',
    'await app.waitFor("id:new-session-variant-recent-fixture-claude-model-high");',
    'await app.press("id:new-session-variant-recent-fixture-claude-model-high");',
    'await app.waitFor("id:new-session-selection-search", { state: "gone" });',
    'await app.back();',
    'await app.waitFor("id:projects-open-search");',
    'await app.press("id:projects-open-search");',
    'await app.type("id:projects-global-search", "Bots");',
    'await app.waitFor("id:projects-search-command:settings:assistants");',
    'await app.press("id:projects-search-command:settings:assistants");',
    'await app.waitUntil(() => app.enabled("id:assistant-settings-create"));',
    'await app.press("id:assistant-settings-create");',
    'await app.waitUntil(() => app.value("id:features-bot-name") === "Yuri");',
    'await app.waitFor("text:Claude fixture");',
    'await app.waitFor("text:high");',
    'expect(app.shows("id:features-bot-defaults-error")).toBe(false);',
    'expect(app.texts()).not.toContain("GPT fixture");',
    'expect(app.texts()).not.toContain("Configuration decoy");',
    'await app.press("id:bot-context-production-audit");',
    'await app.waitUntil(() => app.texts().some(value => value.startsWith("bot-context-audit:")));',
    'const audit = JSON.parse(app.texts().find(value => value.startsWith("bot-context-audit:")).slice("bot-context-audit:".length));',
    'expect(audit.configDirectories).toEqual(["/fixture/other"]);',
    'expect(audit.catalogDirectories).toContain("/fixture/other");',
    'expect(audit.bootstrapReads).toBe(1);',
    'expect(audit.mutations).toBe(0); expect(audit.creates).toBe(0); expect(audit.prompts).toBe(0);',
    'expect(audit.rejected).toEqual([]);',
    'expect(app.texts().join("\\n")).not.toMatch(/Unexpected new-session|Invalid assistant|ReferenceError|TypeError/);',
  ];
  // Engine expects the ESM createHost export, not the VM-only CJS wrapper.
  const engineHost = path.join(temporary, 'engine-host.js');
  const build = spawnSync('bun', ['build', 'tests/bot-context-production-host.js', '--target=browser', '--outfile', engineHost], { cwd: directory, encoding: 'utf8', timeout: 30_000 });
  expect(build.error, build.stdout + build.stderr).toBeUndefined();
  expect(build.status, build.stdout + build.stderr).toBe(0);
  const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'fixture.tsx', '--web-host', engineHost], { cwd: fixtureDirectory, encoding: 'utf8', timeout: 60_000, input: steps.join('\n') });
  expect(result.error, result.stdout + result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
}, 95_000);
