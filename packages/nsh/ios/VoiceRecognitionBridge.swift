import Foundation
import CoreFoundation

#if canImport(UIKit) && canImport(NativeShell)
import UIKit
import AVFoundation
import NativeShell

@MainActor private final class VoicePermissionWait {
    var reply: CheckedContinuation<Bool, Never>?
    var result: Bool?
    func complete(_ value: Bool) { guard result == nil else { return }; result = value; reply?.resume(returning: value); reply = nil }
    func wait() async -> Bool {
        await withTaskCancellationHandler(operation: {
            await withCheckedContinuation { reply in
                if let result { reply.resume(returning: result); return }
                self.reply = reply
                if Task.isCancelled { complete(false); return }
                let complete: @Sendable (Bool) -> Void = { granted in Task { @MainActor in self.complete(granted) } }
                if #available(iOS 17.0, *) { AVAudioApplication.requestRecordPermission(completionHandler: complete) }
                else { AVAudioSession.sharedInstance().requestRecordPermission(complete) }
            }
        }, onCancel: { Task { @MainActor in self.complete(false) } })
    }
}

/// Recorder file IO runs away from the UI actor. Only validated, incremental PCM
/// reaches the core; temporary files are protected and never exposed to JS.
@MainActor private final class VoiceRecognitionRecorder: VoiceRecognitionAudio {
    private var recorder: AVAudioRecorder?
    private var file: URL?
    private var consumed = 0
    private var stopped = false
    private var activated = false
    func permission() async -> Bool {
        switch AVAudioSession.sharedInstance().recordPermission {
        case .granted: return true
        case .denied: return false
        default: return await VoicePermissionWait().wait()
        }
    }
    func start() throws {
        guard file == nil else { throw VoiceRecognitionFailure.audio }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".wav")
        file = url
        do {
            // Create with protection before AVAudioRecorder opens the destination.
            try Data().write(to: url, options: [.atomic, .completeFileProtection])
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement); try session.setActive(true); activated = true
            let settings: [String: Any] = [AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 16000,
                AVNumberOfChannelsKey: 1, AVLinearPCMBitDepthKey: 16, AVLinearPCMIsBigEndianKey: false,
                AVLinearPCMIsFloatKey: false, AVLinearPCMIsNonInterleaved: false]
            let recorder = try AVAudioRecorder(url: url, settings: settings); self.recorder = recorder
            guard recorder.prepareToRecord() else { throw VoiceRecognitionFailure.audio }
            try FileManager.default.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: url.path)
            guard recorder.record(forDuration: VoiceRecognitionPCM.maximumSeconds) else { throw VoiceRecognitionFailure.audio }
        } catch { try? cancel(); throw error }
    }
    func readPCM() async throws -> Data {
        guard let file, stopped || recorder?.isRecording == true else { throw VoiceRecognitionFailure.audio }
        let consumed = consumed, final = stopped
        let data = try await Task.detached(priority: .userInitiated) {
            let handle = try FileHandle(forReadingFrom: file); defer { try? handle.close() }
            let size = try handle.seekToEnd()
            guard size <= VoiceRecognitionPCM.maximumBytes + 65536 else { throw VoiceRecognitionFailure.limit }
            try handle.seek(toOffset: 0)
            let header = try handle.read(upToCount: 65536) ?? Data()
            guard let offset = try VoiceRecognitionPCM.payloadOffset(header) else {
                if final { throw VoiceRecognitionFailure.audio }; return Data()
            }
            guard size >= offset + consumed else { throw VoiceRecognitionFailure.audio }
            let available = Int(size) - offset - consumed
            guard available <= VoiceRecognitionPCM.maximumBytes - consumed else { throw VoiceRecognitionFailure.limit }
            guard !final || available % 2 == 0 else { throw VoiceRecognitionFailure.audio }
            try handle.seek(toOffset: UInt64(offset + consumed))
            let data = try handle.read(upToCount: available - available % 2) ?? Data()
            guard data.count % 2 == 0 else { throw VoiceRecognitionFailure.audio }; return data
        }.value
        guard self.file == file else { throw CancellationError() }
        self.consumed += data.count; return data
    }
    func stop() throws { guard file != nil else { throw VoiceRecognitionFailure.audio }; recorder?.stop(); stopped = true; try? deactivate() }
    private func deactivate() throws {
        if activated { try AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation); activated = false }
    }
    func cancel() throws {
        recorder?.stop(); recorder = nil
        // Attempt both independent cleanup operations even if one fails.
        var failure: Error?
        do { try deactivate() } catch { failure = error }
        if let file {
            do { if FileManager.default.fileExists(atPath: file.path) { try FileManager.default.removeItem(at: file) }; self.file = nil }
            catch { failure = error }
        }
        consumed = 0; stopped = false
        if failure != nil { throw VoiceRecognitionFailure.audio }
    }
}

@MainActor final class VoiceRecognitionBridge {
    private var core: VoiceRecognitionCore!
    private var observers: [NSObjectProtocol] = []
    /// Called on explicit start admission so main can stop the existing shared TTS
    /// owner. This bridge never changes SpeechPlaybackBridge's registrations.
    init(app: NshAppView, capture: @escaping (RuntimeHostScope) throws -> VoiceRecognitionTransport, beforeCapture: @escaping () -> Void) {
        core = VoiceRecognitionCore(capture: capture, audio: { VoiceRecognitionRecorder() }, beforeCapture: beforeCapture,
            foreground: { UIApplication.shared.applicationState == .active },
            partial: { [weak app] owner, revision, text in app?.send("voiceRecognition.partial", ["owner": owner, "revision": revision, "text": text]) },
            invalidated: { [weak app] owner, revision in app?.send("voiceRecognition.invalidated", ["owner": owner, "revision": revision]) })
        app.handle("voiceRecognition.capabilities") { input async throws -> Any? in
            guard let object = input as? [String: Any], object.isEmpty else { throw VoiceRecognitionFailure.invalid }
            return ["providers": ["local", "openai-compatible", "volcengine"], "maximumSeconds": 60, "maximumBytes": VoiceRecognitionPCM.maximumBytes]
        }
        app.handle("voiceRecognition.start") { [weak self] input async throws -> Any? in
            guard let self else { throw CancellationError() }
            return try await self.core.start(input)
        }
        app.handle("voiceRecognition.finish") { [weak self] input async throws -> Any? in
            guard let self else { throw CancellationError() }
            let request = try VoiceRecognitionRequest(input, start: false)
            return ["text": try await self.core.finish(owner: request.owner, revision: request.revision)]
        }
        app.handle("voiceRecognition.cancel") { [weak self] input async throws -> Any? in
            let request = try VoiceRecognitionRequest(input, start: false)
            try self?.core.cancel(owner: request.owner, revision: request.revision); return nil
        }
        for name in [UIApplication.willResignActiveNotification, UIApplication.didEnterBackgroundNotification,
                     AVAudioSession.interruptionNotification, AVAudioSession.mediaServicesWereResetNotification, AVAudioSession.routeChangeNotification] {
            observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in Task { @MainActor in self?.invalidate() } })
        }
    }
    deinit { for observer in observers { NotificationCenter.default.removeObserver(observer) } }
    func invalidate() { core.invalidate() }
}
#endif
