import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const output = path.resolve(process.argv[2] ?? '.scratch/remote-projects/performance/owner/fault-diagnostic');
await fs.mkdir(output, { recursive: false });
const original = await fs.readFile(path.join(repo, 'scripts/remote-hosts-acceptance.mjs'), 'utf8');
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode/performance-owner-fault-'));
const replace = (source, before, after) => {
  assert.equal(source.split(before).length, 2, `Fixture instrumentation anchor changed: ${before}`);
  return source.replace(before, after);
};
let source = original.replaceAll("await import('../packages/", `await import('${pathToFileURL(path.join(repo, 'packages/')).href}`);
try {
  await fs.access(path.join(repo, 'packages/web/server/lib/remote-hosts/deadline.js'));
  source = replace(source, "'packages/web/server/index.js',", "'packages/web/server/lib/remote-hosts/deadline.js', 'packages/web/server/index.js',");
} catch (error) { if (error.code !== 'ENOENT') throw error; }
source = replace(source, 'new URL(`../${filename}`, import.meta.url)', `new URL(filename, ${JSON.stringify(pathToFileURL(`${repo}/`).href)})`);
source = replace(source, "new URL('../packages/web/package.json', import.meta.url)", JSON.stringify(pathToFileURL(path.join(repo, 'packages/web/package.json')).href));
source = replace(source, 'let previousCpu = process.cpuUsage();', `
  const { Session } = await import('node:inspector/promises');
  const { performance, monitorEventLoopDelay } = await import('node:perf_hooks');
  const profiler = new Session(); profiler.connect();
  await profiler.post('Profiler.enable'); await profiler.post('Profiler.start');
  const eventLoop = monitorEventLoopDelay({ resolution: 10 }); eventLoop.enable();
  let previousUtilization = performance.eventLoopUtilization();
  let previousCpu = process.cpuUsage();`);
source = replace(source, "process.send({ kind: 'sample',", `
    const utilization = performance.eventLoopUtilization(previousUtilization);
    previousUtilization = performance.eventLoopUtilization();
    const eventLoopDiagnostic = { utilization, minMs: eventLoop.min / 1e6, maxMs: eventLoop.max / 1e6,
      p95Ms: eventLoop.percentile(95) / 1e6, meanMs: eventLoop.mean / 1e6 };
    eventLoop.reset();
    process.send({ eventLoopDiagnostic, kind: 'sample',`);
source = replace(source, 'clearInterval(timer);', `
    clearInterval(timer); eventLoop.disable();
    const { profile } = await profiler.post('Profiler.stop'); profiler.disconnect();
    await fs.writeFile(path.join(config.output, 'hub.cpuprofile'), JSON.stringify(profile));`);
source = replace(source, 'child.send({ root, hosts:', 'child.send({ root, output, hosts:');
source = replace(source, 'const fixture = async index => {', `
  let activeRefreshRequests = 0; let peakRefreshRequests = 0;
  const activeRefreshByHost = new Map(); const peakRefreshByHost = new Map();
  const fixture = async index => {`);
source = replace(source, "if (pathname === '/api/hosts/capabilities')", `
      if (['/api/yuri/session-index', '/api/yuri/session-index/sync', '/api/git/worktrees',
        '/api/yuri/session-unread', '/api/session-folders', '/api/session-folders/order'].includes(pathname)) {
        activeRefreshRequests++;
        peakRefreshRequests = Math.max(peakRefreshRequests, activeRefreshRequests);
        activeRefreshByHost.set(state.id, (activeRefreshByHost.get(state.id) || 0) + 1);
        peakRefreshByHost.set(state.id, Math.max(peakRefreshByHost.get(state.id) || 0, activeRefreshByHost.get(state.id)));
        record({ kind: 'refresh-request-start', hostId: state.id, pathname, activeRefreshRequests, hostActive: activeRefreshByHost.get(state.id) });
        let completed = false;
        const finish = () => {
          if (completed) return; completed = true;
          activeRefreshRequests--; activeRefreshByHost.set(state.id, activeRefreshByHost.get(state.id) - 1);
          record({ kind: 'refresh-request-end', hostId: state.id, pathname, activeRefreshRequests, hostActive: activeRefreshByHost.get(state.id) });
        };
        res.once('finish', finish); res.once('close', finish);
      }
      if (pathname === '/api/hosts/capabilities')`);
source = replace(source, "if (pathname === '/api/yuri/session-unread')", `
      if (pathname === '/api/git/worktrees') return reply(200, []);
      if (pathname === '/api/yuri/session-index/sync' && req.method === 'POST') {
        let text = ''; for await (const chunk of req) text += chunk;
        const input = JSON.parse(text);
        if (!Array.isArray(input.directories) || !input.directories.every(directory => directory === '/workspace/shared')) return reply(400, { error: 'invalid_directories' });
        return reply(202, {});
      }
      if (pathname === '/api/yuri/session-unread')`);
source = replace(source, 'result.finishedSourceHashes = await sourceHashes();', `
    result.refreshConcurrency = { peakRefreshRequests, peakRefreshByHost: Object.fromEntries(peakRefreshByHost),
      activeRefreshRequests, activeRefreshByHost: Object.fromEntries(activeRefreshByHost),
      routes: 'index,index-sync,worktrees,unread,folders,order; counted through HTTP response finish or close',
      limit: 'single-runtime sequential upper bound 1; Gateway global <=2, per Host <=1' };
    result.finishedSourceHashes = await sourceHashes();`);
const runner = path.join(temporary, 'instrumented-fault.mjs');
await fs.writeFile(runner, source);
await fs.writeFile(path.join(output, 'instrumented-fault.mjs.txt'), source);
await fs.writeFile(path.join(output, 'instrumentation.json'), JSON.stringify({
  originalSha256: sha256(original), instrumentedSha256: sha256(source), wrapperSha256: sha256(await fs.readFile(fileURLToPath(import.meta.url))),
  classification: 'diagnostic only; profiler active and exclusive window not granted; no budget acceptance',
  command: process.argv, node: process.version, abi: process.versions.modules,
  os: `${os.platform()} ${os.release()} ${os.arch()}`,
  fixtureCorrections: ['authoritative empty worktrees', 'validated session-index sync acknowledgement'],
}, null, 2));
const syntax = spawnSync(process.execPath, ['--check', runner], { encoding: 'utf8' });
assert.equal(syntax.status, 0, syntax.stderr);
if (process.argv.includes('--prepare-only')) {
  await fs.rm(temporary, { recursive: true, force: true });
  console.log('Instrumentation prepared and syntax checked; no Hub started.');
  process.exit(0);
}
const child = spawn(process.execPath, [runner, output, '--fault-only'], { cwd: repo, stdio: 'inherit', env: { ...process.env, NODE_OPTIONS: '' } });
const code = await new Promise(resolve => child.once('exit', code => resolve(code ?? 1)));
await fs.rm(temporary, { recursive: true, force: true });
process.exitCode = code;
