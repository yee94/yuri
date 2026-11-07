import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { checkSyncCapture, type SyncCapture } from './sync-verdict';

// Opt-in offline replay of immutable, user-supplied local evidence. Never contacts a device/Host.
const resultsPath = process.env.NSH_HISTORY_SYNC_RAW_RESULTS;
it.skipIf(!resultsPath)('keeps all three real build5 releases invalid and identifies their missing persisted periodic post prefix', () => {
  const rows = JSON.parse(readFileSync(resultsPath!, 'utf8')) as { mode: string; capture: string }[];
  const holds = rows.filter(row => row.mode === 'hold'); expect(holds).toHaveLength(3);
  for (const row of holds) {
    const data = JSON.parse(readFileSync(row.capture + '/release-captures.json', 'utf8')) as SyncCapture;
    const result = checkSyncCapture(data, data.buildIdentity.executableSHA256, data.buildIdentity.bundleSHA256);
    expect(result.releases).toHaveLength(1);
    expect(result.releases[0]).toMatchObject({ verdict: 'invalid', reason: 'No periodic native post prefix in persisted snapshot', prefix: { periodicPostSamples: 0, explicitPostSamples: 1 } });
    const point = data.events.find(event => event.jsMeasure?.label === 'after-footer-sync-release')!.native!;
    expect(point.markers.find(marker => marker.id === 'terminal-footer')!.frame.height).toBe(0);
    expect(point.scrollViews.find(view => view.id === 'terminal-transcript')!.offsetY).toBeCloseTo(6.3333333333);
  }
});
