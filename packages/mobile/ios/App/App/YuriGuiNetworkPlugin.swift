import Capacitor
import Foundation
import Network
import UIKit
import WebKit

/// The WebView always connects through this gateway. Ordinary app bootstrap uses
/// direct TCP; an active GUI lease switches all new streams to the encrypted Relay.
private final class GuiSocksServer {
    private final class Stream {
        let connection: NWConnection
        var credit = 0
        var reading = false
        var opened = false
        var inputEnded = false
        var outputEnded = false
        var direct: NWConnection?
        init(_ connection: NWConnection) { self.connection = connection }
    }
    private let queue = DispatchQueue(label: "com.yuri.gui-network")
    private var emit: (([String: Any]) -> Void)?
    private var directTargets: Set<String> = []
    private var listener: NWListener?
    private var onListenerLost: (() -> Void)?
    private var streams: [UInt32: Stream] = [:]
    private var nextID: UInt32 = 0
    private var stopped = false

    static func targetKey(_ hostname: String, _ port: Int) -> String {
        var normalized = hostname.lowercased()
        if normalized.hasPrefix("["), normalized.hasSuffix("]") { normalized = String(normalized.dropFirst().dropLast()) }
        return "\(normalized):\(port)"
    }

    /// `direct` keeps Yuri's own Relay/runtime endpoints out of plugin egress.
    func setRelayEmitter(_ emit: (([String: Any]) -> Void)?, direct: Set<String> = [], completion: @escaping () -> Void) {
        queue.async {
            for id in Array(self.streams.keys) { self.close(id, notify: false) }
            self.emit = emit
            self.directTargets = emit == nil ? [] : direct
            completion()
        }
    }

    func start(onLost: @escaping () -> Void, _ completion: @escaping (Result<UInt16, Error>) -> Void) {
        queue.async {
            self.onListenerLost = onLost
            self.listen(completion)
        }
    }

    /// iOS defuncts listening sockets while the app is suspended (TN2277). Accepted
    /// streams are independent of the listener, so rebinding only replaces the entry point.
    func relisten(_ completion: @escaping (Result<UInt16, Error>) -> Void) {
        queue.async { self.listen(completion) }
    }

    private func dropListener() {
        guard let old = listener else { return }
        listener = nil
        old.stateUpdateHandler = nil
        old.newConnectionHandler = nil
        old.cancel()
    }

    private func listen(_ completion: @escaping (Result<UInt16, Error>) -> Void) {
        guard !stopped else { completion(.failure(URLError(.cancelled))); return }
        dropListener()
        do {
            let parameters = NWParameters.tcp
            parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .any)
            let listener = try NWListener(using: parameters)
            self.listener = listener
            var replied = false
            listener.stateUpdateHandler = { state in
                guard self.listener === listener else { return }
                if replied {
                    switch state {
                    case .failed, .cancelled:
                        self.dropListener()
                        if !self.stopped { self.onListenerLost?() }
                    default: break
                    }
                    return
                }
                switch state {
                case .ready:
                    replied = true
                    if !self.stopped, let port = listener.port { completion(.success(port.rawValue)) }
                    else { completion(.failure(URLError(.cancelled))) }
                case .failed(let error): replied = true; self.dropListener(); completion(.failure(error))
                case .cancelled: replied = true; self.dropListener(); completion(.failure(URLError(.cancelled)))
                default: break
                }
            }
            listener.newConnectionHandler = { self.accept($0) }
            listener.start(queue: queue)
            queue.asyncAfter(deadline: .now() + 5) {
                guard !replied else { return }
                replied = true
                if self.listener === listener { self.dropListener() } else { listener.cancel() }
                completion(.failure(URLError(.timedOut)))
            }
        } catch { completion(.failure(error)) }
    }

    private func accept(_ connection: NWConnection) {
        guard !stopped, streams.count < 32 else { connection.cancel(); return }
        repeat { nextID &+= 1 } while nextID == 0 || streams[nextID] != nil
        let id = nextID
        streams[id] = Stream(connection)
        connection.stateUpdateHandler = { [weak self] state in
            if case .failed = state { self?.close(id) }
        }
        connection.start(queue: queue)
        queue.asyncAfter(deadline: .now() + 20) { [weak self] in
            if self?.streams[id]?.opened == false { self?.close(id) }
        }
        exact(id, 2) { header in
            guard header[0] == 5, header[1] > 0 else { self.close(id); return }
            self.exact(id, Int(header[1])) { methods in
                guard methods.contains(0) else { self.close(id); return }
                connection.send(content: Data([5, 0]), completion: .contentProcessed { error in
                    guard error == nil else { self.close(id); return }
                    self.request(id)
                })
            }
        }
    }


    private func exact(_ id: UInt32, _ count: Int, _ received: Data = Data(), then: @escaping (Data) -> Void) {
        guard let stream = streams[id] else { return }
        stream.connection.receive(minimumIncompleteLength: 1, maximumLength: count - received.count) { data, _, ended, error in
            guard self.streams[id] === stream else { return }
            var bytes = received
            if let data { bytes.append(data) }
            if bytes.count == count { then(bytes); return }
            if ended || error != nil { self.close(id); return }
            self.exact(id, count, bytes, then: then)
        }
    }

    private func request(_ id: UInt32) {
        exact(id, 4) { header in
            guard header[0] == 5, header[1] == 1, header[2] == 0 else { self.close(id); return }
            let address: (Data) -> Void = { bytes in
                let hostname: String?
                switch header[3] {
                case 1: hostname = IPv4Address(bytes)?.debugDescription
                case 4: hostname = IPv6Address(bytes)?.debugDescription
                default: hostname = String(data: bytes, encoding: .utf8)
                }
                guard let hostname, !hostname.isEmpty else { self.close(id); return }
                self.exact(id, 2) { port in
                    let number = UInt16(port[0]) * 256 + UInt16(port[1])
                    if let emit = self.emit, !self.directTargets.contains(Self.targetKey(hostname, Int(number))) {
                        emit(["type": "open", "id": id, "hostname": hostname, "port": Int(number)])
                    }
                    else { self.openDirect(id, hostname: hostname, port: number) }
                }
            }
            switch header[3] {
            case 1: self.exact(id, 4, then: address)
            case 4: self.exact(id, 16, then: address)
            case 3: self.exact(id, 1) { length in
                guard length[0] > 0 else { self.close(id); return }
                self.exact(id, Int(length[0]), then: address)
            }
            default: self.close(id)
            }
        }
    }

    private func openDirect(_ id: UInt32, hostname: String, port: UInt16) {
        guard let stream = streams[id], port > 0, let endpoint = NWEndpoint.Port(rawValue: port) else { close(id); return }
        let target = NWConnection(host: NWEndpoint.Host(hostname), port: endpoint, using: .tcp)
        stream.direct = target
        target.stateUpdateHandler = { state in
            guard self.streams[id] === stream else { return }
            switch state {
            case .ready:
                guard !stream.opened else { return }
                stream.opened = true
                stream.connection.send(content: Data([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]), completion: .contentProcessed { error in
                    guard error == nil else { self.close(id); return }
                    self.pipeDirect(id, stream: stream, input: true)
                    self.pipeDirect(id, stream: stream, input: false)
                })
            case .failed: self.close(id)
            default: break
            }
        }
        target.start(queue: queue)
    }

    private func pipeDirect(_ id: UInt32, stream: Stream, input: Bool) {
        guard streams[id] === stream, let target = stream.direct else { return }
        let source = input ? stream.connection : target
        let destination = input ? target : stream.connection
        source.receive(minimumIncompleteLength: 1, maximumLength: 16 * 1024) { data, _, ended, error in
            guard self.streams[id] === stream else { return }
            guard error == nil else { self.close(id); return }
            destination.send(content: data, contentContext: ended ? .finalMessage : .defaultMessage, isComplete: ended,
                             completion: .contentProcessed { error in
                guard self.streams[id] === stream else { return }
                if error != nil { self.close(id); return }
                if ended {
                    if input { stream.inputEnded = true } else { stream.outputEnded = true }
                    if stream.inputEnded && stream.outputEnded { self.close(id) }
                } else { self.pipeDirect(id, stream: stream, input: input) }
            })
        }
    }

    private func read(_ id: UInt32) {
        guard let stream = streams[id], stream.opened, !stream.reading, !stream.inputEnded, stream.credit > 0 else { return }
        stream.reading = true
        stream.connection.receive(minimumIncompleteLength: 1, maximumLength: min(16 * 1024, stream.credit)) { data, _, ended, error in
            guard self.streams[id] === stream else { return }
            stream.reading = false
            if let data, !data.isEmpty {
                stream.credit -= data.count
                self.emit?(["type": "data", "id": id, "data": data.base64EncodedString()])
            }
            if error != nil { self.close(id); return }
            if ended {
                stream.inputEnded = true
                self.emit?(["type": "fin", "id": id])
                if stream.outputEnded { self.close(id) }
            } else { self.read(id) }
        }
    }

    func send(id: UInt32, type: String, data: Data?, credit: Int, completion: @escaping (Bool) -> Void) {
        queue.async {
            guard let stream = self.streams[id] else { completion(false); return }
            switch type {
            case "opened":
                guard !stream.opened else { completion(false); return }
                stream.opened = true
                stream.credit = 128 * 1024
                stream.connection.send(content: Data([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]), completion: .contentProcessed { error in
                    completion(error == nil)
                    if error == nil { self.read(id) } else { self.close(id) }
                })
            case "credit":
                guard credit > 0, stream.credit + credit <= 128 * 1024 else { completion(false); return }
                stream.credit += credit
                self.read(id)
                completion(true)
            case "data":
                guard stream.opened, !stream.outputEnded, let data, data.count <= 16 * 1024 else { completion(false); return }
                stream.connection.send(content: data, completion: .contentProcessed { error in
                    if error != nil { self.close(id) }
                    completion(error == nil)
                })
            case "fin":
                stream.outputEnded = true
                stream.connection.send(content: nil, contentContext: .finalMessage, isComplete: true, completion: .contentProcessed { error in
                    if error != nil || stream.inputEnded { self.close(id) }
                    completion(error == nil)
                })
            case "close": self.close(id, notify: false); completion(true)
            default: completion(false)
            }
        }
    }

    private func close(_ id: UInt32, notify: Bool = true) {
        guard let stream = streams.removeValue(forKey: id) else { return }
        let relayed = stream.direct == nil
        stream.connection.cancel()
        stream.direct?.cancel()
        stream.direct?.stateUpdateHandler = nil
        stream.direct = nil
        if notify, relayed { emit?(["type": "close", "id": id]) }
    }
    func stop() {
        queue.async {
            self.stopped = true
            self.onListenerLost = nil
            self.dropListener()
            for id in Array(self.streams.keys) { self.close(id, notify: false) }
        }
    }
}

@objc(YuriGuiNetworkPlugin)
public class YuriGuiNetworkPlugin: CAPPlugin, CAPBridgedPlugin, URLSessionWebSocketDelegate {
    public let identifier = "YuriGuiNetworkPlugin"
    public let jsName = "YuriGuiNetwork"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "prepare", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "capabilities", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "send", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "connect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "write", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "disconnect", returnType: CAPPluginReturnPromise),
    ]
    private var server: GuiSocksServer?
    private var scope: String?
    private var restore: (() -> Void)?
    private var relayURL: URL?
    private var wires: [String: URLSessionWebSocketTask] = [:]
    private var wireSession: URLSession?
    private var prepared = false
    private var prepareCalls: [CAPPluginCall] = []
    private var proxyStore: WKWebsiteDataStore?
    private var port: UInt16?
    private var excluded: [String] = []
    private var backgrounded = false
    private var rebinding = false
    private var rebindAgain = false

    @objc func capabilities(_ call: CAPPluginCall) {
        if #available(iOS 17.0, *) { call.resolve(["supported": prepared]) }
        else { call.resolve(["supported": false]) }
    }
    @objc func prepare(_ call: CAPPluginCall) {
        guard #available(iOS 17.0, *) else { call.reject("unsupported"); return }
        DispatchQueue.main.async {
            if self.prepared { call.resolve(); return }
            guard let store = self.webView?.configuration.websiteDataStore else { call.reject("unsupported"); return }
            self.prepareCalls.append(call)
            guard self.server == nil else { return }
            let server = GuiSocksServer()
            self.server = server
            server.start(onLost: { [weak self] in
                DispatchQueue.main.async { self?.rebindProxy() }
            }) { result in
                DispatchQueue.main.async {
                    let calls = self.prepareCalls
                    self.prepareCalls.removeAll()
                    switch result {
                    case .failure:
                        server.stop(); self.server = nil
                        for call in calls { call.reject("proxy_failed") }
                    case .success(let port):
                        // Ordinary application networking keeps its original path; the
                        // data store only points at this gateway while a plugin view holds a lease.
                        self.port = port
                        self.proxyStore = store
                        self.prepared = true
                        let center = NotificationCenter.default
                        center.addObserver(self, selector: #selector(self.didEnterBackground), name: UIApplication.didEnterBackgroundNotification, object: nil)
                        center.addObserver(self, selector: #selector(self.willEnterForeground), name: UIApplication.willEnterForegroundNotification, object: nil)
                        for call in calls { call.resolve() }
                    }
                }
            }
        }
    }

    /// Points the data store at the gateway only while a lease is active. Yuri's own
    /// endpoints are excluded at the WebView layer so they never touch the gateway.
    private func activateProxy() {
        guard #available(iOS 17.0, *), scope != nil, let port, let store = proxyStore else { return }
        if restore == nil {
            let previous = store.proxyConfigurations
            restore = { store.proxyConfigurations = previous }
        }
        var proxy = ProxyConfiguration(socksv5Proxy: .hostPort(host: .ipv4(.loopback), port: NWEndpoint.Port(rawValue: port)!))
        proxy.allowFailover = false
        proxy.excludedDomains = excluded
        store.proxyConfigurations = [proxy]
    }

    private func deactivateProxy() {
        restore?()
        restore = nil
    }

    @objc private func didEnterBackground() { backgrounded = true }

    @objc private func willEnterForeground() {
        guard backgrounded else { return }
        backgrounded = false
        rebindProxy()
    }

    /// iOS defuncts the loopback listener while suspended and the proxy has no failover,
    /// so an open plugin view would stop loading. Rebind and repoint an active lease.
    private func rebindProxy(attempt: Int = 0) {
        guard prepared, let server else { return }
        if rebinding { rebindAgain = true; return }
        rebinding = true
        server.relisten { result in
            DispatchQueue.main.async {
                self.rebinding = false
                guard self.server === server else { return }
                if case .success(let port) = result { self.port = port; self.activateProxy() }
                if self.rebindAgain {
                    self.rebindAgain = false
                    self.rebindProxy()
                } else if case .failure = result, attempt < 5 {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.rebindProxy(attempt: attempt + 1) }
                }
            }
        }
    }
    @objc func start(_ call: CAPPluginCall) {
        guard let owner = call.getString("scope"), !owner.isEmpty,
              let relay = call.getString("relayUrl"), let url = URL(string: relay),
              ["ws", "wss"].contains(url.scheme ?? ""), let hostname = url.host,
              !hostname.isEmpty, !hostname.contains("*"), url.user == nil, url.password == nil, url.fragment == nil
        else { call.reject("invalid_relay"); return }
        var direct = Set<String>()
        var hosts = Set<String>()
        for case let target as JSObject in (call.getArray("direct") ?? []).prefix(32) {
            guard let hostname = target["hostname"] as? String, !hostname.isEmpty,
                  let port = target["port"] as? Int, port > 0, port <= 65535 else { call.reject("invalid_direct"); return }
            direct.insert(GuiSocksServer.targetKey(hostname, port))
            hosts.insert(hostname.lowercased())
        }
        DispatchQueue.main.async {
            guard self.prepared, let server = self.server else { call.reject("unsupported"); return }
            // JS serializes leases, so an existing scope belongs to a reloaded document
            // that can no longer release it. Replace it instead of failing forever.
            if self.scope != nil {
                for wire in self.wires.values { wire.cancel(with: .goingAway, reason: nil) }
                self.wires.removeAll()
                self.wireSession?.invalidateAndCancel(); self.wireSession = nil
            }
            self.scope = owner; self.relayURL = url; self.excluded = Array(hosts)
            server.setRelayEmitter({ [weak self] event in
                DispatchQueue.main.async {
                    guard self?.scope == owner else { return }
                    self?.notifyListeners("stream", data: event.merging(["scope": owner]) { _, new in new })
                }
            }, direct: direct, completion: {
                DispatchQueue.main.async {
                    if self.scope == owner { self.activateProxy() }
                    call.resolve()
                }
            })
        }
    }
    @objc func send(_ call: CAPPluginCall) {
        guard let scope = call.getString("scope"), scope == self.scope, let rawID = call.getInt("id"),
              rawID > 0, rawID <= Int(UInt32.max), let type = call.getString("type"), let server else { call.reject("closed"); return }
        let data = call.getString("data").flatMap { Data(base64Encoded: $0) }
        server.send(id: UInt32(rawID), type: type, data: data, credit: call.getInt("bytes") ?? 0) { ok in
            if ok { call.resolve() } else { call.reject("stream_closed") }
        }
    }
    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard call.getString("scope") == self.scope else { call.resolve(); return }
            for wire in self.wires.values { wire.cancel(with: .goingAway, reason: nil) }
            self.wires.removeAll(); self.relayURL = nil
            self.wireSession?.invalidateAndCancel(); self.wireSession = nil
            self.scope = nil; self.excluded = []
            self.deactivateProxy()
            // The gateway exists only for a lease; the next lease binds a fresh one.
            NotificationCenter.default.removeObserver(self)
            self.server?.stop(); self.server = nil
            self.port = nil; self.proxyStore = nil; self.prepared = false; self.backgrounded = false
            call.resolve()
        }
    }

    @objc func connect(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let owner = call.getString("scope"), owner == self.scope,
                  let id = call.getString("wireId"), !id.isEmpty, self.wires[id] == nil, self.wires.count < 4,
                  let raw = call.getString("url"), let url = URL(string: raw), let relay = self.relayURL,
                  url.scheme == relay.scheme, url.host == relay.host, url.port == relay.port, url.path == relay.path,
                  url.user == nil, url.password == nil, url.fragment == nil else { call.reject("invalid_relay"); return }
            // Only the paired Relay wire is native. The JS tunnel still owns E2EE;
            // Yuri's own endpoints stay direct, plugin destinations use SOCKS.
            if self.wireSession == nil { self.wireSession = URLSession(configuration: .ephemeral, delegate: self, delegateQueue: .main) }
            let wire = self.wireSession!.webSocketTask(with: url)
            wire.maximumMessageSize = 2 * 1024 * 1024
            self.wires[id] = wire
            wire.resume()
            self.receiveWire(id, owner: owner, wire: wire)
            call.resolve()
        }
    }

    private func receiveWire(_ id: String, owner: String, wire: URLSessionWebSocketTask) {
        wire.receive { result in
            DispatchQueue.main.async {
                guard self.scope == owner, self.wires[id] === wire else { return }
                switch result {
                case .success(let message):
                    var event: [String: Any] = ["scope": owner, "wireId": id, "type": "message"]
                    switch message {
                    case .string(let text): event["text"] = text
                    case .data(let data): event["data"] = data.base64EncodedString()
                    @unknown default: self.endWire(id, code: 1006); return
                    }
                    self.notifyListeners("wire", data: event)
                    self.receiveWire(id, owner: owner, wire: wire)
                case .failure: self.endWire(id, code: 1006)
                }
            }
        }
    }

    private func endWire(_ id: String, code: Int) {
        guard let wire = wires.removeValue(forKey: id), let scope else { return }
        wire.cancel(with: .goingAway, reason: nil)
        notifyListeners("wire", data: ["scope": scope, "wireId": id, "type": "close", "code": code])
    }

    public func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        guard let scope, let id = wires.first(where: { $0.value === webSocketTask })?.key else { return }
        notifyListeners("wire", data: ["scope": scope, "wireId": id, "type": "open"])
    }

    public func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        guard let id = wires.first(where: { $0.value === webSocketTask })?.key else { return }
        endWire(id, code: closeCode.rawValue)
    }

    public func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                           newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }

    @objc func write(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard call.getString("scope") == self.scope, let id = call.getString("wireId"), let wire = self.wires[id] else { call.reject("closed"); return }
            let message: URLSessionWebSocketTask.Message
            if let text = call.getString("text"), text.utf8.count <= 128 * 1024 { message = .string(text) }
            else if let raw = call.getString("data"), let data = Data(base64Encoded: raw), data.count <= 2 * 1024 * 1024 { message = .data(data) }
            else { call.reject("invalid_message"); return }
            wire.send(message) { error in
                if error == nil { call.resolve() } else { call.reject("wire_closed") }
            }
        }
    }

    @objc func disconnect(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if call.getString("scope") == self.scope, let id = call.getString("wireId") { self.endWire(id, code: 1000) }
            call.resolve()
        }
    }
    deinit { NotificationCenter.default.removeObserver(self); server?.stop(); restore?() }
}
