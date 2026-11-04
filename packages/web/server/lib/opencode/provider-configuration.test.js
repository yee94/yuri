import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { removeProviderConfiguration } from './providers.js';
import { readConfigFile } from './config-files.js';
import { registerOpenCodeRoutes } from './routes.js';

let root;
let project;
let files;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuri-provider-delete-'));
  project = path.join(root, 'project'); fs.mkdirSync(project);
  const global = path.join(root, 'config'); fs.mkdirSync(global);
  files = [path.join(global, 'opencode.json'), path.join(global, 'opencode.jsonc'), path.join(root, 'explicit.jsonc'), path.join(project, 'opencode.jsonc')];
  vi.stubEnv('OPENCODE_CONFIG_DIR', global); vi.stubEnv('OPENCODE_CONFIG', files[2]);
  files.forEach((file, index) => fs.writeFileSync(file, `{ // keep unrelated comment\n"${index % 2 ? 'providers' : 'provider'}":{"target":{"name":"Target"},"keep":{}},"model":"keep/model"}`));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });

describe('provider configuration deletion', () => {
  it('removes every physical occurrence in both spellings, preserves unrelated values/comments, and supports retry', () => {
    expect(removeProviderConfiguration('target', project)).toBe(true);
    files.forEach((file, index) => {
      expect(readConfigFile(file)).toEqual({ [index % 2 ? 'providers' : 'provider']: { keep: {} }, model: 'keep/model' });
      expect(fs.readFileSync(file, 'utf8')).toContain('// keep unrelated comment');
      expect(fs.readFileSync(`${file}.yuri.backup`, 'utf8')).toContain('Target');
    });
    expect(removeProviderConfiguration('target', project)).toBe(false);
  });

  it('leaves a failed document intact and completes partial deletion on retry', () => {
    const rename = fs.renameSync.bind(fs);
    const failedPath = fs.realpathSync(files[1]);
    const failure = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (to === failedPath) throw new Error('write failed');
      return rename(from, to);
    });
    expect(() => removeProviderConfiguration('target', project)).toThrow('write failed');
    expect(readConfigFile(files[0]).provider.target).toBeUndefined();
    expect(readConfigFile(files[1]).providers.target).toBeDefined();
    failure.mockRestore();
    expect(removeProviderConfiguration('target', project)).toBe(true);
    expect(files.every((file) => !JSON.stringify(readConfigFile(file)).includes('Target'))).toBe(true);
  });

  it('fails before any write when one input file is malformed', () => {
    fs.writeFileSync(files[3], '{broken');
    expect(() => removeProviderConfiguration('target', project)).toThrow();
    expect(readConfigFile(files[0]).provider.target).toBeDefined();
  });

  it('exposes config-only deletion without service reload or credential side effects', async () => {
    const app = express(); const reload = vi.fn();
    registerOpenCodeRoutes(app, { resolveProjectDirectory: async () => ({ directory: project }), refreshOpenCodeAfterConfigChange: reload });
    const response = await request(app).delete('/api/provider/target/auth').query({ scope: 'config', directory: project }).expect(200);
    expect(response.body).toEqual({ success: true, removed: true, requiresReload: false });
    expect(reload).not.toHaveBeenCalled();
    expect(removeProviderConfiguration('target', project)).toBe(false);
  });
});
