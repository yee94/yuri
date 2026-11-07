import { readFileSync } from 'node:fs';
import { readingVerdict, type NativeFrame } from './verdict';

// Main-only offline feedback loop. This script does not start an engine or connect to a device.
const file = process.argv[2];
if (!file) throw new Error('Usage: bun packages/nsh/tests/history-terminal/check-capture.ts captures.json [--release]');
const releaseOnly = process.argv.includes('--release');
const data = JSON.parse(readFileSync(file, 'utf8')) as {
  events: { js?: { phase: string; revision: number; state: { adopted: number; messageCount: number; messageIDs: string[]; cursor: string | null; more: boolean; loading: boolean } };
    jsMeasure?: { label: string; revision: number; footerHold?: { minHeight: number; releases: number } }; native?: NativeFrame }[];
  frames: NativeFrame[];
};
const commits = data.events.filter(event => event.js?.phase === 'after-js-commit');
const results = commits.map(event => {
  const commit = event.js!;
  const captured = data.events.filter(candidate => candidate.jsMeasure?.label === 'before-js-commit' && candidate.jsMeasure.revision < commit.revision && candidate.native).at(-1);
  const baseline = captured?.native;
  if (!baseline) return { revision: commit.revision, verdict: 'invalid', reason: 'No explicit native pre-commit capture' };
  let observedRevision: number | undefined;
  try { observedRevision = JSON.parse(baseline.observedCounters ?? '{}').revision; } catch { /* Invalid native counters cannot prove a baseline. */ }
  if (observedRevision !== captured?.jsMeasure?.revision) return { revision: commit.revision, verdict: 'invalid', reason: 'Native pre-commit counters did not yet reflect the captured JS revision' };
  const after = data.frames.filter(frame => {
    if (frame.nativeUptimeMs <= baseline.nativeUptimeMs || !frame.observedCounters) return false;
    try { return JSON.parse(frame.observedCounters).revision === commit.revision; } catch { return false; }
  });
  return { revision: commit.revision, adopted: commit.state.adopted, authority: commit.state, ...readingVerdict(baseline, after) };
});
const releaseResults = data.events.filter(event => event.jsMeasure?.label === 'before-footer-release' && event.native).map(event => {
  const baseline = event.native!, hold = event.jsMeasure!.footerHold;
  if (!hold || hold.minHeight <= 0) return { verdict: 'invalid', reason: 'No measured pre-release footprint' };
  let nativeHold: { minHeight?: number; releases?: number } | undefined;
  try { nativeHold = JSON.parse(baseline.observedCounters ?? '{}').footerHold; } catch { /* Fail closed below. */ }
  if (nativeHold?.minHeight !== hold.minHeight || nativeHold.releases !== hold.releases) return { verdict: 'invalid', reason: 'Native counters did not yet observe the retained footprint' };
  const after = data.frames.filter(frame => {
    if (frame.nativeUptimeMs <= baseline.nativeUptimeMs || !frame.observedCounters) return false;
    try {
      const next = JSON.parse(frame.observedCounters).footerHold;
      return next?.releases === hold.releases + 1 && next.minHeight === 0;
    } catch { return false; }
  });
  return { retainedPt: hold.minHeight, ...readingVerdict(baseline, after) };
});
console.log(JSON.stringify({ results: releaseOnly ? [] : results, releaseResults,
  note: 'Synthetic native sample verdict only. Video coverage and real Host acceptance remain separate. Use --release for the separately captured idle release window.' }, null, 2));
const selected = releaseOnly ? releaseResults : results;
process.exitCode = selected.length && selected.every(result => result.verdict === 'within-sampled-window') ? 0 : 1;
