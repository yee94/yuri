import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { distribution } from './gates.mjs';

export function analyzeTrace(trace) {
  const events = trace.traceEvents;
  if (!Array.isArray(events)) throw new Error('Expected Chromium JSON trace; do not treat Perfetto protobuf as empty success');
  const rendererPids = new Set(events.filter(e => e.ph === 'M' && e.name === 'process_name' && e.args?.name === 'Renderer').map(e => e.pid));
  const mainThreads = new Set(events.filter(e => rendererPids.has(e.pid) && e.ph === 'M' && e.name === 'thread_name' && e.args?.name === 'CrRendererMain').map(e => `${e.pid}:${e.tid}`));
  if (!mainThreads.size) throw new Error('No real Chromium renderer main thread identified');
  const onMain = events.filter(e => mainThreads.has(`${e.pid}:${e.tid}`) && e.ph === 'X' && Number.isFinite(e.dur));
  const tasks = onMain.filter(e => ['ThreadControllerImpl::RunTask', 'RunTask'].includes(e.name));
  if (!tasks.length) throw new Error('No top-level renderer tasks recorded');
  const dispatch = onMain.filter(e => e.name === 'EventDispatch' && ['input', 'beforeinput', 'keydown', 'paste', 'compositionupdate', 'compositionend'].includes(e.args?.data?.type));
  const containingTasks = new Set();
  for (const event of dispatch) {
    const containing = tasks.filter(t => t.pid === event.pid && t.tid === event.tid && t.ts <= event.ts && t.ts + t.dur >= event.ts + event.dur).sort((a, b) => a.dur - b.dur)[0];
    if (containing) containingTasks.add(containing);
  }
  return { schemaVersion: 1, rendererProcesses: [...rendererPids], rendererMainThreads: [...mainThreads],
    allRendererMainTaskMs: distribution(tasks.map(e => e.dur / 1000)),
    rendererMainTasksAtLeast50ms: tasks.filter(e => e.dur >= 50_000).map(e => ({ startUs: e.ts, durationMs: e.dur / 1000, pid: e.pid, tid: e.tid })),
    inputContainingTaskMs: containingTasks.size ? distribution([...containingTasks].map(e => e.dur / 1000)) : null,
    inputContainingTasksAtLeast50ms: [...containingTasks].filter(e => e.dur >= 50_000).length,
    eventDispatch: Object.fromEntries([...new Set(dispatch.map(e => e.args.data.type))].map(type => [type, distribution(dispatch.filter(e => e.args.data.type === type).map(e => e.dur / 1000))])),
    caveat: 'Top-level tasks include post-dispatch microtasks; input-containing is temporal containment, not causal attribution. All renderer-main tasks cover the recorded input interval only. GPU/worker tasks are excluded, not hidden as renderer long tasks. No input-to-paint value inferred.' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const input = process.argv[2];
  const output = process.argv[3] ?? path.join(path.dirname(input), 'input-trace-analysis.json');
  const report = analyzeTrace(JSON.parse(fs.readFileSync(input, 'utf8')));
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
