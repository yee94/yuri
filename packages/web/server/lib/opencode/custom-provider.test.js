import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Schema } from 'effect';
import { ConfigProvider } from '@opencode/schema/config/provider';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createCustomProvider } from './custom-provider.js';
import { readConfigFile } from './config-files.js';
import { configureOpenCodeCredentials } from './auth.js';
import { registerOpenCodeRoutes } from './routes.js';
import { registerCommonRequestMiddleware } from './core-routes.js';
import express from 'express';
import request from 'supertest';

let root;
let file;
let client;
const input = (pkg = '@opencode/ai/providers/openai-compatible') => ({
  providerId: 'custom-fixture', apiKey: 'fixture-key',
  config: { name: 'Gateway', package: pkg, settings: { baseURL: 'https://api.example.com/v1' },
    models: { 'upstream/coder': { name: 'Coder', capabilities: { tools: true, input: ['text', 'image'], output: ['text'] }, limit: { context: 32768, output: 8192 } } } },
});
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuri-custom-provider-'));
  vi.stubEnv('OPENCODE_CONFIG_DIR', root);
  vi.stubEnv('OPENCODE_CONFIG', '');
  file = path.join(root, 'opencode.jsonc');
  client = { credential: { create: vi.fn().mockResolvedValue({ id: 'fixture-credential' }), remove: vi.fn().mockResolvedValue(undefined) } };
  client.provider = { list: vi.fn().mockResolvedValue({ data: [] }) };
  client.integration = { list: vi.fn().mockResolvedValue({ data: [] }) };
});
afterEach(() => { configureOpenCodeCredentials(null); vi.restoreAllMocks(); vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });

describe('custom provider native V2 persistence', () => {
  it.each([
    ['  My Gateway  ', 'my-gateway'],
    ['My__Gateway / Test', 'my-gateway-test'],
    ['我的 网关', '我的-网关'],
    ['!!!', 'custom-provider'],
    ['constructor', 'constructor-2'],
  ])('derives a lowercase hyphenated ID from %s', async (name, expectedId) => {
    const draft = input(); delete draft.providerId; draft.config.name = name;
    expect(await createCustomProvider(draft, root, client)).toEqual({ providerId: expectedId });
    expect(readConfigFile(file).providers[expectedId]).toEqual(draft.config);
    expect(client.credential.create).toHaveBeenCalledWith(expect.objectContaining({ integrationID: expectedId }), expect.anything());
    expect(client.provider.list).toHaveBeenCalledWith({ location: { directory: root } }, expect.anything());
  });

  it('suffixes duplicate names without replacing saved, runtime or built-in integrations', async () => {
    fs.writeFileSync(file, '{"providers":{"gateway-3":{"name":"Keep"}}}');
    client.provider.list.mockResolvedValue({ data: [{ id: 'gateway' }] });
    client.integration.list.mockResolvedValue({ data: [{ id: 'gateway-2' }] });
    const draft = input(); delete draft.providerId;
    expect(await createCustomProvider(draft, undefined, client)).toEqual({ providerId: 'gateway-4' });
    expect(readConfigFile(file).providers['gateway-3']).toEqual({ name: 'Keep' });
    expect(readConfigFile(file).providers['gateway-4']).toEqual(draft.config);
  });

  it('reserves distinct name-based IDs for simultaneous creates', async () => {
    const draft = input(); delete draft.providerId;
    const results = await Promise.all([createCustomProvider(draft, undefined, client), createCustomProvider(draft, undefined, client)]);
    expect(results.map((entry) => entry.providerId)).toEqual(['gateway', 'gateway-2']);
    expect(Object.keys(readConfigFile(file).providers)).toEqual(['gateway', 'gateway-2']);
  });

  it('does not create credentials or config when the ID inventory cannot be read', async () => {
    const draft = input(); delete draft.providerId;
    client.provider.list.mockRejectedValue(new Error('offline'));
    await expect(createCustomProvider(draft, undefined, client)).rejects.toThrow();
    expect(client.credential.create).not.toHaveBeenCalled();
    expect(fs.existsSync(file)).toBe(false);
  });

  it('parses draft discovery JSON through the common middleware without persisting credentials or config', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'coder', name: 'Coder' }] })));
    const app = express(); registerCommonRequestMiddleware(app, { express });
    registerOpenCodeRoutes(app, {});
    const response = await request(app).post('/api/config/providers/custom/models').send({
      package: '@opencode/ai/providers/openai-compatible', baseURL: 'https://api.example.com/v1', apiKey: 'fixture-key',
    }).expect(200);
    expect(response.body).toEqual({ models: [{ id: 'coder', name: 'Coder' }] });
    expect(fetch.mock.calls[0][0].toString()).toBe('https://api.example.com/v1/models');
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer fixture-key');
    expect(JSON.stringify(response.body)).not.toContain('fixture-key');
    expect(client.credential.create).not.toHaveBeenCalled(); expect(fs.existsSync(file)).toBe(false);
  });

  it('exposes only the created provider ID through the authenticated host route and uses the captured directory', async () => {
    configureOpenCodeCredentials(() => client);
    const app = express(); registerCommonRequestMiddleware(app, { express });
    const validateDirectoryPath = vi.fn().mockResolvedValue({ ok: true, directory: root });
    registerOpenCodeRoutes(app, { validateDirectoryPath });
    const response = await request(app).post('/api/config/providers/custom').send({ ...input(), directory: root }).expect(200);
    expect(response.body).toEqual({ providerId: 'custom-fixture' });
    expect(validateDirectoryPath).toHaveBeenCalledWith(root);
    expect(JSON.stringify(response.body)).not.toContain('fixture-key');
  });

  it('does not write for an invalid requested directory', async () => {
    configureOpenCodeCredentials(() => client);
    const app = express(); registerCommonRequestMiddleware(app, { express });
    registerOpenCodeRoutes(app, { validateDirectoryPath: async () => ({ ok: false }) });
    await request(app).post('/api/config/providers/custom').send({ ...input(), directory: 'missing' }).expect(400);
    expect(client.credential.create).not.toHaveBeenCalled(); expect(fs.existsSync(file)).toBe(false);
  });

  it.each([
    '@opencode/ai/providers/openai-compatible', '@opencode/ai/providers/openai-compatible/responses',
    '@opencode/ai/providers/anthropic-compatible', '@opencode/ai/providers/google',
  ])('round-trips %s through the official schema, preserving comments and unrelated config', async (pkg) => {
    const original = '{ // keep this comment\n"model":"existing/coder","providers":{"existing":{"name":"Existing"}},}';
    fs.writeFileSync(file, original);
    expect(await createCustomProvider(input(pkg), undefined, client)).toEqual({ providerId: 'custom-fixture' });
    const saved = readConfigFile(file);
    expect(saved).toEqual({ $schema: 'https://opencode.ai/config.json', model: 'existing/coder',
      providers: { existing: { name: 'Existing' }, 'custom-fixture': input(pkg).config } });
    expect(() => Schema.decodeUnknownSync(ConfigProvider.Info)(saved.providers['custom-fixture'])).not.toThrow();
    expect(fs.readFileSync(file, 'utf8')).toContain('// keep this comment');
    expect(fs.readFileSync(file, 'utf8')).not.toContain('fixture-key');
    expect(fs.readFileSync(`${file}.yuri.backup`, 'utf8')).toBe(original);
    expect(client.credential.create).toHaveBeenCalledWith(expect.objectContaining({ integrationID: 'custom-fixture', value: { type: 'key', key: 'fixture-key' } }), expect.anything());
  });

  it('supports keyless services and writes only the target document, not merged project settings', async () => {
    fs.writeFileSync(path.join(root, 'opencode.json'), '{"model":"global/coder"}');
    const project = path.join(root, 'project'); fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, 'opencode.json'), '{"instructions":["project.md"]}');
    const request = input(); delete request.apiKey;
    await createCustomProvider(request, project, client);
    const saved = readConfigFile(path.join(root, 'opencode.json'));
    expect(saved.model).toBe('global/coder'); expect(saved.instructions).toBeUndefined();
    expect(saved.providers['custom-fixture']).toEqual(request.config);
    expect(client.credential.create).not.toHaveBeenCalled();
  });

  it('honors the explicit config path', async () => {
    const custom = path.join(root, 'explicit.jsonc'); vi.stubEnv('OPENCODE_CONFIG', custom);
    await createCustomProvider(input(), undefined, client);
    expect(readConfigFile(custom).providers['custom-fixture']).toEqual(input().config);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('rejects duplicate providers before touching credentials or files', async () => {
    fs.writeFileSync(file, '{"providers":{"custom-fixture":{"name":"Keep"}}}');
    await expect(createCustomProvider(input(), undefined, client)).rejects.toMatchObject({ code: 'PROVIDER_EXISTS' });
    expect(client.credential.create).not.toHaveBeenCalled();
    expect(readConfigFile(file)).toEqual({ providers: { 'custom-fixture': { name: 'Keep' } } });
  });

  it.each(['Gateway Two', 'Gateway One'])('keeps multiple providers independent even with the same endpoint and second name %s', async (secondName) => {
    const first = input(); first.providerId = 'custom-first'; first.config.name = 'Gateway One';
    const second = input(); second.providerId = 'custom-second'; second.config.name = secondName;
    client.credential.create.mockImplementation(async ({ integrationID }) => ({ id: `credential-${integrationID}` }));
    await Promise.all([
      createCustomProvider(first, undefined, client),
      createCustomProvider(second, undefined, client),
    ]);
    const saved = readConfigFile(file);
    expect(saved.providers).toEqual({ 'custom-first': first.config, 'custom-second': second.config });
    expect(client.credential.create.mock.calls.map(([credential]) => ({ integrationID: credential.integrationID, label: credential.label })))
      .toEqual([{ integrationID: 'custom-first', label: 'Gateway One' }, { integrationID: 'custom-second', label: secondName }]);
    expect(client.credential.remove).not.toHaveBeenCalled();
    expect(fs.readFileSync(file, 'utf8')).not.toContain('fixture-key');
  });

  it.each([
    (request) => { request.config.npm = '@ai-sdk/openai'; },
    (request) => { request.config.settings.apiKey = 'do-not-write'; },
    (request) => { request.config.settings.baseURL = 'https://user:password@example.com/v1'; },
    (request) => { request.config.settings.baseURL = 'file:///example'; },
    (request) => { request.config.models['upstream/coder'].limit.output = 999999; },
    (request) => { request.config.models['upstream/coder'].limit.context = -1; },
    (request) => { request.config.models = {}; },
    (request) => { request.config.models['upstream/coder'].options = {}; },
    (request) => { request.providerId = '__proto__'; },
    (request) => { request.config.package = 'file:///untrusted.js'; },
  ])('rejects malformed/legacy/untrusted input without side effects (%#)', async (change) => {
    const request = input(); change(request);
    await expect(createCustomProvider(request, undefined, client)).rejects.toMatchObject({ status: 400 });
    expect(client.credential.create).not.toHaveBeenCalled(); expect(fs.existsSync(file)).toBe(false);
  });

  it('does not replace malformed existing JSONC or persist a credential', async () => {
    fs.writeFileSync(file, '{ broken');
    await expect(createCustomProvider(input(), undefined, client)).rejects.toMatchObject({ code: 'PROVIDER_SAVE_FAILED' });
    expect(fs.readFileSync(file, 'utf8')).toBe('{ broken'); expect(client.credential.create).not.toHaveBeenCalled();
  });

  it('keeps the original file on failed atomic replacement and rolls back only the new credential', async () => {
    fs.writeFileSync(file, '{ // keep\n"model":"existing/coder"}');
    const original = fs.readFileSync(file, 'utf8');
    vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('fixture IO error'); });
    await expect(createCustomProvider(input(), undefined, client)).rejects.toMatchObject({ code: 'PROVIDER_SAVE_FAILED' });
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
    expect(client.credential.remove).toHaveBeenCalledWith({ credentialID: 'fixture-credential' }, expect.anything());
    expect(fs.readdirSync(root).some((name) => name.endsWith('.tmp'))).toBe(false);
  });

  it('sanitizes credential failures and never writes config after a failed credential save', async () => {
    client.credential.create.mockRejectedValue(new Error('fixture-key in upstream body'));
    const error = await createCustomProvider(input(), undefined, client).catch((error) => error);
    expect(error.message).toBe('PROVIDER_CREDENTIAL_FAILED'); expect(fs.existsSync(file)).toBe(false);
  });

  it('reports a failed rollback explicitly', async () => {
    vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('fixture IO error'); });
    client.credential.remove.mockRejectedValue(new Error('fixture cleanup error'));
    await expect(createCustomProvider(input(), undefined, client)).rejects.toMatchObject({ code: 'PROVIDER_CLEANUP_FAILED' });
    expect(fs.existsSync(file)).toBe(false);
  });
});
