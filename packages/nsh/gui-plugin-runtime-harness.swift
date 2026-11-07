import Foundation
import NativeShell

enum GuiSyntheticReadError: Error { case upstream }
struct GuiPartialIterator: AsyncIteratorProtocol {
    var remaining = 20 * 1024
    var failure: Error = GuiSyntheticReadError.upstream
    mutating func next() async throws -> UInt8? {
        guard remaining > 0 else { throw failure }
        remaining -= 1; return UInt8(remaining % 251)
    }
}

@main struct GuiRuntimeHarness {
    @MainActor static func main() async throws {
        let (bytes, _) = try await URLSession.shared.data(from: URL(string: CommandLine.arguments[1])!)
        let config = try JSONSerialization.jsonObject(with: bytes) as! [String: Any]
        let mode = CommandLine.arguments[2]
        let relay = mode == "relay" ? RelayConfiguration(relayUrl: config["relayUrl"] as! String, serverId: config["serverId"] as! String, hostEncPubJwk: config["hostEncPubJwk"] as! [String: String]) : nil
        let store = try ConnectionStore()
        try store.save(url: URL(string: config["origin"] as! String)!, token: "synthetic-gui", label: "Synthetic", relay: relay)
        let runtime = RuntimeBridge(app: NshAppView(), store: store)
        runtime.setForeground(true); defer { runtime.stop() }
        let scope = try RuntimeHostScope(runtime.snapshot["runtimeScope"])
        let capture = try runtime.guiPluginPreviewCapture(expectedHost: scope)
        let partial = GuiPluginDirectBody(GuiPartialIterator())
        let collected = try await partial.read(65536)
        precondition(collected == Data((0..<(20 * 1024)).reversed().map { UInt8($0 % 251) }))
        do { _ = try await partial.read(65536); preconditionFailure("upstream error became EOF") } catch GuiSyntheticReadError.upstream {}
        let transportCancellation = GuiPluginDirectBody(GuiPartialIterator(failure:CancellationError()))
        let transportBytes = try await transportCancellation.read(65536)
        precondition(transportBytes == collected)
        do { _ = try await transportCancellation.read(65536); preconditionFailure("upstream cancellation became EOF") } catch is CancellationError {}
        let cancelledPartial = GuiPluginDirectBody(GuiPartialIterator())
        await cancelledPartial.cancel()
        do { _ = try await cancelledPartial.read(65536); preconditionFailure("cancel delivered bytes") } catch is CancellationError {}
        let relayPartial = GuiPluginRelayBody()
        try await relayPartial.response(200,["content-type":"text/plain"])
        let payload = Data((0..<65536).map { UInt8($0 % 251) })
        let partiallySent = Task { try await relayPartial.receive(payload) }
        let first = try await relayPartial.read(20 * 1024)
        precondition(first == payload.prefix(20 * 1024))
        await relayPartial.finish(GuiSyntheticReadError.upstream)
        let tail = try await relayPartial.read(65536)
        precondition(tail == payload.suffix(65536 - 20 * 1024))
        do { _ = try await relayPartial.read(65536); preconditionFailure("relay error became EOF") } catch GuiSyntheticReadError.upstream {}
        do { try await partiallySent.value; preconditionFailure("producer lost terminal error") } catch GuiSyntheticReadError.upstream {}
        await relayPartial.cancel()
        do { _ = try await relayPartial.read(65536); preconditionFailure("cancel lost priority") } catch is CancellationError {}
        let cancelWithTail = GuiPluginRelayBody()
        try await cancelWithTail.response(200,["content-type":"text/plain"])
        let cancelledSend = Task { try await cancelWithTail.receive(payload) }
        _ = try await cancelWithTail.read(20 * 1024)
        await cancelWithTail.finish(GuiSyntheticReadError.upstream)
        await cancelWithTail.cancel()
        do { _ = try await cancelWithTail.read(65536); preconditionFailure("cancel leaked retained tail") } catch is CancellationError {}
        do { try await cancelledSend.value } catch GuiSyntheticReadError.upstream {}
        let wrong = RuntimeHostScope(hostID: scope.hostID, lease: UUID())
        let wrongScope = try await awaitResult { try await capture.openGui(wrong, GuiPluginPreviewRequest(["method":"GET","route":"/api/plugin"])) }; precondition(!wrongScope)
        let rendezvous = GuiPluginRelayBody()
        try await rendezvous.response(418, ["content-type":"text/plain", "set-cookie":"synthetic-hidden", "x-yuri-gui-revision":String(repeating:"a",count:64)])
        var producerCompleted = false
        let producer = Task { try await rendezvous.receive(Data(repeating:7,count:131072)); producerCompleted = true }
        let half = try await rendezvous.read(65536); precondition(half?.count == 65536 && !producerCompleted)
        let rest = try await rendezvous.read(65536); precondition(rest?.count == 65536)
        try await producer.value; precondition(producerCompleted)
        await rendezvous.finish()
        let eof = try await rendezvous.read(65536); precondition(eof == nil)
        func request(_ path: String) throws -> GuiPluginPreviewRequest { try GuiPluginPreviewRequest(["method": "GET", "route": "/api/fs/read?path=" + path, "headers": ["accept": "application/javascript"]]) }
        var budgeted: [GuiPluginPreviewByteStream] = []
        for _ in 0..<8 { budgeted.append(try await capture.openGui(scope, request("small"))) }
        do { _ = try await capture.openGui(scope, request("small")); preconditionFailure("unbounded GUI lanes") } catch GuiPluginPreviewFailure.busy {}
        budgeted.forEach { $0.cancel() }
        let neverStarted = Task { try await capture.openGui(scope, request("pending-never-" + mode)) }
        neverStarted.cancel()
        let neverResult = try await awaitResult { try await neverStarted.value }; precondition(!neverResult)
        let paused = try await capture.openGui(scope, request("paused"))
        try await Task.sleep(nanoseconds: 100_000_000)
        let (statsData, _) = try await URLSession.shared.data(from: URL(string: (config["origin"] as! String) + "/stats")!)
        let pausedStats = try JSONSerialization.jsonObject(with: statsData) as! [String:Any]
        precondition(!(pausedStats["started"] as! [String]).contains("pending-never-" + mode))
        let produced = (pausedStats["produced"] as! [String:Int])["paused"]!
        print("\(mode) paused source produced \(produced) bytes")
        precondition(produced < 33 * 1024 * 1024 + 65536)
        paused.cancel()
        let stream = try await capture.openGui(scope, request("large"))
        precondition(stream.status == 200 && stream.mime == "application/javascript; charset=utf-8")
        precondition(stream.headers == ["x-yuri-file-exists": "true"])
        var count = 0
        while let chunk = try await stream.read(65536) {
            precondition(chunk.count <= 65536 && !chunk.isEmpty)
            precondition(chunk.allSatisfy { $0 == 65 }); count += chunk.count
        }
        precondition(count == 33 * 1024 * 1024 + 65536)
        let missing = try await capture.readGui(scope, request("missing"), 65536)
        precondition(missing.data.isEmpty && missing.headers["x-yuri-file-exists"] == "false")
        let empty = try await capture.readGui(scope, request("empty"), 65536)
        precondition(empty.data.isEmpty && empty.headers["x-yuri-file-exists"] == "true")
        let void = try await capture.readGui(scope, request("void"), 65536)
        precondition(void.status == 204 && void.data.isEmpty && void.mime == "")
        let limited = try await awaitResult { try await capture.readGui(scope, request("large"), 65536) }; precondition(!limited)
        let rpc = try GuiPluginPreviewRequest(["method":"POST", "route":"/api/rpc/synthetic/echo", "headers":["accept":"application/json", "content-type":"application/json", "x-opencode-directory":"/synthetic", "x-yuri-gui-revision":String(repeating:"a",count:64)], "body":"{ \"x\": 1 }"])
        let (rpcBeforeData, _) = try await URLSession.shared.data(from: URL(string: (config["origin"] as! String) + "/stats")!)
        let rpcBefore = try JSONSerialization.jsonObject(with: rpcBeforeData) as! [String: Any]
        let reply = try await capture.readGui(scope, rpc, 65536)
        precondition(reply.status == 422 && String(data:reply.data,encoding:.utf8) == "{ \"x\": 1 }")
        precondition(reply.headers["x-yuri-gui-code"] == "full")
        let (rpcAfterData, _) = try await URLSession.shared.data(from: URL(string: (config["origin"] as! String) + "/stats")!)
        let rpcAfter = try JSONSerialization.jsonObject(with: rpcAfterData) as! [String: Any]
        precondition((rpcAfter["rpcCount"] as! Int) == (rpcBefore["rpcCount"] as! Int) + 1)
        let redirect = try await awaitResult { try await capture.openGui(scope, request("redirect")) }
        precondition(redirect == false)
        let old = try await capture.openGui(scope, request("large")); old.cancel()
        let newer = try await capture.openGui(scope, request("small"))
        let stale = try await awaitResult { _ = try await old.read(65536) }; precondition(!stale)
        let small = try await newer.read(65536); precondition(small == Data("A".utf8)); newer.cancel()
        let retiring = try await capture.openGui(scope, request("large"))
        runtime.setForeground(false)
        precondition(!capture.isCurrent() && !capture.resource.isCurrent())
        let retired = try await awaitResult { _ = try await retiring.read(65536) }; precondition(!retired)
        runtime.setForeground(true)
        let rejected = try await awaitResult { try await capture.openGui(scope, request("small")) }; precondition(!rejected)
        let freshScope = try RuntimeHostScope(runtime.snapshot["runtimeScope"])
        let fresh = try runtime.guiPluginPreviewCapture(expectedHost: freshScope)
        func waitStarted(_ name: String) async throws {
            for _ in 0..<500 {
                let (data, _) = try await URLSession.shared.data(from: URL(string: (config["origin"] as! String) + "/stats")!)
                let stats = try JSONSerialization.jsonObject(with: data) as! [String: Any]
                if (stats["started"] as! [String]).contains(name) { return }
                try await Task.sleep(nanoseconds: 1_000_000)
            }
            fatalError("synthetic request never entered source")
        }
        let queued = Task { try await fresh.openGui(freshScope, request("pending-cancel-" + mode)) }
        try await waitStarted("pending-cancel-" + mode)
        queued.cancel()
        let queuedResult = try await awaitResult { try await queued.value }; precondition(!queuedResult)
        let blocked = try await fresh.openGui(freshScope, request("blocked"))
        if mode == "relay" { _ = try await blocked.read(65536) }
        let waiting = Task { try await blocked.read(65536) }
        await Task.yield(); waiting.cancel()
        let waitingResult = try await awaitResult { try await waiting.value }; precondition(!waitingResult)
        blocked.cancel()
        let late = try await fresh.openGui(freshScope, request("small"))
        blocked.cancel()
        let lateBytes = try await late.read(65536); precondition(lateBytes == Data("A".utf8)); late.cancel()
        let retryOld = try await fresh.openGui(freshScope, request("blocked"))
        if mode == "relay" { _ = try await retryOld.read(65536) }
        let lateRead = Task { try await retryOld.read(65536) }
        await Task.yield(); retryOld.cancel()
        let retryNew = try await fresh.openGui(freshScope, request("small"))
        let oldResult = try await awaitResult { try await lateRead.value }; precondition(!oldResult)
        retryOld.cancel()
        let newBytes = try await retryNew.read(65536); precondition(newBytes == Data("A".utf8)); retryNew.cancel()
        let pendingRetire = Task { try await fresh.openGui(freshScope, request("pending-retire-" + mode)) }
        try await waitStarted("pending-retire-" + mode)
        runtime.setForeground(false)
        let pendingResult = try await awaitResult { try await pendingRetire.value }; precondition(!pendingResult)
        runtime.setForeground(true)
        let lastScope = try RuntimeHostScope(runtime.snapshot["runtimeScope"])
        let last = try runtime.guiPluginPreviewCapture(expectedHost: lastScope)
        let lastStream = try await last.openGui(lastScope, request("large"))
        try store.save(url: URL(string: config["origin"] as! String)!, token: "synthetic-replacement", label: "Replacement", relay: relay)
        runtime.stop()
        let changed = try await awaitResult { _ = try await lastStream.read(65536) }; precondition(!changed)
        print("GUI runtime \(mode) large/fidelity/redirect/cancel/retire passed")
    }
    @MainActor static func awaitResult<T>(_ work: () async throws -> T) async throws -> Bool {
        do { _ = try await work(); return true } catch { return false }
    }
}
