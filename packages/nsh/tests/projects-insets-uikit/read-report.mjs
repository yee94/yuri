import { readFileSync } from 'node:fs';

const [filename, expectedBundle] = process.argv.slice(2);
if (!filename || !expectedBundle) throw new Error('Usage: read-report.mjs report.json expected.bundle.id');
const report = JSON.parse(readFileSync(filename, 'utf8')), snapshot = report.snapshots?.at(-1);
if (!snapshot || snapshot.bundleID !== expectedBundle || !snapshot.buildID || !snapshot.applicationActive || snapshot.capacityExceeded || snapshot.errors?.length || snapshot.core?.error) throw new Error('Wrong/inactive/incomplete/errored capture; do not accept geometry');
const nodes = new Map(snapshot.hierarchy.map(node => [node.token, node]));
const measurements = new Map((snapshot.core.measurements ?? []).map(entry => [entry.key, entry.measurement]));
const rows = snapshot.anchors.map(anchor => {
  const node = nodes.get(anchor.structuralOwnerToken), event = snapshot.core.events?.[anchor.key], measurement = measurements.get(anchor.key);
  const chain = anchor.chainToSurface;
  const structural = anchor.hostContainsRegistration && anchor.ownerContainsHost && chain?.[2]?.token === node?.token && chain.at(-1)?.isSurface;
  const layout = event && node ? { width: node.frame.width - event.size.width, height: node.frame.height - event.size.height, x: node.frame.x - event.origin.x, y: node.frame.y - event.origin.y } : null;
  return { key: anchor.key, structuralBinding: structural ? 'explicit component ancestry' : 'INCONCLUSIVE', publicIdentifier: node?.publicIdentifier, windowRect: node?.windowRect, nativeFrame: node?.frame, nativeBounds: node?.bounds, layoutEvent: event, publicMeasure: measurement, nativeMinusLayout: layout };
});
console.log(JSON.stringify({ buildID: snapshot.buildID, bundleID: snapshot.bundleID, pid: snapshot.pid, mode: snapshot.mode, surface: snapshot.surface, rows, scrolls: snapshot.hierarchy.filter(node => node.isScrollView) }, null, 2));
if (!rows.length || rows.some(row => row.structuralBinding === 'INCONCLUSIVE' || !row.layoutEvent || !row.publicMeasure)) process.exitCode = 2;
