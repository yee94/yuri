import Foundation

@MainActor private final class FakeAudio: VoiceRecognitionAudio {
    var granted = true, starts = 0, stops = 0, cancels = 0, permissions = 0
    var chunks = [Data([1, 0, 2, 0])]
    var permissionWait: CheckedContinuation<Bool, Never>?
    var delayPermission = false
    var failCleanup = false
    func permission() async -> Bool { permissions += 1; if delayPermission { return await withCheckedContinuation { permissionWait = $0 } }; return granted }
    func start() throws { starts += 1 }
    func readPCM() async throws -> Data { chunks.isEmpty ? Data() : chunks.removeFirst() }
    func stop() throws { stops += 1 }
    func cancel() throws { cancels += 1; if failCleanup { failCleanup = false; throw VoiceRecognitionFailure.audio } }
}
@MainActor private final class FakeSocket {
    var messages: [VoiceRecognitionMessage] = [.text("{\"type\":\"ready\"}")]
    var waiting: CheckedContinuation<VoiceRecognitionMessage, Error>?
    var closed = false, id = "", chunks = [Data](), finalSeq: Int?
    var failFinal = false, text = "recognized"
    func emit(_ object: [String: Any]) throws {
        let message = VoiceRecognitionMessage.text(String(data: try JSONSerialization.data(withJSONObject: object), encoding: .utf8)!)
        if let waiting { self.waiting = nil; waiting.resume(returning: message) } else { messages.append(message) }
    }
    func socket() -> VoiceRecognitionSocket {
        VoiceRecognitionSocket(receive: {
            if self.closed { throw CancellationError() }
            if !self.messages.isEmpty { return self.messages.removeFirst() }
            return try await withCheckedThrowingContinuation { self.waiting = $0 }
        }, send: { raw in
            guard !self.closed, let value = try JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any], let type = value["type"] as? String else { throw VoiceRecognitionFailure.transport }
            switch type {
            case "start":
                self.id = value["dictationId"] as! String
                precondition(value["format"] as? String == "audio/pcm;rate=16000;bits=16;channels=1")
                try self.emit(["type": "ack", "dictationId": self.id, "ackSeq": -1])
            case "chunk":
                precondition(value["seq"] as? Int == self.chunks.count)
                self.chunks.append(Data(base64Encoded: value["audio"] as! String)!)
                try self.emit(["type": "ack", "dictationId": self.id, "ackSeq": self.chunks.count - 1])
                try self.emit(["type": "partial", "dictationId": self.id, "text": "live partial"])
            case "finish":
                self.finalSeq = value["finalSeq"] as? Int
                if self.failFinal { try self.emit(["type": "error", "dictationId": self.id, "error": "synthetic"]); return }
                try self.emit(["type": "finish_accepted", "dictationId": self.id, "timeoutMs": 1000])
                try self.emit(["type": "final", "dictationId": self.id, "text": self.text])
            default: preconditionFailure("Unexpected protocol")
            }
        }, close: {
            self.closed = true; self.waiting?.resume(throwing: CancellationError()); self.waiting = nil
        })
    }
}
@MainActor private final class Fixture {
    let audio = FakeAudio()
    var provider = "openai-compatible", configured = true, model = "fixture-model", current = true, foreground = true
    var settingsReads = 0, uploads = [Data](), sockets = [FakeSocket](), partials = [String](), invalidations = 0
    var failFile = false, failStreamOnce = false
    var now: TimeInterval = 100
    var ttsStops = 0, factories = 0, delaySettings = false
    var settingsWait: CheckedContinuation<VoiceRecognitionResponse, Error>?
    let expectedHost = RuntimeHostScope(hostID: "fixture", lease: UUID())
    var fileWait: CheckedContinuation<VoiceRecognitionResponse, Error>?, delayFile = false
    var openWait: CheckedContinuation<VoiceRecognitionSocket, Error>?, delayOpen = false
    lazy var core = VoiceRecognitionCore(capture: { expected in
        guard expected == self.expectedHost else { throw RuntimeHostScopeFailure.stale }; return self.transport()
    }, audio: { self.factories += 1; return self.audio }, beforeCapture: { self.ttsStops += 1 }, foreground: { self.foreground }, partial: { _, _, text in self.partials.append(text) }, invalidated: { _, _ in self.invalidations += 1 }, now: { self.now })
    func settings() async throws -> VoiceRecognitionResponse {
        settingsReads += 1
        if delaySettings { return try await withCheckedThrowingContinuation { settingsWait = $0 } }
        return try savedSettings()
    }
    func savedSettings() throws -> VoiceRecognitionResponse {
        return VoiceRecognitionResponse(status: 200, mime: "application/json", data: try JSONSerialization.data(withJSONObject: ["sttProvider": provider, "configured": configured, "sttServerUrl": "fixture-config-not-exposed", "sttModel": model]))
    }
    func transport() -> VoiceRecognitionTransport {
        VoiceRecognitionTransport(settings: { try await self.settings() }, transcribe: { data in
            self.uploads.append(data)
            if self.delayFile { return try await withCheckedThrowingContinuation { self.fileWait = $0 } }
            if self.failFile { self.failFile = false; throw VoiceRecognitionFailure.transport }
            return VoiceRecognitionResponse(status: 200, mime: "application/json", data: Data("{\"transcript\":\"\"}".utf8))
        }, open: {
            if self.delayOpen { return try await withCheckedThrowingContinuation { self.openWait = $0 } }
            let socket = FakeSocket(); socket.failFinal = self.failStreamOnce; self.failStreamOnce = false; self.sockets.append(socket); return socket.socket()
        }, isCurrent: { self.current })
    }
    func start(_ revision: Int = 1) async throws { _ = try await core.start(owner: "fixture", revision: revision, provider: provider, expectedHost: expectedHost) }
    func cancel(_ revision: Int = 1) { try! core.cancel(owner: "fixture", revision: revision) }
}

@main struct RecognitionChecks {
    @MainActor static func eventually(_ condition: () -> Bool) async throws {
        let deadline = ProcessInfo.processInfo.systemUptime + 2
        while !condition() { guard ProcessInfo.processInfo.systemUptime < deadline else { throw VoiceRecognitionFailure.transport }; try await Task.sleep(nanoseconds: 1_000_000) }
    }
    @MainActor static func main() async throws {
        let pcm = Data([1, 0, 2, 0]), wav = try VoiceRecognitionPCM.wav(pcm)
        let offset = try VoiceRecognitionPCM.payloadOffset(wav); precondition(offset == 44)
        precondition(wav.suffix(4) == pcm)
        do { _ = try VoiceRecognitionPCM.wav(Data([1])); preconditionFailure() } catch {}
        do { _ = try VoiceRecognitionPCM.wav(Data(repeating: 0, count: VoiceRecognitionPCM.maximumBytes + 2)); preconditionFailure() } catch {}
        do { _ = try VoiceRecognitionPCM.transcript(VoiceRecognitionResponse(status: 200, mime: "application/json", data: Data("{}".utf8))); preconditionFailure() } catch {}

        let file = Fixture(); try await file.start()
        let empty = try await file.core.finish(owner: "fixture", revision: 1)
        precondition(empty == "" && file.audio.starts == 1 && file.audio.stops == 1 && file.uploads == [wav])
        _ = try await file.core.finish(owner: "fixture", revision: 1)
        precondition(file.uploads.count == 1); file.cancel()

        let denied = Fixture(); denied.audio.granted = false
        do { try await denied.start(); preconditionFailure() } catch VoiceRecognitionFailure.permissionDenied {}
        precondition(denied.audio.starts == 0 && denied.uploads.isEmpty)
        denied.audio.granted = true; try await denied.start(2); denied.cancel(2)

        let retry = Fixture(); retry.failFile = true; try await retry.start()
        do { _ = try await retry.core.finish(owner: "fixture", revision: 1); preconditionFailure() } catch {}
        _ = try await retry.core.finish(owner: "fixture", revision: 1)
        precondition(retry.audio.starts == 1 && retry.audio.stops == 1 && retry.uploads == [wav, wav]); retry.cancel()

        let stream = Fixture(); stream.provider = "volcengine"; try await stream.start()
        try await Task.sleep(nanoseconds: 260_000_000)
        precondition(stream.partials == ["live partial"] && stream.uploads.isEmpty)
        let recognized = try await stream.core.finish(owner: "fixture", revision: 1)
        precondition(recognized == "recognized" && stream.sockets[0].chunks == [pcm] && stream.sockets[0].closed && stream.sockets[0].finalSeq == 0); stream.cancel()

        let replay = Fixture(); replay.provider = "local"; replay.failStreamOnce = true; try await replay.start()
        do { _ = try await replay.core.finish(owner: "fixture", revision: 1); preconditionFailure() } catch {}
        let replayed = try await replay.core.finish(owner: "fixture", revision: 1)
        precondition(replayed == "recognized" && replay.sockets.count == 2 && replay.sockets.allSatisfy { $0.chunks == [pcm] && $0.closed } && replay.audio.starts == 1); replay.cancel()
        let silence = Fixture(); silence.provider = "local"; try await silence.start(); silence.sockets[0].text = ""
        let silentText = try await silence.core.finish(owner: "fixture", revision: 1)
        precondition(silentText == "" && silence.audio.stops == 1); silence.cancel()

        let changed = Fixture(); try await changed.start(); changed.model = "new-model"
        do { _ = try await changed.core.finish(owner: "fixture", revision: 1); preconditionFailure() } catch VoiceRecognitionFailure.settingsChanged {}
        precondition(changed.uploads.isEmpty); changed.cancel()
        let unknown = Fixture(); unknown.provider = "unknown"
        do { try await unknown.start(); preconditionFailure() } catch VoiceRecognitionFailure.invalid {}
        precondition(unknown.audio.starts == 0)

        let permission = Fixture(); permission.audio.delayPermission = true
        let pending = Task { try await permission.start() }
        while permission.audio.permissionWait == nil { await Task.yield() }
        permission.cancel(); permission.audio.permissionWait?.resume(returning: true); permission.audio.permissionWait = nil
        do { try await pending.value; preconditionFailure() } catch {}
        precondition(permission.audio.starts == 0)

        let opening = Fixture(); opening.provider = "volcengine"; opening.delayOpen = true
        let pendingOpen = Task { try await opening.start() }
        while opening.openWait == nil { await Task.yield() }
        opening.cancel(); let late = FakeSocket(); opening.openWait?.resume(returning: late.socket()); opening.openWait = nil
        do { try await pendingOpen.value; preconditionFailure() } catch {}
        precondition(late.closed && opening.audio.starts == 0)

        let lateResult = Fixture(); lateResult.delayFile = true; try await lateResult.start()
        let finishing = Task { try await lateResult.core.finish(owner: "fixture", revision: 1) }
        while lateResult.fileWait == nil { await Task.yield() }
        lateResult.cancel(); lateResult.delayFile = false; try await lateResult.start(2)
        lateResult.fileWait?.resume(returning: VoiceRecognitionResponse(status: 200, mime: "application/json", data: Data("{\"transcript\":\"late\"}".utf8))); lateResult.fileWait = nil
        do { _ = try await finishing.value; preconditionFailure() } catch {}
        precondition(lateResult.audio.starts == 2); lateResult.cancel(2)

        let background = Fixture(); try await background.start(); background.foreground = false
        try await Task.sleep(nanoseconds: 260_000_000)
        precondition(background.invalidations == 1 && background.audio.cancels > 0 && background.uploads.isEmpty)
        let generation = Fixture(); try await generation.start(); generation.current = false
        try await Task.sleep(nanoseconds: 260_000_000)
        precondition(generation.invalidations == 1 && generation.audio.cancels > 0)
        let duration = Fixture(); try await duration.start(); duration.now += 61
        try await Task.sleep(nanoseconds: 260_000_000)
        precondition(duration.invalidations == 1 && duration.audio.cancels > 0 && duration.uploads.isEmpty)

        let oversized = Fixture(); oversized.audio.chunks = [Data(repeating: 0, count: VoiceRecognitionPCM.maximumBytes + 2)]; try await oversized.start()
        do { _ = try await oversized.core.finish(owner: "fixture", revision: 1); preconditionFailure() } catch VoiceRecognitionFailure.limit {}
        precondition(oversized.uploads.isEmpty); oversized.cancel()
        let preCancelled = Fixture()
        let neverStart = Task { try await preCancelled.start() }; neverStart.cancel()
        do { try await neverStart.value; preconditionFailure() } catch is CancellationError {}
        precondition(preCancelled.ttsStops == 0 && preCancelled.factories == 0 && preCancelled.settingsReads == 0 && preCancelled.audio.permissions == 0 && preCancelled.audio.starts == 0 && preCancelled.uploads.isEmpty && preCancelled.sockets.isEmpty)

        let pendingSettings = Fixture(); pendingSettings.delaySettings = true
        let cancellingSettings = Task { try await pendingSettings.start() }
        try await eventually { pendingSettings.settingsWait != nil }
        cancellingSettings.cancel(); try await eventually { pendingSettings.audio.cancels > 0 }
        pendingSettings.delaySettings = false
        try await pendingSettings.start(2)
        pendingSettings.settingsWait?.resume(returning: try pendingSettings.savedSettings()); pendingSettings.settingsWait = nil
        do { try await cancellingSettings.value; preconditionFailure() } catch is CancellationError {}
        precondition(pendingSettings.audio.permissions == 1 && pendingSettings.audio.starts == 1 && pendingSettings.uploads.isEmpty && pendingSettings.sockets.isEmpty)
        // Late old completion cannot cancel or replace the newer lease.
        _ = try await pendingSettings.core.finish(owner: "fixture", revision: 2); pendingSettings.cancel(2)

        let pendingPermission = Fixture(); pendingPermission.audio.delayPermission = true
        let cancellingPermission = Task { try await pendingPermission.start() }
        try await eventually { pendingPermission.audio.permissionWait != nil }
        cancellingPermission.cancel(); try await eventually { pendingPermission.audio.cancels > 0 }
        pendingPermission.audio.permissionWait?.resume(returning: true); pendingPermission.audio.permissionWait = nil
        do { try await cancellingPermission.value; preconditionFailure() } catch is CancellationError {}
        precondition(pendingPermission.audio.starts == 0 && pendingPermission.uploads.isEmpty && pendingPermission.sockets.isEmpty)

        let racingPermission = Fixture(); racingPermission.audio.delayPermission = true
        let cancellingAtResume = Task { try await racingPermission.start() }
        try await eventually { racingPermission.audio.permissionWait != nil }
        cancellingAtResume.cancel()
        // Resume immediately, before the MainActor cancellation cleanup can run.
        // The child Task's cancellation flag must already block audio/WS startup.
        racingPermission.audio.permissionWait?.resume(returning: true); racingPermission.audio.permissionWait = nil
        do { try await cancellingAtResume.value; preconditionFailure() } catch is CancellationError {}
        precondition(racingPermission.audio.starts == 0 && racingPermission.uploads.isEmpty && racingPermission.sockets.isEmpty)

        let unfinished = Fixture(); unfinished.audio.delayPermission = true
        let acquiring = Task { try await unfinished.start() }
        try await eventually { unfinished.audio.permissionWait != nil }
        do { _ = try await unfinished.core.finish(owner: "fixture", revision: 1); preconditionFailure() } catch VoiceRecognitionFailure.unavailable {}
        precondition(unfinished.uploads.isEmpty && unfinished.sockets.isEmpty && unfinished.audio.starts == 0 && unfinished.settingsReads == 1)
        unfinished.audio.permissionWait?.resume(returning: true); unfinished.audio.permissionWait = nil
        try await acquiring.value
        _ = try await unfinished.core.finish(owner: "fixture", revision: 1)
        try await Task.sleep(nanoseconds: 220_000_000)
        precondition(unfinished.audio.starts == 1 && unfinished.audio.stops == 1 && unfinished.uploads.count == 1)
        unfinished.cancel()
        let finalCleanup = Fixture(); try await finalCleanup.start(); finalCleanup.audio.failCleanup = true
        do { _ = try await finalCleanup.core.finish(owner: "fixture", revision: 1); preconditionFailure() } catch VoiceRecognitionFailure.audio {}
        let retainedText = try await finalCleanup.core.finish(owner: "fixture", revision: 1)
        precondition(retainedText == "" && finalCleanup.uploads.count == 1); finalCleanup.cancel()
        let cleanup = Fixture(); try await cleanup.start(); cleanup.audio.failCleanup = true
        do { try cleanup.core.cancel(owner: "fixture", revision: 1); preconditionFailure() } catch VoiceRecognitionFailure.audio {}
        do { try await cleanup.start(2); preconditionFailure() } catch VoiceRecognitionFailure.unavailable {}
        cleanup.cancel(); try await cleanup.start(2); cleanup.cancel(2)
        print("Native configured ASR fake-audio / synthetic-transport checks passed")
    }
}
