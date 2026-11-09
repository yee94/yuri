import Foundation

/// Session-only authenticated socket. RuntimeBridge supplies the admitted
/// same-origin request; no credential construction or persistence lives here.
@MainActor final class SessionMessageStreamDirect: NSObject, URLSessionWebSocketDelegate {
    private let request: URLRequest
    private let opening = NativeSocketInbox(maxMessageBytes: 1024 * 1024)
    private var session: URLSession?, wire: URLSessionWebSocketTask?
    private var ended = false
    init(request: URLRequest) { self.request = request }
    func open() async throws -> SessionStreamSocket {
        try Task.checkCancellation()
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil; config.httpShouldSetCookies = false; config.urlCache = nil
        config.timeoutIntervalForRequest = 15; config.timeoutIntervalForResource = 7 * 24 * 3600
        let session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        self.session = session
        let wire = session.webSocketTask(with: request); self.wire = wire
        wire.maximumMessageSize = 1024 * 1024; wire.resume()
        do {
            try await withTaskCancellationHandler(operation: { try await opening.waitUntilOpen(); try Task.checkCancellation() }, onCancel: { Task { @MainActor in self.close() } })
            return SessionStreamSocket(receive: { [self] in
                try Task.checkCancellation(); guard !ended else { throw CancellationError() }
                let message = try await withTaskCancellationHandler(operation: { try await wire.receive() }, onCancel: { Task { @MainActor in self.close() } })
                try Task.checkCancellation(); guard !ended else { throw CancellationError() }
                guard case .string(let text) = message else { throw SessionStreamFailure.invalid }
                return text
            }, close: { self.close() })
        } catch { close(); throw error }
    }
    func close() {
        guard !ended else { return }; ended = true
        wire?.cancel(with: .goingAway, reason: nil); wire = nil
        session?.invalidateAndCancel(); session = nil
        Task { await opening.fail(CancellationError()) }
    }
    nonisolated func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
    nonisolated func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        Task { @MainActor in guard !self.ended else { return }; try? await self.opening.didOpen() }
    }
    nonisolated func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        Task { await opening.fail(SessionStreamFailure.closed) }
    }
    nonisolated func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        Task {
            if let response = task.response as? HTTPURLResponse, response.statusCode != 101 { await opening.fail(SessionStreamFailure.http(response.statusCode)) }
            else if error != nil { await opening.fail(SessionStreamFailure.closed) }
        }
    }
}
