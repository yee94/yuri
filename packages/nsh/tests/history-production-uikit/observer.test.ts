import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = path.dirname(fileURLToPath(import.meta.url));
const observer = readFileSync(path.join(root, 'Observer.swift'), 'utf8');

it('discovers noncentral out-of-bounds subtree coverage and refuses unknown drawing or exhausted capacity', () => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'history-coverage-subtree-'));
  try {
    const core = observer.slice(observer.indexOf('enum HistoryCoverageTraversal {'), observer.indexOf('/// Bounded synthetic AX metadata'));
    const source = path.join(temporary, 'Coverage.swift'), binary = path.join(temporary, 'coverage');
    writeFileSync(source, `import Foundation
import CoreGraphics
${core}
struct Node { let id: String; let frame: CGRect; let clip: CGRect; let clips: Bool; var children: [Node] = []; var known = true }
let viewport = CGRect(x: 0, y: 0, width: 400, height: 850), target = CGRect(x: 100, y: 100, width: 100, height: 100)
let corner = Node(id: "corner", frame: CGRect(x: 100, y: 100, width: 10, height: 10), clip: viewport, clips: true)
var sibling = Node(id: "sibling", frame: CGRect(x: 0, y: 0, width: 20, height: 20), clip: viewport, clips: false, children: [corner])
func scan(_ node: Node, cap: Int = 16) -> HistoryCoverageTraversal.Result {
 HistoryCoverageTraversal.scan(roots: [node], target: target, capacity: cap, facts: { .init(frame: $0.frame, clip: $0.clip, visible: true, geometryKnown: $0.known, clipsChildren: $0.clips) }, children: { $0.children }, identity: { $0.id })
}
precondition(!sibling.frame.intersects(target) && !corner.frame.contains(CGPoint(x: 150, y: 150)))
let overflow = scan(sibling); precondition(overflow.unknown && overflow.blockers == ["corner"])
sibling = Node(id: "sibling", frame: sibling.frame, clip: viewport, clips: true, children: [corner])
let clipped = scan(sibling); precondition(!clipped.unknown && clipped.blockers.isEmpty && clipped.inspected == 1)
precondition(scan(Node(id: "unclipped-leaf", frame: sibling.frame, clip: viewport, clips: false)).unknown)
precondition(scan(Node(id: "uncertain", frame: sibling.frame, clip: viewport, clips: true, known: false)).unknown)
let exhausted = scan(Node(id: "overflow", frame: target, clip: viewport, clips: true, children: [corner, corner]), cap: 2)
precondition(exhausted.unknown && exhausted.inspected <= 2)
let clippedCorner = Node(id: "clipped-corner", frame: corner.frame, clip: sibling.frame, clips: true)
precondition(scan(clippedCorner).blockers.isEmpty)
print("coverage discovery regressions passed")
`);
    const compiled = spawnSync('xcrun', ['--sdk', 'macosx', 'swiftc', '-swift-version', '5', source, '-o', binary], { encoding: 'utf8', timeout: 110000 });
    expect(compiled.status, compiled.stderr).toBe(0);
    const run = spawnSync(binary, [], { encoding: 'utf8', timeout: 10000 });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain('coverage discovery regressions passed');
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}, 120000);

it('requires exact unique object membership and never hashes unallowlisted or real user text', () => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'history-observer-policy-'));
  try {
    const policy = observer.slice(observer.indexOf('enum HistoryProductionObservationPolicy {'), observer.indexOf('/// Public object membership'));
    const source = path.join(temporary, 'Policy.swift'), binary = path.join(temporary, 'policy');
    writeFileSync(source, `import Foundation
import CoreGraphics
import CryptoKit
${policy}
let body = "body-part-hp-0488:text:0"
let paragraph = String(repeating: "A complete neutral paragraph exercises variable natural line wrapping without removing source content. ", count: 2 + 488 % 7)
let result: [String: Any] = [
  "unique": HistoryProductionObservationPolicy.navigationOwner(barInstances: ["bar"], matchingOwners: ["bar"], transcriptCount: 1) == "bar",
  "absent": HistoryProductionObservationPolicy.navigationOwner(barInstances: [], matchingOwners: [], transcriptCount: 1) == nil,
  "duplicate": HistoryProductionObservationPolicy.navigationOwner(barInstances: ["bar", "other"], matchingOwners: ["bar"], transcriptCount: 1) == nil,
  "wrongObject": HistoryProductionObservationPolicy.navigationOwner(barInstances: ["bar"], matchingOwners: ["other"], transcriptCount: 1) == nil,
  "duplicateOwner": HistoryProductionObservationPolicy.navigationOwner(barInstances: ["bar"], matchingOwners: ["bar", "bar"], transcriptCount: 1) == nil,
  "missingTranscript": HistoryProductionObservationPolicy.navigationOwner(barInstances: ["bar"], matchingOwners: ["bar"], transcriptCount: 0) == nil,
  "duplicateTranscript": HistoryProductionObservationPolicy.navigationOwner(barInstances: ["bar"], matchingOwners: ["bar"], transcriptCount: 2) == nil,
  "marker": HistoryProductionObservationPolicy.syntheticFingerprint("ANCHOR hp-0488", bodyID: body) != nil,
  "code": HistoryProductionObservationPolicy.syntheticFingerprint("ANCHOR hp-0488\\nno command is executed", bodyID: body) != nil,
  "paragraph": HistoryProductionObservationPolicy.syntheticFingerprint(paragraph, bodyID: body) != nil,
  "normalized": HistoryProductionObservationPolicy.syntheticFingerprint("Preserve order \\n", bodyID: body) == HistoryProductionObservationPolicy.syntheticFingerprint("Preserve order", bodyID: body),
  "rootTime": HistoryProductionObservationPolicy.syntheticFingerprint("03:32", bodyID: body) == nil,
  "privateText": HistoryProductionObservationPolicy.syntheticFingerprint("private user content", bodyID: body) == nil,
  "prefixAttack": HistoryProductionObservationPolicy.syntheticFingerprint("Preserve order private user content", bodyID: body) == nil,
  "wrongMarker": HistoryProductionObservationPolicy.syntheticFingerprint("ANCHOR hp-0489", bodyID: body) == nil,
  "invalidBody": HistoryProductionObservationPolicy.syntheticFingerprint("Preserve order", bodyID: "real-session-body") == nil,
  "outOfFixture": HistoryProductionObservationPolicy.syntheticFingerprint("Preserve order", bodyID: "body-part-hp-0500:text:0") == nil,
  "newlineBody": HistoryProductionObservationPolicy.syntheticFingerprint("Preserve order", bodyID: body + "\\n") == nil]
print(String(decoding: try JSONSerialization.data(withJSONObject: result), as: UTF8.self))
`);
    const compiled = spawnSync('xcrun', ['--sdk', 'macosx', 'swiftc', '-swift-version', '5', source, '-o', binary], { encoding: 'utf8', timeout: 110000 });
    expect(compiled.status, compiled.stderr).toBe(0);
    const run = spawnSync(binary, [], { encoding: 'utf8', timeout: 10000 });
    expect(run.status, run.stderr).toBe(0);
    const facts = JSON.parse(run.stdout) as Record<string, boolean>;
    expect(Object.keys(facts)).toHaveLength(18);
    expect(Object.entries(facts).filter(([, passed]) => !passed)).toEqual([]);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}, 120000);

it('keeps window discovery public, sampler timing raw, and external AX identity explicitly unbound', () => {
  expect(observer).toContain('view as? UINavigationBar');
  expect(observer).toContain('$0.navigationBar === bar');
  expect(observer).toContain('nav.topViewController?.viewIfLoaded');
  expect(observer).toContain('view.isAccessibilityElement && view.accessibilityTraits.contains(.staticText)');
  expect(observer).toContain('body.isDescendant(of: transcripts[0])');
  expect(observer).toContain('external AX tree has no shared object identity');
  expect(observer).toContain('"readEndNativeMs": HistoryProductionClock.now()');
  expect(observer).toContain('try flush()');
  expect(observer).not.toMatch(/NSClassFromString|value\(forKey:|perform\(|setContentOffset|contentOffset\s*=|contentInset\s*=|layoutIfNeeded|accessibilityLabel\s*=/);
  expect(observer).not.toMatch(/"(?:label|text|accessibilityLabel)"\s*:/);
});

it('versions only new artifacts and leaves the frozen driver version seam explicit', () => {
  const builder = readFileSync(path.join(root, 'build.mjs'), 'utf8');
  expect(builder).toContain("observerContract: 'instrumented-v3; synthetic-ax-id-v3;");
  expect(builder).toContain("randomUUID().slice(0, 8)");
  expect(builder).toContain("'ios/NativeInputMetadataBinding.swift'");
  expect(builder).toContain("'ios/NativeInputMetadataOwner.swift'");
});

it.skipIf(!process.env.NSH_DIST)('compiles Observer and public UIKit SDK probes without running UIKit or an engine', () => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'history-observer-sdk-'));
  try {
    const sdkResult = spawnSync('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path'], { encoding: 'utf8', timeout: 10000 });
    expect(sdkResult.status, sdkResult.stderr).toBe(0);
    const framework = path.join(process.env.NSH_DIST!, 'embed/ios/NativeShell.xcframework/ios-arm64-simulator');
    const names = ['Observer.swift', 'SyntheticHost.swift', 'ClockContract.swift', 'observer-sdk.swift', 'ClockClient.swift', 'v4/SnapshotValue.swift', 'v4/NativeSnapshotValue.swift', 'v4/CoverageReadMemo.swift', 'v4/ControlValueSnapshot.swift', 'v4/ControlReadContext.swift', 'v4/TypedGeometry.swift', 'v4/SegmentWriter.swift', 'v4/CapturePipeline.swift'];
    const frozen = names.map(file => readFileSync(path.join(root, file)));
    const sources = names.map((file, index) => { const output = path.join(temporary, path.basename(file)); writeFileSync(output, frozen[index]); return output; });
    const checked = spawnSync('xcrun', ['--sdk', 'iphonesimulator', 'swiftc', '-typecheck', '-swift-version', '5', '-parse-as-library', '-sdk', sdkResult.stdout.trim(), '-target', 'arm64-apple-ios15.0-simulator', '-F', framework, ...sources], { encoding: 'utf8', timeout: 110000 });
    expect(checked.status, checked.stderr).toBe(0);
    for (const primary of [sources[0], sources[3], sources[4]]) {
      const result = spawnSync('xcrun', ['--sdk', 'iphonesimulator', 'swiftc', '-frontend', '-emit-object', '-module-name', 'HistoryObserverSDKProbe', '-swift-version', '5', '-parse-as-library', '-sdk', sdkResult.stdout.trim(), '-target', 'arm64-apple-ios15.0-simulator', '-F', framework,
        '-primary-file', primary, ...sources.filter(file => file !== primary), '-o', path.join(temporary, path.basename(primary) + '.o')], { encoding: 'utf8', timeout: 110000 });
      expect(result.status, result.stderr).toBe(0);
    }
    for (const [index, file] of names.entries()) {
      const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
      expect(sha(readFileSync(path.join(root, file))), 'Source changed during SDK snapshot compile: ' + file).toBe(sha(frozen[index]));
    }
    // Also compile exactly the current builder inputs, including the separately owned Composer binding.
    const builder = readFileSync(path.join(root, 'build.mjs'), 'utf8');
    const files = JSON.parse(builder.match(/^const swiftSources = (\[.*\]);$/m)![1].replaceAll("'", '"')) as string[];
    const ownerSources = files.map(file => path.join(root, '../..', file));
    const ownerBytes = ownerSources.map(file => readFileSync(file));
    const staged = ownerSources.map((file, index) => { const output = path.join(temporary, path.basename(file)); writeFileSync(output, ownerBytes[index]); return output; });
    const complete = spawnSync('xcrun', ['--sdk', 'iphonesimulator', 'swiftc', '-typecheck', '-swift-version', '5', '-parse-as-library', '-sdk', sdkResult.stdout.trim(), '-target', 'arm64-apple-ios15.0-simulator', '-F', framework, ...staged], { encoding: 'utf8', timeout: 110000 });
    expect(complete.status, complete.stderr).toBe(0);
    for (const [index, file] of ownerSources.entries()) {
      expect(readFileSync(file).equals(ownerBytes[index]), 'Builder source changed during full SDK typecheck: ' + path.basename(file)).toBe(true);
    }
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}, 240000);

it('keeps AX token lifecycle weak, bounded, monotonic and write-free outside explicit preparation', () => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'history-observer-lifecycle-'));
  try {
    const policy = observer.slice(observer.indexOf('enum HistoryProductionObservationPolicy {'), observer.indexOf('/// Public object membership'));
    const source = path.join(temporary, 'Lifecycle.swift'), binary = path.join(temporary, 'lifecycle');
    writeFileSync(source, `import Foundation
import CoreGraphics
import CryptoKit
${policy}
final class Node: NSObject { var identifier: String? }
let body = Node(), outer = Node(), view = Node()
func candidate(_ view: Node, _ label: String = "Preserve identity", body owner: Node = body, nested: Bool = false, isAX: Bool = true) -> HistoryDiagnosticAXLedger.Candidate {
  .init(view: view, body: owner, outer: outer, bodyID: "body-part-hp-0488:text:0", label: label, isAXText: isAX, nested: nested)
}
var writes: [String?] = []
func read(_ object: AnyObject) -> String? { (object as! Node).identifier }
func write(_ object: AnyObject, _ id: String?) { writes.append(id); (object as! Node).identifier = id }
let ledger = HistoryDiagnosticAXLedger(runNonce: "fixed-run", capacity: 4, lifetimeCapacity: 20)
var facts: [String: Bool] = [:]
facts["movingRefused"] = ledger.prepare([candidate(view)], sequence: 1, stable: false, readID: read, writeID: write)["prepared"] as? Bool == false && writes.isEmpty
let appView = Node(); appView.identifier = "application-owner"
let invalid = [candidate(appView), candidate(Node(), nested: true), candidate(Node(), isAX: false), candidate(Node(), "03:32")]
_ = ledger.prepare(invalid, sequence: 1, stable: true, readID: read, writeID: write)
facts["negativeCandidatesNoWrites"] = writes.isEmpty && ledger.bindings.isEmpty
_ = ledger.prepare([candidate(view)], sequence: 2, stable: true, readID: read, writeID: write)
let first = ledger.bindings.last!, token = first.token, writeCount = writes.count
facts["firstBinding"] = token.hasPrefix("hpdiag-ax-fixed-run-") && first.originalID == nil && first.assignedSequence == 2
facts["readNoWrite"] = ledger.validate(first, candidate: candidate(view), currentID: view.identifier) == nil && writes.count == writeCount
facts["textChangeRetiresWithoutCleanup"] = ledger.validate(first, candidate: candidate(view, "Preserve order"), currentID: view.identifier) != nil && view.identifier == token && writes.count == writeCount
_ = ledger.prepare([candidate(view, "Preserve order")], sequence: 3, stable: true, readID: read, writeID: write)
let second = ledger.bindings.last!
facts["newTokenGenerationNilRestore"] = second.token != token && second.generation > first.generation && writes[writeCount] == nil && second.originalID == nil
facts["retiredNeverResurrects"] = ledger.validate(first, candidate: candidate(view), currentID: token) != nil
view.identifier = "new-application-ID"; let countBeforeApp = writes.count
_ = ledger.validate(second, candidate: candidate(view, "Preserve order"), currentID: view.identifier)
_ = ledger.prepare([candidate(view)], sequence: 4, stable: true, readID: read, writeID: write)
facts["neverStealsApplicationID"] = view.identifier == "new-application-ID" && writes.count == countBeforeApp
let empty = Node(); empty.identifier = ""
_ = ledger.prepare([candidate(empty)], sequence: 5, stable: true, readID: read, writeID: write)
let emptyBinding = ledger.bindings.last!, beforeEmpty = writes.count
_ = ledger.prepare([candidate(empty)], sequence: 6, stable: true, readID: read, writeID: write)
facts["emptyRestoreDistinctFromNil"] = emptyBinding.originalID == "" && writes[beforeEmpty] == ""
let changedOwner = Node(), active = ledger.bindings.last!
facts["ownerReplacementRetires"] = ledger.validate(active, candidate: candidate(empty, body: changedOwner), currentID: empty.identifier) != nil
ledger.sealed = true; let sealedCount = writes.count
facts["sealedNoWrites"] = ledger.prepare([candidate(empty)], sequence: 7, stable: true, readID: read, writeID: write)["prepared"] as? Bool == false && writes.count == sealedCount
let bounded = HistoryDiagnosticAXLedger(runNonce: "bounded", capacity: 1, lifetimeCapacity: 2), a = Node(), b = Node()
let beforeCapacity = writes.count
facts["capacityPreflightNoWrites"] = bounded.prepare([candidate(a), candidate(b)], sequence: 1, stable: true, readID: read, writeID: write)["prepared"] as? Bool == false && writes.count == beforeCapacity
_ = bounded.prepare([candidate(a)], sequence: 2, stable: true, readID: read, writeID: write)
_ = bounded.prepare([candidate(a)], sequence: 3, stable: true, readID: read, writeID: write)
let countBeforeLifetime = writes.count, lastToken = a.identifier
facts["lifetimeFailClosed"] = bounded.prepare([candidate(a)], sequence: 4, stable: true, readID: read, writeID: write)["prepared"] as? Bool == false && writes.count == countBeforeLifetime && a.identifier == lastToken
let weakLedger = HistoryDiagnosticAXLedger(runNonce: "weak")
var disposable: Node? = Node()
_ = weakLedger.prepare([candidate(disposable!)], sequence: 1, stable: true, readID: read, writeID: write)
let dead = weakLedger.bindings[0]; disposable = nil
facts["weakObjectCannotABA"] = dead.view == nil && weakLedger.validate(dead, candidate: candidate(Node()), currentID: dead.token) != nil
let nestedLedger = HistoryDiagnosticAXLedger(), code = Node()
_ = nestedLedger.prepare([candidate(code)], sequence: 1, stable: true, readID: read, writeID: write)
facts["nestedChangeRetires"] = nestedLedger.validate(nestedLedger.bindings[0], candidate: candidate(code, nested: true), currentID: code.identifier) != nil
let chainLedger = HistoryDiagnosticAXLedger(), chainView = Node(), wrapper = Node(), replacement = Node()
var chainCandidate = candidate(chainView); chainCandidate.ancestorChain = [chainView, wrapper, body, outer]
_ = chainLedger.prepare([chainCandidate], sequence: 1, stable: true, readID: read, writeID: write)
chainCandidate.ancestorChain = [chainView, replacement, body, outer]
facts["changedAncestorChainRetires"] = chainLedger.validate(chainLedger.bindings[0], candidate: chainCandidate, currentID: chainView.identifier) != nil
let unreadableLedger = HistoryDiagnosticAXLedger(), unreadable = Node(), beforeUnreadable = writes.count
let rejected = unreadableLedger.prepare([candidate(unreadable)], sequence: 1, stable: true, readID: { _ in nil }, writeID: write)
facts["immediateGetterMismatchFailsClosedNoRetry"] = rejected["prepared"] as? Bool == false && rejected["readbackConfirmedCount"] as? Int == 0 && unreadableLedger.bindings[0].assignmentReadbackKind == "nil" && writes.count == beforeUnreadable + 1
print(String(decoding: try JSONSerialization.data(withJSONObject: facts), as: UTF8.self))
`);
    const compiled = spawnSync('xcrun', ['--sdk', 'macosx', 'swiftc', '-swift-version', '5', source, '-o', binary], { encoding: 'utf8', timeout: 110000 });
    expect(compiled.status, compiled.stderr).toBe(0);
    const result = spawnSync(binary, [], { encoding: 'utf8', timeout: 10000 });
    expect(result.status, result.stderr).toBe(0);
    const facts = JSON.parse(result.stdout) as Record<string, boolean>;
    expect(Object.keys(facts)).toHaveLength(17);
    expect(Object.entries(facts).filter(([, passed]) => !passed)).toEqual([]);
    const sampler = observer.slice(observer.indexOf('@objc private func sample'));
    expect(sampler).not.toMatch(/accessibilityIdentifier\s*=|syntheticFingerprint\(/);
    expect(sampler).toContain('!diagnosticAX.owns(identifier)');
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}, 120000);
