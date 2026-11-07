import { expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { createHost } from './tests/settings-collections-host.js';
import { prepareCollectionsFixture } from './tests/settings-collections-fixture-config.mjs';

test('isolated fixture audit rejects every unintended import/cancel write or connection', () => {
  const host = createHost();
  expect(host.call('collections.fixture.audit', {})).toEqual({ permissionDeletes: 0, agentWrites: 0, mcpWrites: 0, reloads: 0, checks: 0, updates: 0 });
  expect(() => host.call('runtime.request', { path: '/api/experimental/mcp/imported/connect', method: 'POST' })).toThrow('Unexpected collections fixture request');
  expect(() => host.call('runtime.request', { path: '/api/location/reload', method: 'GET' })).toThrow('Unexpected collections fixture request');
  expect(host.call('runtime.request', { path: '/api/location/reload', method: 'POST' })).toEqual({ status: 204, body: null });
  expect(host.call('collections.fixture.audit', {}).reloads).toBe(1);
});

test('own Host parses/dispatches with no URL globals and keeps exact method/query/directory allowlists', () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(path.join(directory, 'tests/settings-collections-host.js'), 'utf8');
  const host = runInNewContext(source.replace('export function createHost()', 'function createHost()') + '\ncreateHost()', { URL: undefined, URLSearchParams: undefined });
  const send = (path: string, method = 'GET', body?: unknown) => host.call('runtime.request', { path, method, ...(body === undefined ? {} : { body }) });
  expect(send('/api/location?location%5Bdirectory%5D=%2Ffixture%2Fproject').body.project.id).toBe('fixture-project');
  expect(send('/api/permission/saved?projectID=fixture-project').body.data).toHaveLength(1);
  expect(send('/api/config/plugins/registry?specs=example-plugin%40latest&directory=%2Ffixture%2Fproject').body.results).toHaveLength(1);
  expect(send('/api/plugin/check?location%5Bdirectory%5D=%2Ffixture%2Fproject', 'POST', {}).status).toBe(200);
  for (const route of [
    '/api/location?location%5Bdirectory%5D=%2Fother',
    '/api/location?directory=%2Ffixture%2Fproject',
    '/api/location?location%5Bdirectory%5D=%2Ffixture%2Fproject&location%5Bdirectory%5D=%2Fother',
    '/api/permission/saved?projectID=other',
    '/api/permission/saved?projectID=fixture-project&unexpected=true',
    '/api/permission/saved?projectID=%ZZ',
    '/api/permission/saved?projectID=fixture-project#fragment',
  ]) expect(() => send(route)).toThrow();
  expect(() => send('/api/location/reload', 'GET')).toThrow();
  expect(() => send('/api/plugin/check?location%5Bdirectory%5D=%2Ffixture%2Fproject', 'GET')).toThrow();
  expect(send('/api/location/reload', 'POST').status).toBe(204);
});

test('runner grants audit only in its own temporary config, without changing production capabilities', () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const production = readFileSync(path.join(root, 'nsh.json'), 'utf8');
  const parent = path.join(process.env.TMPDIR || tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true });
  const temporary = mkdtempSync(path.join(parent, 'settings-collections-config-'));
  try {
    const fixture = prepareCollectionsFixture(root, temporary);
    const config = JSON.parse(readFileSync(path.join(temporary, 'nsh.json'), 'utf8'));
    expect(config.capabilities).toEqual({ clipboard: true, host: ['runtime.request', 'collections.fixture.audit'] });
    expect(config.theme).toBe(path.join(root, 'theme.json'));
    expect(readFileSync(path.join(temporary, fixture.entry), 'utf8')).toBe(`import ${JSON.stringify(path.join(root, 'settings-collections-fixture.tsx'))};\n`);
    expect(fixture.host).toBe(path.join(root, 'tests/settings-collections-host.js'));
    expect(readFileSync(path.join(root, 'nsh.json'), 'utf8')).toBe(production);
    expect(JSON.parse(production).capabilities.host).not.toContain('collections.fixture.audit');
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
