import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createDataset, datasetHash } from './dataset.mjs';

export const profiles = {
  lan: { rttMs: 5, disconnectEvery: 0 },
  relay: { rttMs: 80, disconnectEvery: 0 },
  weak: { rttMs: 300, disconnectEvery: 100 },
};

// A real loopback HTTP/SSE upstream, not an in-process replacement for the Hub.
// Weak profile simulates failed HTTP exchanges, NOT TCP packet loss/E2EE/SSH.
export async function startFakeHost({ hostId = 'perf-host-1', profile = 'lan', port = 0 } = {}) {
  if (!profiles[profile]) throw new Error(`Unknown profile ${profile}`);
  const dataset = createDataset();
  if (!dataset.hosts.some(h => h.id === hostId)) throw new Error('Unknown fixture host');
  const projects = dataset.projects.filter(p => p.hostId === hostId);
  const summaries = dataset.summaries.filter(s => s.hostId === hostId);
  const snapshot = selected => ({
    revision: 1,
    sync: { active: false, enriching: false, completed: selected.length, total: selected.length,
      pendingDirectories: [], completedDirectories: selected.map(project => project.path), failedDirectories: [] },
    directories: selected.map(project => ({ directory: project.path,
      sessions: summaries.filter(s => s.directory === project.path).map(({ hostId: _, ...s }) => s),
      hasMore: false, pinnedSessionIds: [], fetchedAt: dataset.epoch })),
  });
  const streams = new Map();
  const pending = new Map();
  const counts = { requests: 0, activeRequests: 0, peakRequests: 0, subscriptions: 0, openedSubscriptions: 0, events: 0, droppedRequests: 0, requestsByPath: {} };
  let mode = 'online';
  let stallMs = 30_000;
  const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/__perf/metrics') return json(res, 200, { hostId, profile, mode, datasetHash: datasetHash(dataset), ...counts });
    if (url.pathname === '/__perf/control' && req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) { raw += chunk; if (raw.length > 8192) return json(res, 413, { error: 'body too large' }); }
      let body;
      try { body = JSON.parse(raw); } catch { return json(res, 400, { error: 'invalid JSON' }); }
      if (body.mode) {
        if (!['online', 'offline', 'stall', 'unauthorized', 'incompatible'].includes(body.mode)) return json(res, 400, { error: 'invalid mode' });
        mode = body.mode;
        if (mode === 'offline') for (const stream of streams.keys()) stream.destroy();
      }
      if (body.stallMs !== undefined) {
        if (!Number.isFinite(body.stallMs) || body.stallMs < 0 || body.stallMs > 60_000) return json(res, 400, { error: 'invalid stallMs' });
        stallMs = body.stallMs;
      }
      if (body.event) {
        const event = { ...body.event, __perf: { sequence: ++counts.events, emittedAt: Date.now(), hostId } };
        const payload = event.payload ?? event;
        const status = /^(session\.|yuri:session-|yuri:project|permission\.|question\.)/.test(payload.type ?? '');
        for (const [stream, meta] of streams) {
          if (meta.statusOnly && !status) continue;
          stream.write(`data: ${JSON.stringify(event)}\n\n`);
        }
      }
      return json(res, 200, { mode });
    }
    counts.requests++;
    counts.requestsByPath[url.pathname] = (counts.requestsByPath[url.pathname] ?? 0) + 1;
    counts.activeRequests++;
    counts.peakRequests = Math.max(counts.peakRequests, counts.activeRequests);
    res.once('close', () => { counts.activeRequests--; const timer = pending.get(res); if (timer) clearTimeout(timer); pending.delete(res); });
    if (mode === 'offline' || (profiles[profile].disconnectEvery && counts.requests % profiles[profile].disconnectEvery === 0)) {
      counts.droppedRequests++; res.destroy(); return;
    }
    const delay = mode === 'stall' ? stallMs : profiles[profile].rttMs;
    await new Promise(resolve => { pending.set(res, setTimeout(() => { pending.delete(res); resolve(); }, delay)); });
    if (res.destroyed) return;
    if (mode === 'unauthorized') return json(res, 401, { code: 'unauthorized', error: 'Fixture unauthorized' });
    if (mode === 'incompatible') return json(res, 426, { code: 'incompatible', minimumVersion: 'fixture-next' });
    const route = url.pathname.replace(/^\/api(?=\/)/, '');
    if (route === '/projects' && req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 8192) return json(res, 413, { error: 'body too large' });
      }
      let input;
      try { input = JSON.parse(raw); } catch { return json(res, 400, { error: 'invalid JSON' }); }
      const project = projects.find(p => p.path === input?.path);
      if (!project) return json(res, 404, { error: 'fixture_project_missing' });
      return json(res, 200, { project: { ...project, id: project.remoteProjectId, hostId: undefined }, created: false });
    }
    if (route === '/yuri/session-index/sync' && req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 8192) return json(res, 413, { error: 'body too large' });
      }
      let input;
      try { input = JSON.parse(raw); } catch { return json(res, 400, { error: 'invalid JSON' }); }
      if (!Array.isArray(input?.directories) || input.directories.some(directory => typeof directory !== 'string' || !directory)) {
        return json(res, 400, { error: 'fixture_directories_required' });
      }
      if (input.directories.some(directory => !projects.some(project => project.path === directory))) {
        return json(res, 404, { error: 'fixture_directory_missing' });
      }
      return json(res, 202, snapshot(projects.filter(project => input.directories.includes(project.path))));
    }
    if (req.method !== 'GET') return json(res, 405, { error: 'fixture_method_missing' });
    if (route === '/event' || route === '/global/event' || route === '/hosts/status-stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(': fixture connected\n\n');
      const heartbeat = setInterval(() => res.write(': fixture heartbeat\n\n'), 1000);
      streams.set(res, { statusOnly: route === '/hosts/status-stream', heartbeat });
      counts.subscriptions++; counts.openedSubscriptions++;
      res.once('close', () => { clearInterval(heartbeat); streams.delete(res); counts.subscriptions--; });
      return;
    }
    if (route === '/projects') return json(res, 200, { projects: projects.map(p => ({ ...p, id: p.remoteProjectId, hostId: undefined })) });
    if (route === '/hosts/capabilities') return json(res, 200, { remoteProjects: true, protocol: 1, instanceId: hostId, version: '0.2.40-beta.2' });
    if (route === '/yuri/session-index') return json(res, 200, snapshot(projects));
    if (route === '/git/worktrees') {
      const directory = url.searchParams.get('directory');
      if (!directory) return json(res, 400, { error: 'fixture_directory_required' });
      if (!projects.some(project => project.path === directory)) return json(res, 404, { error: 'fixture_directory_missing' });
      return json(res, 200, []);
    }
    if (route === '/session') {
      const directory = url.searchParams.get('directory') ?? req.headers['x-opencode-directory'];
      return json(res, 200, summaries.filter(s => !directory || s.directory === directory).map(({ hostId: _, ...s }) => s));
    }
    if (route === '/session/status') return json(res, 200, Object.fromEntries(dataset.streaming.filter(s => s.hostId === hostId).map(s => [s.sessionId, { type: 'busy' }])));
    if (route === '/global/health' || route === '/health') return json(res, 200, { healthy: true, version: '2.2.1' });
    if (route === '/hosts') return json(res, 200, { supported: true, hubId: hostId, hosts: [], projects: [] });
    // Unknown endpoints fail loudly rather than manufacturing usable empty data.
    return json(res, 404, { code: 'fixture_route_missing', error: `Fixture has no ${req.method} ${url.pathname}` });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { origin: `http://127.0.0.1:${server.address().port}`, counts,
    async close() { for (const timer of pending.values()) clearTimeout(timer); for (const [stream, meta] of streams) { clearInterval(meta.heartbeat); stream.destroy(); } server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = Object.fromEntries(process.argv.slice(2).map(a => a.replace(/^--/, '').split('=')));
  const host = await startFakeHost({ hostId: options.host, profile: options.profile, port: Number(options.port ?? 0) });
  console.log(JSON.stringify({ fixture: 'remote-projects-upstream', origin: host.origin }));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await host.close(); process.exit(0); });
}
