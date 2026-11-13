import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { distribution } from './gates.mjs';

export function summarizeRuns(document) {
  const startup = { sidebar: [], transcript: [] };
  const inputs = [];
  const failures = [];
  for (const run of document.runs) {
    if (run.raw.status !== 'measured') { failures.push({ index: run.index, reason: run.raw.reason }); continue; }
    for (const [, window] of run.raw.windows ?? []) {
      for (const kind of ['sidebar', 'transcript']) {
        if (window[kind] && !window[kind].emptyImage) startup[kind].push(window[kind].captureCompletedEpochMs - run.raw.launchEpochMs);
      }
      for (const [name, probe] of Object.entries(window.input?.scenarios ?? {})) {
        if (!probe.samples) { inputs.push({ scenario: name, status: 'blocked', reason: probe.reason }); continue; }
        const event = 'input';
        const samples = probe.samples.filter(s => s.event === event && (name !== 'undo' || s.inputType === 'historyUndo') && s.trusted && s.synchronousDispatchMs !== null);
        const dispatch = samples.map(s => s.synchronousDispatchMs);
        const nextFrame = samples.filter(s => s.nextAnimationFrameMs !== null).map(s => s.nextAnimationFrameMs);
        inputs.push({ scenario: name, event, samples: samples.length, missingWindowBubble: probe.samples.filter(s => s.event === event && s.synchronousDispatchMs === null).length,
          correctnessInteractions: probe.correctness?.length ?? 0,
          allEchoCaretFocusAssertionsPassed: Array.isArray(probe.correctness) && probe.correctness.length >= 50 && probe.correctness.every(c => c.focused && c.length === c.expectedLength && c.selectionStart === c.selectionEnd),
          synchronousDispatchMs: dispatch.length ? distribution(dispatch) : null,
          nextAnimationFrameMs: nextFrame.length ? distribution(nextFrame) : null,
          longTaskObserverSupported: probe.observer.longtask,
          observedLongTasks: probe.longTasks.length,
          maxObservedLongTaskMs: probe.longTasks.length ? Math.max(...probe.longTasks.map(t => t.duration)) : 0,
          inputTypes: Object.fromEntries([...new Set(samples.map(s => s.inputType))].map(type => [String(type), samples.filter(s => s.inputType === type).length])),
          rawArtifact: path.join(document.isolatedRoot, `cold-${run.index}`, `input-${name}.json`), traceArtifact: window.input.tracePath });
      }
    }
  }
  return { schemaVersion: 1, classification: document.classification ?? 'diagnostic', phase: document.phase, build: document.build, requestedColdStarts: document.requestedColdStarts,
    measuredColdStarts: document.runs.filter(r => r.raw.status === 'measured').length, failures,
    startup: Object.fromEntries(Object.entries(startup).map(([key, samples]) => [key, { samples, distributionMs: samples.length ? distribution(samples) : null, minimum20: samples.length >= 20 }])),
    inputs,
    gateStatus: { P0_2: 'unverified until matched candidate comparison; screenshot-completion upper bound, not exact first presentation', P2: 'unverified: baseline local small fixture, no 5-stream L/remote/system Chinese IME; raw trace requires attribution review' },
    limitations: [document.classification === 'budget' ? 'Budget classification requires externally scheduled quiescence; confirmation flag and load average are not automatic proof of exclusive load.' : 'This campaign ran while other implementation/build/test agents could be active; diagnostic only, not formal budget evidence.',
      'Cold means fresh Electron+Hub process and fresh isolated Chromium profile, not a reboot or OS page-cache purge.',
      'Real OpenCode external process is seeded and ready before the Electron launch clock; no credentials/providers/models copied.',
      'Unmodified Electron main/preload + Vite production assets; development shell channel with bundled protocol, not a signed installer.',
      'Startup captures include 50ms observer polling + real screenshot overhead.',
      'Use input rather than profiler/development helper timings; rAF is explicitly not actual input-to-paint.'] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const input = process.argv[2];
  const output = process.argv[3] ?? path.join(path.dirname(input), 'summary.json');
  const summary = summarizeRuns(JSON.parse(fs.readFileSync(input, 'utf8')));
  fs.writeFileSync(output, JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify({ output, measuredColdStarts: summary.measuredColdStarts, inputs: summary.inputs }, null, 2));
}
