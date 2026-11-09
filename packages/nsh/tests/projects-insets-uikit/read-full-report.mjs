import { readFileSync } from 'node:fs';
const [file, expectedBundle] = process.argv.slice(2);
if (!file || !expectedBundle) throw new Error('Usage: read-full-report.mjs report.json expected.bundle.id');
const report = JSON.parse(readFileSync(file, 'utf8'));
if (report.schema !== 2 || report.bundleID !== expectedBundle || !report.consumerMarkerMatches || report.observedConsumerMarker !== report.expectedConsumerMarker) throw new Error('Wrong bundle or ProjectsHome packed-source consumption unproven');
const snapshots = report.snapshots.map(snapshot => {
  const native = snapshot.nativeAtCoreResponse ?? snapshot.native, core = snapshot.coreResponse;
  if (!native.attached) return { sequence: snapshot.sequence, reason: snapshot.reason, attached: false };
  const nodes = new Map(native.hierarchy.map(row => [row.token, row]));
  const measurements = new Map((core?.measurements ?? []).map(row => [row.key, row.measurement]));
  const rows = native.anchors.map(anchor => {
    const node = nodes.get(anchor.structuralOwnerToken), event = core?.events?.[anchor.key], measurement = measurements.get(anchor.key);
    return { key: anchor.key, explicitAncestry: anchor.hostContainsRegistration && anchor.ownerContainsHost && anchor.chainToSurface?.[2]?.token === node?.token, publicIdentifier: node?.publicIdentifier, nativeFrame: node?.frame, windowRect: node?.windowRect, layoutEvent: event, publicMeasure: measurement,
      nativeMinusLayout: event && node ? { width: node.frame.width - event.size.width, x: node.frame.x - event.origin.x } : null };
  });
  return { sequence: snapshot.sequence, reason: snapshot.reason, nativeMs: snapshot.nativeMs, coreResponseNativeMs: snapshot.coreResponseNativeMs, timing: core ? 'nativeAtCoreResponse correlated with original ref/onLayout response; synchronous before snapshot also retained in report' : 'synchronous native-only snapshot; no core parity verdict', applicationActive: native.applicationActive, capacityExceeded: native.capacityExceeded, surface: native.surface, surfaceAncestorChain: native.surfaceAncestorChain, rows, scrolls: native.hierarchy.filter(row => row.isScrollView) };
});
console.log(JSON.stringify({ bundleID: report.bundleID, buildID: report.buildID, pid: report.pid, processNonce: report.processNonce, consumerMarker: report.observedConsumerMarker, snapshots }, null, 2));
if (!snapshots.some(row => row.applicationActive && !row.capacityExceeded && row.rows?.some(item => item.key === 'production-content' && item.layoutEvent && item.publicMeasure && item.explicitAncestry))) process.exitCode = 2;
