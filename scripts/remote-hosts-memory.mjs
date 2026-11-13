import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { createServer } from 'node:http';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PerformanceObserver, constants, performance } from 'node:perf_hooks';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const script = fileURLToPath(import.meta.url);
const sourceFiles = ['packages/web/server/index.js', 'packages/web/server/lib/remote-hosts/gateway.js',
  'packages/web/server/lib/remote-hosts/routes.js', 'packages/web/server/lib/remote-hosts/transport.js',
  'packages/web/server/lib/remote-hosts/store.js',
  'scripts/remote-hosts-memory.mjs'];
const hashes = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async filename =>
  [filename, crypto.createHash('sha256').update(await fs.readFile(new URL(`../${filename}`, import.meta.url))).digest('hex')])));
const stats = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = p => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? null;
  return { count: sorted.length, min: sorted[0] ?? null, p50: at(.5), p95: at(.95), max: at(1) };
};
const memoryKeys = ['rss', 'heapUsed', 'heapTotal', 'external', 'arrayBuffers'];

if (process.argv.includes('--worker')) {
  const config = await new Promise(resolve => process.once('message', resolve));
  for (const key of Object.keys(process.env)) if (/^(YURI_|OPENCODE_)/.test(key)) delete process.env[key];
  Object.assign(process.env, { HOME: config.root, XDG_CONFIG_HOME: path.join(config.root, 'config'),
    XDG_DATA_HOME: path.join(config.root, 'data'), XDG_STATE_HOME: path.join(config.root, 'state'),
    YURI_DATA_DIR: path.join(config.root, 'hub'), YURI_RUNTIME: 'desktop', NODE_ENV: 'development',
    YURI_SKIP_OPENCODE_START: 'true', OPENCODE_HOST: config.upstream,
    YURI_WEIXIN_ENABLED: '0', YURI_CHANNELS_ENABLED: '0' });
  let gcCount = 0; let majorGcCount = 0;
  const observer = new PerformanceObserver(list => {
    for (const entry of list.getEntries()) {
      gcCount++;
      if (entry.detail.kind & constants.NODE_PERFORMANCE_GC_MAJOR) majorGcCount++;
      process.send({ kind: 'gc', startTimeMs: entry.startTime, durationMs: entry.duration,
        gcKind: entry.detail.kind, flags: entry.detail.flags, gcCount, majorGcCount,
        observedAtMs: performance.now() });
    }
  });
  observer.observe({ entryTypes: ['gc'] });
  const loadedHashes = await hashes();
  const { createRemoteClientAuthRuntime } = await import('../packages/web/server/lib/client-auth/remote-clients.js');
  const clients = createRemoteClientAuthRuntime({ fsPromises: fs, path, crypto, storePath: path.join(config.root, 'hub', 'remote-clients.json') });
  const credentials = [];
  for (let i = 0; i < 2; i++) credentials.push(await clients.createClient({ label: `Memory fixture ${i}`, clientKind: 'desktop-local' }));
  const { startWebUiServer } = await import('../packages/web/server/index.js');
  const hub = await startWebUiServer({ port: 0, host: '127.0.0.1', apiOnly: true,
    attachSignals: false, exitOnShutdown: false, remoteHostsAdapter: { listHosts: async () => config.hosts } });
  const timer = setInterval(() => process.send({ kind: 'memory', atMs: performance.now(),
    pid: process.pid, ...process.memoryUsage(), gcCount, majorGcCount }), 250);
  process.send({ kind: 'ready', origin: `http://127.0.0.1:${hub.getPort()}`,
    tokens: credentials.map(c => c.token), loadedHashes, forcedGcAvailable: typeof global.gc === 'function' });
  process.on('message', async message => {
    if (message?.kind !== 'stop') return;
    clearInterval(timer); observer.disconnect();
    await hub.stop({ exitProcess: false, forceCloseConnections: true });
    process.exit(0);
  });
} else {
  const quick = process.argv.includes('--quick');
  const resetDemand = process.argv.includes('--reset-demand');
  const output = path.resolve(process.argv[2] || `.scratch/remote-projects/gateway-evidence/memory-${new Date().toISOString().replaceAll(':', '-')}`);
  await fs.mkdir(output, { recursive: true });
  const windowMs = quick ? 1000 : 15000; const settleMs = quick ? 250 : 5000;
  const raw = createWriteStream(path.join(output, 'raw.jsonl'));
  const rounds = []; const pids = [{ role: 'orchestrator', pid: process.pid }];
  const write = value => raw.write(`${JSON.stringify({ timestamp: new Date().toISOString(), ...value })}\n`);
  const makeFixture = async index => {
    const token = crypto.randomUUID(); const status = new Set(); const content = new Map();
    let sequence = 0; const state = { hostId: `host-${index}`, requests: 0, requestsByPath: {}, statusStarts: 0, contentStarts: 0, maxStatus: 0, maxContent: 0 };
    const project = { id: `project-${index}`, path: '/workspace/shared', label: `Host ${index}` };
    const server = createServer(async (req, res) => {
      const pathname = new URL(req.url, 'http://fixture.invalid').pathname;
      state.requests++;
      state.requestsByPath[pathname] = (state.requestsByPath[pathname] || 0) + 1;
      const reply = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.headers.authorization !== `Bearer ${token}`) return reply(401, { error: 'unauthorized' });
      if (pathname === '/api/hosts/capabilities') return reply(200, { remoteProjects: true, protocol: 1, instanceId: state.hostId, version: 'memory-fixture' });
      if (pathname === '/api/projects' && req.method === 'POST') { for await (const chunk of req) { void chunk; } return reply(200, { project, created: false }); }
      if (pathname === '/api/projects') return reply(200, { projects: [project] });
      if (pathname === '/api/git/worktrees') return reply(200, []);
      if (pathname === '/api/yuri/session-index/sync' && req.method === 'POST') {
        let body = ''; for await (const chunk of req) body += chunk;
        const input = JSON.parse(body);
        if (!Array.isArray(input.directories) || !input.directories.every(directory => typeof directory === 'string')) return reply(400, { error: 'invalid_directories' });
        return reply(202, {});
      }
      if (pathname === '/api/yuri/session-index') return reply(200, { directories: [{ directory: project.path,
        sessions: Array.from({ length: 20 }, (_, n) => ({ id: `session-${n}`, title: `Summary ${n}`, directory: project.path, time: { created: 1, updated: 2 } })), hasMore: false }], pinnedSessionIds: [] });
      if (pathname === '/api/yuri/session-unread') return reply(200, { revision: 0, sessions: {} });
      if (pathname === '/api/session-folders') return reply(200, { version: 1, foldersMap: {}, collapsedFolderIds: [] });
      if (pathname === '/api/session-folders/order') return reply(200, { revision: 0, sessionOrderByScope: {}, sessionOrderActivityByScope: {} });
      if (pathname === '/api/event' || pathname === '/api/hosts/status-stream') {
        const id = `${state.hostId}-${++sequence}`; const isStatus = pathname.endsWith('status-stream');
        if (isStatus) { status.add(res); state.statusStarts++; state.maxStatus = Math.max(state.maxStatus, status.size); }
        else { content.set(id, res); state.contentStarts++; state.maxContent = Math.max(state.maxContent, content.size); }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' }); res.write(': ready\n\n');
        const timer = setInterval(() => res.write(': heartbeat\n\n'), 1000);
        write({ kind: 'fixture-stream-open', hostId: state.hostId, id, isStatus });
        res.once('close', () => { clearInterval(timer); status.delete(res); content.delete(id);
          write({ kind: 'fixture-stream-close', hostId: state.hostId, id, isStatus }); });
        return;
      }
      reply(404, { error: 'unsupported_fixture_route' });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return { server, state, status, content, descriptor: { id: state.hostId, name: state.hostId, source: 'direct',
      clientToken: token, apiUrl: `http://127.0.0.1:${server.address().port}` } };
  };
  const wait = async (predicate, reason) => {
    const deadline = performance.now() + 20000;
    while (!predicate()) { assert.ok(performance.now() < deadline, `Timeout: ${reason}`); await sleep(25); }
  };
  const run = async direction => {
    const base = path.join(os.tmpdir(), 'opencode'); await fs.mkdir(base, { recursive: true });
    const root = await fs.mkdtemp(path.join(base, 'remote-hosts-memory-'));
    const round = { direction, windows: [], checks: [], gcEvents: [], quickPreflightOnly: quick,
      resetGlobalObserverBetweenStatusDemands: resetDemand };
    let phase = 'startup'; const samples = []; const fixtures = []; const globalStreams = new Set(); const leases = [];
    let child; let childClosed = false;
    const log = createWriteStream(path.join(output, `${direction}-hub.log`));
    const local = createServer((req, res) => {
      const pathname = new URL(req.url, 'http://local.invalid').pathname;
      if (['/api/event', '/api/global/event'].includes(pathname)) {
        res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': ready\n\n');
        const timer = setInterval(() => res.write(': heartbeat\n\n'), 1000);
        res.once('close', () => clearInterval(timer)); return;
      }
      res.writeHead(['/api/info', '/health'].includes(pathname) ? 200 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ version: '2.2.1', healthy: true }));
    });
    const snapshot = () => fixtures.map(f => ({ ...structuredClone(f.state), statusActive: f.status.size,
      contentActive: f.content.size, contentStreamIds: [...f.content.keys()] }));
    const check = (name, passed, detail) => { const item = { name, passed, detail }; round.checks.push(item); write({ round: direction, phase, kind: 'check', ...item }); };
    try {
      await new Promise(resolve => local.listen(0, '127.0.0.1', resolve));
      for (let i = 0; i < 5; i++) fixtures.push(await makeFixture(i));
      const env = { ...process.env }; delete env.NODE_OPTIONS;
      child = fork(script, ['--worker'], { execArgv: [], env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      pids.push({ role: `${direction}-hub`, pid: child.pid }); await fs.writeFile(path.join(output, 'pids.json'), JSON.stringify(pids, null, 2));
      child.once('exit', () => { childClosed = true; }); child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
      child.on('message', message => {
        if (message.kind === 'memory') { const sample = { round: direction, phase, ...message }; samples.push(sample); write(sample); }
        if (message.kind === 'gc') { const event = { round: direction, phase, parentAtMs: performance.now(), ...message }; round.gcEvents.push(event); write(event); }
      });
      const ready = new Promise((resolve, reject) => { child.on('message', message => { if (message.kind === 'ready') resolve(message); }); child.once('exit', code => reject(new Error(`Hub exited before ready: ${code}`))); });
      child.send({ root, hosts: fixtures.map(f => f.descriptor), upstream: `http://127.0.0.1:${local.address().port}` });
      const info = await ready; round.loadedHashes = info.loadedHashes; round.forcedGcAvailable = info.forcedGcAvailable;
      const loadedEvidence = { direction, loadedHashes: info.loadedHashes, forcedGcAvailable: info.forcedGcAvailable, pid: child.pid };
      write({ kind: 'loaded-source', ...loadedEvidence });
      await fs.writeFile(path.join(output, `${direction}-loaded.json`), JSON.stringify(loadedEvidence, null, 2));
      const call = (route, method = 'GET', body, owner = 0) => fetch(`${info.origin}${route}`, { method, signal: AbortSignal.timeout(20000),
        headers: { 'content-type': 'application/json', authorization: `Bearer ${info.tokens[owner]}` },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const stream = async owner => {
        const controller = new AbortController(); const response = await fetch(`${info.origin}/api/global/event`, { signal: controller.signal,
          headers: { authorization: `Bearer ${info.tokens[owner]}` } }); assert.equal(response.status, 200);
        const done = (async () => { try { for await (const chunk of response.body) { void chunk; } } catch { /* Owned stream cancellation. */ } })();
        const handle = { async close() { controller.abort(); await done; globalStreams.delete(handle); } };
        globalStreams.add(handle); return handle;
      };
      const references = new Map();
      const setReferences = async count => {
        if (resetDemand) {
          assert.equal(leases.length, 0, 'demand reset must not hide active content lease deletion');
          await primary.close();
          await wait(() => fixtures.every(f => f.status.size === 0 && f.content.size === 0), 'explicit global observer reset');
        }
        for (let i = 4; i >= count; i--) if (references.has(i)) {
          assert.equal((await call(`/api/hosts/host-${i}/projects/${references.get(i)}`, 'DELETE')).status, 204); references.delete(i);
        }
        for (let i = 0; i < count; i++) if (!references.has(i)) {
          const response = await call(`/api/hosts/host-${i}/projects`, 'POST', { path: '/workspace/shared' });
          assert.equal(response.status, 200); references.set(i, (await response.json()).project.id);
        }
        write({ kind: 'status-demand', round: direction, phase, count, referenceHostIndexes: [...references.keys()], fixtures: snapshot() });
        if (resetDemand) primary = await stream(0);
        await wait(() => fixtures.every((f, i) => f.status.size === (i < count ? 1 : 0)), `status demand ${count}`);
      };
      const acquire = async (sessionId, owner = 0) => {
        const response = await call('/api/hosts/host-0/subscriptions', 'POST', { directory: '/workspace/shared', sessionId }, owner);
        assert.equal(response.status, 200); const lease = { ...await response.json(), owner }; leases.push(lease); return lease;
      };
      const release = async lease => {
        assert.equal((await call(`/api/hosts/host-0/subscriptions/${lease.id}`, 'DELETE', undefined, lease.owner)).status, 204);
        leases.splice(leases.indexOf(lease), 1);
      };
      const setContent = async count => {
        while (leases.length > count) await release(leases.at(-1));
        while (leases.length < count) await acquire(`session-${leases.length}`);
        await wait(() => fixtures[0].content.size === count, `content demand ${count}`);
      };
      const window = async (name, demand, measured = true) => {
        phase = `${name}:settle`; await sleep(settleMs);
        phase = name; const startMs = performance.now(); const sampleStart = samples.length; const gcStart = round.gcEvents.length;
        const before = snapshot();
        const environmentBefore = { loadAverage: os.loadavg(), freeMemoryBytes: os.freemem(), totalMemoryBytes: os.totalmem() };
        await sleep(windowMs); const selected = samples.slice(sampleStart).filter(s => s.phase === name);
        const endMs = performance.now();
        const metrics = Object.fromEntries(memoryKeys.map(key => [key, stats(selected.map(s => s[key]))]));
        const tail = selected.slice(-Math.ceil(selected.length / 3)); const head = selected.slice(0, Math.ceil(selected.length / 3));
        const rssDriftBytes = stats(tail.map(s => s.rss)).p50 - stats(head.map(s => s.rss)).p50;
        const entry = { name, demand, measured, startMs, endMs, sampleCount: selected.length, metrics, rssDriftBytes,
          rssRangeBytes: metrics.rss.max - metrics.rss.min, gcEvents: round.gcEvents.slice(gcStart), before, after: snapshot(),
          environmentBefore, environmentAfter: { loadAverage: os.loadavg(), freeMemoryBytes: os.freemem(), totalMemoryBytes: os.totalmem() } };
        round.windows.push(entry); write({ kind: 'window', round: direction, phase, ...entry });
        return entry;
      };
      let primary = await stream(0);
      phase = 'warmup';
      for (let cycle = 0; cycle < 2; cycle++) {
        await setReferences(5); await setContent(8); await sleep(quick ? 300 : 8000);
        await setContent(0); await setReferences(0); await sleep(quick ? 300 : 4000);
      }
      await window('status-zero-anchor-before', { status: 0, content: 0 }, false);
      const stateCounts = direction === 'ascending' ? [0, 1, 2, 3, 4, 5] : [5, 4, 3, 2, 1, 0];
      for (const count of stateCounts) { await setReferences(count); await window(`status-${count}`, { status: count, content: 0 }); }
      await setReferences(0); await window('status-zero-anchor-after', { status: 0, content: 0 }, false);
      await setReferences(1);
      await window('content-zero-anchor-before', { status: 1, content: 0 }, false);
      const contentCounts = direction === 'ascending' ? [0, 1, 2, 3, 4, 5, 6, 7, 8] : [8, 7, 6, 5, 4, 3, 2, 1, 0];
      for (const count of contentCounts) { await setContent(count); await window(`content-${count}`, { status: 1, content: count }); }
      await setContent(0); await window('content-zero-anchor-after', { status: 1, content: 0 }, false);

      phase = 'correctness-sharing';
      const secondary = await stream(1); const starts = fixtures[0].state.contentStarts;
      const a = await acquire('shared-memory-channel', 0); const b = await acquire('shared-memory-channel', 1);
      await wait(() => fixtures[0].content.size === 1, 'shared channel');
      check('two distinct owners share one upstream content channel', a.id !== b.id && a.channelId === b.channelId && fixtures[0].state.contentStarts - starts === 1, snapshot());
      await release(a); await sleep(quick ? 100 : 1000);
      check('releasing one observer preserves the remaining observer channel', fixtures[0].content.size === 1);
      await secondary.close(); leases.splice(leases.indexOf(b), 1);
      await wait(() => fixtures[0].content.size === 0, 'last owner stream releases content');
      check('closing the last owner global stream releases that owner lease without explicit DELETE', true, snapshot());

      phase = 'correctness-capacity'; await setContent(8); const streamIds = [...fixtures[0].content.keys()];
      const ninth = await call('/api/hosts/host-0/subscriptions', 'POST', { directory: '/workspace/shared', sessionId: 'ninth-distinct-channel' });
      const ninthBody = await ninth.json(); await sleep(quick ? 100 : 1500);
      check('ninth distinct active channel returns explicit 429 content_capacity', ninth.status === 429 && ninthBody.code === 'content_capacity', { status: ninth.status, body: ninthBody });
      check('all eight active upstream channels survive the rejected ninth request', fixtures[0].content.size === 8 && streamIds.every(id => fixtures[0].content.has(id)), snapshot());
      await setContent(0); await setReferences(0);
      const cycleBefore = await window('switching-zero-before', { status: 0, content: 0 }, false);
      phase = 'repeated-switching';
      for (let cycle = 0; cycle < (quick ? 2 : 12); cycle++) {
        await setReferences(5); await setContent(8); await sleep(quick ? 50 : 750);
        await setContent(0); await setReferences(0); await sleep(quick ? 50 : 750);
        check(`switch cycle ${cycle + 1} releases all remote readers`, fixtures.every(f => f.status.size === 0 && f.content.size === 0), snapshot());
      }
      const cycleAfter = await window('switching-zero-after', { status: 0, content: 0 }, false);
      round.switching = Object.fromEntries(memoryKeys.map(key => [key, {
        medianDeltaBytes: cycleAfter.metrics[key].p50 - cycleBefore.metrics[key].p50,
        observedUpperDeltaBytes: cycleAfter.metrics[key].max - cycleBefore.metrics[key].min }]));
      await setReferences(5); await setContent(8); await primary.close(); leases.splice(0);
      await wait(() => fixtures.every(f => f.status.size === 0 && f.content.size === 0), 'last global observer cleanup');
      check('last global observer releases eight content and five status streams with references retained', true, snapshot());
      await window('no-observers-final', { status: 0, content: 0 }, false);
      round.adjacentDeltas = [];
      round.zeroAnchorControls = [];
      for (const type of ['status', 'content']) {
        const before = round.windows.find(w => w.name === `${type}-zero-anchor-before`);
        const after = round.windows.find(w => w.name === `${type}-zero-anchor-after`);
        const medianRssShiftBytes = after.metrics.rss.p50 - before.metrics.rss.p50;
        round.zeroAnchorControls.push({ type, medianRssShiftBytes,
          stable: Math.abs(medianRssShiftBytes) <= 2 * 1024 * 1024 && [before, after].every(w => w.rssRangeBytes <= 2 * 1024 * 1024) });
      }
      for (const type of ['status', 'content']) for (let n = 1; n <= (type === 'status' ? 5 : 8); n++) {
        const low = round.windows.find(w => w.name === `${type}-${n - 1}`); const high = round.windows.find(w => w.name === `${type}-${n}`);
        const pairGcEvents = round.gcEvents.filter(e => e.parentAtMs >= Math.min(low.startMs, high.startMs) && e.parentAtMs <= Math.max(low.endMs, high.endMs));
        const gcAffected = pairGcEvents.length > 0;
        const deltas = Object.fromEntries(memoryKeys.map(key => [key, { medianDeltaBytes: high.metrics[key].p50 - low.metrics[key].p50,
          observedUpperDeltaBytes: high.metrics[key].max - low.metrics[key].min }]));
        round.adjacentDeltas.push({ type, from: n - 1, to: n, gcAffected, pairGcEvents,
          majorGcAffected: pairGcEvents.some(e => e.gcKind & constants.NODE_PERFORMANCE_GC_MAJOR),
          stableRssWindows: [low, high].every(w => w.rssRangeBytes <= 2 * 1024 * 1024 && Math.abs(w.rssDriftBytes) <= 1024 * 1024),
          deltas });
      }
      round.finishedHashes = await hashes(); round.sourceChangedDuringRun = JSON.stringify(round.loadedHashes) !== JSON.stringify(round.finishedHashes);
      round.correctnessPassed = round.checks.every(c => c.passed);
      child.send({ kind: 'stop' }); await once(child, 'exit');
    } catch (error) {
      round.error = { name: error.name, message: error.message, stack: error.stack };
      round.failureSnapshot = snapshot(); round.correctnessPassed = false;
      write({ kind: 'failure', round: direction, phase, error: round.error, fixtures: round.failureSnapshot });
    }
    finally {
      for (const handle of [...globalStreams]) await handle.close();
      if (child && !childClosed) {
        child.send({ kind: 'stop' }); await Promise.race([once(child, 'exit'), sleep(15000)]);
        if (!childClosed) { child.kill('SIGTERM'); await once(child, 'exit'); }
      }
      for (const f of fixtures) { f.server.closeAllConnections(); await new Promise(resolve => f.server.close(resolve)); }
      local.closeAllConnections(); await new Promise(resolve => local.close(resolve));
      log.end(); await fs.rm(root, { recursive: true, force: true });
      round.childExited = childClosed;
      await fs.writeFile(path.join(output, `${direction}.json`), JSON.stringify(round, null, 2));
    }
    return round;
  };
  for (const direction of ['ascending', 'descending']) { const round = await run(direction); rounds.push(round); if (round.error) break; }
  const bounds = [];
  for (const type of ['status', 'content']) for (let n = 1; n <= (type === 'status' ? 5 : 8); n++) {
    const pairs = rounds.map(r => r.adjacentDeltas?.find(d => d.type === type && d.to === n)).filter(Boolean);
    const limitBytes = type === 'status' ? 10000000 : 30000000;
    const observedUpperBytes = pairs.length ? Math.max(...pairs.map(p => p.deltas.rss.observedUpperDeltaBytes)) : null;
    bounds.push({ type, from: n - 1, to: n, limitBytes, observedUpperBytes,
      pairedCleanStableWindows: pairs.length === 2 && pairs.every(p => !p.gcAffected && p.stableRssWindows),
      belowObservedLimit: observedUpperBytes !== null && observedUpperBytes >= 0 && observedUpperBytes <= limitBytes });
  }
  const correctnessPassed = rounds.length === 2 && rounds.every(r => r.correctnessPassed);
  const sourceStable = rounds.length === 2 && rounds.every(r => !r.sourceChangedDuringRun)
    && JSON.stringify(rounds[0].loadedHashes) === JSON.stringify(rounds[1].loadedHashes);
  const observedThresholdSubsetEligible = !quick && !resetDemand && correctnessPassed && sourceStable
    && bounds.every(b => b.pairedCleanStableWindows && b.belowObservedLimit)
    && rounds.every(r => r.zeroAnchorControls.every(c => c.stable));
  const result = { quickPreflightOnly: quick, boundary: 'real startWebUiServer source entrypoint in isolated Node processes; synthetic direct loopback hosts',
    resetGlobalObserverBetweenStatusDemands: resetDemand,
    resetDemandCaveat: resetDemand ? 'explicit last-global-observer reset isolates plateau memory; it does not pass or hide the separately failed live-reference-removal probe' : null,
    samplePeriodMs: 250, settleMs, windowMs, rounds: rounds.map(r => ({ direction: r.direction, correctnessPassed: r.correctnessPassed,
      childExited: r.childExited, sourceChangedDuringRun: r.sourceChangedDuringRun, error: r.error })), bounds,
    correctnessPassed, sourceStable, observedThresholdSubsetEligible,
    fullMemoryThresholdProven: false,
    limitations: ['observed finite-window RSS upper differences are not a universal retained-allocation bound',
      'natural GC/allocator/page residency can change adjacent-window baselines; no forced GC is used',
      'heapUsed/external/arrayBuffers are separate diagnostics, never substituted for RSS',
      'idle synthetic streams, 20 summaries per Host; not high-volume streaming/backpressure or real Relay/SSH',
      'source server NODE_ENV=development with channels disabled, not packaged Electron or Capacitor',
      'parallel UI/candidate builds are uncontrolled; this run makes no CPU or latency acceptance claim',
      'finite switching checks can detect growth/resource leaks, not prove absence of all long-term leaks'] };
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2)); raw.end();
  console.log(JSON.stringify({ output, correctnessPassed: result.correctnessPassed, fullMemoryThresholdProven: false }));
  process.exit(result.correctnessPassed ? 0 : 1);
}
