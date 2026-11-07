import { expect, test } from 'vitest';
import { createHost } from './tests/settings-quota-credentials-host.js';
import { createQuotaCredentials, quotaCredentialResponse, type QuotaCredentialProvider } from './settings-quota-credentials-core';

test.each<QuotaCredentialProvider>(['opencode-go', 'ollama-cloud', 'cursor'])('strict isolated Host exercises %s rejection, correction, validation and deletion', async providerId => {
  const host = createHost();
  const owner = createQuotaCredentials({ providerId, current: () => true, send: async (path, method, body) => quotaCredentialResponse(host.call('runtime.request', { path, method, ...(body === undefined ? {} : { body }) })) });
  owner.setActive(true); await owner.read(); owner.open();
  for (const key of ['authCookie', 'cookie', 'accessToken'] as const) owner.change(key, 'fixture-only-input');
  host.call('quota.fixture.scenario', { mode: 'reject' }); await owner.act('save');
  expect(owner.state().open).toBe(true); expect(owner.state().error).toBe('operation');
  host.call('quota.fixture.scenario', { mode: 'ok' }); await owner.act('save');
  expect(owner.state()).toMatchObject({ open: false, values: {}, notice: 'save' });
  owner.open(); await owner.act('validate'); expect(owner.state().notice).toBe('validate');
  await owner.act('delete'); expect(host.call('quota.fixture.audit').deletes).toBe(0);
  owner.confirmDelete(true); await owner.act('delete');
  expect(owner.state().status).toEqual({ configured: false });
  expect(host.call('quota.fixture.audit')).toMatchObject({ reads: 1, saves: 2, validates: 1, deletes: 1 });
});

test('lost Cursor import/delete ACKs read status and never silently re-import or re-delete', async () => {
  const host = createHost(), owner = createQuotaCredentials({ providerId: 'cursor', current: () => true,
    send: async (path, method, body) => quotaCredentialResponse(host.call('runtime.request', { path, method, ...(body === undefined ? {} : { body }) })) });
  owner.setActive(true); await owner.read(); owner.open();
  host.call('quota.fixture.scenario', { mode: 'lost-ack' });
  await owner.act('import'); await owner.act('import');
  expect(host.call('quota.fixture.audit').imports).toBe(1);
  await owner.read(); expect(owner.state()).toMatchObject({ notice: null, recovery: 'review', status: { configured: true } });
  owner.confirmDelete(true); await owner.act('delete'); await owner.act('delete'); await owner.read();
  expect(host.call('quota.fixture.audit')).toMatchObject({ imports: 1, deletes: 1 });
  expect(owner.state()).toMatchObject({ notice: null, status: { configured: false } });
});

test('fixture rejects model-key substitutes, alternate Host paths, queries, extra fields and non-Cursor import', () => {
  const host = createHost();
  for (const input of [
    { path: '/api/config/providers/custom', method: 'POST' },
    { path: '/api/quota/credentials/cursor?directory=/fixture/project', method: 'GET' },
    { path: '/api/quota/credentials/cursor/validate', method: 'POST', body: { accessToken: 'fixture-only-input' } },
    { path: '/api/quota/credentials/ollama-cloud/import', method: 'POST' },
    { path: '/api/quota/credentials/cursor', method: 'PUT', body: { apiKey: 'fixture-only-input' } },
    { path: '/api/quota/credentials/cursor', method: 'PUT', body: { accessToken: 'arbitrary-value-rejected', refreshToken: '' } },
  ]) expect(() => host.call('runtime.request', input)).toThrow();
});
