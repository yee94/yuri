import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import { distribution } from './gates.mjs';

const option = name => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
if (!process.argv.includes('--confirm-isolated-test')) throw new Error('Explicit isolated test process confirmation required');
const pid = Number(option('pid'));
const seconds = Number(option('seconds') ?? 300);
if (!Number.isInteger(pid) || pid < 2 || !Number.isInteger(seconds) || seconds < 1 || seconds > 900) throw new Error('Invalid pid/duration');
const read = () => {
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'pid=,time=,rss='], { encoding: 'utf8' });
  const match = result.stdout.trim().match(/^(\d+)\s+(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)\s+(\d+)$/);
  if (result.status !== 0 || !match) throw new Error('Target process exited or unsupported ps TIME output');
  return { monotonicMs: performance.now(), cpuSeconds: Number(match[2] ?? 0) * 3600 + Number(match[3]) * 60 + Number(match[4]), rssBytes: Number(match[5]) * 1024 };
};
const samples = [read()];
const deadline = performance.now() + seconds * 1000;
while (performance.now() < deadline) { await setTimeout(Math.min(1000, Math.max(1, deadline - performance.now()))); samples.push(read()); }
const first = samples[0], last = samples.at(-1);
const cpuPercent = (last.cpuSeconds - first.cpuSeconds) / ((last.monotonicMs - first.monotonicMs) / 1000) * 100;
writeFileSync(option('out') ?? '.scratch/remote-projects/performance/process-observation.json', JSON.stringify({
  schemaVersion: 1, pid, observedSeconds: (last.monotonicMs - first.monotonicMs) / 1000, cpuPercent,
  rssBytes: distribution(samples.map(s => s.rssBytes)), samples,
  warning: 'Process-only observation: no claim of host/timer/subscription coverage, causality or per-subscription memory. Pair with Hub/upstream resource counters and baseline deltas.',
}, null, 2) + '\n');
