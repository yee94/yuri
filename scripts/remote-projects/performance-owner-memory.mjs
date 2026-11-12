import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

// Reuse the existing lifecycle fixture without modifying its source or devices.
const repo = fileURLToPath(new URL('../../', import.meta.url));
const output = path.resolve(process.argv[2] ?? '.scratch/remote-projects/performance/owner/memory-diagnostic');
const rssStaircase = process.argv.includes('--rss-staircase');
const longSwitches = process.argv.includes('--long-switches');
if (rssStaircase && longSwitches) throw new Error('Long-switch profiling must not be confused with the unmodified RSS staircase');
await fs.mkdir(output, { recursive: false });
const original = await fs.readFile(path.join(repo, 'scripts/remote-hosts-memory.mjs'), 'utf8');
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const base = path.join(os.tmpdir(), 'opencode');
await fs.mkdir(base, { recursive: true });
const temporary = await fs.mkdtemp(path.join(base, 'performance-owner-profiler-'));
const replace = (source, before, after) => {
  assert.equal(source.split(before).length, 2, `Fixture instrumentation anchor changed: ${before}`);
  return source.replace(before, after);
};
let source = original.replaceAll("await import('../packages/", `await import('${pathToFileURL(path.join(repo, 'packages/')).href}`);
try {
  await fs.access(path.join(repo, 'packages/web/server/lib/remote-hosts/deadline.js'));
  source = replace(source, "['packages/web/server/index.js',", "['packages/web/server/lib/remote-hosts/deadline.js', 'packages/web/server/index.js',");
} catch (error) { if (error.code !== 'ENOENT') throw error; }
source = replace(source, 'new URL(`../${filename}`, import.meta.url)', `new URL(filename, ${JSON.stringify(pathToFileURL(`${repo}/`).href)})`);
if (!rssStaircase) {
source = replace(source, 'const loadedHashes = await hashes();', `
  const { Session } = await import('node:inspector/promises');
  const v8 = await import('node:v8');
  const { createHook } = await import('node:async_hooks');
  const remoteTimers = new Map();
  const timerAudit = createHook({
    init(id, type, triggerId, resource) {
      if (type !== 'Timeout') return;
      const stack = new Error().stack;
      if (!/remote-hosts|event-stream\\/upstream-reader/.test(stack)) return;
      remoteTimers.set(id, { id, triggerId, stack, resource: new WeakRef(resource) });
    },
    destroy(id) { remoteTimers.delete(id); },
  });
  timerAudit.enable();
  const profiler = new Session(); profiler.connect();
  await profiler.post('HeapProfiler.startSampling', { samplingInterval: 32768 });
  const allocationCheckpoint = async label => {
    if (label === 'switching-start') {
      await profiler.post('HeapProfiler.stopSampling');
      await profiler.post('HeapProfiler.startSampling', { samplingInterval: 32768 });
    }
    const profile = await profiler.post('HeapProfiler.getSamplingProfile');
    const resources = process.getActiveResourcesInfo().reduce((counts, type) => {
      counts[type] = (counts[type] || 0) + 1; return counts;
    }, {});
    await fs.writeFile(path.join(config.output, config.direction + '-' + label + '.allocations.json'),
      JSON.stringify({ label, atMs: performance.now(), memory: process.memoryUsage(),
        heapSpaces: v8.getHeapSpaceStatistics(), heap: v8.getHeapStatistics(), resources,
        remoteTimerAudit: [...remoteTimers.values()].map(({ resource, ...entry }) => ({ ...entry,
          refed: resource.deref()?.hasRef(), destroyed: resource.deref()?._destroyed })), ...profile }));
  };
  process.on('message', async message => {
    if (message?.kind !== 'allocation-checkpoint') return;
    try { await allocationCheckpoint(message.label); process.send({ kind: 'allocation-checkpoint-done', label: message.label }); }
    catch (error) { process.send({ kind: 'allocation-checkpoint-done', label: message.label, error: error.message }); }
  });
  const loadedHashes = await hashes();`);
source = replace(source, "child.send({ root, hosts: fixtures.map(f => f.descriptor), upstream:", "child.send({ root, output, direction, hosts: fixtures.map(f => f.descriptor), upstream:");
source = replace(source, "const window = async (name, demand, measured = true) => {", `
      const checkpoint = label => new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { child.off('message', receive); reject(new Error('Allocation checkpoint timeout')); }, 15000);
        const receive = message => {
          if (message.kind !== 'allocation-checkpoint-done' || message.label !== label) return;
          clearTimeout(timeout); child.off('message', receive);
          if (message.error) reject(new Error(message.error)); else resolve();
        };
        child.on('message', receive); child.send({ kind: 'allocation-checkpoint', label });
      });
      const window = async (name, demand, measured = true) => {`);
source = replace(source, 'round.windows.push(entry); write(', "if (name === 'switching-zero-after') await checkpoint(name); round.windows.push(entry); write(");
source = replace(source, '(quick ? 2 : 12)', '(quick ? 12 : 12)');
source = replace(source, "phase = 'repeated-switching';", "phase = 'repeated-switching'; await checkpoint('switching-start');");
source = replace(source, 'check(`switch cycle ${cycle + 1}', "await checkpoint(`cycle-${cycle + 1}`); check(`switch cycle ${cycle + 1}");
source = replace(source, 'round.switching = Object.fromEntries', `
      await sleep(20000); await checkpoint('switching-idle-20s');
      await sleep(40000); await checkpoint('switching-idle-60s');
       round.switching = Object.fromEntries`);
if (longSwitches) {
  assert.equal(source.split('await sleep(quick ? 50 : 750)').length, 3, 'Two switching delay anchors required');
  source = source.replaceAll('await sleep(quick ? 50 : 750)', 'await sleep(750)');
}
} else {
  source = replace(source, "child.send({ root, hosts: fixtures.map(f => f.descriptor), upstream:", "child.send({ root, output, direction, hosts: fixtures.map(f => f.descriptor), upstream:");
}
const runner = path.join(temporary, 'instrumented-memory.mjs');
await fs.writeFile(runner, source);
await fs.writeFile(path.join(output, 'instrumented-memory.mjs.txt'), source);
await fs.writeFile(path.join(output, 'instrumentation.json'), JSON.stringify({
  originalSha256: sha256(original), instrumentedSha256: sha256(source), wrapperSha256: sha256(await fs.readFile(fileURLToPath(import.meta.url))),
  classification: rssStaircase ? 'RSS staircase only; no inspector, allocation profiler or forced GC; production/source and scheduling eligibility must be checked separately' : 'allocation diagnostic only; profiler and concurrent platform work invalidate budget timing',
  command: process.argv, node: process.version, abi: process.versions.modules,
  os: `${os.platform()} ${os.release()} ${os.arch()}`, samplingInterval: 32768,
  forcedGC: false, retainedSamplesAreNotRSS: true, quickWindowsAreNotMemoryGate: !rssStaircase,
  rssStaircase, longSwitches, switchingDelayMs: longSwitches || rssStaircase ? 750 : 50,
  inspectorEnabled: !rssStaircase, samplePeriodMs: 250,
  settleMs: rssStaircase ? 5000 : 250, windowMs: rssStaircase ? 15000 : 1000,
}, null, 2));
const syntax = spawnSync(process.execPath, ['--check', runner], { encoding: 'utf8' });
assert.equal(syntax.status, 0, syntax.stderr);
if (process.argv.includes('--prepare-only')) {
  await fs.rm(temporary, { recursive: true, force: true });
  console.log('Instrumentation prepared and syntax checked; no Hub started.');
  process.exit(0);
}
if (rssStaircase && !process.argv.includes('--confirm-owner-window-released')) {
  await fs.rm(temporary, { recursive: true, force: true });
  throw new Error('RSS runtime sampling requires explicit owner window handoff; prepare-only is available without it');
}
const child = spawn(process.execPath, [runner, output, ...(rssStaircase ? [] : ['--quick'])], { cwd: repo, stdio: 'inherit', env: { ...process.env, NODE_OPTIONS: '' } });
const exitCode = await new Promise(resolve => child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0))));
await fs.rm(temporary, { recursive: true, force: true });
process.exitCode = exitCode;
