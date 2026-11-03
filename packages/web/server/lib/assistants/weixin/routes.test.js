import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { registerWeixinRoutes } from './routes.js';

describe('authenticated Bot WeChat routes', () => {
  it('keeps the existing authentication boundary, has explicit routes and no-store QR responses', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/yuri', (req, res, next) => req.headers.authorization === 'Bearer test-owner' ? next() : res.sendStatus(401));
    const runtime = {
      status: vi.fn(() => ({ status: 'disconnected', error: null })),
      startLogin: vi.fn(async () => ({ status: 'waiting', qrCode: 'https://example.com/scan', error: null })),
      verify: vi.fn(() => ({ status: 'verify', error: null })),
      retry: vi.fn(() => ({ status: 'connected', error: null })),
      disconnect: vi.fn(() => ({ status: 'disconnected', error: null })),
      transfer: vi.fn(async () => ({ status: 'connected', error: null })),
    };
    registerWeixinRoutes(app, runtime);
    const root = '/api/yuri/assistants/bot/weixin';
    await request(app).post(`${root}/login`).send({}).expect(401);
    expect(runtime.startLogin).not.toHaveBeenCalled();
    const response = await request(app).post(`${root}/login`).auth('test-owner', { type: 'bearer' }).send({ language: 'zh-CN' }).expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toMatchObject({ status: 'waiting' });
    expect(runtime.startLogin).toHaveBeenCalledWith('bot', 'zh-CN');
    await request(app).post(`${root}/verify`).auth('test-owner', { type: 'bearer' }).send({ code: '123456' }).expect(200);
    expect(runtime.verify).toHaveBeenCalledWith('bot', '123456');
    await request(app).delete(root).auth('test-owner', { type: 'bearer' }).expect(200);
    expect(runtime.disconnect).toHaveBeenCalledWith('bot');
    await request(app).post(`${root}/transfer`).send({ sourceAssistantID: 'old', revision: 'r1' }).expect(401);
    expect(runtime.transfer).not.toHaveBeenCalled();
    await request(app).post(`${root}/transfer`).auth('test-owner', { type: 'bearer' })
      .send({ sourceAssistantID: 'old', revision: 'r1', language: 'zh-CN' }).expect('Cache-Control', 'no-store').expect(200);
    expect(runtime.transfer).toHaveBeenCalledWith('bot', { sourceAssistantID: 'old', revision: 'r1', language: 'zh-CN' });
  });

  it('reports stale move confirmations as conflicts without leaking binding credentials', async () => {
    const app = express();
    registerWeixinRoutes(app, { transfer: () => { throw Object.assign(new Error('private-token'), { code: 'binding_changed' }); } });
    const result = await request(app).post('/api/yuri/assistants/bot/weixin/transfer').expect(409);
    expect(result.body).toEqual({ error: 'binding_changed' });
  });

  it('redacts untrusted errors and reports binding conflicts as conflicts', async () => {
    const app = express();
    registerWeixinRoutes(app, { status: () => { throw new Error('credential=private-token'); },
      startLogin: () => { throw Object.assign(new Error('private upstream response'), { code: 'account_in_use' }); } });
    const response = await request(app).get('/api/yuri/assistants/bot/weixin').expect(400);
    expect(response.body).toEqual({ error: 'channel_error' });
    const conflict = await request(app).post('/api/yuri/assistants/bot/weixin/login').expect(409);
    expect(conflict.body).toEqual({ error: 'account_in_use' });
  });
});
