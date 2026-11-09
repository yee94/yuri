import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = path.dirname(fileURLToPath(import.meta.url));

it('preserves all native container bits, fallback/rejection and detached values while reducing generic freeze dispatches', () => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'history-native-snapshot-'));
  try {
    const original = readFileSync(path.join(root, 'v4/SnapshotValue.swift'), 'utf8');
    const measured = original.replace('enum HistoryV4Error:', '@MainActor var legacyFreezeCalls = 0\n\nenum HistoryV4Error:')
      .replace('let valueType = type(of: value)', 'legacyFreezeCalls += 1\n        let valueType = type(of: value)');
    writeFileSync(path.join(temporary, 'SnapshotValue.swift'), measured);
    writeFileSync(path.join(temporary, 'Probe.swift'), `import Foundation
@main struct Probe {
 @MainActor static func main() throws {
  let bits: [UInt64] = [0, 0x8000000000000000, 0x7ff8000000000042, 0x7ff0000000000000, 0xfff0000000000000, 1, 0x3ff4000000000000]
  let scalars = bits.map { Double(bitPattern: $0) }
  let cg = scalars.map { CGFloat($0) }
  let geometry: [String: Any] = ["frame": ["x": CGFloat(-53), "y": CGFloat(-0.0), "width": CGFloat(402), "height": CGFloat(874)],
   "alpha": CGFloat(1), "layerOpacity": Float(1), "transform": cg, "layerTransform": cg + cg + cg,
   "selected": NSNull(), "animationCount": 0, "hidden": false, "instances": ["one", "two"]]
  var input: [String: Any] = ["navigationBars": Array(repeating: geometry, count: 12), "doubles": Dictionary(uniqueKeysWithValues: scalars.enumerated().map { (String($0.offset), $0.element) }),
   "cgValues": Dictionary(uniqueKeysWithValues: cg.enumerated().map { (String($0.offset), $0.element) }), "readPhases": ["start": 1.25, "end": -0.0],
   "counts": ["scrolls": 3, "nodes": 634], "nativeAny": [NSNull(), false, scalars[2], "text", [1, 2, 3]] as [Any],
   "foundation": NSDictionary(dictionary: ["bool": NSNumber(value: true), "integer": NSNumber(value: 37), "string": NSString(string: "é")])]
  legacyFreezeCalls = 0
  let expected = try HistorySnapshotValue.freeze(input), oldCalls = legacyFreezeCalls
  legacyFreezeCalls = 0
  let actual = try HistoryV4NativeSnapshotValue.freeze(input), newCalls = legacyFreezeCalls
  precondition(actual == expected)
  precondition(actual.allocationBudget == expected.allocationBudget)
  let pretyped: HistorySnapshotValue = .array(bits.map { .doubleBits($0) })
  let typedPass = try HistoryV4NativeSnapshotValue.freeze(["typed": pretyped])
  precondition(typedPass["typed"] == pretyped)
  var a = Data(), b = Data(); actual.encode(into: &a); expected.encode(into: &b); precondition(a == b)
  precondition(newCalls * 2 < oldCalls, "generic dispatch work did not decrease")
  for (index, bit) in bits.enumerated() { precondition(actual["doubles"]?[String(index)] == .doubleBits(bit)); precondition(actual["cgValues"]?[String(index)] == .doubleBits(bit)) }
  input["navigationBars"] = [] as [[String: Any]]
  let mutated = try HistoryV4NativeSnapshotValue.freeze(input)
  precondition(actual["navigationBars"] != mutated["navigationBars"])
  do { _ = try HistoryV4NativeSnapshotValue.freeze(["nested": NSObject()]); preconditionFailure("unsupported reference escaped") }
  catch HistoryV4Error.invalid {} 
  print("native snapshot parity passed; oldDispatches=\\(oldCalls) newDispatches=\\(newCalls)")
 }
}
`);
    const binary = path.join(temporary, 'probe');
    const compiled = spawnSync('xcrun', ['--sdk', 'macosx', 'swiftc', '-O', '-swift-version', '6', '-parse-as-library',
      path.join(temporary, 'SnapshotValue.swift'), path.join(root, 'v4/NativeSnapshotValue.swift'), path.join(temporary, 'Probe.swift'), '-o', binary], { encoding: 'utf8', timeout: 110000 });
    expect(compiled.status, compiled.stderr).toBe(0);
    const run = spawnSync(binary, [], { encoding: 'utf8', timeout: 10000 });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain('native snapshot parity passed');
    console.log(run.stdout.trim());
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}, 120000);
