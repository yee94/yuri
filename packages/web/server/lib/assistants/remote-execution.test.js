import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { createAssistantsService } from './service.js';
import { createAssistantExecutionAccessor, parseExecutionTarget } from './execution-target.js';
import { createOpenCodeContactTools } from './opencode-tools.js';
import { configureServerOpenCodeFetchGate } from '../opencode/server-opencode-fetch.js';
import { createSessionCardPart, contactCardIdentity } from './cards.js';
import { runContactTurn as nativeRunContactTurn } from './harness.js';

vi.mock('../opencode/native-goal.js', () => ({ getNativeSessionGoal: async () => null }));
const require = createRequire(import.meta.url);
const target = (hostId = 'remote-a') => ({ hubId: 'hub', hostId, instanceId: `instance-${hostId}` });
const remoteDirectory = '/remote-only/same/project';
const fixture = ({ nativeCompletion, sessionIDs = ['ses_same'] } = {}) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-remote-'));
  const requests = [];
  const leases = new Set();
  const busy = new Map([['remote-a', true], ['remote-b', true]]);
  const deliveries = new Map();
  let unavailable = false;
  let retargeted = false;
  const gateway = {
    store: { hubId: 'hub' },
    list: async () => ({ hubId: 'hub', hosts: [{ id: 'remote-a', name: 'Machine A' }, { id: 'remote-b', name: 'Machine B' }], projects: [] }),
    acquireTask: vi.fn(async (hostId, options = {}) => {
      if (unavailable || retargeted || (options.instanceId && options.instanceId !== target(hostId).instanceId)) throw new Error('remote unavailable');
      const lease = { target: target(hostId), options, released: false,
        release() { lease.released = true; leases.delete(lease); },
        async json(route, init = {}) {
          if (unavailable) throw new Error('offline');
          requests.push({ hostId, route, method: init.method || 'GET', body: init.body });
          if (route === '/api/projects') return { projects: [{ id: 'project', path: remoteDirectory, label: `Project ${hostId}` }] };
          if (route.startsWith('/api/git/worktrees')) return [];
          if (route === '/api/yuri/session-index') return { directories: [{ directory: remoteDirectory, sessions: [{ id: 'ses_same', title: hostId, time: { updated: 10 } }] }] };
          if (route.endsWith('/archive')) return { session: { id: 'ses_same' } };
          throw new Error(`Unexpected Yuri route: ${route}`);
        },
        async request(route, init) {
          if (unavailable) throw new Error('offline');
          const bodyText = init.body ? Buffer.from(init.body).toString() : '';
          const body = bodyText ? JSON.parse(bodyText) : undefined;
          requests.push({ hostId, route, method: init.method, body, signal: init.signal, headers: new Headers(init.headers) });
          const url = new URL(route, 'http://remote.invalid');
          if (url.pathname === '/api/provider') return Response.json({ data: [{ id: hostId, name: hostId }] });
          if (url.pathname === '/api/model') return Response.json({ data: [{ id: 'remote-model', providerID: hostId, capabilities: { input: { image: true } } }] });
          if (url.pathname.endsWith('/model') && init.method === 'POST') return new Response(null, { status: 204 });
          if (url.pathname === '/api/session/active') return Response.json({ data: busy.get(hostId) ? Object.fromEntries(sessionIDs.map((id) => [id, { type: 'running' }])) : {} });
          if (url.pathname === '/api/session' && init.method === 'GET') return Response.json({ data: [{ id: 'ses_same', title: hostId, location: { directory: remoteDirectory }, time: { updated: 10 } }], cursor: {} });
          if (url.pathname === '/api/session' && init.method === 'POST') return Response.json({ data: { id: 'ses_same', location: { directory: remoteDirectory } } });
          if (url.pathname.endsWith('/prompt')) {
            deliveries.set(hostId, body.id);
            return Response.json({ data: { id: body.id || 'input', type: 'user' } });
          }
          if (url.pathname.endsWith('/interrupt')) { busy.set(hostId, false); return Response.json({}); }
          if (url.pathname.endsWith('/message')) return Response.json({ data: [
            ...(deliveries.get(hostId) ? [{ id: deliveries.get(hostId), type: 'user', time: { created: 1 }, content: [{ type: 'text', text: 'Task' }] }] : []),
            { id: 'msg_worker', type: 'assistant', sessionID: 'ses_same', finish: 'stop', time: { created: 2, ...(busy.get(hostId) ? {} : { completed: 3 }) }, content: [
              { type: 'text', text: `Authored worker finding ${hostId}` },
              { type: 'tool', name: 'read', id: 'tool', state: { status: 'completed', output: `RAW_REMOTE_TOOL_SENTINEL_${hostId}` } },
            ] },
          ], cursor: {} });
          if (url.pathname === '/api/session/ses_same' && init.method === 'DELETE') return new Response(null, { status: 204 });
          if (sessionIDs.some((id) => url.pathname === `/api/session/${id}`)) return Response.json({ data: { id: url.pathname.split('/').at(-1), title: hostId, location: { directory: remoteDirectory }, status: { type: busy.get(hostId) ? 'busy' : 'idle' } } });
          if (url.pathname === '/api/skill') return Response.json({ location: { directory: remoteDirectory }, data: [{ id: 'remote-skill', name: hostId, content: `Instructions ${hostId}` }] });
          throw new Error(`Unexpected SDK route: ${init.method} ${route}`);
        },
      };
      leases.add(lease);
      options.signal?.addEventListener('abort', () => lease.release(), { once: true });
      return lease;
    }),
  };
  let action = async () => {};
  const reviews = [];
  let failReview = false;
  const localClient = vi.fn(() => { throw new Error('LOCAL_CLIENT_MUST_NOT_BE_USED'); });
  let service;
  const open = () => {
    service = createAssistantsService({
      dbPath: path.join(directory, 'assistants.sqlite'), dataDir: directory,
      getAllowedRoots: () => [], listProjects: async () => [], remoteHostGateway: gateway,
      clientFactory: localClient, reconcileIntervalMs: 100000,
      createChatCompletion: nativeCompletion || null,
      runContactTurn: nativeCompletion ? nativeRunContactTurn : async ({ tools, readOnly, userText }) => {
        if (readOnly) {
          reviews.push(userText);
          if (failReview) throw new Error('Synthetic provider failure');
          return { bubbles: ['任务结果已核对。'] };
        }
        await action((name, params) => tools.find((tool) => tool.name === name).execute(`call_${name}`, params));
        return { bubbles: ['已处理请求。'] };
      },
    });
    return service;
  };
  open();
  const assistant = service.createAssistant({ name: 'Hub Assistant', providerID: 'hub-only-provider', modelID: 'hub-only-model' });
  let turn = 0;
  return {
    directory, gateway, requests, leases, busy, localClient, reviews, assistant,
    get service() { return service; },
    async send(next, assistantID = assistant.id) {
      action = next;
      const sent = await service.send(assistantID, { messageID: `user_${++turn}`, text: '执行已授权项目请求' });
      const settled = await service.whenContactTurnSettled(sent.messageID);
      expect(settled, JSON.stringify(settled)).toMatchObject({ status: 'complete' });
      return settled;
    },
    async emit(hostId, type = 'session.execution.succeeded', data = {}) {
      for (const lease of [...leases]) if (lease.target.hostId === hostId && lease.options.onEvent) lease.options.onEvent({ payload: { type, data: { sessionID: 'ses_same', ...data } } });
      await service.reconcile();
    },
    offline(value) { unavailable = value; }, retarget(value) { retargeted = value; }, failReview(value) { failReview = value; },
    reopen() { service.close(); return open(); },
    db() { return new (require('better-sqlite3'))(path.join(directory, 'assistants.sqlite')); },
    close() { service.close(); fs.rmSync(directory, { recursive: true, force: true }); },
  };
};

describe('Hub assistant remote execution', () => {
  it.each([{ sessionIDs: ['ses_same'] }, { sessionIDs: Array.from({ length: 20 }, (_, i) => `ses_worker_${i}`) }])('shares one authority snapshot for 20 contacts during reconciliation (%j)', async ({ sessionIDs }) => {
    const f = fixture({ sessionIDs });
    try {
      for (let i = 0; i < 20; i++) {
        const assistant = f.service.createAssistant({ name: `Watcher ${i}`, providerID: 'hub-only-provider', modelID: 'hub-only-model' });
        await f.send((call) => call('watch_session', { sessionID: sessionIDs[i % sessionIDs.length], target: target() }), assistant.id);
      }
      await f.service.reconcile();
      f.requests.length = 0;
      await f.service.reconcile();
      expect(f.requests.filter((request) => request.route === '/api/session/active')).toHaveLength(1);
      expect(f.requests.filter((request) => sessionIDs.some((id) => request.route === `/api/session/${id}`))).toHaveLength(sessionIDs.length);
      expect(f.requests.some((request) => request.route.endsWith('/message'))).toBe(false);
      expect([...f.leases].filter((lease) => lease.options.onEvent)).toHaveLength(sessionIDs.length);
    } finally { f.close(); }
  });
  it('runs native Agent discovery/read/continue/reference end to end with the exact target and no raw result storage', async () => {
    let round = 0;
    const nativeCall = (name, args) => ({ completion: { choices: [{ message: { content: '', tool_calls: [
      { id: `call_${round}`, type: 'function', function: { name, arguments: JSON.stringify(args) } },
    ] } }] } });
    const f = fixture({ nativeCompletion: async ({ body }) => {
      round++;
      if (round === 1) return nativeCall('list_projects', {});
      if (round === 2) {
        expect(JSON.stringify(body.messages)).toContain('instance-remote-a');
        return nativeCall('read_session', { sessionID: 'ses_same', target: target() });
      }
      if (round === 3) {
        expect(JSON.stringify(body.messages)).toContain('RAW_REMOTE_TOOL_SENTINEL_remote-a');
        return nativeCall('assign_session', { sessionID: 'ses_same', target: target(), prompt: 'Continue remote work' });
      }
      if (round === 4) {
        expect(body.tools.map((tool) => tool.function.name)).toEqual(['reference_resource']);
        expect(JSON.stringify(body.messages)).toContain('instance-remote-a');
        return nativeCall('reference_resource', { cardType: 'session', sessionID: 'ses_same', target: target() });
      }
      return { text: '已在目标机器继续处理。' };
    } });
    try {
      await f.send();
      expect(round).toBe(5);
      const messages = f.service.contactMessages(f.assistant.id).messages;
      expect(messages.flatMap((row) => row.cards)).toEqual([expect.objectContaining({ target: target(), sessionID: 'ses_same' })]);
      expect(JSON.stringify(messages)).not.toContain('RAW_REMOTE_TOOL_SENTINEL');
      expect(f.localClient).not.toHaveBeenCalled();
    } finally { f.close(); }
  });

  it('discovers, lists and reads two machines with identical IDs without local access or raw tool persistence', async () => {
    const f = fixture();
    try {
      await f.send(async (call) => {
        const found = await call('list_projects', {});
        expect(found.details.projects.map((item) => item.target)).toEqual([target(), target('remote-b')]);
        for (const identity of [target(), target('remote-b')]) {
          const listed = await call('list_sessions', { target: identity, projectID: 'project' });
          expect(listed.details.sessions).toEqual([expect.objectContaining({ sessionID: 'ses_same', target: identity, title: identity.hostId })]);
          const read = await call('read_session', { sessionID: 'ses_same', target: identity });
          expect(read.details, JSON.stringify({ read, requests: f.requests })).toMatchObject({ target: identity, directory: remoteDirectory });
          expect(read.content[0].text).toContain(`RAW_REMOTE_TOOL_SENTINEL_${identity.hostId}`);
          const card = await call('reference_resource', { cardType: 'session', sessionID: 'ses_same', target: identity });
          expect(card.details.card.target).toEqual(identity);
        }
      });
      const cards = f.service.contactMessages(f.assistant.id).messages.flatMap((row) => row.cards);
      expect(cards).toHaveLength(2);
      expect(contactCardIdentity(cards[0])).not.toBe(contactCardIdentity(cards[1]));
      expect(f.leases.size).toBe(0);
      expect(f.localClient).not.toHaveBeenCalled();
      const db = f.db();
      try { expect(JSON.stringify(db.prepare('SELECT * FROM assistant_contact_part').all())).not.toContain('RAW_REMOTE_TOOL_SENTINEL'); }
      finally { db.close(); }
      f.reopen();
      expect(f.service.contactMessages(f.assistant.id).messages.flatMap((row) => row.cards)).toEqual(cards);
    } finally { f.close(); }
  });

  it('creates and continues with target-owned defaults, persists scoped watches, recovers without UI and reports once', async () => {
    const f = fixture();
    try {
      for (const identity of [target(), target('remote-b')]) await f.send(async (call) => {
        const result = await call('assign_session', { target: identity, projectPath: remoteDirectory, prompt: 'Perform task' });
        expect(result.details.assigned, JSON.stringify({ result, requests: f.requests })).toMatchObject({ sessionID: 'ses_same', target: identity });
      });
      expect(f.requests.filter((row) => row.route.endsWith('/prompt'))).toHaveLength(2);
      expect(f.requests.some((row) => row.route.includes('/model') || row.route.includes('/agent'))).toBe(false);
      expect(JSON.stringify(f.requests)).not.toContain('hub-only');
      expect([...f.leases].filter((lease) => lease.options.onEvent)).toHaveLength(2);
      expect(f.service.snapshot().assistants[0].assignedSessions).toEqual(expect.arrayContaining([
        expect.objectContaining({ target: target() }), expect.objectContaining({ target: target('remote-b') }),
      ]));
      // Existing contact semantics: a new user turn supersedes older result
      // notifications. Explicitly rewatch A to request its eventual result again.
      await f.send(async (call) => {
        expect((await call('watch_session', { target: target(), sessionID: 'ses_same' })).details.watched.target).toEqual(target());
      });
      f.reopen();
      await f.service.reconcile();
      expect([...f.leases].filter((lease) => lease.options.onEvent)).toHaveLength(2);
      f.busy.set('remote-a', false);
      await f.emit('remote-a');
      await vi.waitFor(() => expect(f.reviews).toHaveLength(1));
      await vi.waitFor(() => expect([...f.leases].filter((lease) => lease.options.onEvent)).toHaveLength(1));
      expect(f.reviews[0]).toContain(JSON.stringify(target()));
      expect(f.reviews[0]).not.toContain('RAW_REMOTE_TOOL_SENTINEL');
      await f.service.reconcile();
      expect(f.reviews).toHaveLength(1);
      await f.send(async (call) => {
        const stopped = await call('stop_session', { target: target('remote-b'), sessionID: 'ses_same' });
        expect(stopped.details.stopped).toMatchObject({ target: target('remote-b'), aborted: true });
      });
      expect([...f.leases].filter((lease) => lease.options.onEvent)).toHaveLength(0);
      f.busy.set('remote-a', true);
      await f.send(async (call) => {
        const result = await call('assign_session', { target: target(), sessionID: 'ses_same', prompt: 'Continue task' });
        expect(result.details.assigned).toMatchObject({ target: target(), reused: true });
      });
      f.service.close();
      expect(f.leases.size).toBe(0);
      expect(f.localClient).not.toHaveBeenCalled();
    } finally { f.close(); }
  });

  it('routes watch/steer/archive/delete to the captured machine and rejects malformed or retargeted references', async () => {
    const f = fixture();
    try {
      await f.send(async (call) => {
        const result = await call('watch_session', { target: target(), sessionID: 'ses_same' });
        expect(result.details.watched, JSON.stringify(result)).toMatchObject({ target: target() });
      });
      for (const name of ['steer_session', 'archive_session', 'delete_session']) await f.send(async (call) => {
        const output = await call(name, { target: target(), sessionID: 'ses_same', ...(name === 'steer_session' ? { text: 'Change direction' } : {}) });
        expect(output.details.result, JSON.stringify(output)).toMatchObject({ target: target(), operation: name.replace('_session', '') });
      });
      const count = f.requests.length;
      for (const invalid of [null, {}, { hubId: 'hub', hostId: 'remote-a' }, { ...target(), extra: 'invalid' }]) await f.send(async (call) => {
        const output = await call('read_session', { target: invalid, sessionID: 'ses_same' });
        expect(output.details.error).toBe('validation_error');
      });
      f.retarget(true);
      await f.send(async (call) => {
        const output = await call('delete_session', { target: target(), sessionID: 'ses_same' });
        expect(output.details.error).toBeDefined();
      });
      expect(f.requests).toHaveLength(count);
      expect(f.localClient).not.toHaveBeenCalled();
    } finally { f.close(); }
  });

  it('validates explicit worker models against only the target catalog and never changes the Hub contact', async () => {
    const f = fixture();
    try {
      await f.send(async (call) => {
        const listed = await call('list_models', { target: target('remote-b') });
        expect(listed.content[0].text).toContain('remote-b');
        expect(listed.content[0].text).not.toContain('hub-only-provider');
        const assigned = await call('assign_session', { target: target('remote-b'), projectPath: remoteDirectory, providerID: 'remote-b', modelID: 'remote-model', prompt: 'Work with the remote model' });
        expect(assigned.details.assigned, JSON.stringify(assigned)).toMatchObject({ target: target('remote-b') });
      });
      expect(f.requests.find((request) => request.method === 'POST' && request.route.endsWith('/model'))).toMatchObject({ hostId: 'remote-b', body: { model: { id: 'remote-model', providerID: 'remote-b' } } });
      expect(f.service.snapshot().assistants[0]).toMatchObject({ providerID: 'hub-only-provider', modelID: 'hub-only-model' });
      await f.send(async (call) => {
        const rejected = await call('assign_session', { target: target(), projectPath: remoteDirectory, providerID: 'remote-b', modelID: 'remote-model', prompt: 'Do not borrow another Host model' });
        expect(rejected.details.error).toBe('model_not_found');
      });
      expect(f.requests.filter((request) => request.method === 'POST' && request.route === '/api/session')).toHaveLength(1);
    } finally { f.close(); }
  });

  it('keeps offline watches and failed terminal reviews recoverable across restart without replaying assignment', async () => {
    const f = fixture();
    try {
      await f.send((call) => call('assign_session', { target: target(), projectPath: remoteDirectory, prompt: 'Run once' }));
      f.offline(true);
      await f.service.reconcile();
      expect(f.service.snapshot().assistants[0].assignedSessions).toHaveLength(1);
      expect(f.reviews).toHaveLength(0);
      f.offline(false); f.busy.set('remote-a', false); f.failReview(true);
      await f.emit('remote-a');
      await vi.waitFor(() => expect(f.reviews.length).toBeGreaterThan(0));
      f.reopen(); f.failReview(false);
      await f.service.reconcile();
      await vi.waitFor(() => expect(f.service.contactMessages(f.assistant.id).messages.some((row) => row.text === '任务结果已核对。')).toBe(true));
      const db = f.db();
      try {
        expect(db.prepare('SELECT remote_resume_pending FROM assistant_contact_watch').get().remote_resume_pending).toBe(0);
        expect(JSON.stringify(db.prepare('SELECT * FROM assistant_contact_part').all())).not.toContain('RAW_REMOTE_TOOL_SENTINEL');
      } finally { db.close(); }
      expect(f.requests.filter((row) => row.route.endsWith('/prompt'))).toHaveLength(1);
    } finally { f.close(); }
  });

  it('ignores 50 unrelated session events and settles native manual interruption without waiting for a terminal message', async () => {
    const f = fixture();
    try {
      await f.send((call) => call('watch_session', { target: target(), sessionID: 'ses_same' }));
      await f.service.reconcile();
      const before = f.requests.length;
      const watchers = [...f.leases].filter((lease) => lease.options.onEvent);
      for (let index = 0; index < 50; index++) for (const lease of watchers) lease.options.onEvent({ payload: { type: 'session.execution.started', data: { sessionID: 'ses_unrelated' } } });
      await Promise.resolve();
      expect(f.requests).toHaveLength(before);
      await f.emit('remote-a', 'session.execution.interrupted', { reason: 'user' });
      await vi.waitFor(() => expect(f.reviews).toHaveLength(1));
      expect(f.reviews[0]).toContain('status: cancelled');
      expect(f.reviews[0]).toContain('reason: user_interrupted');
      expect([...f.leases].filter((lease) => lease.options.onEvent)).toHaveLength(0);
    } finally { f.close(); }
  });

  it('reports one unavailable discovery independently and never stats remote directories on the Hub', async () => {
    const f = fixture();
    const original = f.gateway.acquireTask.getMockImplementation();
    f.gateway.acquireTask.mockImplementation((hostId, options) => hostId === 'remote-a' ? Promise.reject(new Error('offline')) : original(hostId, options));
    const realpath = vi.spyOn(fs, 'realpathSync');
    try {
      await f.send(async (call) => {
        const projects = await call('list_projects', {});
        expect(projects.details).toMatchObject({ partial: true, failed: [{ hostId: 'remote-a' }], projects: [{ target: target('remote-b') }] });
        await call('list_sessions', { target: target('remote-b') });
        await call('read_session', { target: target('remote-b'), sessionID: 'ses_same' });
      });
      expect(realpath.mock.calls.some(([value]) => typeof value === 'string' && value.startsWith('/remote-only'))).toBe(false);
      expect(f.localClient).not.toHaveBeenCalled();
    } finally { realpath.mockRestore(); f.close(); }
  });

  it('preserves official SDK request body/signal and delegates admission to the target proxy, not the Hub gate', async () => {
    const f = fixture();
    configureServerOpenCodeFetchGate(() => ({ executionAllowed: false }));
    try {
      const accessor = createAssistantExecutionAccessor(f.gateway);
      const controller = new AbortController();
      await accessor.run({ target: target(), signal: controller.signal }, async () => {
        await accessor.current().api.session.prompt({ sessionID: 'ses_same', text: 'exact body', delivery: 'steer' }, { signal: controller.signal });
      });
      const request = f.requests.find((row) => row.route.endsWith('/prompt'));
      expect(request).toMatchObject({ method: 'POST', body: { text: 'exact body', delivery: 'steer' } });
      expect(request.headers.get('content-type')).toContain('application/json');
      expect(request.signal).toBeInstanceOf(AbortSignal);
      expect(f.leases.size).toBe(0);
      const tools = createOpenCodeContactTools({ resolveClient: f.localClient, acquireExecution: accessor.acquire, directory: '/hub-only' });
      const read = await tools.find((tool) => tool.name === 'read_opencode_skill').execute('skill', { target: target('remote-b'), directory: remoteDirectory, id: 'remote-skill' });
      expect(read.details).toMatchObject({ target: target('remote-b'), content: 'Instructions remote-b' });
      expect(f.requests.at(-1).route).not.toContain('hub-only');
      expect(f.localClient).not.toHaveBeenCalled();
    } finally { configureServerOpenCodeFetchGate(null, { allowMissingContract: true }); f.close(); }
  });

  it.each([null, {}, { hubId: 'hub', hostId: 'remote-a' }, { ...target(), instanceId: '' }])('rejects malformed card targets: %j', (invalid) => {
    expect(() => parseExecutionTarget(invalid)).toThrow();
    expect(() => createSessionCardPart({ sessionID: 'ses_same', directory: remoteDirectory, target: invalid })).toThrow();
  });
});
