import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { platform, arch, release, cpus } from 'node:os';
import { createDataset, datasetHash } from './dataset.mjs';
import { gates, distribution, validateEvidence } from './gates.mjs';

const [action, ...args] = process.argv.slice(2);
const option = name => args.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const output = resolve(option('out') ?? '.scratch/remote-projects/performance');
mkdirSync(output, { recursive: true });
const save = (name, value) => writeFileSync(join(output, name), JSON.stringify(value, null, 2) + '\n');
const environment = { device: cpus()[0]?.model ?? arch(), os: `${platform()} ${release()} ${arch()}`, node: process.version };

if (action === 'dataset') {
  for (const localOnly of [false, true]) {
    const data = createDataset({ localOnly }); save(`${data.name}.json`, { ...data, sha256: datasetHash(data) });
  }
} else if (action === 'regressions') {
  const repo = resolve(option('repo') ?? '.');
  const files = [
    'components/session/sidebar/SidebarProjectsList.performance.test.tsx',
    'components/session/sidebar/SessionSidebar.actions.performance.test.tsx',
    'components/session/sidebar/hooks/useSessionSidebarSections.performance.test.tsx',
    'sync/session-transcript-sse.performance.test.js', 'components/chat/composerClosedPickers.test.tsx',
  ].map(f => `packages/ui/src/${f}`);
  const hash = createHash('sha256');
  for (const file of files) { hash.update(file); hash.update(readFileSync(join(repo, file))); }
  const phase = option('phase');
  if (!['baseline', 'candidate'].includes(phase)) throw new Error('--phase=baseline|candidate required');
  const startedAt = new Date().toISOString();
  const resultPath = join(output, `${phase}-regressions.json`);
  const command = ['x', 'vitest', 'run', '--project', '@yuriai/ui', ...files, '--reporter=json', `--outputFile=${resultPath}`];
  const result = spawnSync('bun', command, { cwd: repo, encoding: 'utf8', timeout: 180_000, maxBuffer: 16 * 1024 * 1024 });
  writeFileSync(join(output, `${phase}-regressions.log`), `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  save(`${phase}-regressions-environment.json`, { ...environment, phase, startedAt,
    command: `bun ${command.join(' ')}`, exitCode: result.status, sourceHash: hash.digest('hex'),
    build: option('build') ?? 'unrecorded', dataset: 'existing test fixtures, NOT L',
    note: 'Unit test durations are not UI interaction measurements; avatar gate separate.' });
  process.exitCode = result.status ?? 1;
} else if (action === 'report') {
  const records = args.filter(a => !a.startsWith('--')).flatMap(file => {
    const parsed = JSON.parse(readFileSync(file, 'utf8')); return Array.isArray(parsed) ? parsed : [parsed];
  });
  for (const record of records) {
    const errors = validateEvidence(record); if (errors.length) throw new Error(errors.join('; '));
  }
  save('gate-report.json', { schemaVersion: 1, generatedAt: new Date().toISOString(), environment,
    gates: gates.map(gate => ({ ...gate, status: 'unverified',
      evidence: records.filter(r => r.gate === gate.id).map(r => ({ ...r,
        distributions: Object.fromEntries(Object.entries(r.metrics ?? {}).map(([key, m]) => [key, { unit: m.unit, ...distribution(m.samples) }])) })),
      reason: 'Individual measurements do not establish full runtime/scenario coverage. Manual gate review required.' })),
  });
} else if (action === 'observe-http') {
  const origin = new URL(option('origin'));
  if (origin.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(origin.hostname) || !args.includes('--confirm-isolated-test')) {
    throw new Error('Only explicitly confirmed isolated loopback HTTP test origins allowed');
  }
  const path = option('path');
  if (!path?.startsWith('/') || path.startsWith('//')) throw new Error('--path=/... required');
  const count = Number(option('count') ?? 30);
  if (!Number.isInteger(count) || count < 20 || count > 1000) throw new Error('count must be 20..1000');
  const samples = [];
  const failures = [];
  for (let i = 0; i < count; i++) {
    const start = performance.now();
    try {
      const response = await fetch(new URL(path, origin), { signal: AbortSignal.timeout(35_000), redirect: 'error' });
      const body = await response.arrayBuffer();
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      samples.push({ durationMs: performance.now() - start, bytes: body.byteLength });
    } catch (error) { failures.push({ index: i, error: error.message }); }
  }
  save('http-observation.json', { ...environment, source: 'real HTTP complete-body duration',
    measurement: 'Diagnostic ONLY: not session-open visibility, RTT subtraction, nor a UI performance gate',
    path, attempted: count, failures, samples,
    distribution: samples.length ? distribution(samples.map(s => s.durationMs)) : null });
  if (failures.length) process.exitCode = 1;
} else {
  throw new Error('Usage: run.mjs dataset|regressions|report|observe-http [--out=directory]');
}
