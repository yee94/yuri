import Foundation
import CoreFoundation

/// Data-only allowlist. Credentials and audio never enter the NSH runtime.
struct NativeSpeechSettings {
    let provider: String
    let mode: String
    let visible: Bool
    let rate: Double
    let pitch: Double
    let volume: Double
    let voice: String
    init(_ data: Data) throws {
        guard data.count <= 65536, let value = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let provider = value["voiceProvider"] as? String,
              ["browser", "local", "say", "openai", "openai-compatible", "volcengine"].contains(provider),
              let mode = value["ttsInputMode"] as? String, ["final", "sanitized", "raw", "summarized"].contains(mode),
              let flag = value["showMessageTTSButtons"] as? NSNumber, CFGetTypeID(flag) == CFBooleanGetTypeID() else { throw SpeechFailure.invalid }
        func number(_ key: String, _ range: ClosedRange<Double>) throws -> Double {
            guard let n = value[key] as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite, range.contains(n.doubleValue) else { throw SpeechFailure.invalid }
            return n.doubleValue
        }
        self.provider = provider; self.mode = mode; self.visible = flag.boolValue
        rate = try number("speechRate", 0.5...2); pitch = try number("speechPitch", 0.5...2); volume = try number("speechVolume", 0...1)
        voice = value["browserVoice"] as? String ?? ""
    }
    var route: String? {
        switch provider { case "browser": return nil; case "local": return "/api/dictation/tts/speak"; case "say": return "/api/tts/say/speak"; default: return "/api/tts/speak" }
    }
    var publicValue: [String: Any] { ["provider": provider, "mode": mode, "visible": visible] }
}
enum SpeechFailure: LocalizedError {
    case invalid, unavailable, audio
    var errorDescription: String? { "原生朗读失败，请重试或检查语音设置" }
}
struct NativeSpeechSegment {
    let text: String
    let revision: Int
    let source: String
    init(_ input: Any?, owner: String, revision: Int) throws {
        guard let value = input as? [String: Any], Set(value.keys).isSubset(of: ["owner", "revision", "text", "source"]),
               value["owner"] as? String == owner, !owner.isEmpty,
               let number = value["revision"] as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
               number.doubleValue == Double(number.intValue), number.intValue > revision,
               let text = value["text"] as? String, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, text.utf8.count <= 4096 else { throw SpeechFailure.invalid }
        let source = value["source"] ?? "manual"
        guard let source = source as? String, ["manual", "auto-read", "settings-preview"].contains(source) else { throw SpeechFailure.invalid }
        self.text = text; self.revision = number.intValue; self.source = source
    }
    func validatePlayback(visible: Bool, current: Bool, foreground: Bool) throws {
        guard (visible || source == "auto-read" || source == "settings-preview"), current, foreground else { throw SpeechFailure.invalid }
    }
}
struct NativeSpeechAwakeRequest {
    let revision: Int
    let enabled: Bool
    init(_ input: Any?, owner: String, revision: Int) throws {
        guard let value = input as? [String: Any], Set(value.keys) == ["owner", "revision", "enabled"],
              value["owner"] as? String == owner, !owner.isEmpty,
              let number = value["revision"] as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue == Double(number.intValue), number.intValue > revision,
              let enabled = value["enabled"] as? NSNumber, CFGetTypeID(enabled) == CFBooleanGetTypeID() else { throw SpeechFailure.invalid }
        self.revision = number.intValue; self.enabled = enabled.boolValue
    }
    func response(current: Bool, foreground: Bool) throws -> [String: Any] {
        guard !enabled || (current && foreground) else { throw SpeechFailure.invalid }
        // UIKit exposes an app-wide Bool, not a releasable assertion. Without the app's
        // common idle-timer owner, restoring it could clear another holder's request.
        // Report the gap; never mutate another feature's idleTimerDisabled state.
        return ["supported": false, "enabled": false]
    }
}
struct NativeSpeechAudio {
    let pitch: Double
    let volume: Double
    init(status: Int, mime: String, data: Data, pitch: String?, volume: String?, settings: NativeSpeechSettings) throws {
        guard (200..<300).contains(status), mime.lowercased().hasPrefix("audio/"), !data.isEmpty, data.count <= 16 * 1024 * 1024 else { throw SpeechFailure.audio }
        let p = pitch.flatMap(Double.init) ?? (pitch == nil ? settings.pitch : .nan)
        let v = volume.flatMap(Double.init) ?? (volume == nil ? settings.volume : .nan)
        guard p.isFinite, (0.5...2).contains(p), v.isFinite, (0...1).contains(v) else { throw SpeechFailure.audio }
        self.pitch = p; self.volume = v
    }
}

#if canImport(UIKit) && canImport(NativeShell)
import UIKit
import AVFoundation
import NativeShell

/// One page lease and one native player. Network tasks retain the captured Host fence.
@MainActor final class SpeechPlaybackBridge: NSObject, @preconcurrency AVSpeechSynthesizerDelegate, @preconcurrency AVAudioPlayerDelegate {
    private weak var app: NshAppView?
    private let capture: () throws -> ResourceTransport
    private var transport: ResourceTransport?
    private var settings: NativeSpeechSettings?
    private var owner = ""
    private var revision = 0
    private var awakeRevision = 0
    private var preparing: UUID?
    private var fetching: Task<SpeechResourceResponse, Error>?
    private var completion: CheckedContinuation<Void, Error>?
    private var synthesizer: AVSpeechSynthesizer?
    private var player: AVAudioPlayer?
    private var engine: AVAudioEngine?
    private var node: AVAudioPlayerNode?
    private var temporary: URL?
    private var watchdog: Task<Void, Never>?
    private var observers: [NSObjectProtocol] = []
    init(app: NshAppView, capture: @escaping () throws -> ResourceTransport) {
        self.app = app; self.capture = capture
        super.init()
        app.handle("speech.prepare") { [weak self] input async throws -> Any? in
            guard let self, let value = input as? [String: Any], Set(value.keys) == ["owner"], let owner = value["owner"] as? String, !owner.isEmpty, owner.utf8.count <= 128 else { throw SpeechFailure.invalid }
            self.invalidate()
            let ticket = UUID(); self.preparing = ticket
            let transport = try self.capture()
            guard let read = transport.speech else { throw SpeechFailure.unavailable }
            let task = Task { try await read("/api/voice/settings", nil) }; self.fetching = task
            let response = try await task.value
            guard self.preparing == ticket, transport.isCurrent(), UIApplication.shared.applicationState == .active else { throw CancellationError() }
            self.fetching = nil; self.preparing = nil
            guard (200..<300).contains(response.status), response.mime.lowercased().hasPrefix("application/json") else { throw SpeechFailure.unavailable }
            let settings = try NativeSpeechSettings(response.data)
            self.owner = owner; self.transport = transport; self.settings = settings
            return settings.publicValue
        }
        app.handle("speech.segment") { [weak self] input async throws -> Any? in
            guard let self else { throw CancellationError() }
            try await self.segment(input); return nil
        }
        app.handle("speech.stop") { [weak self] input async throws -> Any? in
            guard let self, let value = input as? [String: Any], Set(value.keys) == ["owner", "revision"], value["owner"] as? String == self.owner,
                  let revision = value["revision"] as? Int, revision >= self.revision else { return nil }
            self.revision = revision; self.stop(); return nil
        }
        app.handle("speech.release") { [weak self] input async throws -> Any? in
            if let self, (input as? [String: Any])?["owner"] as? String == self.owner { self.invalidate() }; return nil
        }
        app.handle("speech.awake") { [weak self] input async throws -> Any? in
            guard let self else { throw CancellationError() }
            let request = try NativeSpeechAwakeRequest(input, owner: self.owner, revision: self.awakeRevision)
            let response = try request.response(current: self.settings != nil && self.transport?.isCurrent() == true, foreground: UIApplication.shared.applicationState == .active)
            self.awakeRevision = request.revision
            return response
        }
        for name in [UIApplication.willResignActiveNotification, UIApplication.didEnterBackgroundNotification, AVAudioSession.interruptionNotification, AVAudioSession.mediaServicesWereResetNotification, AVAudioSession.routeChangeNotification] {
            observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] note in
                // A route addition need not stop playback; unplugging headphones must.
                if name == AVAudioSession.routeChangeNotification, (note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt) != AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue { return }
                Task { @MainActor [weak self] in self?.invalidate() }
            })
        }
    }
    deinit { for observer in observers { NotificationCenter.default.removeObserver(observer) } }
    func invalidate() {
        let previous = owner
        owner = ""; preparing = nil; settings = nil; transport = nil; revision = 0; awakeRevision = 0; stop()
        if !previous.isEmpty { app?.send("speech.invalidated", ["owner": previous]) }
    }
    private func stop() {
        watchdog?.cancel(); watchdog = nil
        fetching?.cancel(); fetching = nil
        let pending = completion; completion = nil
        synthesizer?.delegate = nil; synthesizer?.stopSpeaking(at: .immediate); synthesizer = nil
        player?.delegate = nil; player?.stop(); player = nil
        node?.stop(); engine?.stop(); node = nil; engine = nil
        if let temporary { try? FileManager.default.removeItem(at: temporary) }; temporary = nil
        pending?.resume(throwing: CancellationError())
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
    private func segment(_ input: Any?) async throws {
        let segment = try NativeSpeechSegment(input, owner: owner, revision: revision)
        let text = segment.text, next = segment.revision
        guard let settings, let transport else { throw SpeechFailure.invalid }
        try segment.validatePlayback(visible: settings.visible, current: transport.isCurrent(), foreground: UIApplication.shared.applicationState == .active)
        stop(); revision = next
        let capturedOwner = owner
        func current() -> Bool { self.owner == capturedOwner && self.revision == next && transport.isCurrent() && UIApplication.shared.applicationState == .active }
        do {
            var bytes: Data?
            var audio: NativeSpeechAudio?
            if let route = settings.route {
                guard let read = transport.speech else { throw SpeechFailure.unavailable }
                let task = Task { try await read(route, text) }; fetching = task
                let response = try await task.value
                guard current() else { throw CancellationError() }
                fetching = nil
                audio = try NativeSpeechAudio(status: response.status, mime: response.mime, data: response.data, pitch: response.pitch, volume: response.volume, settings: settings)
                bytes = response.data
            }
            guard current() else { throw CancellationError() }
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .spokenAudio); try session.setActive(true)
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                completion = continuation
                watchdog = Task { [weak self] in
                    do { try await Task.sleep(nanoseconds: 180_000_000_000) } catch { return }
                    if current() { self?.finish(SpeechFailure.audio) }
                }
                do {
                    if let bytes, let audio { try play(bytes, pitch: audio.pitch, volume: audio.volume, current: current) }
                    else {
                        let utterance = AVSpeechUtterance(string: text)
                        if !settings.voice.isEmpty {
                            guard let voice = AVSpeechSynthesisVoice.speechVoices().first(where: { $0.identifier == settings.voice || $0.name == settings.voice }) else { throw SpeechFailure.unavailable }
                            utterance.voice = voice
                        }
                        let rate = AVSpeechUtteranceDefaultSpeechRate * Float(settings.rate)
                        guard rate >= AVSpeechUtteranceMinimumSpeechRate, rate <= AVSpeechUtteranceMaximumSpeechRate, settings.pitch >= 0.5 else { throw SpeechFailure.unavailable }
                        utterance.rate = rate; utterance.pitchMultiplier = Float(settings.pitch); utterance.volume = Float(settings.volume)
                        let synth = AVSpeechSynthesizer(); synthesizer = synth; synth.delegate = self; synth.speak(utterance)
                    }
                    if bytes != nil { app?.send("speech.playing", ["owner": capturedOwner, "revision": next]) }
                } catch { finish(error) }
            }
            guard current() else { throw CancellationError() }
        } catch {
            if current() { stop() }
            throw error is CancellationError ? CancellationError() : SpeechFailure.audio
        }
    }
    private func play(_ bytes: Data, pitch: Double, volume: Double, current: @escaping () -> Bool) throws {
        if pitch == 1 {
            let audio = try AVAudioPlayer(data: bytes); player = audio; audio.delegate = self; audio.volume = Float(volume)
            guard audio.prepareToPlay(), audio.play() else { throw SpeechFailure.audio }
        } else {
            // Web playbackRate changes pitch and duration together. Varispeed preserves that contract.
            let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".audio")
            temporary = url
            try bytes.write(to: url, options: [.atomic, .completeFileProtection])
            let file = try AVAudioFile(forReading: url)
            let engine = AVAudioEngine(), node = AVAudioPlayerNode(), speed = AVAudioUnitVarispeed()
            self.engine = engine; self.node = node; speed.rate = Float(pitch); node.volume = Float(volume)
            engine.attach(node); engine.attach(speed); engine.connect(node, to: speed, format: file.processingFormat); engine.connect(speed, to: engine.mainMixerNode, format: file.processingFormat)
            node.scheduleFile(file, at: nil, completionCallbackType: .dataPlayedBack) { [weak self] _ in
                Task { @MainActor [weak self] in if current() { self?.finish(nil) } }
            }
            try engine.start(); node.play()
        }
    }
    private func finish(_ error: Error?) {
        let pending = completion; completion = nil
        stop()
        if let error { pending?.resume(throwing: error) } else { pending?.resume() }
    }
    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) { if self.synthesizer === synthesizer { finish(nil) } }
    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) { if self.synthesizer === synthesizer { app?.send("speech.playing", ["owner": owner, "revision": revision]) } }
    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) { if self.synthesizer === synthesizer { finish(CancellationError()) } }
    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) { if self.player === player { finish(flag ? nil : SpeechFailure.audio) } }
    func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) { if self.player === player { finish(SpeechFailure.audio) } }
}
#endif
