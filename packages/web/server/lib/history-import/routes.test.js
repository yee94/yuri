import express from 'express';
import request from 'supertest';
import { expect, test, vi } from 'vitest';
import { registerHistoryImportRoutes } from './routes.js';

const setup = (context = { type: 'client', clientId: 'device' }) => {
  const app = express();
  const service = { scan: vi.fn(async () => ({ sessions: [] })), imported: vi.fn(async () => ({ states: {} })), preview: vi.fn(), start: vi.fn(), resume: vi.fn(async () => ({ id: 'job' })), dismiss: vi.fn(() => ({ id: 'job' })), jobs: vi.fn(() => []), status: vi.fn(), cancel: vi.fn() };
  const resolveAuthContext = vi.fn(async () => context);
  registerHistoryImportRoutes(app, { express, service, uiAuthController: { resolveAuthContext } });
  return { app, service, resolveAuthContext };
};
test('owned routes parse their own body, prohibit URL-token auth and scope requests to the authenticated device', async () => {
  const { app, service, resolveAuthContext } = setup();
  const response = await request(app).post('/api/yuri/history-import/scan').send({ sources: ['claude'] });
  expect(response.status).toBe(200); expect(response.headers['cache-control']).toBe('no-store');
  expect(service.scan).toHaveBeenCalledWith({ sources: ['claude'] }, 'client:device');
  expect(resolveAuthContext.mock.calls[0][2]).toEqual({ allowUrlToken: false });
  const badges = await request(app).post('/api/yuri/history-import/imported').send({ scanID: 'scan', directory: '/workspace' });
  expect(badges.status).toBe(200); expect(badges.headers['cache-control']).toBe('no-store');
  expect(service.imported).toHaveBeenCalledWith({ scanID: 'scan', directory: '/workspace' }, 'client:device');
  expect((await request(app).get('/api/yuri/history-import/jobs')).body).toEqual([]);
  expect(service.jobs).toHaveBeenCalledWith('client:device');
  expect((await request(app).post('/api/yuri/history-import/resume').send({ id: 'job', confirm: true })).body).toEqual({ id: 'job' });
  expect(service.resume).toHaveBeenCalledWith({ id: 'job', confirm: true }, 'client:device');
  expect((await request(app).post('/api/yuri/history-import/dismiss').send({ id: 'job' })).body).toEqual({ id: 'job' });
  expect(service.dismiss).toHaveBeenCalledWith({ id: 'job' }, 'client:device');
});
test('unauthenticated requests do not invoke the importer', async () => {
  const { app, service } = setup(null);
  expect((await request(app).post('/api/yuri/history-import/scan').send({})).status).toBe(401);
  expect(service.scan).not.toHaveBeenCalled();
  expect((await request(app).post('/api/yuri/history-import/resume').send({ id: 'job', confirm: true })).status).toBe(401);
  expect((await request(app).get('/api/yuri/history-import/jobs')).status).toBe(401);
  expect(service.resume).not.toHaveBeenCalled();
  expect((await request(app).post('/api/yuri/history-import/dismiss').send({ id: 'job' })).status).toBe(401);
  expect(service.dismiss).not.toHaveBeenCalled();
});
test('preview credentials cannot enumerate jobs or resume an import even with an owner cookie', async () => {
  const { app, service } = setup({ type: 'session' });
  expect((await request(app).get('/api/yuri/history-import/jobs?yuri_preview_token=preview')).status).toBe(403);
  expect((await request(app).post('/api/yuri/history-import/resume').set('Cookie', 'yuri_preview_token=preview').send({ id: 'job', confirm: true })).status).toBe(403);
  expect((await request(app).post('/api/yuri/history-import/resume').set('Origin', 'https://other.example').send({ id: 'job', confirm: true })).status).toBe(403);
  expect(service.jobs).not.toHaveBeenCalled(); expect(service.resume).not.toHaveBeenCalled();
  expect((await request(app).post('/api/yuri/history-import/dismiss').set('Origin', 'https://other.example').send({ id: 'job' })).status).toBe(403);
  expect(service.dismiss).not.toHaveBeenCalled();
});
test('errors expose only stable codes, never upstream bodies or file contents', async () => {
  const { app, service } = setup();
  service.scan.mockRejectedValue(new Error('private content must never be returned'));
  const response = await request(app).post('/api/yuri/history-import/scan').send({});
  expect(response.status).toBe(500); expect(response.body).toEqual({ code: 'import_failed' });
  service.scan.mockRejectedValue(Object.assign(new Error('private'), { code: 'source_changed' }));
  expect((await request(app).post('/api/yuri/history-import/scan').send({})).status).toBe(409);
});
