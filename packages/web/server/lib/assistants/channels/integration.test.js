import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { registerAssistantRoutes } from '../routes.js';

describe('Host channel route integration', () => {
  it('registers all enterprise channels and drains connections before closing contact storage', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yuri-channel-http-'));
    const stops = [];
    const adapters = Object.fromEntries(['wecom', 'feishu', 'dingtalk'].map((provider) => [provider, {
      connect: vi.fn(async ({ signal, onReady }) => {
        onReady();
        await new Promise((resolve) => {
          if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true });
        });
        stops.push(provider);
      }), send: vi.fn(),
    }]));
    const app = express();
    app.use(express.json());
    const runtime = registerAssistantRoutes(app, {
      dbPath: path.join(directory, 'assistants.sqlite'), yuriDataDir: directory,
      buildOpenCodeUrl: () => 'http://upstream.invalid', getOpenCodeAuthHeaders: () => ({}),
      assistantChannelAdapters: adapters, channelsEnv: { YURI_CHANNELS_ENABLED: '1' },
    });
    try {
      const bot = runtime.service.createAssistant({ name: 'channel integration', providerID: 'p', modelID: 'm' });
      for (const provider of Object.keys(adapters)) {
        const root = `/api/yuri/assistants/${bot.id}/channels/${provider}`;
        const saved = await request(app).put(root).send({ clientID: `test-${provider}`, clientSecret: 'test-only-secret', ownerID: 'owner' }).expect(200);
        expect(saved.headers['cache-control']).toBe('no-store');
        expect(JSON.stringify(saved.body)).not.toContain('test-only-secret');
        await vi.waitFor(() => expect(adapters[provider].connect).toHaveBeenCalledOnce());
        const status = await request(app).get(root).expect(200);
        expect(status.body).toMatchObject({ provider, configured: true, hasSecret: true });
      }
      await runtime.close();
      expect(stops.sort()).toEqual(['dingtalk', 'feishu', 'wecom']);
    } finally { await runtime.close(); await fs.rm(directory, { recursive: true, force: true }); }
  });
});
