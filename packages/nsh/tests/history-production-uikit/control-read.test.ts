import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = path.dirname(fileURLToPath(import.meta.url));

it('shares only one read of coverage facts, preserves every legacy predicate/cap and re-samples the next read', () => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'history-control-read-'));
  try {
    writeFileSync(path.join(temporary, 'Probe.swift'), `import Foundation
import CoreGraphics
@MainActor final class Node {
 weak var parent: Node?; var children: [Node] = []; var frame: CGRect; var alpha: CGFloat = 1
 var hidden = false, clips = true, transformed = false, animated = false, masked = false, sameWindow = true
 init(_ parent: Node?, _ frame: CGRect) { self.parent = parent; self.frame = frame; parent?.children.append(self) }
}
@main struct Probe {
 @MainActor static func main() {
  let bounds = CGRect(x: 0, y: 0, width: 402, height: 874), root = Node(nil, CGRect(x: 0, y: 0, width: 402, height: 874))
  var parents = [root]
  for index in 1..<28 { parents.append(Node(parents.last!, bounds.insetBy(dx: CGFloat(index % 3), dy: 0))) }
  let leaves = (0..<606).map { index in Node(parents[27], CGRect(x: Double(index % 20), y: Double(index % 800), width: 20, height: 25)) }
  let surface = parents[8]
  var membershipSteps = 0, prefixSteps = 0
  func members(_ node: Node, inherited: Bool, shared: Bool) -> [ObjectIdentifier] {
   var belongs = inherited || node === surface
   if shared { prefixSteps += 1 }
   else {
    belongs = false; var cursor: Node? = node
    while let current = cursor { membershipSteps += 1; if current === surface { belongs = true; break }; cursor = current.parent }
   }
   var result = belongs ? [ObjectIdentifier(node)] : []
   for child in node.children { result.append(contentsOf: members(child, inherited: belongs, shared: shared)) }
   return result
  }
  precondition(members(root, inherited: false, shared: false) == members(root, inherited: false, shared: true))
  precondition(prefixSteps == 634 && membershipSteps > prefixSteps * 10)
  var legacyReads = 0
  func legacy(_ node: Node) -> HistoryV4CoverageReadMemo<Node>.Facts {
   var cursor: Node? = node, last: Node?, clip = bounds, alpha: CGFloat = 1
   var hidden = false, transformed = false, animated = false, masked = false
   while let current = cursor {
    legacyReads += 1; alpha *= current.alpha; hidden = hidden || current.hidden
    transformed = transformed || current.transformed; animated = animated || current.animated; masked = masked || current.masked
    if current !== node && current.clips { clip = clip.intersection(current.frame) }
    last = current; if current === root { break }; cursor = current.parent
   }
   let attached = node.sameWindow && last === root
   return .init(frame: node.frame, clip: clip, visible: attached && !hidden && alpha > 0.01,
    geometryKnown: attached && !transformed && !animated && !masked, clipsChildren: node.clips)
  }
  func memo(_ capacity: Int = 8192) -> HistoryV4CoverageReadMemo<Node> {
   .init(root: root, bounds: bounds, capacity: capacity) { node in
    .init(parent: node.parent, frame: node.frame, alpha: node.alpha, hidden: node.hidden, clips: node.clips,
     transformed: node.transformed, animated: node.animated, masked: node.masked, sameWindow: node.sameWindow)
   }
  }
  func equal(_ a: HistoryV4CoverageReadMemo<Node>.Facts, _ b: HistoryV4CoverageReadMemo<Node>.Facts) {
   precondition(a.frame == b.frame && a.clip == b.clip && a.visible == b.visible && a.geometryKnown == b.geometryKnown && a.clipsChildren == b.clipsChildren)
  }
  let first = memo()
  for _ in 0..<10 { for node in leaves { equal(first.resolve(node), legacy(node)) } }
  precondition(first.sampleReads == 634 && first.factHits == 5454 && first.sampleReads * 10 < legacyReads)
  let oldReads = legacyReads
  for variant in 0..<8 {
   parents[2].alpha = variant == 0 ? 0.01 : variant == 1 ? CGFloat.nan : 0.999999999999
   parents[3].hidden = variant == 2; parents[4].transformed = variant == 3; parents[5].animated = variant == 4
   parents[6].masked = variant == 5; leaves[0].sameWindow = variant != 6; parents[8].clips = variant != 7
   let current = memo(), noReuse = memo(0)
   equal(current.resolve(leaves[0]), legacy(leaves[0])); equal(noReuse.resolve(leaves[0]), legacy(leaves[0]))
  }
  parents[3].hidden = true
  precondition(first.resolve(leaves[0]).visible)
  precondition(!memo().resolve(leaves[0]).visible)
  print("coverage facts preserved: legacySamples=\\(oldReads) sharedSamples=\\(first.sampleReads) factHits=\\(first.factHits)")
 }
}
`);
    const binary = path.join(temporary, 'probe');
    const compiled = spawnSync('xcrun', ['--sdk', 'macosx', 'swiftc', '-O', '-swift-version', '6', '-parse-as-library',
      path.join(root, 'v4/CoverageReadMemo.swift'), path.join(temporary, 'Probe.swift'), '-o', binary], { encoding: 'utf8', timeout: 110000 });
    expect(compiled.status, compiled.stderr).toBe(0);
    const run = spawnSync(binary, [], { encoding: 'utf8', timeout: 10000 });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain('sharedSamples=634');
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}, 120000);
