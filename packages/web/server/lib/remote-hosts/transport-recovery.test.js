import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRemoteHostGateway } from './gateway.js';
import { createRemoteHostStore } from './store.js';

let gateway; let root;
afterEach(async () => {
  gateway?.stop(); gateway = null;
  if (root) await fs.rm(root, { recursive: true, force: true });
  root = null;
});

const setup = async ({ prepareHost, transports }) => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode/transport-recovery-'));
  const host = { id: 'host', source: 'ssh', clientToken: 'token', apiUrl: 'http://fixture.invalid' };
  const store = createRemoteHostStore(path.join(root, 'remote.sqlite'));
  let built = 0;
  gateway = createRemoteHostGateway({
    store, indexDbPath: path.join(root, 'index.sqlite'),
    adapter: { listHosts: async () => [{ ...host }], prepareHost },
    transportFactory: async () => {
      const make = transports[Math.min(built, transports.length - 1)];
      built += 1;
      return { capabilities: { remoteProjects: true, protocol: 1, instanceId: 'fixture' }, close: vi.fn(), fetch: make };
    },
  });
  store.saveProject('host', { id: 'project', path: '/repo' });
  gateway.observe({}, 'owner');
  return { built: () => built };
};

const deadTransport = async () => { throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }); };
const liveTransport = async () => new Response(new ReadableStream({ start() {} }), { status: 200 });

it('rebuilds the cached transport after the status stream hits a network failure', async () => {
  const prepareHost = vi.fn(async () => ({ id: 'host', source: 'ssh', clientToken: 'token', apiUrl: 'http://fixture.invalid' }));
  const { built } = await setup({ prepareHost, transports: [deadTransport, liveTransport] });
  await vi.waitFor(() => expect(built()).toBe(2), { timeout: 8000 });
  expect(prepareHost).toHaveBeenCalledTimes(2);
});

it('keeps the cached transport while the status stream is healthy', async () => {
  const prepareHost = vi.fn(async () => ({ id: 'host', source: 'ssh', clientToken: 'token', apiUrl: 'http://fixture.invalid' }));
  const { built } = await setup({ prepareHost, transports: [liveTransport] });
  await vi.waitFor(() => expect(built()).toBe(1), { timeout: 4000 });
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(built()).toBe(1);
  expect(prepareHost).toHaveBeenCalledTimes(1);
});
