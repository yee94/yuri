export type NativeFrame = {
  nativeUptimeMs: number;
  observedCounters: string | null;
  markers: { id: string; frame: { x: number; y: number; width: number; height: number } }[];
  scrollViews: { dragging: boolean; tracking: boolean; decelerating: boolean }[];
};
export type ReadingVerdict = { verdict: 'invalid' | 'red' | 'within-sampled-window'; reason: string; worstPt?: number; samples?: number };

/** Geometry is native UIKit-only. Missing samples/identity/idle state never become green. */
export function readingVerdict(before: NativeFrame, after: NativeFrame[], minimumSamples = 30): ReadingVerdict {
  const anchors = before.markers.filter(marker => marker.id.startsWith('terminal-marker-'));
  if (anchors.length < 3) return { verdict: 'invalid', reason: 'Need three pre-commit UIKit markers' };
  const selected = anchors.slice(0, 3);
  const frames = [before, ...after];
  let previous = -Infinity, worstPt = 0;
  for (const frame of frames) {
    if (!Number.isFinite(frame.nativeUptimeMs) || frame.nativeUptimeMs <= previous) return { verdict: 'invalid', reason: 'Native clock is not strictly monotonic' };
    previous = frame.nativeUptimeMs;
    if (!frame.scrollViews.length || frame.scrollViews.some(view => view.dragging || view.tracking || view.decelerating)) return { verdict: 'invalid', reason: 'No released, idle native scroll viewport' };
    for (const anchor of selected) {
      const candidates = frame.markers.filter(marker => marker.id === anchor.id);
      if (candidates.length !== 1 || !Number.isFinite(candidates[0]!.frame.y)) return { verdict: 'invalid', reason: `Missing/duplicate native marker ${anchor.id}` };
      worstPt = Math.max(worstPt, Math.abs(candidates[0]!.frame.y - anchor.frame.y));
    }
  }
  if (worstPt > 1.1) return { verdict: 'red', reason: 'Released reading marker exceeds 1.1pt', worstPt, samples: after.length };
  if (after.length < minimumSamples) return { verdict: 'invalid', reason: 'Too few actual native samples', worstPt, samples: after.length };
  return { verdict: 'within-sampled-window', reason: 'Not a video/transient or real-Host acceptance', worstPt, samples: after.length };
}
