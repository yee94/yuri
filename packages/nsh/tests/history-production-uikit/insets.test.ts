import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { stageHistoryProduction } from './build.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));

it('preserves eight inset Double bit patterns through the real freeze/codec and independent reader, and reports isolated value cost', () => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'history-insets-'));
  try {
    const geometry = readFileSync(path.join(root, 'v4/TypedGeometry.swift'), 'utf8');
    const helper = geometry.match(/    static func insets\(_ value: UIEdgeInsets\) -> \[String: Double\] \{\n[^\n]*\n    \}/)![0];
    const source = `import Foundation
struct UIEdgeInsets { let top: CGFloat; let left: CGFloat; let bottom: CGFloat; let right: CGFloat }
@MainActor enum Insets { ${helper} }
@main struct Probe {
 @MainActor static func main() throws {
  let bits: [UInt64] = [0x8000000000000000, 0x7ff8000000000042, 0x7ff0000000000000, 0xfff0000000000000, 0x3ff4000000000000, 0xc04a800000000000, 0x0000000000000001, 0x7ff8000000000053]
  let values = bits.map { CGFloat(Double(bitPattern: $0)) }
  let a = Insets.insets(UIEdgeInsets(top: values[0], left: values[1], bottom: values[2], right: values[3]))
  let b = Insets.insets(UIEdgeInsets(top: values[4], left: values[5], bottom: values[6], right: values[7]))
  let original: [String: Any] = ["offsetY": -53.0, "contentHeight": 800.0, "pan": ["state": 0]]
  var augmented = original
  augmented["contentInset"] = a; augmented["adjustedContentInset"] = b
  augmented["readStartNativeMs"] = 100.0; augmented["readEndNativeMs"] = 101.0
  let old = try HistorySnapshotValue.freeze(original), new = try HistorySnapshotValue.freeze(augmented)
  for (key, value) in old.object! { precondition(new[key] == value) }
  let frame: HistorySnapshotValue = .object(["ordinal": .integer(1), "kind": .string("frame"), "sequence": .integer(1),
    "value": .object(["sequence": .integer(1), "scrolls": .array([new]), "windowObservation": .object(["sequence": .integer(1)]),
      "diagnosticIdentity": .object(["observationKind": .string("periodic"), "windowObservationRef": .integer(1)])])])
  let control: HistorySnapshotValue = .object(["kind": .string("control"), "value": .object(["result": .object(["windowObservation": .object(["liveProtection": .object(["outerTranscript": new])])])])])
  var data = Data(); HistorySnapshotValue.array([frame, control]).encode(into: &data)
  try data.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
  var oldSamples: [Double] = [], newSamples: [Double] = [], sink = 0
  for index in 0..<2000 {
    for variant in (index % 2 == 0 ? [false, true] : [true, false]) {
      let start = ProcessInfo.processInfo.systemUptime
      let frozen = try HistorySnapshotValue.freeze(variant ? augmented : original)
      var encoded = Data(); frozen.encode(into: &encoded); sink += encoded.count
      let elapsed = (ProcessInfo.processInfo.systemUptime - start) * 1000000
      if variant { newSamples.append(elapsed) } else { oldSamples.append(elapsed) }
    }
  }
  oldSamples.sort(); newSamples.sort()
  let report: [String: Any] = ["scope": "macOS pure-value freeze+encode microbenchmark; no UIKit getter/frame acceptance", "iterationsPerVariant": 2000,
    "oldWireBytes": try old.wireByteCount(), "newWireBytes": try new.wireByteCount(), "addedWireBytes": try new.wireByteCount() - old.wireByteCount(),
    "addedAllocationBudget": new.allocationBudget - old.allocationBudget,
    "oldMedianUs": oldSamples[1000], "newMedianUs": newSamples[1000], "oldP95Us": oldSamples[1900], "newP95Us": newSamples[1900], "sink": sink]
  print(String(data: try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]), encoding: .utf8)!)
 }
}
`;
    writeFileSync(path.join(temporary, 'Probe.swift'), source);
    const compiled = spawnSync('xcrun', ['--sdk', 'macosx', 'swiftc', '-O', '-swift-version', '6', '-parse-as-library', path.join(root, 'v4/SnapshotValue.swift'), path.join(temporary, 'Probe.swift'), '-o', path.join(temporary, 'probe')], { encoding: 'utf8', timeout: 110000 });
    expect(compiled.status, compiled.stderr).toBe(0);
    const run = spawnSync(path.join(temporary, 'probe'), [path.join(temporary, 'values.tlv')], { encoding: 'utf8', timeout: 20000 });
    expect(run.status, run.stderr).toBe(0);
    console.log('INSET_VALUE_COST ' + run.stdout.trim());
    const checked = spawnSync('python3', ['-c', `import importlib.util,io,sys
s=importlib.util.spec_from_file_location('reader',sys.argv[1]);r=importlib.util.module_from_spec(s);sys.modules[s.name]=r;s.loader.exec_module(r)
records=r.decode(io.BytesIO(open(sys.argv[2],'rb').read()))
expected=[0x8000000000000000,0x7ff8000000000042,0x7ff0000000000000,0xfff0000000000000,0x3ff4000000000000,0xc04a800000000000,1,0x7ff8000000000053]
scroll=r.expand(records[0])['value']['scrolls'][0]
outer=records[1]['value']['result']['windowObservation']['liveProtection']['outerTranscript']
assert scroll==outer
for value in (scroll,outer):
 actual=[value[group][side].bits for group in ('contentInset','adjustedContentInset') for side in ('top','left','bottom','right')]
 assert actual==expected,(actual,expected)
assert scroll['offsetY'].bits==0xc04a800000000000
`, path.join(root, 'v4/stream_reader.py'), path.join(temporary, 'values.tlv')], { encoding: 'utf8', timeout: 10000 });
    expect(checked.status, checked.stderr).toBe(0);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}, 120000);

it('keeps phases opt-in and identifies the new v4 revision while preserving default v3', async () => {
  for (const version of ['v3', 'v4']) {
    const output = mkdtempSync(path.join(tmpdir(), 'history-insets-stage-'));
    try {
      const { manifest } = await stageHistoryProduction({ output, observerVersion: version });
      expect(manifest.diagnosticRevision).toBe(version === 'v4' ? 'control-read-sharing-v2' : undefined);
      expect(manifest.scrollInsetsRevision).toBe(version === 'v4' ? 'scroll-insets-v1' : undefined);
      expect(manifest.readPhases).toBe(version === 'v4' ? false : undefined);
    } finally { rmSync(output, { recursive: true, force: true }); }
  }
}, 120000);
