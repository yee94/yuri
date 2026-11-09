import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
const root = path.dirname(fileURLToPath(import.meta.url));
function frames(shift = 0) {
  return Array.from({ length: 301 }, (_, i) => ({ sequence: i + 1, nativeUptimeMs: i * 1000 / 60, readEndNativeMs: i * 1000 / 60 + .1,
    nodes: [0, 1, 2].map(n => ({ id: `history-copy-hp-000${n}`, instance: `native-${n}`, fullyVisible: true, frame: { y: n * 200 + (i === 150 ? shift : 0) } })),
    scrolls: [{ id: 'transcript', instance: 'native-list', frame: { y: 100, height: 700 }, offsetY: 0, contentHeight: 10000, tracking: false, dragging: false, decelerating: false }] }));
}
function check(sample: ReturnType<typeof frames>, changed = {}) {
  const input = { schema: 1, synthetic: true, overflow: false, host: { rejected: 0 }, frames: sample, events: [{ phase: 'mark', nativeUptimeMs: 1001, lastPeriodicSequence: 61, anchors: ['history-copy-hp-0000', 'history-copy-hp-0001', 'history-copy-hp-0002'] }, { phase: 'request', nativeUptimeMs: 1020, requestID: 17 }, { phase: 'history-response', nativeUptimeMs: 1021, requestID: 17, responseIDs: Array.from({ length: 20 }, (_, i) => 'hp-' + i.toString().padStart(4, '0')), complete: false }], ...changed };
  const script = `import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('history_check',sys.argv[1]); module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
try: print(json.dumps(module.native_verdict(json.load(sys.stdin),61,['history-copy-hp-0000','history-copy-hp-0001','history-copy-hp-0002'],17)))
except (ValueError,KeyError,StopIteration) as error: print(json.dumps({'geometry':'invalid','reason':str(error)}))`;
  const result = spawnSync('python3', ['-c', script, path.join(root, 'check.py')], { input: JSON.stringify(input), encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0); return JSON.parse(result.stdout);
}
it('goes red on a 53pt one-sample displacement, even if the final frame returns to baseline', () => {
  expect(check(frames(-53))).toMatchObject({ geometry: 'red', worstPt: 53 });
  expect(check(frames())).toMatchObject({ geometry: 'pass', original53pt: 'unresolved' });
});
it('rejects missing native coverage, source/viewport recycling, user motion and absent real page response', () => {
  const gap = frames().filter((_, i) => i < 100 || i > 104); expect(check(gap).geometry).toBe('invalid');
  const recycled = frames(); recycled[150].nodes[0].instance = 'different'; expect(check(recycled).geometry).toBe('invalid');
  const dragging = frames(); dragging[150].scrolls[0].tracking = true; expect(check(dragging).geometry).toBe('invalid');
  expect(check(frames(), { events: [] }).geometry).toBe('invalid');
  expect(check(frames(), { overflow: true }).geometry).toBe('invalid');
});
