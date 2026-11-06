import express from 'express';
import request from 'supertest';
import { expect, test, vi } from 'vitest';
import { registerContentSearchRoutes } from './routes.js';
import { createContentSearchService } from './service.js';
import { createContentSearchRuntime } from './runtime.js';

test('exposes durable initialization times through the existing status route', async () => {
  const app = express();
  const service = createContentSearchService({ dbPath: ':memory:' });
  const runtime = createContentSearchRuntime({ service, getRuntimeKey: () => 'host', now: () => 100,
    listSessions: async () => ({ data: [], cursor: {} }), listMessages: async () => { throw new Error('unexpected'); },
  });
  registerContentSearchRoutes(app, { contentSearch: { service, runtime, getRuntimeKey: () => 'host' } });
  try {
    const pending = await request(app).get('/api/yuri/content-search');
    expect(pending.body.index).toMatchObject({ initializationRequired: true, indexStartedAt: null, indexCompletedAt: null });
    await runtime.sync();
    const ready = await request(app).get('/api/yuri/content-search');
    expect(ready.body.index).toMatchObject({ initializationRequired: false, indexStartedAt: 100, indexCompletedAt: 100, verifiedAt: 100 });
    expect(ready.body.hits).toEqual([]);
  } finally {
    await runtime.stop();
    service.close();
  }
});

test('global route returns coverage and preserves hit directories without a selected-project filter', async () => {
  const app = express();
  const hit = { sessionID: 's', messageID: 'm', title: 'Other project', directory: '/other', snippet: 'needle' };
  const search = vi.fn(() => [hit]);
  registerContentSearchRoutes(app, { contentSearch: {
    service: { search }, getRuntimeKey: () => 'host', runtime: { status: () => ({ phase: 'ready', messages: 1 }) },
  } });
  const response = await request(app).get('/api/yuri/content-search').query({ q: 'needle' });
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ hits: [hit], index: { phase: 'ready', messages: 1 } });
  expect(search).toHaveBeenCalledWith('host', 'needle', { limit: 30, directory: undefined });
  expect((await request(app).get('/api/yuri/content-search').query({ limit: -1 })).status).toBe(400);
  search.mockImplementation(() => { throw new Error('database unavailable'); });
  expect((await request(app).get('/api/yuri/content-search').query({ q: 'needle' })).status).toBe(500);
});

test('resume requires real auth and same-origin browser intent, rejects preview credentials, and starts background work', async () => {
  const app = express(); let context = null;
  const resolveAuthContext = vi.fn(async () => context);
  const sync = vi.fn(() => new Promise(() => {}));
  registerContentSearchRoutes(app, { uiAuthController: { resolveAuthContext }, contentSearch: {
    runtime: { sync, status: () => ({ phase: 'indexing', completed: 79, total: 357 }) },
  } });
  const route = '/api/yuri/content-search/resume';
  expect((await request(app).post(route)).status).toBe(401);
  context = { type: 'session' };
  expect((await request(app).post(route).set('Origin', 'https://other.example')).status).toBe(403);
  expect((await request(app).post(`${route}?yuri_preview_token=preview`)).status).toBe(403);
  expect(sync).not.toHaveBeenCalled();
  const accepted = await request(app).post(route);
  expect(accepted.status).toBe(202);
  expect(accepted.headers['cache-control']).toBe('no-store');
  expect(accepted.body.index).toMatchObject({ phase: 'indexing', completed: 79 });
  expect(sync).toHaveBeenCalledExactlyOnceWith({ resume: true });
  expect(resolveAuthContext.mock.calls[0][2]).toEqual({ allowClientAuth: true, allowUrlToken: false });
});
