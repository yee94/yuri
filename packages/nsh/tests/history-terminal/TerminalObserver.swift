import UIKit
import NativeShell
import CryptoKit

/// Read-only, bounded observation. Never sets an offset, content size, inset, or layout constraint.
@MainActor final class TerminalObserver: NSObject {
    private weak var surface: NshAppView?
    private var displayLink: CADisplayLink?
    private var stopAt: Double = 0
    private var sequence = 0
    private var frames: [[String: Any]] = []
    private var events: [[String: Any]] = []
    private var lastCounterLabel: String?
    private var compactCounterLabel: String?
    private var continuous = false
    private var sampleSequence = 0
    private var droppedFrames = 0
    private let syncFrameLimit = 12000
    private let buildIdentity: [String: Any]
    private let writer = TerminalCaptureWriter()
    private var flushRevision = 0
    private var postWindow = TerminalPostWindow()
    private let directory: URL
    init(surface: NshAppView) {
        self.surface = surface
        directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("history-terminal", isDirectory: true)
        let executable = Bundle.main.executableURL.flatMap { try? Data(contentsOf: $0) }
        let bytecode = Bundle.main.url(forResource: "bundle", withExtension: "nshc", subdirectory: "nsh").flatMap { try? Data(contentsOf: $0) }
        buildIdentity = ["build": Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") ?? "unknown",
            "executableSHA256": executable.map { SHA256.hash(data: $0).map { String(format: "%02x", $0) }.joined() } ?? "unknown",
            "bundleSHA256": bytecode.map { SHA256.hash(data: $0).map { String(format: "%02x", $0) }.joined() } ?? "unknown"]
        super.init()
        surface.handle("terminal.record") { [weak self] data async throws -> Any? in
            guard let self else { throw CancellationError() }
            let payload = data as? [String: Any] ?? [:]
            if let mode = payload["releaseMode"] as? String {
                self.continuous = mode == "sync"
                if !self.continuous { self.postWindow.reset() }
            }
            self.sequence += 1
            let phase = payload["phase"] as? String ?? ""
            if phase == "footer-sync-before-release" || phase == "footer-sync-after-release" {
                // Use ONLY already captured CADisplayLink samples; never measure/flush on this release path.
                var event: [String: Any] = ["sequence": self.sequence, "nativeReceivedUptimeMs": self.uptime(), "js": payload]
                if phase == "footer-sync-before-release" {
                    let pre = self.cachedPre(payload)
                    event["cachedPre"] = pre
                    if let id = payload["releaseID"] as? Int, pre["valid"] as? Bool == true, let t = pre["lastNativeUptimeMs"] as? Double {
                        self.postWindow.notePre(id: id, nativeMs: t)
                    }
                } else if let id = payload["releaseID"] as? Int, let timeline = payload["timeline"] as? [String: Any], timeline["released"] as? Bool == true {
                    self.postWindow.noteReleased(id: id)
                }
                self.events.append(event)
                if self.events.count > 512 { self.events.removeFirst(self.events.count - 512) }
                self.observe()
                return ["recorded": self.sequence]
            }
            self.events.append(["sequence": self.sequence, "nativeReceivedUptimeMs": self.uptime(), "js": data ?? NSNull(), "native": self.capture(kind: "journal-received")])
            if self.events.count > 512 { self.events.removeFirst(self.events.count - 512) }
            self.observe()
            return self.capture(kind: "journal-received")
        }
        surface.handle("terminal.capture") { [weak self] data async throws -> Any? in
            guard let self else { throw CancellationError() }
            var capture = self.capture(kind: "explicit")
            self.events.append(["nativeReceivedUptimeMs": self.uptime(), "jsMeasure": data ?? NSNull(), "native": capture])
            if self.events.count > 512 { self.events.removeFirst(self.events.count - 512) }
            if self.continuous { capture["persistedSnapshotRevision"] = try await self.flushContinuous() } else { try self.flush() }
            return capture
        }
    }
    private func uptime() -> Double { ProcessInfo.processInfo.systemUptime * 1000 }
    private func rectangle(_ value: CGRect) -> [String: Double] {
        ["x": Double(value.minX), "y": Double(value.minY), "width": Double(value.width), "height": Double(value.height)]
    }
    private func counters(_ label: String?) -> String? {
        // One bounded label cache: parse only on authority/control changes, not every display frame.
        if label == lastCounterLabel { return compactCounterLabel }
        lastCounterLabel = label
        compactCounterLabel = nil
        guard let data = label?.data(using: .utf8), let source = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return nil }
        let keys: Set<String> = ["revision", "page", "messageCount", "rowCount", "requests", "adopted", "controlCommits", "more", "loading", "pending", "trigger", "footerExperiment", "footerHold", "footerPublishedOffsetY", "footerMeasuring", "footerOffsetPolicy", "releaseMode"]
        let compact = source.filter { keys.contains($0.key) }
        if let data = try? JSONSerialization.data(withJSONObject: compact, options: .sortedKeys) {
            compactCounterLabel = String(data: data, encoding: .utf8)
        }
        return compactCounterLabel
    }
    private func capture(kind: String) -> [String: Any] {
        guard let surface else { return ["error": "surface-released", "nativeUptimeMs": uptime()] }
        var markers: [[String: Any]] = [], scrolls: [[String: Any]] = []
        var observedCounters: String? = nil
        func visit(_ view: UIView, hidden: Bool, clip: CGRect) {
            let hidden = hidden || view.isHidden || view.alpha <= 0.01
            let id = view.accessibilityIdentifier ?? ""
            let frame = view.convert(view.bounds, to: surface)
            if id == "terminal-counters" { observedCounters = counters(view.accessibilityLabel) }
            let footerNode = id == "terminal-footer" || id == "terminal-footer-natural"
            if !hidden && (footerNode || frame.intersects(clip) && (id.hasPrefix("terminal-marker-") || id == "history-load-older" || id.hasPrefix("terminal-metadata-") || id == "terminal-top" || id == "terminal-bottom")) {
                markers.append(["id": id, "class": NSStringFromClass(type(of: view)), "frame": rectangle(frame), "intersectsClip": frame.intersects(clip), "label": view.accessibilityLabel ?? ""])
            }
            if !hidden && frame.intersects(clip), let scroll = view as? UIScrollView {
                scrolls.append(["id": id, "class": NSStringFromClass(type(of: view)), "frame": rectangle(frame),
                    "offsetX": Double(scroll.contentOffset.x), "offsetY": Double(scroll.contentOffset.y),
                    "contentHeight": Double(scroll.contentSize.height), "contentWidth": Double(scroll.contentSize.width),
                    "dragging": scroll.isDragging, "tracking": scroll.isTracking, "decelerating": scroll.isDecelerating])
            }
            let childClip = view.clipsToBounds ? clip.intersection(frame) : clip
            for child in view.subviews { visit(child, hidden: hidden, clip: childClip) }
        }
        // UIView.convert uses UIKit geometry, including inversion transforms. No core-layout stand-in.
        visit(surface, hidden: false, clip: surface.bounds)
        return ["kind": kind, "nativeUptimeMs": uptime(), "journalSequence": sequence,
            "observedCounters": observedCounters as Any? ?? NSNull(), "markers": markers, "scrollViews": scrolls]
    }
    private func observe() {
        stopAt = ProcessInfo.processInfo.systemUptime + 4
        guard displayLink == nil else { return }
        let link = CADisplayLink(target: self, selector: #selector(frame(_:)))
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 60, maximum: 60, preferred: 60)
        link.add(to: .main, forMode: .common)
        displayLink = link
    }
    private func cachedPre(_ payload: [String: Any]) -> [String: Any] {
        guard let expected = payload["footerHold"] as? [String: Any],
              let scope = expected["scope"] as? String, let releases = expected["releases"] as? Int,
              let height = expected["minHeight"] as? Double, height > 0 else { return ["valid": false, "reason": "no-held-footprint"] }
        // Search a bounded recent sample suffix; freshness is checked separately by the offline judge.
        let recent = frames.suffix(180)
        guard let last = recent.last(where: { frame in
            guard let label = frame["observedCounters"] as? String, let data = label.data(using: .utf8),
                  let counters = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  let hold = counters["footerHold"] as? [String: Any] else { return false }
            return hold["scope"] as? String == scope && hold["releases"] as? Int == releases && hold["minHeight"] as? Double == height
        }), let t = last["nativeUptimeMs"] as? Double else { return ["valid": false, "reason": "no-cached-native-pre"] }
        let pre = recent.filter { (($0["nativeUptimeMs"] as? Double) ?? 0) >= t - 300 && (($0["nativeUptimeMs"] as? Double) ?? 0) <= t }
        return ["valid": true, "source": "existing-display-link-ring", "lastSampleSequence": last["sampleSequence"] ?? -1,
            "lastNativeUptimeMs": t, "receiptAgeMs": uptime() - t, "preSampleCount": pre.count,
            "firstSampleSequence": pre.first?["sampleSequence"] ?? -1]
    }
    @objc private func frame(_ link: CADisplayLink) {
        if surface == nil || !continuous && ProcessInfo.processInfo.systemUptime >= stopAt {
            link.invalidate(); displayLink = nil
            do { try flush() } catch { NSLog("HISTORY_TERMINAL_WRITE_ERROR %@", error.localizedDescription) }
            return
        }
        var value = capture(kind: "display-link")
        sampleSequence += 1
        value["sampleSequence"] = sampleSequence
        value["displayLinkTimestampMs"] = link.timestamp * 1000
        value["displayLinkTargetTimestampMs"] = link.targetTimestamp * 1000
        frames.append(value)
        let limit = continuous ? syncFrameLimit : 600
        if frames.count > limit { droppedFrames += frames.count - limit; frames.removeFirst(frames.count - limit) }
        if continuous, let t = value["nativeUptimeMs"] as? Double {
            let ready = postWindow.takeReady(atNativeSampleMs: t)
            if !ready.isEmpty {
                events.append(["nativeReceivedUptimeMs": uptime(), "nativeObservation": ["phase": "post-window-snapshot", "releaseIDs": ready,
                    "lastSampleSequence": sampleSequence, "lastPeriodicNativeMs": t, "observationSpanMs": TerminalPostWindow.observationSpanMs]])
                if events.count > 512 { events.removeFirst(events.count - 512) }
                // Asynchronous evidence publication after the unchanged four-second native prefix; never gates release.
                Task { [weak self] in
                    guard let self else { return }
                    do { _ = try await self.flushContinuous() } catch { NSLog("HISTORY_TERMINAL_WRITE_ERROR %@", error.localizedDescription) }
                }
            }
        }
    }
    private func flush() throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let envelope: [String: Any] = ["schema": 2, "clock": "ProcessInfo.systemUptime milliseconds; JS clock separate",
            "continuous": continuous, "buildIdentity": buildIdentity, "droppedFrames": droppedFrames,
            "frameRetentionLimit": continuous ? syncFrameLimit : 600, "eventRetentionLimit": 512, "events": events, "frames": frames]
        let data = try JSONSerialization.data(withJSONObject: envelope, options: [.sortedKeys])
        try data.write(to: directory.appendingPathComponent("captures.json"), options: .atomic)
    }
    private func flushContinuous() async throws -> Int {
        flushRevision += 1
        let revision = flushRevision
        // Freeze value snapshots here, serialize/write on the actor executor, not on UIKit's display-link path.
        let envelope: [String: Any] = ["schema": 2, "clock": "ProcessInfo.systemUptime milliseconds; JS clock separate",
            "continuous": true, "buildIdentity": buildIdentity, "droppedFrames": droppedFrames,
            "snapshotNativeUptimeMs": uptime(), "lastPeriodicNativeMs": frames.last?["nativeUptimeMs"] ?? NSNull(),
            "lastPeriodicSampleSequence": frames.last?["sampleSequence"] ?? NSNull(),
            "frameRetentionLimit": syncFrameLimit, "eventRetentionLimit": 512, "events": events, "frames": frames]
        return try await writer.write(envelope, to: directory, revision: revision)
    }
}
