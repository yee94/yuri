import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRemoteHostGateway } from './gateway.js';
import { createRemoteHostStore } from './store.js';

let gateway; let root;
afterEach(async () => { gateway?.stop(); gateway = null; vi.useRealTimers(); if (root) await fs.rm(root, { recursive: true, force: true }); root = null; });
const setup = async fetch => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode/json-lifecycle-'));
  const host = { id: 'host', source: 'direct', clientToken: 'fixture-a', apiUrl: 'http://fixture.invalid' };
  gateway = createRemoteHostGateway({ store: createRemoteHostStore(path.join(root, 'remote.sqlite')),
    indexDbPath: path.join(root, 'index.sqlite'), adapter: { listHosts: async () => [{ ...host }] },
    transportFactory: async () => ({ capabilities: { remoteProjects: true, protocol: 1, instanceId: 'fixture' }, fetch, close() {} }) });
  const resource = {}; gateway.observe(resource, 'owner', { status: false }); gateway.retainHost('host', resource);
  await Promise.resolve(); await Promise.resolve(); vi.useFakeTimers();
  return host;
};

it('fifty fully consumed JSON responses retain zero deadline timers with the shared connection alive', async () => {
  await setup(async () => Response.json({ value: 42 }));
  for (let index = 0; index < 50; index++) expect(await gateway.json('host', '/api/value')).toEqual({ value: 42 });
  expect(vi.getTimerCount()).toBe(0);
});

it.each([['malformed', () => new Response('{'), 'SyntaxError'],
  ['non-2xx', () => new Response('{}', { status: 503 }), 'Error']])('%s consumption preserves failure and releases its deadline', async (_name, response, name) => {
  await setup(async () => response());
  await expect(gateway.json('host', '/api/value')).rejects.toMatchObject({ name });
  expect(vi.getTimerCount()).toBe(0);
});

it('headers alone do not release the JSON body deadline', async () => {
  let body; let started;
  const bodyStarted = new Promise(resolve => { started = resolve; });
  await setup(async (_route, init) => ({ ok: true, json: () => {
    started(); return new Promise((resolve, reject) => { body = resolve;
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }); });
  } }));
  const reading = gateway.json('host', '/api/value');
  const assertion = expect(reading).rejects.toMatchObject({ name: 'TimeoutError' });
  await bodyStarted; expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(15000); await assertion;
  expect(vi.getTimerCount()).toBe(0); body({ value: 'too late' });
});

it('credential ABA after body headers still rejects a late parsed value and clears the local owner', async () => {
  let finish; let started;
  const bodyStarted = new Promise(resolve => { started = resolve; });
  const host = await setup(async () => ({ ok: true, json: () => { started(); return new Promise(resolve => { finish = resolve; }); } }));
  const reading = gateway.json('host', '/api/value'); const assertion = expect(reading).rejects.toMatchObject({ code: 'stale_host' });
  await bodyStarted; host.clientToken = 'fixture-b'; await gateway.list(); host.clientToken = 'fixture-a'; await gateway.list();
  finish({ value: 'stale' }); await assertion; expect(vi.getTimerCount()).toBe(0);
});

it.each(['abort', 'retarget'])('remote registration never persists a late project after %s', async (mode) => {
  let finish; let started;
  const bodyStarted = new Promise(resolve => { started = resolve; });
  const host = await setup(async () => ({ ok: true, json: () => { started(); return new Promise(resolve => { finish = resolve; }); } }));
  const controller = new AbortController();
  const pending = gateway.registerProject('host', { path: '/repo' }, { instanceId: 'fixture', signal: controller.signal });
  const assertion = expect(pending).rejects.toThrow();
  await bodyStarted;
  if (mode === 'abort') controller.abort();
  else { host.clientToken = 'replacement'; await gateway.list(); }
  finish({ project: { id: 'remote', path: '/repo' } });
  await assertion;
  expect(gateway.store.projects()).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});

it.each([{}, { project: { id: 'remote', path: '/repo', hostId: 'nested-host' } }, { project: { id: 'remote', path: {} } }])('rejects malformed remote registration responses without saving a reference: %j', async (response) => {
  await setup(async () => Response.json(response));
  await expect(gateway.registerProject('host', { path: '/repo' }, { instanceId: 'fixture' })).rejects.toMatchObject({ code: 'remote_invalid_project' });
  expect(gateway.store.projects()).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});

it('uses only the remote canonical path when deduplicating registrations from different aliases', async () => {
  const fetch = vi.fn(async () => Response.json({ project: { id: 'remote', path: '/remote-canonical', label: 'Preserved' } }));
  await setup(fetch);
  const first = await gateway.registerProject('host', { path: '/remote-alias' }, { instanceId: 'fixture' });
  const second = await gateway.registerProject('host', { path: '/another-remote-alias' }, { instanceId: 'fixture' });
  expect(first).toMatchObject({ created: true, project: { path: '/remote-canonical' } });
  expect(second).toEqual({ project: first.project, created: false });
  expect(gateway.store.projects()).toEqual([first.project]);
  expect(fetch.mock.calls.map(([, init]) => JSON.parse(init.body).path)).toEqual(['/remote-alias', '/another-remote-alias']);
  expect(vi.getTimerCount()).toBe(0);
});
