import Foundation
import ImageIO

@main struct ResourcePageWireContract {
    @MainActor static func main() throws {
        let memory = ResourcePageSyntheticHost(), expected = memory.scope.publicValue
        func rejects(_ work: () throws -> Void) {
            do { try work(); fatalError("unexpected admission") } catch {}
        }
        _ = try RuntimeHostScope(memory.snapshot()["runtimeScope"])
        _ = try memory.request(["path": "/api/config/settings", "method": "GET", "expectedHost": expected])
        for name in ["index.html", "note.md", "plain.txt", "art.svg", "style.css", "app.js", "pixel.png"] {
            let result = try memory.read("/api/fs/serve/fixture/" + name, limit: 1_000_000)
            precondition(result.status == 200 && !result.data.isEmpty)
        }
        let image = try memory.read("/api/fs/serve/fixture/pixel.png", limit: 65536)
        let decoded = CGImageSourceCreateWithData(image.data as CFData, nil)!
        precondition(CGImageSourceCreateImageAtIndex(decoded, 0, nil)?.width == 1)
        for route in ["/api/unknown", "/api/fs/stat?path=%2Ffixture%2Fplain.txt&extra=1", "/api/fs/stat?path=%2Ffixture%2Fplain.txt&path=%2Ffixture%2Fplain.txt", "/api/fs/serve/fixture/../private.txt", "/api/fs/serve/fixture/index.html?extra=1", "/api/fs/serve/fixture/%69ndex.html", "https://synthetic.invalid/api/config/settings"] {
            rejects { _ = try memory.read(route, limit: 1_000_000) }
        }
        rejects { _ = try memory.read("/api/fs/serve/fixture/index.html", limit: 1) }
        rejects { _ = try memory.request(["path": "/api/config/settings", "method": "GET", "expectedHost": expected, "body": "invalid"]) }
        for method in ["POST", "PUT", "PATCH", "DELETE"] {
            rejects { _ = try memory.request(["path": "/api/config/settings", "method": method, "body": ["never": "write"], "expectedHost": expected]) }
        }
        let request = try GuiPluginPreviewRequest(["method": "GET", "route": "/api/plugin"])
        let inventory = try memory.gui(memory.scope, request, 65536)
        precondition(String(data: inventory.data, encoding: .utf8) == "[]")
        let rpc = try GuiPluginPreviewRequest(["method": "POST", "route": "/api/rpc/synthetic/write", "body": "{}"])
        rejects { _ = try memory.gui(memory.scope, rpc, 65536) }
        rejects { try memory.admit(RuntimeHostScope(hostID: memory.scope.hostID, lease: UUID())) }
        let before = try memory.read("/api/fs/stat?path=%2Ffixture%2Findex.html", limit: 65536)
        _ = try memory.read("/api/fs/serve/fixture/watch.png", limit: 65536)
        let after = try memory.read("/api/fs/stat?path=%2Ffixture%2Findex.html", limit: 65536)
        precondition(before.data != after.data)
        let audit = memory.audit(), counts = audit["counts"] as! [String: Int]
        precondition(counts["deniedHostWrites"] == 5 && counts["guiInventoryReads"] == 1)
        for _ in 0..<60 { _ = try memory.read("/api/config/settings", limit: 65536) }
        precondition((memory.audit()["journal"] as! [[String: String]]).count == 48)
        memory.invalidate()
        rejects { _ = try memory.read("/api/config/settings", limit: 65536) }
        print("Synthetic resource strict wire contract passed; writes denied=5; realHost=false")
    }
}
