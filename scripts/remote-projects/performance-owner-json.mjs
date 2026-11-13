import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createServer } from 'node:http';
import { EventEmitter, once } from 'node:events';
import { createHook } from 'node:async_hooks';
import { setTimeout as sleep, setImmediate as tick } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const repo = path.resolve(option('repo') ?? fileURLToPath(new URL('../../', import.meta.url)));
const output = path.resolve(option('out') ?? '.scratch/remote-projects/performance/owner/json-consumption');
const sourcePaths = ['packages/web/server/lib/remote-hosts/gateway.js', 'packages/web/server/lib/remote-hosts/transport.js', 'packages/web/server/lib/remote-hosts/deadline.js', 'packages/web/server/lib/remote-hosts/store.js'];
const hashes = async () => Object.fromEntries(await Promise.all(sourcePaths.map(async file => [file,
  crypto.createHash('sha256').update(await fs.readFile(path.join(repo, file))).digest('hex')])));
await fs.mkdir(output, { recursive: false });
const result = { classification: 'owning Gateway JSON consumption resource/semantic diagnostic, NOT UI or RSS gate',
  repo, node: process.version, abi: process.versions.modules, sourceBefore: await hashes(),
  requestTimeoutMs: 500, command: process.argv, checks: [], checkpoints: [], sourceAfter: null };
if (process.argv.includes('--prepare-only')) {
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ ...result, status: 'prepared-no-runtime',
    cases: ['50 successful JSON reads with connection retained', 'malformed JSON', 'non-2xx', 'incomplete body deadline', 'caller cancellation', 'stream survives JSON deadline', 'credential ABA late body rejection'] }, null, 2));
  process.exit(0);
}
if (!process.argv.includes('--confirm-owner-window-released')) throw new Error('Runtime probe requires explicit task-owner handoff');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode/performance-owner-json-'));
const signals = new EventEmitter(); const pending = new Map(); const responses = new Set(); const timers = new Map();
const tokens = [crypto.randomUUID(), crypto.randomUUID()]; let tokenIndex = 0;
const hook = createHook({ init(id, type, triggerId, resource) {
  if (type !== 'Timeout') return;
  const stack = new Error().stack;
  if (stack.includes('/remote-hosts/deadline.js')) timers.set(id, { id, triggerId, stack, resource: new WeakRef(resource) });
}, destroy(id) { timers.delete(id); } });
const checkpoint = async label => {
  await tick(); await tick();
  const entries = [...timers.values()].map(({ resource, ...entry }) => ({ ...entry,
    destroyed: resource.deref()?._destroyed, refed: resource.deref()?.hasRef() }));
  result.checkpoints.push({ label, liveDeadlines: entries.filter(entry => entry.destroyed === false).length,
    unknownDeadlines: entries.filter(entry => entry.destroyed === undefined).length, entries });
};
const check = (name, passed, detail) => { result.checks.push({ name, passed, detail }); assert.ok(passed, name); };
const outcome = promise => promise.then(value => ({ resolved: true, value }), error => ({ resolved: false, name: error.name, code: error.code, message: error.message }));
const server = createServer((req, res) => {
  responses.add(res); res.once('close', () => responses.delete(res));
  const route = new URL(req.url, 'http://fixture.invalid').pathname;
  if (!tokens.some(token => req.headers.authorization === `Bearer ${token}`)) { res.writeHead(401).end(); return; }
  res.setHeader('content-type', 'application/json');
  if (route === '/api/hosts/capabilities') { res.end(JSON.stringify({ protocol: 1, remoteProjects: true, instanceId: 'json-fixture' })); return; }
  if (route === '/probe/ok') { res.end('{"value":42}'); return; }
  if (route === '/probe/malformed') { res.end('{'); return; }
  if (route === '/probe/failure') { res.writeHead(503).end('{"error":"fixture"}'); return; }
  res.write('{"value":'); pending.set(route, res); res.once('close', () => pending.delete(route)); signals.emit(route);
});
let gateway; let releaseHost; let releaseObserver;
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { createRemoteHostGateway } = await import(pathToFileURL(path.join(repo, sourcePaths[0])).href);
  const { createRemoteHostStore } = await import(pathToFileURL(path.join(repo, sourcePaths[3])).href);
  gateway = createRemoteHostGateway({ store: createRemoteHostStore(path.join(temporary, 'remote.sqlite')),
    indexDbPath: path.join(temporary, 'index.sqlite'), requestTimeoutMs: 500,
    adapter: { listHosts: async () => [{ id: 'json-fixture', name: 'JSON fixture', source: 'direct',
      apiUrl: `http://127.0.0.1:${server.address().port}`, clientToken: tokens[tokenIndex] }] } });
  const resource = {}; releaseObserver = gateway.observe(resource, 'json-owner', { status: false });
  releaseHost = gateway.retainHost('json-fixture', resource); await tick();
  hook.enable();
  await checkpoint('before');
  for (let index = 0; index < 50; index++) assert.deepEqual(await gateway.json('json-fixture', '/probe/ok'), { value: 42 });
  await checkpoint('50-successful-consumed-connection-retained'); check('all fifty bodies fully parsed without releasing connection', true);
  for (const [route, expected] of [['malformed', 'SyntaxError'], ['failure', 'remote_request_failed']]) {
    const value = await outcome(gateway.json('json-fixture', `/probe/${route}`));
    check(`${route} propagates original failure`, !value.resolved && (value.name === expected || value.code === expected), value);
    await checkpoint(`${route}-consumption-ended`);
  }
  const timeoutHeaders = once(signals, '/probe/timeout');
  let settled = false; const timeout = outcome(gateway.json('json-fixture', '/probe/timeout')).then(value => { settled = true; return value; });
  await timeoutHeaders; await sleep(30); await checkpoint('headers-received-body-incomplete');
  check('headers do not release JSON body budget or prematurely settle body', !settled && result.checkpoints.at(-1).liveDeadlines > 0);
  check('incomplete body still fails at the owning deadline', !(await timeout).resolved);
  const controller = new AbortController(); const abortHeaders = once(signals, '/probe/cancel');
  const cancelled = outcome(gateway.json('json-fixture', '/probe/cancel', { signal: controller.signal }));
  await abortHeaders; controller.abort(new Error('fixture cancellation'));
  check('caller cancellation still rejects the pending body', !(await cancelled).resolved); await checkpoint('caller-cancelled');
  const streamHeaders = once(signals, '/probe/stream');
  const responsePromise = gateway.request('json-fixture', '/probe/stream', {}, { streaming: true });
  await streamHeaders; const response = await responsePromise; const stream = response.text();
  await sleep(650); pending.get('/probe/stream')?.end('42}');
  check('streaming body survives beyond the ordinary JSON deadline', await stream === '{"value":42}');
  const abaHeaders = once(signals, '/probe/aba'); const late = outcome(gateway.json('json-fixture', '/probe/aba'));
  await abaHeaders; tokenIndex = 1; await gateway.list(); tokenIndex = 0; await gateway.list(); pending.get('/probe/aba')?.end('42}');
  check('credential ABA cannot commit a late JSON result', !(await late).resolved);
  releaseHost(); releaseHost = null; releaseObserver(); releaseObserver = null;
  await checkpoint('all-owners-released');
  check('owner release clears all known remote deadline timers', result.checkpoints.at(-1).liveDeadlines === 0 && result.checkpoints.at(-1).unknownDeadlines === 0);
  result.status = 'measured';
} catch (error) { result.status = 'failed'; result.error = { name: error.name, message: error.message, stack: error.stack }; process.exitCode = 1; }
finally {
  releaseHost?.(); releaseObserver?.(); gateway?.stop(); hook.disable();
  for (const res of responses) res.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  result.sourceAfter = await hashes(); result.sourceStable = JSON.stringify(result.sourceBefore) === JSON.stringify(result.sourceAfter);
  await fs.rm(temporary, { recursive: true, force: true });
  result.cleanup = { temporaryFixtureRemoved: true, fixtureServerClosed: true, childProcessesCreated: 0 };
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
}
console.log(JSON.stringify({ status: result.status, sourceStable: result.sourceStable,
  checkpoints: result.checkpoints.map(({ label, liveDeadlines, unknownDeadlines }) => ({ label, liveDeadlines, unknownDeadlines })), checks: result.checks }));
