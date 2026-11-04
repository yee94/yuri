import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { updateProviderModel } from './provider-model-config.js';
import { readConfigFile } from './config-files.js';
import { registerOpenCodeRoutes } from './routes.js';
import { registerCommonRequestMiddleware } from './core-routes.js';

let root;
let file;
const input = () => ({ providerId: 'openai', modelId: 'coder', name: 'My coder', context: 32000, output: 4000,
  tools: true, vision: true, inputModalities: ['text', 'audio', 'pdf'] });
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuri-model-edit-'));
  vi.stubEnv('OPENCODE_CONFIG_DIR', root); vi.stubEnv('OPENCODE_CONFIG', '');
  file = path.join(root, 'opencode.jsonc');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });
it('writes only model fields in their physical provider source and preserves routing, modalities, comments and other models', () => {
  fs.writeFileSync(file, '{ // keep\n"providers":{"openai":{"settings":{"baseURL":"https://example.com/v1"},"models":{"other":{},"coder":{"settings":{"reasoningEffort":"high"},"capabilities":{"input":["text","video"]},"limit":{"input":16000}}}}}}');
  const project = path.join(root, 'project'); fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'opencode.json'), '{"instructions":["keep.md"]}');
  expect(updateProviderModel(input(), project)).toEqual({ providerId: 'openai', modelId: 'coder' });
  const config = readConfigFile(file);
  expect(config.instructions).toBeUndefined();
  expect(config.providers.openai.settings).toEqual({ baseURL: 'https://example.com/v1' });
  expect(config.providers.openai.models.other).toEqual({});
  expect(config.providers.openai.models.coder).toMatchObject({ name: 'My coder', settings: { reasoningEffort: 'high' },
    capabilities: { tools: true, input: ['text', 'video', 'image'] }, limit: { context: 32000, output: 4000, input: 16000 } });
  expect(fs.readFileSync(file, 'utf8')).toContain('// keep');
  updateProviderModel({ ...input(), context: null, output: null, vision: false }, project);
  expect(readConfigFile(file).providers.openai.models.coder.limit).toEqual({ input: 16000 });
  expect(readConfigFile(file).providers.openai.models.coder.capabilities.input).toEqual(['text', 'video']);
});
it('creates an override for runtime models and preserves their supplied non-image modalities', () => {
  updateProviderModel(input());
  expect(readConfigFile(file).providers.openai.models.coder.capabilities.input).toEqual(['text', 'audio', 'pdf', 'image']);
});
it('uses the highest project provider source rather than changing global config', () => {
  fs.writeFileSync(file, '{"providers":{"openai":{"name":"Global"}}}');
  const project = path.join(root, 'project'); fs.mkdirSync(project);
  const projectFile = path.join(project, 'opencode.json');
  fs.writeFileSync(projectFile, '{"providers":{"openai":{"name":"Project"}}}');
  updateProviderModel(input(), project);
  expect(readConfigFile(file).providers.openai).toEqual({ name: 'Global' });
  expect(readConfigFile(projectFile).providers.openai.models.coder.name).toBe('My coder');
});
it.each([{ modelId: '__proto__' }, { providerId: 'constructor' }, { context: -1 }, { output: 100000 }, { inputModalities: ['unknown'] }])('rejects invalid updates %j', (patch) => {
  expect(() => updateProviderModel({ ...input(), ...patch })).toThrow();
  expect(fs.existsSync(file)).toBe(false);
});
it('keeps the original on failed replacement', () => {
  const original = '{"providers":{"openai":{"name":"Original"}}}'; fs.writeFileSync(file, original);
  vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('IO'); });
  expect(() => updateProviderModel(input())).toThrow();
  expect(fs.readFileSync(file, 'utf8')).toBe(original);
});
it('parses PUT JSON and validates directory on the real route, returning only IDs', async () => {
  const app = express(); registerCommonRequestMiddleware(app, { express });
  const validateDirectoryPath = vi.fn(async () => ({ ok: true, directory: root }));
  registerOpenCodeRoutes(app, { validateDirectoryPath });
  const result = await request(app).put('/api/config/providers/model').send({ ...input(), directory: root }).expect(200);
  expect(result.body).toEqual({ providerId: 'openai', modelId: 'coder' });
  expect(validateDirectoryPath).toHaveBeenCalledWith(root);
  expect(readConfigFile(file).providers.openai.models.coder.name).toBe('My coder');
});
