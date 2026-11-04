import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readConfigFile } from '../../web/server/lib/opencode/config-files.js';

vi.mock('vscode', () => ({ workspace: { workspaceFolders: [] } }));
let root: string;
let directory: string;
let api: typeof import('./opencodeConfig');
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuri-config-parity-'));
  directory = path.join(root, 'xdg', 'opencode');
  fs.mkdirSync(directory, { recursive: true });
  vi.stubEnv('XDG_CONFIG_HOME', path.dirname(directory));
  vi.stubEnv('OPENCODE_CONFIG', '');
  vi.stubEnv('OPENCODE_CONFIG_DIR', '');
  vi.spyOn(os, 'homedir').mockReturnValue(root);
  vi.resetModules();
  api = await import('./opencodeConfig');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('VS Code physical config parity', () => {
  it('updates saved models through the shared native writer', async () => {
    const { handleConfigBridgeMessage } = await import('./bridge-config-runtime');
    const response = await handleConfigBridgeMessage({ id: 'edit', type: 'api:config/providers/model:update', payload: {
      providerId: 'openai', modelId: 'coder', name: 'Coder', tools: true, vision: false,
      context: 32000, output: 4000, inputModalities: ['text'], directory,
    } }, undefined, {} as Parameters<typeof handleConfigBridgeMessage>[2]);
    expect(response).toMatchObject({ success: true, data: { providerId: 'openai', modelId: 'coder' } });
    expect(readConfigFile(path.join(directory, 'opencode.jsonc'))).toMatchObject({ providers: { openai: { models: { coder: { name: 'Coder' } } } } });
  });
  it('bridges safe provider provenance from the active service and preserves failures', async () => {
    const { handleConfigBridgeMessage } = await import('./bridge-config-runtime');
    const { configureOpenCodeCredentials } = await import('../../web/server/lib/opencode/auth.js');
    const client = {
      provider: { list: vi.fn(async () => ({ data: [{ id: 'injected' }] })) },
      integration: { list: vi.fn(async () => ({ data: [] })) },
      credential: { create: vi.fn(), list: vi.fn(async () => []), update: vi.fn(), activate: vi.fn(), remove: vi.fn() },
      config: { get: vi.fn(async () => []) },
    };
    configureOpenCodeCredentials(() => client);
    try {
      const message = { id: 'source', type: 'api:config/providers/sources:get', payload: { directory } };
      const deps = {} as Parameters<typeof handleConfigBridgeMessage>[2];
      const response = await handleConfigBridgeMessage(message, undefined, deps);
      expect(response).toMatchObject({ success: true, data: { injected: { origin: 'runtime', auth: { exists: false }, files: [] } } });
      expect(client.provider.list).toHaveBeenCalledWith({ location: { directory } }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
      client.config.get.mockRejectedValue(new Error('secret-sentinel'));
      expect(await handleConfigBridgeMessage(message, undefined, deps)).toEqual({ id: 'source', type: message.type, success: false, error: 'Unable to read provider sources' });
    } finally { configureOpenCodeCredentials(null); }
  });

  it('creates native V2 custom providers through the shared host writer without putting keys in config or replies', async () => {
    const { handleConfigBridgeMessage } = await import('./bridge-config-runtime');
    const { configureOpenCodeCredentials } = await import('../../web/server/lib/opencode/auth.js');
    const create = vi.fn().mockResolvedValue({ id: 'fixture-credential' });
    configureOpenCodeCredentials(() => ({ credential: { create, list: vi.fn(), update: vi.fn(), activate: vi.fn(), remove: vi.fn() }, config: { get: vi.fn() } }));
    try {
      const response = await handleConfigBridgeMessage({ id: 'custom', type: 'api:config/providers/custom:create', payload: {
        providerId: 'custom-fixture', apiKey: 'fixture-key',
        config: { name: 'Custom', package: '@opencode/ai/providers/openai-compatible/responses', settings: { baseURL: 'https://api.example.com/v1' }, models: { coder: {} } },
      } }, undefined, {} as Parameters<typeof handleConfigBridgeMessage>[2]);
      expect(response).toEqual({ id: 'custom', type: 'api:config/providers/custom:create', success: true, data: { providerId: 'custom-fixture' } });
      const saved = readConfigFile(path.join(directory, 'opencode.jsonc'));
      expect(saved.providers).toEqual({ 'custom-fixture': { name: 'Custom', package: '@opencode/ai/providers/openai-compatible/responses', settings: { baseURL: 'https://api.example.com/v1' }, models: { coder: {} } } });
      expect(JSON.stringify(saved)).not.toContain('fixture-key'); expect(JSON.stringify(response)).not.toContain('fixture-key');
      expect(create).toHaveBeenCalledTimes(1);
    } finally { configureOpenCodeCredentials(null); }
  });

  it('discovers models through the same host protocol adapter without persisting drafts', async () => {
    const { handleConfigBridgeMessage } = await import('./bridge-config-runtime');
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'coder' }] })));
    const response = await handleConfigBridgeMessage({ id: 'models', type: 'api:config/providers/custom:models',
      payload: { package: '@opencode/ai/providers/anthropic-compatible', baseURL: 'https://api.example.com/v1', apiKey: 'fixture-key' } },
    undefined, {} as Parameters<typeof handleConfigBridgeMessage>[2]);
    expect(response?.data).toEqual({ models: [{ id: 'coder', name: 'coder' }] });
    expect(fetch.mock.calls[0][1]?.headers).toMatchObject({ 'x-api-key': 'fixture-key' });
    expect(fs.existsSync(path.join(directory, 'opencode.jsonc'))).toBe(false);
  });

  it('MCP updates and deletes the real source, while additions never copy other layers', () => {
    const json = path.join(directory, 'opencode.json');
    const jsonc = path.join(directory, 'opencode.jsonc');
    fs.writeFileSync(json, '{"mcp":{"lower":{"type":"local","command":["lower"]}},"model":"base"}');
    fs.writeFileSync(jsonc, '{ // keep comment\n"mcp":{"higher":{"type":"local","command":["higher"]}},"model":"winning",}');
    expect(api.listMcpConfigs().map((entry) => entry.name).sort()).toEqual(['higher', 'lower']);
    api.updateMcpConfig('lower', { enabled: false });
    expect(readConfigFile(json)).toMatchObject({ mcp: { lower: { enabled: false } } });
    api.updateMcpConfig('higher', { enabled: false });
    expect(fs.readFileSync(jsonc, 'utf8')).toContain('// keep comment');
    api.createMcpConfig('new', { type: 'local', command: ['new'] });
    expect((readConfigFile(jsonc).mcp as Record<string, unknown>).lower).toBeUndefined();
    api.deleteMcpConfig('higher');
    expect((readConfigFile(jsonc).mcp as Record<string, unknown>).higher).toBeUndefined();
    expect((readConfigFile(json).mcp as Record<string, unknown>).lower).toBeDefined();
  });

  it('agent source and scoped deletion use the physical global layer', () => {
    const json = path.join(directory, 'opencode.json');
    const jsonc = path.join(directory, 'opencode.jsonc');
    fs.writeFileSync(json, '{"agent":{"lower":{"description":"lower"}}}');
    fs.writeFileSync(jsonc, '{ // retained\n"agent":{"higher":{"description":"higher"}}}');
    expect(api.getAgentSources('lower').json).toMatchObject({ exists: true, path: json });
    expect(api.getAgentSources('higher').json).toMatchObject({ exists: true, path: jsonc });
    api.deleteAgent('lower', undefined, 'user');
    expect(readConfigFile(json).agent).toBeUndefined();
    expect(readConfigFile(jsonc).agent).toBeDefined();
  });

  it('provider deletion and plugin edits preserve physical provenance', () => {
    const json = path.join(directory, 'opencode.json');
    const jsonc = path.join(directory, 'opencode.jsonc');
    fs.writeFileSync(json, '{"provider":{"lower":{}},"plugin":["lower-plugin"]}');
    fs.writeFileSync(jsonc, '{ // retained\n"providers":{"higher":{}},"plugin":["higher-plugin"]}');
    expect(api.getProviderSources('lower').user.path).toBe(json);
    api.removeProviderConfig('lower');
    expect(readConfigFile(json).provider).toBeUndefined();
    const plugin = api.listPluginEntries().find((entry) => entry.spec === 'lower-plugin')!;
    api.updatePluginEntry(plugin.id, { spec: 'updated-plugin' });
    expect(readConfigFile(json).plugins).toEqual(['updated-plugin']);
    expect(readConfigFile(json).plugin).toBeUndefined();
    expect(readConfigFile(jsonc).plugin).toEqual(['higher-plugin']);
  });

  it('raw bridge picks winning JSONC, honors an explicit config and preserves backups', async () => {
    const { handleConfigBridgeMessage } = await import('./bridge-config-runtime');
    const json = path.join(directory, 'opencode.json');
    const jsonc = path.join(directory, 'opencode.jsonc');
    fs.writeFileSync(json, '{"model":"base"}');
    fs.writeFileSync(jsonc, '{"model":"winning"}');
    const deps = {} as Parameters<typeof handleConfigBridgeMessage>[2];
    const read = () => handleConfigBridgeMessage({ id: 'read', type: 'api:config/global:get', payload: { target: 'opencode' } }, undefined, deps);
    expect((await read())?.data).toMatchObject({ fileName: 'opencode.jsonc', content: '{"model":"winning"}' });
    const custom = path.join(root, 'explicit.jsonc');
    fs.writeFileSync(custom, '{"model":"explicit"}');
    vi.stubEnv('OPENCODE_CONFIG', custom);
    expect((await read())?.data).toMatchObject({ fileName: 'explicit.jsonc' });
    await handleConfigBridgeMessage({ id: 'save', type: 'api:config/global:save', payload: { target: 'opencode', content: '{ // saved\n"model":"new"}' } }, undefined, deps);
    expect(readConfigFile(custom)).toEqual({ model: 'new' });
    expect(readConfigFile(jsonc)).toEqual({ model: 'winning' });
    expect(fs.readFileSync(`${custom}.yuri.backup`, 'utf8')).toBe('{"model":"explicit"}');
  });
});
