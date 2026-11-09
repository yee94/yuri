import Foundation
import CoreGraphics

/// One synchronous control read only. Capacity limits reuse, never the underlying safety inspection.
@MainActor final class HistoryV4CoverageReadMemo<Node: AnyObject> {
    struct Sample {
        let parent: Node?
        let frame: CGRect
        let alpha: CGFloat
        let hidden: Bool, clips: Bool, transformed: Bool, animated: Bool, masked: Bool, sameWindow: Bool
    }
    struct Facts {
        let frame: CGRect, clip: CGRect
        let visible: Bool, geometryKnown: Bool, clipsChildren: Bool
    }
    private let root: Node, bounds: CGRect, capacity: Int
    private let sample: (Node) -> Sample
    private var samples: [ObjectIdentifier: Sample] = [:]
    private var facts: [ObjectIdentifier: Facts] = [:]
    private(set) var sampleReads = 0, sampleHits = 0, factRequests = 0, factHits = 0, ancestorSteps = 0
    init(root: Node, bounds: CGRect, capacity: Int = 8192, sample: @escaping (Node) -> Sample) {
        self.root = root; self.bounds = bounds; self.capacity = capacity; self.sample = sample
    }
    private func read(_ node: Node) -> Sample {
        let key = ObjectIdentifier(node)
        if let value = samples[key] { sampleHits += 1; return value }
        sampleReads += 1
        let value = sample(node)
        if samples.count < capacity { samples[key] = value }
        return value
    }
    func resolve(_ node: Node) -> Facts {
        factRequests += 1
        let key = ObjectIdentifier(node)
        if let value = facts[key] { factHits += 1; return value }
        let own = read(node)
        var cursor: Node? = node, last: Node?, clip = bounds, alpha: CGFloat = 1
        var hidden = false, transformed = false, animated = false, masked = false
        while let current = cursor {
            let value = current === node ? own : read(current)
            ancestorSteps += 1
            // Keep the legacy leaf-to-root multiplication/intersection order, including borderline alpha.
            alpha *= value.alpha; hidden = hidden || value.hidden
            transformed = transformed || value.transformed; animated = animated || value.animated; masked = masked || value.masked
            if current !== node && value.clips { clip = clip.intersection(value.frame) }
            last = current
            if current === root { break }
            cursor = value.parent
        }
        let attached = own.sameWindow && last === root
        let value = Facts(frame: own.frame, clip: clip, visible: attached && !hidden && alpha > 0.01,
            geometryKnown: attached && !transformed && !animated && !masked, clipsChildren: own.clips)
        if facts.count < capacity { facts[key] = value }
        return value
    }
    func finishRead() {
        samples.removeAll(keepingCapacity: false)
        facts.removeAll(keepingCapacity: false)
    }
}
