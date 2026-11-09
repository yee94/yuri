import { speechDefaults } from '../ui/src/lib/voice/speechSettings';

/** Synthetic headless transport only; never installed as an application Host. */
export function createSettingsProtectionFixtureHost() {
  const ok = (body: unknown) => ({ status: 200, body });
  const entry = { id: 'fixture', name: 'fixture', scope: 'user', description: 'Fixture description', mode: 'primary', template: 'Fixture command', type: 'remote', url: 'https://mcp.example.invalid', enabled: true, spec: 'fixture-plugin', options: {} };
  const provider = { id: 'fixture', name: 'Fixture provider', integrationID: 'fixture', models: { fixture: { id: 'fixture', name: 'Fixture model', capabilities: { tools: true, input: ['text'], output: ['text'] }, limit: { context: 4096, output: 1024 } } } };
  let voice = { ...speechDefaults }, magic: Record<string, string> = {}, behavior = 'Fixture behavior';
  let settings: Record<string, unknown> = { defaultModel: '', hiddenModels: [], gitChangesViewMode: 'flat' };
  let globalConfig = '{\n// Fixture JSONC comment\n}\n';
  return (input: { path: string; method: string; body?: unknown }) => {
    const pathname = input.path.split('?')[0], body = input.body as Record<string, unknown>;
    if (pathname === '/api/config/global/opencode') {
      if (input.method === 'PUT') globalConfig = String(body.content);
      return ok({ target: 'opencode', fileName: 'opencode.jsonc', content: globalConfig });
    }
    if (pathname === '/api/config/settings') {
      if (input.method === 'PUT') settings = { ...settings, ...body };
      return ok({ ...settings });
    }
    if (pathname === '/api/voice/settings') { if (input.method === 'PUT') voice = { ...voice, ...body }; return ok({ ...voice }); }
    if (pathname === '/api/behavior/agents-md') { if (input.method === 'PUT') behavior = String(body.content); return ok({ content: behavior }); }
    if (pathname === '/api/magic-prompts') { if (input.method === 'PUT') magic = body.overrides as Record<string, string>; return ok({ version: 1, overrides: magic }); }
    if (pathname.startsWith('/api/magic-prompts/')) { const id = decodeURIComponent(pathname.slice('/api/magic-prompts/'.length)); if (input.method === 'PUT') magic[id] = String(body.text); else if (input.method === 'DELETE') delete magic[id]; return ok({ version: 1, overrides: { ...magic } }); }
    if (pathname === '/api/dictation/status') return ok({ provider: 'local', models: [], ttsModels: [] });
    if (pathname === '/api/github/auth/status') return ok({ connected: false, accounts: [], ghCli: { available: false, active: false, disabled: false } });
    if (pathname === '/api/git/discover-credentials') return ok([]);
    if (pathname === '/api/system/info') return ok({ yuriVersion: '1.0.0' });
    if (pathname === '/api/opencode/upgrade-status') return ok({ serveVersion: '1.0.0', management: 'manual-external', canManage: false });
    if (pathname === '/api/system/update') return ok({ supported: false, currentVersion: '1.0.0' });
    if (pathname === '/api/agent' || pathname === '/api/command') return ok({ data: [{ ...entry }] });
    if (pathname === '/api/config/agents/metadata') return ok({ agents: { fixture: { scope: 'user' } } });
    if (pathname === '/api/config/agents/fixture/config') return ok({ config: { prompt: 'Fixture system' } });
    if (pathname === '/api/config/mcp') return ok([{ ...entry }]);
    if (pathname === '/api/config/skills') return ok({ skills: [{ ...entry, path: '/fixture/SKILL.md' }] });
    if (pathname === '/api/config/skills/fixture' && input.method === 'GET') return ok({ ...entry, sources: { md: { description: entry.description, instructions: 'Fixture instructions', path: '/fixture/SKILL.md', supportingFiles: [] } } });
    if (pathname === '/api/config/plugins') return ok({ entries: [{ ...entry }], files: [] });
    if (pathname === '/api/plugin' || pathname === '/api/plugin/check') return ok({ data: [] });
    if (pathname === '/api/config/plugins/registry') return ok({ results: [] });
    if (pathname === '/api/experimental/mcp') return ok({});
    if (pathname === '/api/config/catalog/providers') return ok({ schemaVersion: 1, providers: [provider] });
    if (pathname === '/api/provider') return ok({ data: [provider] });
    if (pathname === '/api/integration') return ok({ data: [{ id: 'fixture', connections: [] }] });
    if (pathname === '/api/config/providers/sources') return ok({ fixture: { files: [{ scope: 'user', path: '/fixture/opencode.json' }] } });
    if (pathname === '/api/integration/fixture') return ok({ data: { methods: [{ id: 'key', type: 'key' }] } });
    if (pathname === '/api/integration/fixture/connect/key') return ok({ data: {} });
    if (pathname === '/api/config/providers/model') { provider.models.fixture.name = String(body.name); return ok({ ok: true }); }
    if (pathname === '/api/git/identities') return ok([{ id: 'fixture', name: 'Fixture identity', userName: 'Example', userEmail: 'example@example.invalid', authType: 'ssh', signCommits: false }]);
    if (pathname === '/api/git/global-identity') return ok({ userName: 'Global', userEmail: 'global@example.invalid' });
    if (pathname === '/api/location') return ok({ project: { id: 'fixture-project' } });
    if (pathname === '/api/permission/saved') return ok({ data: [] });
    if (pathname === '/api/session') return ok({ data: [], cursor: {} });
    if (input.method !== 'GET' && /^\/api\/config\/(?:agents|commands|mcp|plugins|skills)\//.test(pathname)) return ok({ ok: true });
    if (input.method !== 'GET' && pathname.startsWith('/api/git/identities/')) return ok({ ok: true });
    return null;
  };
}
