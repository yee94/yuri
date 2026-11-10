import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import express from 'express';
import { createServer } from 'vite';
import { expect, test } from 'vitest';
import createConfig from '../../../vite.config.ts';
import { createHistoryImportService } from './service.js';
import { createImportStore } from './store.js';
import { registerHistoryImportRoutes } from './routes.js';
import { digest } from './events.js';

test('real development proxy preserves browser origin for resume and durable task dismissal', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yuri-import-proxy-'));
  const store = createImportStore(path.join(directory, 'receipts.sqlite'));
  store.create('interrupted', 'owner', digest('fixture'), 357);
  store.append('interrupted', 0, { key: 'saved', status: 'imported', sessionID: 'existing' });
  store.finish('interrupted', 'interrupted');
  const service = createHistoryImportService({ store, getRuntimeIdentity: () => 'fixture', createClient: () => { throw new Error('must not touch imported content'); } });
  const backend = express();
  registerHistoryImportRoutes(backend, { express, service, uiAuthController: { resolveAuthContext: async () => ({ type: 'session' }) } });
  const api = http.createServer(backend); const ui = http.createServer();
  let vite;
  try {
    api.listen(0, '127.0.0.1'); await once(api, 'listening');
    const config = createConfig({ command: 'serve', mode: 'development' });
    vite = await createServer({ configFile: false, root: directory, cacheDir: path.join(directory, '.vite'), appType: 'custom', logLevel: 'silent',
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { middlewareMode: { server: ui }, hmr: false,
        proxy: { '/api': { ...config.server.proxy['/api'], target: `http://127.0.0.1:${api.address().port}` } },
      },
    });
    ui.on('request', vite.middlewares); ui.listen(0, '127.0.0.1'); await once(ui, 'listening');
    const origin = `http://127.0.0.1:${ui.address().port}`;
    const call = (route, body, requestOrigin = origin) => fetch(`${origin}/api/yuri/history-import/${route}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: requestOrigin, 'Sec-Fetch-Site': 'same-origin' }, body: JSON.stringify(body),
    });
    const resume = await call('resume', { id: 'interrupted', confirm: true });
    expect({ status: resume.status, body: await resume.json() }).toEqual({ status: 400, body: { code: 'resume_request_missing' } });
    const forbidden = await call('dismiss', { id: 'interrupted' }, 'https://attacker.example');
    expect(forbidden.status).toBe(403);
    const dismiss = await call('dismiss', { id: 'interrupted' });
    expect({ status: dismiss.status, body: await dismiss.json() }).toEqual({ status: 200, body: { id: 'interrupted' } });
    expect(await (await fetch(`${origin}/api/yuri/history-import/jobs`)).json()).toEqual([]);
    expect(service.status('interrupted', 'owner')).toMatchObject({ dismissed: true, completed: 1, results: [{ sessionID: 'existing' }] });
  } finally {
    await vite?.close();
    for (const server of [ui, api]) {
      server.closeAllConnections();
      if (server.listening) await new Promise(resolve => server.close(resolve));
    }
    await service.close(); await fs.rm(directory, { recursive: true, force: true });
  }
});
