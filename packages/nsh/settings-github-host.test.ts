import { expect, it } from 'vitest';
import { createHost } from './tests/settings-github-host.js';
import { createSettingsGitHub } from './settings-github-core';
import { createSettingsGitCredentials } from './settings-git-credentials-core';
import { gitSettingsResponse, type GitSettingsRequest } from './settings-github-protocol';

it('strict synthetic Host rejects real URL/network/system/credential capabilities and unexpected wire fields', () => {
  const host = createHost();
  expect(host.call('connection.list', {})).toMatchObject({ selected: 'synthetic-github-host', runtimeScope: { hostID: 'synthetic-github-host', lease: 'synthetic-settings-lease-1' } });
  for (const name of ['connection.connect', 'native.keychain.read', 'system.open', 'fetch', 'process.exec']) expect(() => host.call(name, {})).toThrow();
  expect(() => host.call('github.fixture.open', { url: 'https://github.com/login/device?token=synthetic' })).toThrow();
  expect(() => host.call('runtime.request', { path: '/api/github/auth/start', method: 'POST', body: { accessToken: 'synthetic' } })).toThrow();
  expect(() => host.call('runtime.request', { path: '/api/github/auth', method: 'DELETE', body: { accountId: 'synthetic-oauth' } })).toThrow();
  expect(() => host.call('runtime.request', { path: 'https://real.example', method: 'GET' })).toThrow();
  expect(() => host.call('runtime.request', { path: '/api/git/identities', method: 'GET', headers: { Authorization: 'synthetic' } })).toThrow();
});

it('runs the production pure controllers through the strict synthetic Host, preserving metadata-only writes', async () => {
  const host = createHost();
  const expectedHost = host.call('connection.list', {}).runtimeScope;
  const request: GitSettingsRequest = async (path, method = 'GET', body) => gitSettingsResponse(host.call('runtime.request', { path, method, expectedHost, ...(body === undefined ? {} : { body }) }));
  const github = createSettingsGitHub({ request, current: () => true, open: async url => host.call('github.fixture.open', { url }) === true });
  await github.setActive(true); const account = github.state().status!.accounts.find(account => account.source === 'oauth')!;
  github.requestRemoval(account); await github.confirmRemoval();
  const credentials = createSettingsGitCredentials({ request, current: () => true, id: () => 'synthetic-import' });
  await credentials.setActive(true); credentials.begin(credentials.candidates()[0]); credentials.edit('userEmail', 'synthetic@example.invalid'); await credentials.save();
  expect(credentials.state().saved).toBe(true); expect(credentials.candidates()).toEqual([]);
  expect(host.call('github.fixture.audit')).toMatchObject({ imports: 1, removals: 1, profileCount: 1, starts: 0, completes: 0, opened: 0 });
  github.dispose(); credentials.dispose();
});
