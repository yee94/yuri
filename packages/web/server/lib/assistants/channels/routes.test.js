import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { registerAssistantChannelRoutes } from './routes.js';
import { createAssistantChannelsRuntime } from './runtime.js';

describe('authenticated enterprise channel routes', () => {
  it('reports a disabled channel and blocks every mutation, not only UI controls', async () => {
    const app = express();
    app.use(express.json());
    const runtime = createAssistantChannelsRuntime({ env: { NODE_ENV: 'development' } });
    registerAssistantChannelRoutes(app, runtime);
    const root = '/api/yuri/assistants/bot/channels/wecom';
    const response = await request(app).get(root).expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual({
      provider: 'wecom', status: 'disabled', error: null, configured: false,
      hasSecret: false, transport: 'websocket',
    });
    await request(app).put(root).send({}).expect(403, { error: 'channel_disabled' });
    await request(app).post(`${root}/retry`).send({}).expect(403, { error: 'channel_disabled' });
    await request(app).post(`${root}/transfer`).send({}).expect(403, { error: 'channel_disabled' });
    await request(app).post(`${root}/discover`).send({}).expect(403, { error: 'channel_disabled' });
    await request(app).delete(root).expect(403, { error: 'channel_disabled' });
    await runtime.close();
  });

  it('keeps the existing authentication boundary and forwards the save contract', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/yuri', (req, res, next) => (
      req.headers.authorization === 'Bearer test-owner' ? next() : res.sendStatus(401)
    ));
    const runtime = {
      status: vi.fn(() => ({
        provider: 'feishu', status: 'disconnected', error: null, configured: false,
        hasSecret: false, transport: 'websocket',
      })),
      save: vi.fn(async () => ({
        provider: 'feishu', status: 'connecting', error: null, configured: true,
        clientID: 'client', ownerID: 'owner', hasSecret: true, transport: 'websocket',
      })),
      retry: vi.fn(async () => ({ provider: 'feishu', status: 'reconnecting', error: null })),
      transfer: vi.fn(async () => ({ provider: 'feishu', status: 'connecting', error: null })),
      discover: vi.fn(async () => ({ ownerID: 'ou_user' })),
      disconnect: vi.fn(async () => ({ provider: 'feishu', status: 'disconnected', error: null })),
    };
    registerAssistantChannelRoutes(app, runtime);
    const root = '/api/yuri/assistants/bot/channels/feishu';
    await request(app).put(root).send({}).expect(401);
    expect(runtime.save).not.toHaveBeenCalled();
    const saved = await request(app).put(root).auth('test-owner', { type: 'bearer' })
      .send({ clientID: 'client', clientSecret: 'secret', ownerID: 'owner', language: 'zh-CN' })
      .expect('Cache-Control', 'no-store').expect(200);
    expect(saved.body).toMatchObject({ provider: 'feishu', configured: true, hasSecret: true });
    expect(runtime.save).toHaveBeenCalledWith('bot', 'feishu', {
      clientID: 'client', clientSecret: 'secret', ownerID: 'owner', language: 'zh-CN',
    });
    await request(app).post(`${root}/retry`).auth('test-owner', { type: 'bearer' }).expect(200);
    expect(runtime.retry).toHaveBeenCalledWith('bot', 'feishu');
    await request(app).post(`${root}/transfer`).send({ sourceAssistantID: 'old', revision: 'r1' }).expect(401);
    expect(runtime.transfer).not.toHaveBeenCalled();
    await request(app).post(`${root}/transfer`).auth('test-owner', { type: 'bearer' })
      .send({ sourceAssistantID: 'old', revision: 'r1' }).expect(200);
    expect(runtime.transfer).toHaveBeenCalledWith('bot', 'feishu', { sourceAssistantID: 'old', revision: 'r1' });
    await request(app).post(`${root}/discover`).send({ clientID: 'client' }).expect(401);
    expect(runtime.discover).not.toHaveBeenCalled();
    await request(app).post(`${root}/discover`).auth('test-owner', { type: 'bearer' })
      .send({ clientID: 'client', clientSecret: 'secret' }).expect('Cache-Control', 'no-store').expect(200, { ownerID: 'ou_user' });
    expect(runtime.discover).toHaveBeenCalledWith('bot', 'feishu', { clientID: 'client', clientSecret: 'secret' }, { signal: expect.any(AbortSignal) });
    await request(app).delete(root).auth('test-owner', { type: 'bearer' }).expect(200);
    expect(runtime.disconnect).toHaveBeenCalledWith('bot', 'feishu');
  });

  it('redacts untrusted errors and maps safe codes to explicit statuses', async () => {
    const app = express();
    app.use(express.json());
    const runtime = {
      status: vi.fn(() => { throw new Error('client-secret=private-value'); }),
      save: vi.fn(async () => { throw Object.assign(new Error('private upstream body'), { code: 'account_in_use' }); }),
      retry: vi.fn(async () => { throw Object.assign(new Error('private'), { code: 'not_found' }); }),
      disconnect: vi.fn(async () => { throw Object.assign(new Error('private'), { code: 'network_error' }); }),
    };
    registerAssistantChannelRoutes(app, runtime);
    const root = '/api/yuri/assistants/bot/channels/dingtalk';
    const redacted = await request(app).get(root).expect(400);
    expect(redacted.body).toEqual({ error: 'channel_error' });
    expect(JSON.stringify(redacted.body)).not.toContain('private-value');
    await request(app).put(root).send({}).expect(409, { error: 'account_in_use' });
    await request(app).post(`${root}/retry`).expect(404, { error: 'not_found' });
    await request(app).delete(root).expect(502, { error: 'network_error' });
    const validation = {
      status: vi.fn(() => { throw Object.assign(new Error('private'), { code: 'channel_disabled' }); }),
    };
    const second = express();
    registerAssistantChannelRoutes(second, validation);
    await request(second).get(root).expect(403, { error: 'channel_disabled' });
  });

  it('maps sticky SDK conflicts to explicit conflicts without leaking messages', async () => {
    const app = express();
    app.use(express.json());
    const runtime = {
      save: async () => { throw Object.assign(new Error('private sdk detail'), { code: 'connection_replaced' }); },
      retry: async () => { throw Object.assign(new Error('private epoch'), { code: 'binding_changed' }); },
    };
    registerAssistantChannelRoutes(app, runtime);
    const root = '/api/yuri/assistants/bot/channels/wecom';
    await request(app).put(root).send({}).expect(409, { error: 'connection_replaced' });
    await request(app).post(`${root}/retry`).expect(409, { error: 'binding_changed' });
  });

  it('aborts discovery when the HTTP caller closes the request', async () => {
    const app = express();
    app.use(express.json());
    let signal;
    registerAssistantChannelRoutes(app, {
      discover: async (_assistantID, _provider, _body, options) => {
        signal = options.signal;
        return new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'cancelled' })), { once: true }));
      },
    });
    const server = app.listen(0, '127.0.0.1');
    try {
      await new Promise((resolve) => server.once('listening', resolve));
      const controller = new AbortController();
      const pending = fetch(`http://127.0.0.1:${server.address().port}/api/yuri/assistants/bot/channels/wecom/discover`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: controller.signal,
      }).catch(() => {});
      await vi.waitFor(() => expect(signal).toBeDefined());
      controller.abort();
      await pending;
      await vi.waitFor(() => expect(signal.aborted).toBe(true));
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
