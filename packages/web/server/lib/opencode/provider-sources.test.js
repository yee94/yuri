import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { readProviderSources } from './provider-sources.js';
import { configureOpenCodeCredentials } from './auth.js';
import { registerOpenCodeRoutes } from './routes.js';

afterEach(() => { configureOpenCodeCredentials(null); vi.unstubAllEnvs(); });

const fixture = () => ({
  provider: { list: vi.fn(async () => ({ data: [
    { id: 'configured', integrationID: 'account', settings: { apiKey: 'secret-sentinel' } },
    { id: 'injected' }, { id: 'builtin' },
  ] })) },
  config: { get: vi.fn(async () => [
    { type: 'document', path: '/config/opencode.jsonc', info: { providers: { configured: { headers: { authorization: 'secret-sentinel' } } } } },
    { type: 'document', path: '/workspace/.opencode/opencode.json', info: { providers: { configured: {} } } },
    { type: 'document', info: { providers: { builtin: {} } } },
  ]) },
  integration: { list: vi.fn(async () => ({ data: [{ id: 'account', connections: [{ id: 'c1', type: 'credential', method: 'key' }] }] })) },
});

describe('provider source projection', () => {
  it('batches runtime metadata, separates physical, in-memory and injected sources, and never serializes credentials', async () => {
    vi.stubEnv('OPENCODE_CONFIG_DIR', '/config'); vi.stubEnv('OPENCODE_CONFIG', '');
    const client = fixture(); configureOpenCodeCredentials(() => client);
    const result = await readProviderSources('/workspace');
    expect(result.configured).toMatchObject({ origin: 'config', auth: { exists: true, type: 'api' }, user: { exists: true }, project: { exists: true } });
    expect(result.configured.files).toEqual([{ path: '/config/opencode.jsonc', scope: 'user' }, { path: '/workspace/.opencode/opencode.json', scope: 'project' }]);
    expect(result.injected).toMatchObject({ origin: 'runtime', auth: { exists: false }, files: [] });
    expect(result.builtin.origin).toBe('builtin');
    expect(JSON.stringify(result)).not.toContain('secret-sentinel');
    for (const read of [client.provider.list, client.config.get, client.integration.list]) {
      expect(read).toHaveBeenCalledExactlyOnceWith({ location: { directory: '/workspace' } }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    }
  });

  it('labels an explicit config separately and does not mistake a global ancestor for project config', async () => {
    vi.stubEnv('OPENCODE_CONFIG_DIR', '/config'); vi.stubEnv('OPENCODE_CONFIG', '/workspace/.opencode/opencode.json');
    const client = fixture(); configureOpenCodeCredentials(() => client);
    const result = await readProviderSources('/config/project');
    expect(result.configured.files.map((file) => file.scope)).toEqual(['user', 'custom']);
  });

  it.each(['provider', 'config', 'integration'])('preserves %s read failure instead of returning empty success', async (resource) => {
    const client = fixture();
    client[resource][resource === 'config' ? 'get' : 'list'].mockRejectedValue(new Error('secret-sentinel'));
    configureOpenCodeCredentials(() => client);
    const app = express(); registerOpenCodeRoutes(app, { resolveProjectDirectory: async () => ({ directory: '/workspace' }) });
    const response = await request(app).get('/api/config/providers/sources?directory=/workspace').expect(502);
    expect(response.body).toEqual({ error: 'Unable to read provider sources' });
  });

  it('rejects malformed authoritative lists', async () => {
    const client = fixture(); client.config.get.mockResolvedValue({ data: [] });
    await expect(readProviderSources('/workspace', client)).rejects.toThrow('Unable to read provider sources');
  });
  it('accepts external credential metadata without requesting raw credentials', async () => {
    const client = fixture();
    client.integration.list.mockResolvedValue({ data: [{ id: 'account', connections: [{ type: 'credential', method: 'external' }] }] });
    expect((await readProviderSources('/workspace', client)).configured.auth).toEqual({ exists: true, type: 'external' });
  });
  it('exposes the safe batch through the host route with the requested directory', async () => {
    const client = fixture(); configureOpenCodeCredentials(() => client);
    const resolveProjectDirectory = vi.fn(async () => ({ directory: '/workspace' }));
    const app = express(); registerOpenCodeRoutes(app, { resolveProjectDirectory });
    const response = await request(app).get('/api/config/providers/sources?directory=/workspace').expect(200);
    expect(response.body.injected.origin).toBe('runtime');
    expect(JSON.stringify(response.body)).not.toContain('secret-sentinel');
    expect(resolveProjectDirectory).toHaveBeenCalledTimes(1);
    expect(client.provider.list.mock.calls[0][0]).toEqual({ location: { directory: '/workspace' } });
  });
});
