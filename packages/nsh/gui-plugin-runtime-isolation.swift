import Foundation
import NativeShell

@main struct GuiRuntimeIsolation {
    @MainActor static func main() async throws {
        let configURL = URL(string: CommandLine.arguments[1])!
        let (data, _) = try await URLSession.shared.data(from: configURL)
        let config = try JSONSerialization.jsonObject(with: data) as! [String:Any]
        let relay = RelayConfiguration(relayUrl:config["relayUrl"] as! String,serverId:config["serverId"] as! String,hostEncPubJwk:config["hostEncPubJwk"] as! [String:String])
        let store = try ConnectionStore()
        try store.save(url:URL(string:config["origin"] as! String)!,token:"synthetic-gui",label:"Synthetic",relay:relay)
        let app = NshAppView(), runtime = RuntimeBridge(app:app,store:store)
        runtime.setForeground(true);defer{runtime.stop()}
        let scope = try RuntimeHostScope(runtime.snapshot["runtimeScope"])
        let capture = try runtime.guiPluginPreviewCapture(expectedHost:scope)
        func request(_ path:String) throws -> GuiPluginPreviewRequest {try GuiPluginPreviewRequest(["method":"GET","route":"/api/fs/read?path="+path,"headers":["accept":"application/javascript"]])}
        let stream = app.handlers["runtime.stream"]!
        _ = try await stream(["expectedHost":scope.publicValue,"key":"global","path":"/api/yuri/events"])
        _ = try await stream(["expectedHost":scope.publicValue,"key":"chat","path":"/api/event?directory=synthetic","mode":"sse","ownerID":"gui-isolation-chat"])
        let terminal = try runtime.terminalTransport(expectedHost:scope), socket = try await terminal.open()
        defer{socket.close()}
        guard case .text("connected") = try await socket.receive() else {preconditionFailure("terminal did not connect")}
        let held = try await capture.openGui(scope,request("paused"))
        let first = try await held.read(1);precondition(first == Data([65]))
        let heldSecond = try await capture.openGui(scope,request("large"))
        let second = try await heldSecond.read(1);precondition(second == Data([65]))
        let independent = try await capture.openGui(scope,request("small"))
        let independentBytes = try await independent.read(65536);precondition(independentBytes == Data([65]));independent.cancel()
        heldSecond.cancel()
        func ticks(_ key:String) -> Int {
            app.events.filter {
                guard $0.0 == "runtime.event", $0.1["key"] as? String == key,
                      let text = $0.1["data"] as? String, let bytes = text.data(using: .utf8),
                      let event = try? JSONSerialization.jsonObject(with: bytes) as? [String:Any] else { return false }
                return event["type"] as? String == "gui.isolation.\(key).tick"
            }.count
        }
        func audit() async throws -> [[String:Any]] {
            let (bytes,_) = try await URLSession.shared.data(from:URL(string:(config["origin"] as! String)+"/stats")!)
            return (try JSONSerialization.jsonObject(with:bytes) as! [String:Any])["lanes"] as! [[String:Any]]
        }
        let before = ProcessInfo.processInfo.systemUptime
        var rounds=0, lastGlobal=0, lastChat=0, lastPong=0, sharedID:Int?
        // Exercise real liveness for >30s idle +15s pong deadline without
        // modifying RelayTunnel's clock or blocking on a long sleep. Each round
        // drives production HTTP/WS/SSE and observes an actual encrypted pong.
        repeat {
            let stat = try await capture.resource.readFile("/api/fs/stat?path=synthetic",65536)
            precondition(stat.status==200)
            let port = try await terminal.freePort!();precondition(port==8123)
            let text="echo-\(rounds)";try await socket.send(.text(text))
            guard case .text(let echoed)=try await socket.receive(),echoed==text else{preconditionFailure("terminal stalled")}
            try await Task.sleep(nanoseconds:1_000_000_000)
            let global=ticks("global"),chat=ticks("chat")
            precondition(global>lastGlobal && chat>lastChat);lastGlobal=global;lastChat=chat
            let lanes=try await audit()
            let shared=lanes.first{($0["requests"] as! [String]).contains{ $0.contains("/api/yuri/events") }}!
            let id=shared["id"] as! Int
            if let sharedID {precondition(sharedID==id)}else{sharedID=id}
            let pong=shared["pongs"] as! Int
            precondition(pong>lastPong && shared["closed"] as? Bool==false);lastPong=pong
            let gui=lanes.filter{($0["requests"] as! [String]).contains{$0.contains("path=paused") || $0.contains("path=large")}}
            precondition(gui.count>=2 && gui.allSatisfy{$0["id"] as! Int != id})
            precondition(!app.events.contains{$0.0=="runtime.disconnected"})
            rounds+=1
        } while ProcessInfo.processInfo.systemUptime-before<47
        held.cancel()
        // Cancelling all GUI lanes must leave the same realtime socket alive.
        try await socket.send(.text("after-gui-close"))
        guard case .text("after-gui-close")=try await socket.receive() else{preconditionFailure("GUI cancel closed realtime")}
        print("GUI isolation passed >47s; rounds=\(rounds), SSE=\(lastGlobal)/\(lastChat), pong=\(lastPong)")
    }
}
