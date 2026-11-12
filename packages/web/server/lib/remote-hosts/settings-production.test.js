import { it, expect, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createProjectIdFromPath } from '../projects/project-id.js';

it('production bootstrap discovers cross-client references and persists Hub-only layout across restart, partition and failure', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-settings-production-'));
  const otherRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-settings-other-'));
  const children = new Set();
  const streams = new Set();
  const remoteRequests = [];
  const upstream = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://fixture.invalid').pathname;
    const reply = (body, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.headers.authorization === 'Bearer fixture-remote') remoteRequests.push([req.method, pathname]);
    if (pathname === '/api/info' || pathname === '/health') return reply({ version: '2.2.1', healthy: true });
    if (pathname === '/api/hosts/capabilities') return reply({ remoteProjects: true, protocol: 1, instanceId: 'fixture' });
    if (pathname === '/api/projects' && req.method === 'POST') {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const input = JSON.parse(raw);
      return reply({ project: { id: `remote-${input.path}`, path: input.path }, created: true });
    }
    if (['/api/event', '/api/global/event', '/api/hosts/status-stream'].includes(pathname)) {
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': ready\n\n');
      const timer = setInterval(() => res.write(': heartbeat\n\n'), 100);
      streams.add(res); res.on('close', () => { clearInterval(timer); streams.delete(res); }); return;
    }
    if (pathname === '/api/git/worktrees') return reply([]);
    if (pathname === '/api/yuri/session-index/sync') { for await (const chunk of req) void chunk; return reply({}, 202); }
    if (pathname === '/api/yuri/session-index') return reply({ directories: [], pinnedSessionIds: [] });
    return reply({}, 404);
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamOrigin = `http://127.0.0.1:${upstream.address().port}`;
  const start = async directory => {
    const child = fork(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/settings-server.mjs'), [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    children.add(child);
    let errors = ''; child.stderr.on('data', value => { errors += value; });
    const ready = new Promise((resolve, reject) => {
      child.on('message', message => { if (message.tokens) resolve(message); });
      child.once('exit', code => reject(new Error(`server exited ${code}: ${errors}`)));
    });
    child.send({ root: directory, upstream: upstreamOrigin,
      hosts: ['one', 'two'].map(id => ({ id, name: id, source: 'direct', apiUrl: upstreamOrigin, clientToken: 'fixture-remote' })) });
    const info = await ready;
    const request = async (route, body, client = 0, method = body === undefined ? 'GET' : 'PUT') => {
      const response = await fetch(info.origin + route, { method,
        signal: AbortSignal.timeout(5000),
        headers: { authorization: `Bearer ${info.tokens[client]}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: response.status === 204 ? null : await response.json() };
    };
    const stop = async () => { const exit = once(child, 'exit'); child.send('stop'); await exit; children.delete(child); };
    return { ...info, request, stop };
  };
  try {
    let a = await start(root);
    expect((await a.request('/api/config/settings/bootstrap')).body.hasRemoteProjects).toBe(false);
    expect((await a.request('/api/config/settings?bootstrap=true')).body.hasRemoteProjects).toBe(false);
    const controller = new AbortController();
    let frames = '';
    const stream = await fetch(a.origin + '/api/global/event', { headers: { authorization: `Bearer ${a.tokens[1]}` },
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) });
    const consuming = (async () => { for await (const data of stream.body) frames += Buffer.from(data).toString(); })().catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(remoteRequests).toEqual([]);
    const first = await a.request('/api/hosts/one/projects', { path: '/remote/does-not-exist-on-hub' }, 0, 'POST');
    expect(first.status).toBe(200);
    await vi.waitFor(() => expect(frames).toContain('yuri:project-order-changed'));
    expect((await a.request('/api/config/settings/bootstrap', undefined, 1)).body.hasRemoteProjects).toBe(true);
    const second = await a.request('/api/hosts/two/projects', { path: '/other/remote' }, 0, 'POST');
    expect(second.status).toBe(200);
    const local = { id: createProjectIdFromPath(root), path: root };
    expect((await a.request('/api/config/settings', { projects: [local] })).status).toBe(200);
    const original = (await a.request('/api/config/settings')).body;
    const hubId = original.hubProjectLayout.hubId;
    const layout = { hubId, order: [first.body.project.id, local.id, second.body.project.id], collapsed: { [first.body.project.id]: true, [local.id]: false } };
    const beforeLayout = remoteRequests.length;
    const tipCount = () => (frames.match(/yuri:project-order-changed/g) || []).length;
    await vi.waitFor(() => expect(tipCount()).toBeGreaterThanOrEqual(3));
    const beforeLayoutTips = tipCount();
    expect((await a.request('/api/config/settings', { hubProjectLayout: layout })).body.hubProjectLayout).toEqual(layout);
    await vi.waitFor(() => expect(tipCount()).toBeGreaterThan(beforeLayoutTips));
    expect((await a.request('/api/config/settings', undefined, 1)).body.hubProjectLayout).toEqual(layout);
    expect(remoteRequests.slice(beforeLayout).some(([, p]) => p === '/api/config/settings')).toBe(false);
    const partial = await a.request('/api/config/settings', { hubProjectLayout: { hubId, order: [local.id], collapsed: { [local.id]: true } } }, 1);
    const merged = { hubId, order: [local.id, first.body.project.id, second.body.project.id], collapsed: { [first.body.project.id]: true, [local.id]: true } };
    expect(partial.body.hubProjectLayout).toEqual(merged);
    expect(partial.body.projects).toEqual(original.projects);
    expect((await a.request('/api/hosts/projects')).body.projects).toHaveLength(2);
    await new Promise(resolve => setTimeout(resolve, 25));
    const beforeInvalidTips = tipCount();
    expect((await a.request('/api/config/settings', { hubProjectLayout: { ...layout, hubId: 'other-hub' } })).status).toBe(409);
    expect((await a.request('/api/config/settings', { hubProjectLayout: { hubId, order: ['/bad'], collapsed: [] } })).status).toBe(400);
    expect((await a.request('/api/config/settings', { hasRemoteProjects: false })).body.hasRemoteProjects).toBe(true);
    const settingsPath = path.join(root, 'hub', 'settings.json');
    const saved = await fs.readFile(settingsPath, 'utf8');
    await fs.rename(settingsPath, settingsPath + '.backup'); await fs.mkdir(settingsPath);
    expect((await a.request('/api/config/settings', { hubProjectLayout: layout })).status).toBe(500);
    await fs.rmdir(settingsPath); await fs.rename(settingsPath + '.backup', settingsPath);
    expect(await fs.readFile(settingsPath, 'utf8')).toBe(saved);
    expect((await a.request('/api/config/settings')).body.hubProjectLayout).toEqual(merged);
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(tipCount()).toBe(beforeInvalidTips);
    controller.abort(); await consuming; await a.stop();
    a = await start(root);
    expect((await a.request('/api/config/settings/bootstrap')).body.hasRemoteProjects).toBe(true);
    expect((await a.request('/api/config/settings')).body.hubProjectLayout).toEqual(merged);
    const lastController = new AbortController();
    let lastFrames = '';
    const lastStream = await fetch(a.origin + '/api/global/event', {
      headers: { authorization: `Bearer ${a.tokens[1]}` }, signal: AbortSignal.any([lastController.signal, AbortSignal.timeout(10000)]) });
    const lastConsuming = (async () => { for await (const data of lastStream.body) lastFrames += Buffer.from(data).toString(); })().catch(() => {});
    const b = await start(otherRoot);
    const other = (await b.request('/api/config/settings')).body;
    expect(other.hubProjectLayout.hubId).not.toBe(hubId);
    expect(other.hubProjectLayout.order).toEqual([]);
    expect(other.hasRemoteProjects).toBe(false);
    expect((await b.request('/api/config/settings', { hubProjectLayout: merged })).status).toBe(409);
    await b.stop();
    expect((await a.request(`/api/hosts/one/projects/${first.body.project.id}`, undefined, 0, 'DELETE')).status).toBe(204);
    await vi.waitFor(() => expect(lastFrames).toContain('yuri:project-order-changed'));
    const firstDeleteTips = (lastFrames.match(/yuri:project-order-changed/g) || []).length;
    expect((await a.request('/api/config/settings/bootstrap', undefined, 1)).body.hasRemoteProjects).toBe(true);
    expect((await a.request(`/api/hosts/two/projects/${second.body.project.id}`, undefined, 0, 'DELETE')).status).toBe(204);
    await vi.waitFor(() => expect((lastFrames.match(/yuri:project-order-changed/g) || []).length).toBeGreaterThan(firstDeleteTips));
    expect((await a.request('/api/config/settings/bootstrap', undefined, 1)).body.hasRemoteProjects).toBe(false);
    expect((await a.request('/api/config/settings')).body.projects).toEqual(original.projects);
    lastController.abort(); await lastConsuming;
    const afterLast = remoteRequests.length;
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(remoteRequests.length).toBe(afterLast);
    await a.stop();
  } finally {
    for (const child of children) { child.kill('SIGTERM'); await once(child, 'exit'); }
    for (const stream of streams) stream.destroy();
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
    await fs.rm(root, { recursive: true, force: true }); await fs.rm(otherRoot, { recursive: true, force: true });
  }
}, 90000);
