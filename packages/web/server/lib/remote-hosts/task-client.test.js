import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeRemoteTaskOpenCodeClient } from './task-client.js';
import { makeOpenCodeV2Client } from '../opencode/v2-client.js';
import { configureServerOpenCodeFetchGate } from '../opencode/server-opencode-fetch.js';
import { createRemoteTransport } from './transport.js';

afterEach(() => configureServerOpenCodeFetchGate(null, { allowMissingContract: true }));
const target = { hubId: 'hub', hostId: 'host', instanceId: 'instance' };

describe('official SDK through a remote task lease', () => {
  it('keeps local admission blocked while forwarding remote writes with native body, headers, query and abort', async () => {
    configureServerOpenCodeFetchGate(() => ({ executionAllowed: false }));
    const localFetch = vi.fn();
    const local = makeOpenCodeV2Client({ baseUrl: 'http://local.invalid', fetchImpl: localFetch });
    await expect(local.session.create({ location: { directory: '/same/path' } })).rejects.toBeDefined();
    expect(localFetch).not.toHaveBeenCalled();
    const request = vi.fn(async () => Response.json({ data: { id: 'input', type: 'user' } }));
    const remote = makeRemoteTaskOpenCodeClient({ target, request });
    const controller = new AbortController();
    await remote.session.prompt({ sessionID: 'ses_test', id: 'msg_test', text: 'exact text', delivery: 'steer' }, { signal: controller.signal, headers: { 'x-test': 'kept' } });
    expect(request).toHaveBeenCalledTimes(1);
    const [route, init] = request.mock.calls[0];
    expect(route).toBe('/api/session/ses_test/prompt');
    expect(init.method).toBe('POST');
    expect(request.mock.calls[0][2]).toEqual({ longRunning: true });
    expect(new Headers(init.headers).get('x-test')).toBe('kept');
    expect(JSON.parse(Buffer.from(init.body).toString())).toEqual({ id: 'msg_test', text: 'exact text', delivery: 'steer' });
    controller.abort();
    expect(init.signal.aborted).toBe(true);
  });

  it('propagates target proxy runtime rejection without retry or a local fallback', async () => {
    configureServerOpenCodeFetchGate(() => ({ executionAllowed: false }));
    const request = vi.fn(async () => Response.json({ error: 'runtime_contract_execution_blocked' }, { status: 503 }));
    const remote = makeRemoteTaskOpenCodeClient({ target, request });
    await expect(remote.session.create({ location: { directory: '/same/path' } })).rejects.toBeDefined();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('rejects missing authority/transport instead of constructing an unscoped network client', () => {
    expect(() => makeRemoteTaskOpenCodeClient({ target: { hubId: 'hub', hostId: 'host' }, request: vi.fn() })).toThrow();
    expect(() => makeRemoteTaskOpenCodeClient({ target })).toThrow();
    expect(() => makeOpenCodeV2Client({ baseUrl: 'http://remote.invalid', executionAdmission: 'target-yuri-proxy' })).toThrow();
  });

  it.each(['Headers', 'record', 'pairs'])('preserves %s request headers while the target credential overrides caller auth case-insensitively', async (kind) => {
    const fetchImpl = vi.fn(async () => Response.json({ remoteProjects: true, protocol: 1, instanceId: 'instance' }));
    const transport = await createRemoteTransport({ apiUrl: 'http://remote.invalid', clientToken: 'target-fixture' }, { fetchImpl });
    const pairs = [['Content-Type', 'application/json'], ['X-Opencode-Directory', '/remote/raw path'], ['authorization', 'Bearer caller-fixture']];
    const headers = kind === 'Headers' ? new Headers(pairs) : kind === 'record' ? Object.fromEntries(pairs) : pairs;
    try {
      await transport.fetch('/api/session', { method: 'POST', headers, body: '{"id":"ses_new"}' });
      const sent = new Headers(fetchImpl.mock.lastCall[1].headers);
      expect(sent.get('content-type')).toBe('application/json');
      expect(sent.get('x-opencode-directory')).toBe('/remote/raw path');
      expect(sent.get('authorization')).toBe('Bearer target-fixture');
      expect(sent.get('authorization')).not.toContain('caller-fixture');
    } finally { transport.close(); }
  });
});
