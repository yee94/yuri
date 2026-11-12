import fs from 'node:fs/promises';
import path from 'node:path';
import { distribution } from './gates.mjs';

const directory = path.resolve(process.argv[2]);
const result = JSON.parse(await fs.readFile(path.join(directory, 'result.json'), 'utf8'));
const raw = (await fs.readFile(path.join(directory, 'samples.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
const profile = JSON.parse(await fs.readFile(path.join(directory, 'hub.cpuprofile'), 'utf8'));
const byId = new Map(profile.nodes.map(node => [node.id, node]));
const sampledUs = new Map();
for (let i = 0; i < profile.samples.length; i++) {
  const id = profile.samples[i]; sampledUs.set(id, (sampledUs.get(id) ?? 0) + profile.timeDeltas[i]);
}
const cpuSamples = [...sampledUs].map(([id, selfUs]) => {
  const frame = byId.get(id).callFrame;
  return { functionName: frame.functionName, url: frame.url.replace(/^.*\/(packages|scripts|node_modules)\//, '$1/'), line: frame.lineNumber + 1, selfUs };
}).sort((a, b) => b.selfUs - a.selfUs);
const perHost = Object.fromEntries(Object.entries(result.baseline.perHost).map(([host, baseline]) => {
  const fault = result.fault.perHost[host];
  return [host, { baseline, fault,
    requestP95RegressionPercent: 100 * (fault.requestMs.p95 / baseline.requestMs.p95 - 1),
    refreshP95RegressionPercent: 100 * (fault.indexFreshnessMs.p95 / baseline.indexFreshnessMs.p95 - 1) }];
}));
const eventLoop = Object.fromEntries(['baseline-30s', 'fault-host-0-stalled-30s'].map(phase => {
  const samples = raw.filter(item => item.kind === 'sample' && item.phase === phase);
  const metrics = {};
  for (const key of ['maxMs', 'p95Ms', 'meanMs']) {
    const values = samples.map(sample => sample.eventLoopDiagnostic?.[key]);
    metrics[key] = { totalSamples: samples.length, invalidSamples: values.filter(value => !Number.isFinite(value)).length,
      distribution: values.every(Number.isFinite) && values.length ? distribution(values) : null };
  }
  return [phase, metrics];
}));
const allHostsBelow10Percent = Object.values(perHost).every(host => host.requestP95RegressionPercent <= 10 && host.refreshP95RegressionPercent <= 10);
const report = { classification: 'diagnostic; no quiescent scheduling proof and source server is not a production package; no gate pass inferred',
  resultPassed: result.passed, sourceChangedDuringRun: result.sourceChangedDuringRun,
  mergedP95Regression: result.p95Regression, allHostsBelow10Percent, perHost,
  refreshConcurrency: result.refreshConcurrency, eventLoop, cpuSamples,
  totalProfileUs: profile.endTime - profile.startTime,
  note: 'CPU sampling self time is profiler evidence, not benchmark improvement. Event-loop delays cannot establish kernel scheduling attribution or renderer paint.' };
await fs.writeFile(path.join(directory, 'fault-analysis.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, cpuSamples: cpuSamples.slice(0, 15) }, null, 2));
