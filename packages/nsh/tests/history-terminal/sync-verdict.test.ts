import { expect, it } from 'vitest';
import { checkSyncCapture, type SyncCapture, type SyncFrame } from './sync-verdict';

const sha = 'a'.repeat(64);
const bundle = 'c'.repeat(64);
function sample(t: number, released = false): SyncFrame {
  return { nativeUptimeMs: t, sampleSequence: t, observedCounters: JSON.stringify({ revision: t < 1000 ? 2 : 3, releaseMode: 'sync', footerHold: { scope: 'fixture', minHeight: released ? 0 : 36, releases: Number(released) } }),
    markers: [...[0, 1, 2].map(i => ({ id: `terminal-marker-${i}`, frame: { x: 0, y: 20 + i * 30, width: 100, height: 14 } })),
      { id: 'terminal-footer', frame: { x: 0, y: 0, width: 200, height: released ? 0 : 36 } },
      { id: 'terminal-footer-natural', frame: { x: 0, y: 0, width: 200, height: 0 } }],
    scrollViews: [{ id: 'terminal-transcript', frame: { x: 0, y: 0, width: 200, height: 200 }, offsetY: released ? 6 : 42, tracking: false, dragging: false, decelerating: false }] };
}
function capture(): SyncCapture {
  const frames = Array.from({ length: 720 }, (_, i) => {
    const t = i * 16, frame = sample(t, t > 7000);
    if (t >= 6000 && t < 7000) {
      const offset = Math.min(42, (t - 6000) / 500 * 42);
      frame.scrollViews[0]!.tracking = true; frame.scrollViews[0]!.offsetY = offset;
      frame.markers.filter(marker => marker.id.startsWith('terminal-marker-')).forEach(marker => { marker.frame.y -= offset - 42; });
    }
    return frame;
  });
  const before = { scope: 'fixture', minHeight: 36, releases: 0, gesture: true }, after = { scope: 'fixture', minHeight: 0, releases: 1 };
  return { schema: 2, continuous: true, buildIdentity: { executableSHA256: sha, bundleSHA256: bundle }, frames, events: [
    { jsMeasure: { label: 'before-js-commit', revision: 2 }, native: sample(999) },
    { js: { phase: 'after-js-commit', revision: 3 } },
    { js: { phase: 'footer-sync-before-release', revision: 3, releaseID: 1, releaseMode: 'sync', eventOffsetY: 42 }, nativeReceivedUptimeMs: 7004,
      cachedPre: { valid: true, source: 'existing-display-link-ring', lastSampleSequence: 6992, receiptAgeMs: 12 } },
    { js: { phase: 'footer-sync-after-release', revision: 3, releaseID: 1, releaseMode: 'sync', timeline: { eventAt: 10, releaseStart: 11, releaseReturned: 12, released: true, before, after } }, nativeReceivedUptimeMs: 7005 },
  ] };
}
it('accepts only a continuous native pre/post window with explicit same-stack release and matching binary hash', () => {
  const result = checkSyncCapture(capture(), sha, bundle);
  expect(result.commits[0]?.verdict).toBe('within-continuous-native-window');
  expect(result.releases[0]).toMatchObject({ verdict: 'within-continuous-native-window', worstPt: 0 });
});
it('is red on a single observed native transient even when final markers return', () => {
  const data = capture(); data.frames[490]!.markers[1]!.frame.y += 36;
  expect(checkSyncCapture(data, sha, bundle).releases[0]).toMatchObject({ verdict: 'red', worstPt: 36 });
});
it('diagnoses a copied pre-only snapshot without promoting an explicit released endpoint into periodic post evidence', () => {
  const data = capture();
  data.frames = data.frames.filter(frame => frame.nativeUptimeMs <= 6992);
  data.events.push({ jsMeasure: { label: 'after-footer-sync-release', revision: 3 }, native: sample(7006, true) });
  expect(checkSyncCapture(data, sha, bundle).releases[0]).toMatchObject({
    verdict: 'invalid', reason: 'No periodic native post prefix in persisted snapshot',
    prefix: { lastPeriodicNativeMs: 6992, periodicPostSamples: 0, explicitPostSamples: 1 },
  });
});
it.each(['gap', 'pre-missing', 'old-build', 'old-bundle', 'diagnostic', 'wrong-offset', 'scope', 'nonmonotonic', 'no-native-gesture', 'no-footprint'] as const)('rejects %s instead of manufacturing green', reason => {
  const data = capture(); let expected = sha;
  if (reason === 'gap') data.frames.splice(490, 5);
  if (reason === 'pre-missing') data.frames = data.frames.filter(frame => frame.nativeUptimeMs >= 6960);
  if (reason === 'old-build') expected = 'b'.repeat(64);
  if (reason === 'old-bundle') data.buildIdentity.bundleSHA256 = 'd'.repeat(64);
  if (reason === 'diagnostic') data.events.at(-1)!.js!.releaseMode = 'diagnostic';
  if (reason === 'wrong-offset') data.events[2]!.js!.eventOffsetY = 44;
  if (reason === 'scope') data.frames[490]!.observedCounters = '{}';
  if (reason === 'nonmonotonic') data.frames[91]!.nativeUptimeMs = data.frames[90]!.nativeUptimeMs;
  if (reason === 'no-native-gesture') data.frames.forEach(frame => { frame.scrollViews[0]!.tracking = false; });
  if (reason === 'no-footprint') data.frames.forEach(frame => { frame.markers = frame.markers.filter(marker => marker.id !== 'terminal-footer'); });
  expect(checkSyncCapture(data, expected, bundle).releases[0]?.verdict).toBe('invalid');
});
