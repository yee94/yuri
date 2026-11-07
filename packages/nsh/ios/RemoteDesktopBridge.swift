import Foundation
import UIKit
import ImageIO
import CoreFoundation
import Network
import NativeShell

enum RemoteDesktopWireMessage {
    case text(String)
    case binary(Data)
    case closed(Int)
}

/// Implemented by the captured RuntimeBridge owner, never by JS or this feature.
/// Direct upgrades use the owner's credential/origin/redirect policy. Relay upgrades
/// MUST use the existing encrypted, paired-client-authorized mux, not a direct URL.
/// Socket messages retain their text/binary boundary after Relay fragmentation.
@MainActor struct RemoteDesktopSocket {
    let receive: () async throws -> RemoteDesktopWireMessage
    let send: (String) async throws -> Void
    let close: () -> Void
}

@MainActor struct RemoteDesktopTransport {
    /// Exact GET /api/remote-desktop via the existing authenticated JSON transport.
    let capability: () async throws -> (status: Int, body: [String: Any])
    /// Exact /api/remote-desktop/ws; mint fresh scoped URL auth for every attempt
    /// where the transport cannot carry Authorization. No long-lived token in URLs.
    /// Enforce incoming message <=512 KiB, outgoing <=96 KiB, bounded buffering,
    /// origin validation and cancellation in the RuntimeBridge/Relay implementation.
    let open: () async throws -> RemoteDesktopSocket
    /// Captured Host AND generation. A LAN/Relay/Host change invalidates this owner.
    let isCurrent: () -> Bool
}

struct RemoteDesktopBridgeFailure: Error { let code: String }

/// A deadline does not wait for a cancelled, non-cooperative transport to settle.
/// A late socket is explicitly closed rather than leaked or adopted by a retry.
@MainActor private final class DesktopDeadline<Value> {
    private var completion: CheckedContinuation<Value, Error>?
    private var work: Task<Void, Never>?
    private var timer: Task<Void, Never>?
    private var completed = false
    private let discard: (Value) -> Void
    init(discard: @escaping (Value) -> Void) { self.discard = discard }
    func run(seconds: UInt64, operation: @escaping @MainActor () async throws -> Value) async throws -> Value {
        try await withTaskCancellationHandler(operation: {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { continuation in
                guard !completed else { continuation.resume(throwing: CancellationError()); return }
                completion = continuation
                work = Task { [self] in
                    do { finish(.success(try await operation())) } catch { finish(.failure(error)) }
                }
                timer = Task { [self] in
                    do { try await Task.sleep(nanoseconds: seconds * 1_000_000_000) } catch { return }
                    finish(.failure(RemoteDesktopBridgeFailure(code: "connection_failed")))
                }
            }
        }, onCancel: { Task { @MainActor [self] in finish(.failure(CancellationError())) } })
    }
    private func finish(_ result: Result<Value, Error>) {
        guard !completed else { if case .success(let value) = result { discard(value) }; return }
        completed = true
        let reply = completion; completion = nil
        timer?.cancel(); timer = nil; work?.cancel(); work = nil
        reply?.resume(with: result)
    }
}

/// Native capture receiver only: no permission prompts, Host settings writes, WebView,
/// new network session, stored credential, frame persistence or input replay.
@MainActor final class RemoteDesktopBridge: NSObject {
    @MainActor private final class Session {
        let owner: String
        let transport: RemoteDesktopTransport
        var task: Task<Void, Never>?
        var heartbeat: Task<Void, Never>?
        var frameDeadline: Task<Void, Never>?
        var writer: Task<Void, Error>?
        var writerID: UUID?
        var retryWait: Task<Void, Never>?
        var retryWaitID: UUID?
        var queued = 0
        var socket: RemoteDesktopSocket?
        var attempt = UUID()
        var attemptError: String?
        var frameSequence = 0
        var pendingFrame: Int?
        var live = false
        var failures = 0
        var desiredZoom: Bool
        var sentZoom = false
        var zoomSupported = false
        var syncingZoom = false
        var fallback = false
        var inputCount = 0
        var inputWindow = ProcessInfo.processInfo.systemUptime
        var startupDeadline: TimeInterval = 0
        var terminal = false
        init(owner: String, transport: RemoteDesktopTransport, zoomed: Bool) {
            self.owner = owner; self.transport = transport; desiredZoom = zoomed
        }
    }
    private weak var app: NshAppView?
    private let capture: () throws -> RemoteDesktopTransport
    private var session: Session?
    private let network = NWPathMonitor()
    private var online = true
    init(app: NshAppView, capture: @escaping () throws -> RemoteDesktopTransport) {
        self.app = app; self.capture = capture
        super.init()
        app.handle("remoteDesktop.open") { [weak self] input async throws -> Any? in
            guard let self else { throw CancellationError() }
            try self.open(input); return true
        }
        app.handle("remoteDesktop.close") { [weak self] input async throws -> Any? in
            guard let self else { return true }
            if let owner = (input as? [String: Any])?["owner"] as? String, self.session?.owner == owner { self.stopSession() }
            return true
        }
        app.handle("remoteDesktop.input") { [weak self] input async throws -> Any? in
            guard let self else { throw CancellationError() }
            let value = try self.owned(input)
            guard value.live else { throw RemoteDesktopBridgeFailure(code: "connection_failed") }
            let now = ProcessInfo.processInfo.systemUptime
            if now - value.inputWindow >= 1 { value.inputWindow = now; value.inputCount = 0 }
            value.inputCount += 1
            guard value.inputCount <= 128, let message = (input as? [String: Any])?["input"] as? [String: Any] else { throw RemoteDesktopBridgeFailure(code: "rate_limited") }
            try await self.send(try Self.projectInput(message), value, value.attempt)
            return true
        }
        app.handle("remoteDesktop.view") { [weak self] input async throws -> Any? in
            guard let self else { throw CancellationError() }
            let value = try self.owned(input)
            guard let zoomed = Self.boolean((input as? [String: Any])?["zoomed"]) else { throw RemoteDesktopBridgeFailure(code: "invalid_message") }
            value.desiredZoom = zoomed
            try await self.syncZoom(value, value.attempt)
            return true
        }
        app.handle("remoteDesktop.ack") { [weak self] input async throws -> Any? in
            guard let self else { throw CancellationError() }
            let value = try self.owned(input), token = value.attempt
            guard let frame = Self.number((input as? [String: Any])?["frame"]), frame.rounded() == frame,
                  value.pendingFrame.map({ Double($0) == frame }) == true else { throw RemoteDesktopBridgeFailure(code: "invalid_message") }
            value.pendingFrame = nil; value.frameDeadline?.cancel(); value.frameDeadline = nil
            try await self.send(["type": "ack"], value, token)
            guard self.current(value, token) else { throw CancellationError() }
            value.failures = 0
            if !value.live { value.live = true; self.state(value, "live") }
            return true
        }
        NotificationCenter.default.addObserver(self, selector: #selector(background), name: UIApplication.didEnterBackgroundNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(foreground), name: UIApplication.didBecomeActiveNotification, object: nil)
        network.pathUpdateHandler = { [weak self] path in
            let available = path.status == .satisfied
            Task { @MainActor [weak self] in
                guard let self else { return }
                let recovered = !self.online && available
                self.online = available
                if recovered { self.session?.retryWait?.cancel() }
            }
        }
        network.start(queue: DispatchQueue(label: "Yuri.RemoteDesktop.Reachability"))
    }
    deinit { network.cancel(); NotificationCenter.default.removeObserver(self) }
    @objc private func background() {
        guard let value = session else { return }
        if !value.terminal { state(value, "paused") }
        value.task?.cancel(); value.task = nil
        value.retryWait?.cancel(); value.retryWait = nil; value.retryWaitID = nil
        stopAttempt(value)
    }
    @objc private func foreground() {
        // The native boundary also recovers if QuickJS was suspended before it could
        // process its background effect. It never revives an explicitly denied session.
        guard let value = session, value.task == nil, !value.terminal else { return }
        guard value.transport.isCurrent() else { invalidate(); return }
        value.task = Task { [weak self, weak value] in
            guard let self, let value else { return }; await self.run(value)
        }
    }
    /// Chain into RuntimeBridge.onInvalidate and native controller teardown.
    func invalidate() {
        guard let value = session else { return }
        state(value, "closed", "runtime_changed")
        stopSession()
    }
    private func stopSession() {
        guard let value = session else { return }
        session = nil; value.task?.cancel(); value.retryWait?.cancel(); value.retryWait = nil; value.retryWaitID = nil; stopAttempt(value)
    }
    private func owned(_ input: Any?) throws -> Session {
        guard let value = session, value.owner == (input as? [String: Any])?["owner"] as? String,
              value.transport.isCurrent(), UIApplication.shared.applicationState == .active else { throw CancellationError() }
        return value
    }
    private func open(_ input: Any?) throws {
        guard UIApplication.shared.applicationState == .active,
              let args = input as? [String: Any], let owner = args["owner"] as? String,
              owner.range(of: "^desktop-[0-9]{1,16}$", options: .regularExpression) != nil,
              let zoomed = Self.boolean(args["zoomed"]) else { throw RemoteDesktopBridgeFailure(code: "invalid_message") }
        // JS retries cannot steal a different still-owned view's live session.
        guard session == nil else { throw RemoteDesktopBridgeFailure(code: "occupied") }
        let transport = try capture()
        guard transport.isCurrent() else { throw CancellationError() }
        let value = Session(owner: owner, transport: transport, zoomed: zoomed)
        session = value
        value.task = Task { [weak self, weak value] in
            guard let self, let value else { return }
            await self.run(value)
        }
    }
    private func current(_ value: Session, _ token: UUID) -> Bool {
        session === value && value.attempt == token && value.transport.isCurrent()
            && UIApplication.shared.applicationState == .active && !Task.isCancelled
    }
    private func state(_ value: Session, _ phase: String, _ code: String? = nil) {
        guard session === value else { return }
        var payload: [String: Any] = ["owner": value.owner, "type": "state", "phase": phase]
        if let code { payload["code"] = code }
        app?.send("remoteDesktop.event", payload)
    }
    private func stopAttempt(_ value: Session) {
        value.attempt = UUID(); value.live = false; value.pendingFrame = nil; value.syncingZoom = false
        value.heartbeat?.cancel(); value.heartbeat = nil
        value.frameDeadline?.cancel(); value.frameDeadline = nil
        value.writer?.cancel(); value.writer = nil; value.writerID = nil; value.queued = 0
        // Closing the socket is authoritative: the Host releases held native buttons on EOF.
        value.socket?.close(); value.socket = nil
    }
    private func failAttempt(_ value: Session, _ token: UUID, _ code: String) {
        guard current(value, token) else { return }
        value.attemptError = code; value.live = false
        value.socket?.close()
    }
    private func run(_ value: Session) async {
        var lastError: String?
        while session === value && !Task.isCancelled {
            if !value.transport.isCurrent() { value.terminal = true; state(value, "closed", "runtime_changed"); break }
            if !online {
                state(value, "closed", lastError ?? "connection_failed")
                await wait(value, seconds: 60)
                continue
            }
            let token = value.attempt
            value.attemptError = nil; value.fallback = false; value.zoomSupported = false; value.sentZoom = false
            state(value, "connecting", lastError)
            do {
                let capability = try await DesktopDeadline<(status: Int, body: [String: Any])>(discard: { _ in }).run(seconds: 10) { try await value.transport.capability() }
                guard current(value, token) else { break }
                if capability.status == 401 || capability.status == 403 { throw RemoteDesktopBridgeFailure(code: "authentication_required") }
                if capability.status == 501 { throw RemoteDesktopBridgeFailure(code: "unsupported") }
                guard capability.status == 200, let supported = Self.boolean(capability.body["supported"]), let enabled = Self.boolean(capability.body["enabled"]) else { throw RemoteDesktopBridgeFailure(code: "connection_failed") }
                guard supported else { throw RemoteDesktopBridgeFailure(code: "unsupported") }
                guard enabled else { throw RemoteDesktopBridgeFailure(code: "disabled") }
                value.startupDeadline = ProcessInfo.processInfo.systemUptime + 60
                let socket = try await DesktopDeadline<RemoteDesktopSocket>(discard: { $0.close() }).run(seconds: 60) { try await value.transport.open() }
                guard current(value, token) else { socket.close(); break }
                guard ProcessInfo.processInfo.systemUptime < value.startupDeadline else { socket.close(); throw RemoteDesktopBridgeFailure(code: "connection_failed") }
                value.socket = socket
                value.heartbeat = Task { [weak self, weak value] in
                    while !Task.isCancelled {
                        do { try await Task.sleep(nanoseconds: 5_000_000_000) } catch { return }
                        guard let self, let value, self.current(value, token) else { return }
                        do { try await self.send(["type": "ping"], value, token) }
                        catch { self.failAttempt(value, token, "connection_failed"); return }
                    }
                }
                // With no native WebRTC library in this dependency-free client, request the
                // Host's existing compatibility stream. Never embed a browser peer instead.
                let remaining = UInt64(max(1, ceil(value.startupDeadline - ProcessInfo.processInfo.systemUptime)))
                let firstFrame = Task { [weak self, weak value] in
                    do { try await Task.sleep(nanoseconds: remaining * 1_000_000_000) } catch { return }
                    guard let self, let value else { return }; self.failAttempt(value, token, "connection_failed")
                }
                value.frameDeadline = firstFrame
                while current(value, token) {
                    let message = try await DesktopDeadline<RemoteDesktopWireMessage>(discard: { _ in }).run(seconds: 30) { try await socket.receive() }
                    guard current(value, token) else { break }
                    try await receive(message, value, token)
                }
                throw RemoteDesktopBridgeFailure(code: value.attemptError ?? "connection_failed")
            } catch {
                guard session === value && !Task.isCancelled else { return }
                if !value.transport.isCurrent() { value.terminal = true; state(value, "closed", "runtime_changed"); break }
                let code = value.attemptError ?? (error as? RemoteDesktopBridgeFailure)?.code ?? "connection_failed"
                stopAttempt(value)
                lastError = code
                state(value, "closed", code)
                if ["disabled", "unsupported", "helper_unavailable", "authentication_required", "permission_denied", "runtime_changed"].contains(code) { value.terminal = true; break }
                let delay = code == "permission_required" || !online ? 60 : min(1 << min(value.failures, 5), 30)
                value.failures = min(value.failures + 1, 6)
                await wait(value, seconds: UInt64(delay))
            }
        }
        if session === value && !Task.isCancelled { stopAttempt(value) }
    }
    private func wait(_ value: Session, seconds: UInt64) async {
        let task = Task { do { try await Task.sleep(nanoseconds: seconds * 1_000_000_000) } catch { return } }
        let id = UUID()
        value.retryWait = task; value.retryWaitID = id
        await withTaskCancellationHandler(operation: { await task.value }, onCancel: { task.cancel() })
        if value.retryWaitID == id { value.retryWait = nil; value.retryWaitID = nil }
    }
    private func requestFallback(_ value: Session, _ token: UUID) async throws {
        guard !value.fallback else { return }
        value.fallback = true
        try await send(["type": "fallback"], value, token)
        frameDeadline(value, token)
    }
    private func frameDeadline(_ value: Session, _ token: UUID) {
        value.frameDeadline?.cancel()
        let delay = value.live ? 15 : min(15, UInt64(max(1, ceil(value.startupDeadline - ProcessInfo.processInfo.systemUptime))))
        value.frameDeadline = Task { [weak self, weak value] in
            do { try await Task.sleep(nanoseconds: delay * 1_000_000_000) } catch { return }
            guard let self, let value else { return }; self.failAttempt(value, token, "connection_failed")
        }
    }
    private func receive(_ message: RemoteDesktopWireMessage, _ value: Session, _ token: UUID) async throws {
        switch message {
        case .closed(let code): throw RemoteDesktopBridgeFailure(code: code == 4001 ? "authentication_required" : "connection_failed")
        case .text(let text):
            guard text.utf8.count <= 96 * 1024, let data = text.data(using: .utf8), let object = try JSONSerialization.jsonObject(with: data) as? [String: Any], let type = object["type"] as? String else { throw RemoteDesktopBridgeFailure(code: "invalid_message") }
            if type == "error" { throw RemoteDesktopBridgeFailure(code: object["code"] as? String ?? "connection_failed") }
            if type == "ready" {
                value.zoomSupported = Self.boolean(object["zoomQuality"]) == true
                try await syncZoom(value, token)
                try await requestFallback(value, token)
            } else if type == "offer" || type == "rtc-failed" { try await requestFallback(value, token) }
            else if type != "ice" && type != "pong" { throw RemoteDesktopBridgeFailure(code: "invalid_message") }
        case .binary(let data):
            guard value.fallback, value.pendingFrame == nil, !data.isEmpty, data.count <= 512 * 1024 else { throw RemoteDesktopBridgeFailure(code: "invalid_message") }
            let decoded = try await Task.detached(priority: .userInitiated) { () throws -> (Int, Int, String) in
                guard let source = CGImageSourceCreateWithData(data as CFData, nil),
                      CGImageSourceGetType(source) as String? == "public.jpeg",
                      let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
                      let width = properties[kCGImagePropertyPixelWidth] as? Int,
                      let height = properties[kCGImagePropertyPixelHeight] as? Int,
                      width > 0, height > 0, width <= 2560, height <= 2560, width * height <= 2560 * 1440,
                      let image = CGImageSourceCreateImageAtIndex(source, 0, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary),
                      image.width == width, image.height == height else { throw RemoteDesktopBridgeFailure(code: "decode_failed") }
                try Task.checkCancellation()
                return (width, height, "data:image/jpeg;base64," + data.base64EncodedString())
            }.value
            guard current(value, token) else { throw CancellationError() }
            value.frameSequence += 1; value.pendingFrame = value.frameSequence
            frameDeadline(value, token)
            app?.send("remoteDesktop.event", ["owner": value.owner, "type": "frame", "frame": value.frameSequence, "width": decoded.0, "height": decoded.1, "source": decoded.2])
        }
    }
    private func syncZoom(_ value: Session, _ token: UUID) async throws {
        guard value.zoomSupported, value.socket != nil, !value.syncingZoom else { return }
        value.syncingZoom = true
        defer { if value.attempt == token { value.syncingZoom = false } }
        while current(value, token) && value.desiredZoom != value.sentZoom {
            let desired = value.desiredZoom
            try await send(["type": "view", "zoomed": desired], value, token)
            if current(value, token) { value.sentZoom = desired }
        }
    }
    private func send(_ message: [String: Any], _ value: Session, _ token: UUID) async throws {
        guard current(value, token), let socket = value.socket, value.attemptError == nil, value.queued < 32 else { throw RemoteDesktopBridgeFailure(code: "connection_failed") }
        let data = try JSONSerialization.data(withJSONObject: message)
        guard data.count <= 96 * 1024, let text = String(data: data, encoding: .utf8) else { throw RemoteDesktopBridgeFailure(code: "invalid_message") }
        let previous = value.writer
        let writeID = UUID()
        value.queued += 1
        let task = Task { [weak self, weak value] in
            if let previous { try await previous.value }
            try Task.checkCancellation()
            guard let self, let value, self.current(value, token), value.attemptError == nil else { throw CancellationError() }
            try await DesktopDeadline<Void>(discard: { _ in }).run(seconds: 10) { try await socket.send(text) }
            guard self.current(value, token) else { throw CancellationError() }
        }
        value.writer = task; value.writerID = writeID
        defer {
            if value.attempt == token {
                value.queued -= 1
                if value.writerID == writeID { value.writer = nil; value.writerID = nil }
            }
        }
        do { try await task.value }
        catch { failAttempt(value, token, "connection_failed"); throw error }
    }
    private static func boolean(_ value: Any?) -> Bool? {
        guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }; return number.boolValue
    }
    private static func number(_ value: Any?) -> Double? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite else { return nil }; return number.doubleValue
    }
    private static func projectInput(_ value: [String: Any]) throws -> [String: Any] {
        guard let type = value["type"] as? String else { throw RemoteDesktopBridgeFailure(code: "invalid_message") }
        if type == "release" { return ["type": type] }
        if type == "pointer", let action = value["action"] as? String, ["move", "down", "up", "click", "right"].contains(action),
           let x = number(value["x"]), let y = number(value["y"]), (0...1).contains(x), (0...1).contains(y) { return ["type": type, "action": action, "x": x, "y": y] }
        if type == "scroll", let dx = number(value["dx"]), let dy = number(value["dy"]) { return ["type": type, "dx": max(-1000, min(1000, dx)), "dy": max(-1000, min(1000, dy))] }
        if type == "text", let text = value["text"] as? String, !text.isEmpty, text.utf16.count <= 1024 { return ["type": type, "text": text] }
        if type == "key", let key = value["key"] as? String,
           ["Enter", "Backspace", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Delete", "Home", "End", "PageUp", "PageDown"].contains(key) { return ["type": type, "key": key] }
        throw RemoteDesktopBridgeFailure(code: "invalid_message")
    }
}
