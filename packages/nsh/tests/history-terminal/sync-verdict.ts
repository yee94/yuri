type Rect = { x: number; y: number; width: number; height: number };
export type SyncFrame = { nativeUptimeMs: number; sampleSequence?: number; observedCounters: string | null;
  markers: { id: string; frame: Rect }[];
  scrollViews: { id: string; frame: Rect; offsetY: number; tracking: boolean; dragging: boolean; decelerating: boolean }[] };
type Hold = { scope: string; minHeight: number; releases: number; gesture?: boolean };
type Journal = { phase: string; revision: number; releaseMode?: string; releaseID?: number; eventOffsetY?: number; footerHold?: Hold;
  timeline?: { eventAt: number; releaseStart: number; releaseReturned: number; released: boolean; before: Hold; after: Hold } };
export type SyncCapture = { schema: number; continuous: boolean; buildIdentity: { executableSHA256: string; bundleSHA256: string }; frames: SyncFrame[];
  events: { js?: Journal; jsMeasure?: { label: string; revision: number }; native?: SyncFrame;
    nativeReceivedUptimeMs?: number; cachedPre?: { valid: boolean; lastSampleSequence: number; receiptAgeMs: number; source: string } }[] };
type Verdict = { verdict: 'invalid' | 'red' | 'within-continuous-native-window'; reason: string; worstPt?: number; preSamples?: number; postSamples?: number; clippedAnchors?: string[] };
const counters = (frame: SyncFrame) => { try { return JSON.parse(frame.observedCounters ?? '{}') as { revision: number; releaseMode?: string; footerHold?: Hold }; } catch { return undefined; } };
const scroll = (frame: SyncFrame) => frame.scrollViews.find(view => view.id === 'terminal-transcript');
const invalid = (reason: string): Verdict => ({ verdict: 'invalid', reason });

function windowVerdict(baseline: SyncFrame, pre: SyncFrame[], post: SyncFrame[], scope: string, releaseOffset?: number): Verdict {
  if (pre.length < 12 || baseline.nativeUptimeMs - pre[0]!.nativeUptimeMs < 250) return invalid('Missing continuous 250ms native pre-window');
  if (post.length < 180 || post.at(-1)!.nativeUptimeMs - baseline.nativeUptimeMs < 3000) return invalid('Need >=180 actual post samples spanning >=3 seconds');
  const ordered = [...pre, baseline, ...post].sort((a, b) => a.nativeUptimeMs - b.nativeUptimeMs).filter((frame, index, all) => !index || frame.nativeUptimeMs !== all[index - 1]!.nativeUptimeMs);
  for (let i = 1; i < ordered.length; i++) if (ordered[i]!.nativeUptimeMs - ordered[i - 1]!.nativeUptimeMs > 50) return invalid('Native sample gap exceeds 50ms across the observation window');
  const viewport = scroll(baseline);
  if (!viewport || !Number.isFinite(viewport.offsetY) || !Object.values(viewport.frame).every(Number.isFinite)) return invalid('Missing/nonfinite native transcript');
  if (releaseOffset !== undefined && Math.abs(viewport.offsetY - releaseOffset) > 0.5) return invalid('Cached pre frame is not at the real onScrollEnd offset');
  const anchors = baseline.markers.filter(marker => marker.id.startsWith('terminal-marker-') && marker.frame.y < viewport.frame.y + viewport.frame.height && marker.frame.y + marker.frame.height > viewport.frame.y).slice(0, 3);
  if (anchors.length !== 3 || new Set(anchors.map(anchor => anchor.id)).size !== 3 || anchors.some(anchor => !Object.values(anchor.frame).every(Number.isFinite))) return invalid('Need three distinct finite visible native anchors');
  const clippedAnchors = anchors.filter(anchor => anchor.frame.y < viewport.frame.y || anchor.frame.y + anchor.frame.height > viewport.frame.y + viewport.frame.height).map(anchor => anchor.id);
  let worstPt = 0;
  for (const frame of [...pre, ...post]) {
    const view = scroll(frame), state = counters(frame);
    if (!view || state?.footerHold?.scope !== scope || state.releaseMode !== 'sync') return invalid('Native scope/mode mismatch');
    if (releaseOffset === undefined || frame.nativeUptimeMs > baseline.nativeUptimeMs) {
      if (view.dragging || view.tracking || view.decelerating) return invalid('Post/commit native viewport is not idle');
    } else if (view.decelerating || Math.abs(view.offsetY - releaseOffset) > 0.5) return invalid('Release pre-window is not stationary at the end-event offset');
    for (const anchor of anchors) {
      const matches = frame.markers.filter(marker => marker.id === anchor.id);
      if (matches.length !== 1 || !Number.isFinite(matches[0]!.frame.y)) return invalid('Missing/duplicate/nonfinite native anchor');
      worstPt = Math.max(worstPt, Math.abs(matches[0]!.frame.y - anchor.frame.y));
    }
  }
  return { verdict: worstPt > 1.1 ? 'red' : 'within-continuous-native-window', reason: 'Native window only; video gaps/transients and production 53pt remain separate',
    worstPt, preSamples: pre.length, postSamples: post.length, clippedAnchors };
}

/** Fail closed on missing native pre frames, build identity, mode, or same-stack release timeline. */
export function checkSyncCapture(data: SyncCapture, executableSHA256: string, bundleSHA256: string) {
  const identity = data.schema === 2 && data.continuous && /^[a-f0-9]{64}$/.test(executableSHA256) && /^[a-f0-9]{64}$/.test(bundleSHA256)
    && data.buildIdentity?.executableSHA256 === executableSHA256 && data.buildIdentity.bundleSHA256 === bundleSHA256;
  const frames = data.frames;
  const sampleOrder = frames.every((frame, index) => Number.isFinite(frame.nativeUptimeMs) && (!index || frame.nativeUptimeMs > frames[index - 1]!.nativeUptimeMs));
  const preFor = (baseline: SyncFrame) => frames.filter(frame => frame.nativeUptimeMs <= baseline.nativeUptimeMs && frame.nativeUptimeMs >= baseline.nativeUptimeMs - 320);
  const postFor = (baseline: SyncFrame) => frames.filter(frame => frame.nativeUptimeMs > baseline.nativeUptimeMs && frame.nativeUptimeMs <= baseline.nativeUptimeMs + 4000);
  const commits = data.events.filter(event => event.js?.phase === 'after-js-commit').map(event => {
    if (!identity || !sampleOrder) return invalid('Build/schema/continuous mode or native sample order mismatch');
    const before = data.events.filter(item => item.jsMeasure?.label === 'before-js-commit' && item.jsMeasure.revision < event.js!.revision).at(-1);
    if (!before?.native) return invalid('Missing explicit commit baseline');
    const state = counters(before.native);
    if (state?.revision !== before.jsMeasure?.revision || !state?.footerHold?.scope) return invalid('Commit baseline did not observe the expected authority');
    return windowVerdict(before.native, preFor(before.native), postFor(before.native), state.footerHold.scope);
  });
  const releases = data.events.filter(event => event.js?.phase === 'footer-sync-after-release' && event.js.timeline?.released).map(event => {
    const js = event.js!, timeline = js.timeline!;
    if (!identity || !sampleOrder || js.releaseMode !== 'sync') return { ...invalid('Build/schema/mode or native sample order mismatch'), timeline };
    if (![timeline.eventAt, timeline.releaseStart, timeline.releaseReturned].every(Number.isFinite) || timeline.eventAt > timeline.releaseStart || timeline.releaseStart > timeline.releaseReturned || timeline.after.releases !== timeline.before.releases + 1 || timeline.after.minHeight !== 0) return { ...invalid('Invalid actual same-stack release timestamp bracket'), timeline };
    const before = data.events.find(item => item.js?.phase === 'footer-sync-before-release' && item.js.releaseID === js.releaseID);
    const cached = before?.cachedPre, baseline = frames.find(frame => frame.sampleSequence === cached?.lastSampleSequence);
    if (!cached?.valid || cached.source !== 'existing-display-link-ring' || !baseline || cached.receiptAgeMs < 0 || cached.receiptAgeMs > 50 || before?.js?.eventOffsetY === undefined) return { ...invalid('Missing/freshness-invalid cached continuous native pre sample'), timeline };
    const hold = counters(baseline)?.footerHold;
    if (!hold?.scope || hold.scope !== timeline.before.scope || hold.minHeight !== timeline.before.minHeight || hold.releases !== timeline.before.releases || hold.minHeight <= 0 || !timeline.before.gesture) return { ...invalid('Cached pre footprint/scope/gesture mismatch'), timeline };
    const nativeFooter = baseline.markers.filter(marker => marker.id === 'terminal-footer');
    if (nativeFooter.length !== 1 || !Number.isFinite(nativeFooter[0]!.frame.height) || Math.abs(nativeFooter[0]!.frame.height - hold.minHeight) > 1.1) return { ...invalid('Cached pre does not contain the actual retained native footprint'), timeline };
    const natural = baseline.markers.filter(marker => marker.id === 'terminal-footer-natural');
    if (natural.length !== 1 || !Number.isFinite(natural[0]!.frame.height) || natural[0]!.frame.height > 1.1) return { ...invalid('Hidden natural content is missing or polluted by held minHeight'), timeline };
    const tracking = frames.filter(frame => frame.nativeUptimeMs <= baseline.nativeUptimeMs && frame.nativeUptimeMs >= baseline.nativeUptimeMs - 2000 && counters(frame)?.footerHold?.scope === hold.scope && (scroll(frame)?.tracking || scroll(frame)?.dragging));
    const offsets = tracking.map(frame => scroll(frame)!.offsetY);
    if (tracking.length < 2 || !offsets.every(Number.isFinite) || Math.max(...offsets) - Math.min(...offsets) < 1) return { ...invalid('No native tracking/moving user release gesture'), timeline };
    const after = postFor(baseline);
    const prefix = { baselineNativeMs: baseline.nativeUptimeMs, postCutoffNativeMs: baseline.nativeUptimeMs + 4000,
      lastPeriodicNativeMs: frames.at(-1)?.nativeUptimeMs, periodicPostSamples: after.length,
      explicitPostSamples: data.events.filter(item => item.native && item.native.nativeUptimeMs > baseline.nativeUptimeMs && item.native.nativeUptimeMs <= baseline.nativeUptimeMs + 4000).length };
    if (!after.length) return { ...invalid('No periodic native post prefix in persisted snapshot'), prefix, timeline };
    const observedReleased = after.some(frame => { const next = counters(frame)?.footerHold; return next?.releases === timeline.after.releases && next.minHeight === 0; });
    if (!observedReleased) return { ...invalid('No native observed release'), prefix, timeline };
    if (after.some(frame => counters(frame)?.footerHold?.releases === timeline.after.releases && frame.markers.some(marker => marker.id === 'terminal-footer' && marker.frame.height > 1.1))) return { ...invalid('Native footer has not actually collapsed after the release counter'), timeline };
    return { ...windowVerdict(baseline, preFor(baseline), after, hold.scope, before.js.eventOffsetY), prefix, timeline,
      nativeBeforeReceiptMs: before.nativeReceivedUptimeMs, nativeAfterReceiptMs: event.nativeReceivedUptimeMs,
      nativeTrackingSamples: tracking.length,
      prePolicy: 'stationary at end-event offset; may still track the finger, not falsely labelled idle' };
  });
  return { commits, releases, note: 'No video or production verdict; JS actual release is bracketed by releaseStart/releaseReturned, never equated with native receipt time.' };
}
