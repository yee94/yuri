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
