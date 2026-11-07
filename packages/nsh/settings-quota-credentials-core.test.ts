import { expect, test } from 'vitest';
import { createQuotaCredentials, projectQuotaCredentialStatus, quotaCredentialBody, quotaCredentialProviderFor, quotaCredentialResponse, type QuotaCredentialProvider } from './settings-quota-credentials-core';

test('closed status projection never returns credential fields; malformed success is not empty success', () => {
  expect(projectQuotaCredentialStatus({ configured: true, workspaceId: 'wrk_fixture', authCookie: 'not-a-real-credential', accessToken: 'not-a-real-credential' }))
    .toEqual({ configured: true, workspaceId: 'wrk_fixture' });
  for (const value of [null, [], {}, { configured: 'yes' }]) expect(() => projectQuotaCredentialStatus(value)).toThrow();
  expect(() => quotaCredentialResponse({ status: 400, body: { error: 'must-not-be-displayed' } })).toThrow('quota_request_failed');
});

test('provider-detail visibility matches Web aliases and does not use unrelated model integrations', () => {
  expect(['opencode', 'opencode-go', 'ollama', 'ollama-cloud', 'cursor', 'openai', 'custom'].map(quotaCredentialProviderFor))
    .toEqual(['opencode-go', 'opencode-go', 'ollama-cloud', 'ollama-cloud', 'cursor', null, null]);
});

test.each<QuotaCredentialProvider>(['opencode-go', 'ollama-cloud', 'cursor'])('save uses the separate %s usage endpoint and only its fields', async providerId => {
  const calls: unknown[][] = [];
  const owner = createQuotaCredentials({ providerId, current: () => true, send: async (...args) => {
    calls.push(args); return { configured: args[1] === 'PUT', ...(providerId === 'opencode-go' ? { workspaceId: 'wrk_fixture' } : {}) };
  } });
  owner.setActive(true); await owner.read(); owner.open();
  owner.change('workspaceId', 'wrk_fixture'); owner.change('authCookie', 'not-a-real-credential');
  owner.change('cookie', 'not-a-real-credential'); owner.change('accessToken', 'not-a-real-credential'); owner.change('refreshToken', '');
  await owner.act('save');
  const expected = providerId === 'opencode-go' ? { workspaceId: 'wrk_fixture', authCookie: 'not-a-real-credential' }
    : providerId === 'ollama-cloud' ? { cookie: 'not-a-real-credential' } : { accessToken: 'not-a-real-credential', refreshToken: '' };
  expect(calls).toEqual([[`/api/quota/credentials/${providerId}`, 'GET'], [`/api/quota/credentials/${providerId}`, 'PUT', expected]]);
  expect(owner.state()).toMatchObject({ values: {}, open: false, notice: 'save', status: { configured: true } });
});

test('Web form requirements reject incomplete or multiline fields without issuing a request', () => {
  for (const provider of ['opencode-go', 'ollama-cloud', 'cursor'] as const) expect(() => quotaCredentialBody(provider, {})).toThrow();
  expect(() => quotaCredentialBody('cursor', { accessToken: '', refreshToken: 'fixture-only-input' })).toThrow();
  expect(() => quotaCredentialBody('ollama-cloud', { cookie: 'line\nbreak' })).toThrow();
  expect(quotaCredentialBody('opencode-go', { workspaceId: ' wrk_fixture ', authCookie: ' auth=fixture-only-input ' }))
    .toEqual({ workspaceId: 'wrk_fixture', authCookie: 'auth=fixture-only-input' });
});

test('validation/import have no draft body, unsupported import and unconfirmed delete never write', async () => {
  const calls: unknown[][] = [];
  let response: unknown = { configured: true };
  const owner = createQuotaCredentials({ providerId: 'cursor', current: () => true, send: async (...args) => { calls.push(args); return response; } });
  owner.setActive(true); await owner.read(); owner.open(); owner.change('accessToken', 'fixture-only-input');
  await owner.act('delete'); expect(calls).toHaveLength(1);
  response = { valid: false }; await owner.act('validate');
  expect(owner.state()).toMatchObject({ error: 'operation', values: { accessToken: 'fixture-only-input' }, notice: null });
  response = { valid: true }; await owner.act('validate');
  expect(owner.state().notice).toBe('validate'); expect(owner.state().open).toBe(true);
  response = { configured: true }; await owner.act('import');
  expect(calls.slice(1)).toEqual([
    ['/api/quota/credentials/cursor/validate', 'POST'], ['/api/quota/credentials/cursor/validate', 'POST'], ['/api/quota/credentials/cursor/import', 'POST'],
  ]);
  expect(owner.state().values).toEqual({});
  owner.open(); owner.confirmDelete(true); response = { configured: false }; await owner.act('delete');
  expect(calls.at(-1)).toEqual(['/api/quota/credentials/cursor', 'DELETE']);
  expect(owner.state()).toMatchObject({ notice: 'delete', status: { configured: false }, confirmDelete: false });
});

test('unknown save keeps draft, blocks blind replay, preserves prior on failed read, and never infers replacement success', async () => {
  let reads = 0, writes = 0;
  const owner = createQuotaCredentials({ providerId: 'cursor', current: () => true, send: async (_path, method) => {
    if (method === 'GET') { reads++; if (reads === 2) throw new Error('fixture read failed'); return { configured: true }; }
    writes++; throw new Error('fixture lost ACK');
  } });
  owner.setActive(true); await owner.read(); owner.open(); owner.change('accessToken', 'fixture-only-input');
  await owner.act('save'); await owner.act('save');
  expect(writes).toBe(1); expect(owner.state()).toMatchObject({ recovery: 'read-required', error: 'operation', values: { accessToken: 'fixture-only-input' } });
  await owner.read(); expect(owner.state()).toMatchObject({ error: 'load', status: { configured: true }, recovery: 'read-required' });
  await owner.act('save'); expect(writes).toBe(1);
  await owner.read(); expect(owner.state()).toMatchObject({ recovery: 'review', values: { accessToken: 'fixture-only-input' }, notice: null });
  expect(writes).toBe(1);
  await owner.act('save'); expect(writes).toBe(2);
});

test('definitive save rejection preserves draft for correction; failed status never becomes optional', async () => {
  let reads = 0;
  const owner = createQuotaCredentials({ providerId: 'ollama-cloud', current: () => true, send: async (_path, method) => {
    if (method === 'GET') { if (++reads === 2) throw new Error('fixture read failed'); return { configured: true }; }
    throw Object.assign(new Error('raw response must not escape'), { status: 400 });
  } });
  owner.setActive(true); await owner.read(); owner.open(); owner.change('cookie', 'fixture-only-input'); await owner.act('save');
  expect(owner.state()).toMatchObject({ values: { cookie: 'fixture-only-input' }, error: 'operation', recovery: null });
  await owner.read(); expect(owner.state()).toMatchObject({ status: { configured: true }, error: 'load' });
  expect(JSON.stringify(owner.state())).not.toContain('raw response');
});

test.each(['hide', 'close', 'host', 'dispose'] as const)('%s clears authentication memory and fences late responses', async boundary => {
  let finish!: (value: unknown) => void, current = true, reads = 0;
  const owner = createQuotaCredentials({ providerId: 'cursor', current: () => current, send: async (_path, method) => {
    if (method === 'GET') { reads++; return { configured: true }; }
    return new Promise(resolve => { finish = resolve; });
  } });
  owner.setActive(true); await owner.read(); owner.open(); owner.change('accessToken', 'fixture-only-input');
  const saving = owner.act('save');
  if (boundary === 'hide') owner.setActive(false);
  else if (boundary === 'close') owner.close();
  else { if (boundary === 'host') current = false; owner.dispose(); }
  expect(owner.state().values).toEqual({}); expect(owner.state().open).toBe(false);
  finish({ configured: true, accessToken: 'must-not-leak' }); await saving;
  expect(owner.state().values).toEqual({}); expect(owner.state().notice).toBeNull();
  expect(reads).toBe(1);
});

test('one actual in-flight operation survives hide/resume without duplicate writes; resume is read-only', async () => {
  let finish!: (value: unknown) => void, reads = 0, writes = 0;
  const owner = createQuotaCredentials({ providerId: 'cursor', current: () => true, send: async (_path, method) => {
    if (method === 'GET') { reads++; return { configured: true }; }
    writes++; return new Promise(resolve => { finish = resolve; });
  } });
  owner.setActive(true); await owner.read(); owner.open(); owner.change('accessToken', 'fixture-only-input');
  const saving = owner.act('save'); await owner.act('import');
  owner.setActive(false); owner.setActive(true); await owner.read();
  finish({ configured: true }); await saving; await Promise.resolve();
  expect(writes).toBe(1); expect(reads).toBe(2); expect(owner.state()).toMatchObject({ values: {}, notice: null, recovery: 'review' });
});

test.each([{}, { configured: false }, null, { status: 502 }] as const)('malformed or negative save ACK requires read without claiming success: %j', async reply => {
  let writes = 0;
  const owner = createQuotaCredentials({ providerId: 'cursor', current: () => true, send: async (_path, method) => {
    if (method === 'GET') return { configured: true };
    writes++; return reply;
  } });
  owner.setActive(true); await owner.read(); owner.open(); owner.change('accessToken', 'fixture-only-input');
  await owner.act('save'); await owner.act('save');
  expect(writes).toBe(1); expect(owner.state()).toMatchObject({ open: true, notice: null, recovery: 'read-required', values: { accessToken: 'fixture-only-input' } });
});

test('initial failed read cannot open a form, and non-Cursor import cannot reach the Host', async () => {
  let calls = 0, failed = true;
  const owner = createQuotaCredentials({ providerId: 'ollama-cloud', current: () => true, send: async () => { calls++; if (failed) throw new Error('fixture read failed'); return { configured: true }; } });
  owner.setActive(true); await owner.read(); owner.open();
  expect(owner.state()).toMatchObject({ status: null, open: false, error: 'load' });
  failed = false; await owner.read(); owner.open(); await owner.act('import');
  expect(calls).toBe(2);
});

test('rejected deletion retains the form and confirmation, while cancel removes all form memory', async () => {
  let writes = 0;
  const owner = createQuotaCredentials({ providerId: 'cursor', current: () => true, send: async (_path, method) => {
    if (method === 'GET') return { configured: true };
    writes++; throw Object.assign(new Error('synthetic rejection'), { status: 400 });
  } });
  owner.setActive(true); await owner.read(); owner.open(); owner.change('accessToken', 'fixture-only-input'); owner.confirmDelete(true);
  await owner.act('delete');
  expect(writes).toBe(1); expect(owner.state()).toMatchObject({ open: true, confirmDelete: true, values: { accessToken: 'fixture-only-input' }, status: { configured: true }, error: 'operation' });
  owner.close(); expect(owner.state()).toMatchObject({ open: false, confirmDelete: false, values: {} });
  owner.setActive(true); await owner.read(); owner.open(); expect(owner.state().values).toEqual({});
});

test('Host retirement during status read prevents stale status/workspace from prefilling another Host', async () => {
  let finish!: (value: unknown) => void, current = true;
  const owner = createQuotaCredentials({ providerId: 'opencode-go', current: () => current, send: async () => new Promise(resolve => { finish = resolve; }) });
  owner.setActive(true); const reading = owner.read(); current = false; owner.dispose();
  finish({ configured: true, workspaceId: 'wrk_previous_host', authCookie: 'must-not-escape' }); await reading;
  expect(owner.state()).toMatchObject({ status: null, values: {}, open: false });
});
