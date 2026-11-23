import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { registerYuriRoutes } from './yuri-routes.js';
import { configureOpenCodeCredentials } from './auth.js';
import { registerConfigSyncRoutes } from '../config-sync/routes.js';
import { checkForUpdates } from '../package-manager.js';

vi.mock('../session-index/routes.js', () => ({ registerSessionIndexRoutes: vi.fn() }));
vi.mock('../transcript-cache/routes.js', () => ({ registerTranscriptCacheRoutes: vi.fn() }));
vi.mock('../config-sync/routes.js', () => ({ registerConfigSyncRoutes: vi.fn() }));
vi.mock('../package-manager.js', () => ({
  checkForUpdates: vi.fn(),
  getUpdateCommand: vi.fn(),
  detectPackageManagerDetails: vi.fn(),
}));

describe('config-sync credential client injection', () => {
  it('reads provider credentials through the backend-configured OpenCode client', async () => {
    const list = vi.fn().mockResolvedValue([{
      id: 'cred_1', integrationID: 'openai', label: 'Work', active: true, value: { type: 'key', key: 'secret' },
    }]);
    configureOpenCodeCredentials(() => ({ credential: { list } }));
    registerYuriRoutes(express(), { express, process: { versions: {}, env: {} } });

    const { receiver } = vi.mocked(registerConfigSyncRoutes).mock.calls[0][1];
    await expect(receiver.credentialInventory()).resolves.toEqual({ bytes: expect.any(Number) });
    expect(list).toHaveBeenCalledTimes(1);
  });
});

describe('remote update installation runtime boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(checkForUpdates).mockResolvedValue({ available: false });
  });

  const createApp = (versions) => {
    const app = express();
    registerYuriRoutes(app, { express, process: { versions, env: {} } });
    return app;
  };

  it('rejects the web installer in an Electron-hosted server before any update work', async () => {
    const response = await request(createApp({ electron: '40.0.0' }))
      .post('/api/yuri/update-install');
    expect(response.status).toBe(409);
    expect(response.body.error).toBe('update_plan_required');
    expect(checkForUpdates).not.toHaveBeenCalled();
  });

  it('requires an exact plan instead of running an unversioned latest update', async () => {
    const response = await request(createApp({ node: '24.0.0' }))
      .post('/api/yuri/update-install');
    expect(response.status).toBe(409);
    expect(response.body.error).toBe('update_plan_required');
    expect(checkForUpdates).not.toHaveBeenCalled();
  });
});
