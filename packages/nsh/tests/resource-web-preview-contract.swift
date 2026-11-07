import Foundation

@main struct ResourceWebPreviewContract {
    static func require(_ value: @autoclosure () throws -> Bool, _ message: String) throws {
        if try !value() { throw NSError(domain: "ResourceWebPreviewFixture", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
    }
    static func rejected(_ body: () throws -> Void) throws {
        do { try body() } catch { return }
        throw NSError(domain: "ResourceWebPreviewFixture", code: 1, userInfo: [NSLocalizedDescriptionKey: "expected rejection"])
    }
    static func rejectedAsync(_ body: () async throws -> Void) async throws {
        do { try await body() } catch { return }
        throw ResourceWebPreviewFailure.response
    }
    @MainActor static func main() async throws {
        let authority = RuntimeHostAuthority()
        authority.setForeground(true, hostID: "A")
        let a = authority.scope(hostID: "A")!
        let owners = ResourceWebPreviewOwnership()
        var captures = 0, downstream = 0
        func input(_ scope: RuntimeHostScope, _ owner: String, loopback: Bool = false) -> [String: Any] {
            var result: [String: Any] = loopback ? ["kind": "loopback", "url": "http://localhost:3000/"] : ["kind": "html", "directory": "/fixture", "path": "/fixture/index.html"]
            result["expectedHost"] = scope.publicValue; result["owner"] = owner; return result
        }
        func capture(_ expected: RuntimeHostScope) throws -> ResourceWebPreviewTransport {
            _ = try authority.admit(expected, hostID: selected, required: true)
            captures += 1
            return ResourceWebPreviewTransport(readFile: { _, _ in downstream += 1; return ResourceWebPreviewResponse(status: 200, mime: "text/html", data: Data()) }, isCurrent: { authority.matches(expected, hostID: selected) }, prepareLoopback: { _ in downstream += 1; throw ResourceWebPreviewFailure.unsupported })
        }
        var selected = "A"
        let old = try owners.begin(input(a, "old"), capture: capture)
        try require(captures == 1 && downstream == 0, "admission precedes all reads")
        try require(owners.retire(old), "old cleanup")
        selected = "B"; authority.rotate(hostID: selected)
        try rejected { _ = try owners.begin(input(a, "late-html"), capture: capture) }
        selected = "A"; authority.rotate(hostID: selected)
        try rejected { _ = try owners.begin(input(a, "late-proxy", loopback: true), capture: capture) }
        let fresh = authority.scope(hostID: selected)!
        authority.setForeground(false, hostID: selected)
        try rejected { _ = try owners.begin(input(fresh, "background"), capture: capture) }
        try require(captures == 1 && downstream == 0, "stale A-B-A/background have zero new Host effects")
        authority.setForeground(true, hostID: selected)
        let currentReceipt = authority.scope(hostID: selected)!
        var missing = input(currentReceipt, "missing"); missing.removeValue(forKey: "expectedHost")
        try rejected { _ = try owners.begin(missing, capture: capture) }
        var malformed = input(currentReceipt, "bad"); malformed["expectedHost"] = ["hostID": "A", "lease": "invalid"]
        try rejected { _ = try owners.begin(malformed, capture: capture) }
        var invalidIntent = input(currentReceipt, "bad-path"); invalidIntent["path"] = "/other/index.html"
        try rejected { _ = try owners.begin(invalidIntent, capture: capture) }
        try require(captures == 1 && downstream == 0, "strict parse before capture")
        let newer = try owners.begin(input(currentReceipt, "new"), capture: capture)
        try require(try owners.closing(["owner": "old", "expectedHost": a.publicValue], capture: capture) == nil, "late close cannot affect new surface")
        try require(!owners.retire(old) && owners.matches(newer), "old completion/cancel cannot retire new ticket")
        _ = try await newer.transport.readFile("/synthetic", 1)
        try require(captures == 2 && downstream == 1, "current scope positive control")
        try require(try owners.closing(["owner": "new", "expectedHost": a.publicValue], capture: capture) == nil, "owner alone is not authority")
        try require(try owners.closing(["owner": "new", "expectedHost": currentReceipt.publicValue], capture: capture) === newer, "exact close admitted")
        try require(owners.retire(newer), "exact new cleanup")
        try require(try owners.closing(["owner": "close-first", "expectedHost": currentReceipt.publicValue], capture: capture) == nil, "close before native handler starts")
        let beforeLatePresent = captures
        try rejected { _ = try owners.begin(input(currentReceipt, "close-first", loopback: true), capture: capture) }
        try require(captures == beforeLatePresent && downstream == 1, "closed owner rejects before capture and proxy effects")
        let dismissing = try owners.begin(input(currentReceipt, "dismissing"), capture: capture)
        try require(owners.startClosing(dismissing) && !owners.matches(dismissing), "closing fences callbacks immediately")
        var acknowledged = false
        let closing = Task { await owners.waitClosed(dismissing); acknowledged = true }
        await Task.yield()
        try require(!acknowledged, "close acknowledgement waits for dismissal completion")
        try rejected { _ = try owners.begin(input(currentReceipt, "too-early"), capture: capture) }
        try require(owners.retire(dismissing), "dismissal completion retires exact ticket")
        await closing.value
        try require(acknowledged, "close acknowledgement after completion")
        let reopened = try owners.begin(input(currentReceipt, "reopened"), capture: capture)
        try require(!owners.retire(dismissing) && owners.matches(reopened), "late dismiss completion cannot retire reopened surface")
        _ = owners.retire(reopened)
        let beforeCancel = captures
        let cancelled = Task { try owners.begin(input(currentReceipt, "pre-cancelled"), capture: capture) }
        cancelled.cancel()
        try await rejectedAsync { _ = try await cancelled.value }
        try require(captures == beforeCancel, "actual pre-cancelled native task has no capture")
        authority.rotate(hostID: selected); owners.invalidateClosedOwners()
        let rotated = authority.scope(hostID: selected)!, beforeLateCloses = captures
        for index in 0..<4100 {
            try require(try owners.closing(["owner": "late-\(index)", "expectedHost": currentReceipt.publicValue], capture: capture) == nil, "retired close ignored")
        }
        try require(captures == beforeLateCloses && downstream == 1, "late old closes cannot capture new Host or consume current cancellation quota")
        let afterLateCloses = try owners.begin(input(rotated, "after-late-closes"), capture: capture)
        try require(owners.matches(afterLateCloses), "new receipt remains available after stale close flood")
        _ = owners.retire(afterLateCloses)
        let diagnostic = ResourceWebPreviewDiagnostic(.rulesCompile, error: NSError(domain: "WKErrorDomain", code: 6, userInfo: [NSLocalizedDescriptionKey: "https://secret.invalid/?token=do-not-emit"]))
        try require(diagnostic.stage.rawValue == "rules.compile" && diagnostic.domain == "WKErrorDomain" && diagnostic.code == 6, "safe exact diagnostic fields")
        let unknown = ResourceWebPreviewDiagnostic(.responseConstruct, error: NSError(domain: "https://secret.invalid/?token=do-not-emit", code: 1))
        try require(unknown.domain == "OtherErrorDomain", "untrusted error domain redacted")
        let noError = ResourceWebPreviewDiagnostic(.navigationPolicy)
        try require(noError.domain == nil && noError.code == nil, "successful stage has no fabricated NSError")
        let responseURL = URL(string: "yuri-resource://fixture/index.html")!
        let utf8 = ResourceWebPreviewResponse(status: 200, mime: "text/html; charset=utf-8", data: Data("<h1>资源预览</h1>".utf8), contentSecurityPolicy: "script-src 'self'")
        let utf8Head = try utf8.webResponse(for: responseURL)
        try require(utf8Head.value(forHTTPHeaderField: "Content-Type") == utf8.mime && utf8Head.textEncodingName == "utf-8", "full UTF-8 Content-Type reaches WebKit response")
        try require(utf8Head.value(forHTTPHeaderField: "Content-Security-Policy") == ResourceWebPreviewScope.policy + ", script-src 'self'", "encoding response retains CSP")
        let latinBytes = Data([0x3c, 0x70, 0x3e, 0x63, 0x61, 0x66, 0xe9, 0x3c, 0x2f, 0x70, 0x3e])
        let latin = ResourceWebPreviewResponse(status: 200, mime: "text/html; charset=iso-8859-1", data: latinBytes)
        let latinHead = try latin.webResponse(for: responseURL)
        try require(latinHead.value(forHTTPHeaderField: "Content-Type") == latin.mime && latinHead.textEncodingName == "iso-8859-1" && latin.data == latinBytes, "non-UTF8 HTML charset and raw bytes preserved")
        for type in ["text/html", "image/png", "application/octet-stream"] {
            let bytes = Data([0xff, 0, 0x80])
            let raw = ResourceWebPreviewResponse(status: 200, mime: type, data: bytes)
            let head = try raw.webResponse(for: responseURL)
            try require(head.value(forHTTPHeaderField: "Content-Type") == type && head.textEncodingName == nil && raw.data == bytes, "missing charset and binary MIME stay untouched")
        }
        let owner = "fixture"
        let files = try ResourceWebPreviewScope.html(directory: "/work", path: "/work/报告 #.html")
        let entry = URL(string: "yuri-resource://fixture" + files.entryPath)!
        try require(ResourceWebPreviewScope.statRoute("/work/a #.html") == "/api/fs/stat?path=%2Fwork%2Fa%20%23.html", "stat query escaping")
        try ResourceWebPreviewScope.validateStat(ResourceWebPreviewResponse(status: 200, mime: "application/json", data: Data("{\"isFile\":true,\"size\":5}".utf8)))
        for stat in [ResourceWebPreviewResponse(status: 200, mime: "text/html", data: Data("<html>SPA fallback</html>".utf8)), ResourceWebPreviewResponse(status: 200, mime: "application/json", data: Data("{\"isFile\":false,\"size\":5}".utf8)), ResourceWebPreviewResponse(status: 200, mime: "application/json", data: Data("{\"isFile\":true,\"size\":8388609}".utf8))] { try rejected { try ResourceWebPreviewScope.validateStat(stat) } }
        try require(try files.route(entry, owner: owner) == "/api/fs/serve/work/%E6%8A%A5%E5%91%8A%20%23.html", "encoded file route")
        let css = URL(string: "./style.css", relativeTo: entry)!.absoluteURL
        try require(try files.route(css, owner: owner) == "/api/fs/serve/work/style.css", "relative subresource")
        try require(try files.route(URL(string: "yuri-resource://fixture/work/a.css?v=1")!, owner: owner) == "/api/fs/serve/work/a.css", "file cache query does not change filesystem identity")
        for value in ["yuri-resource://other/work/a.css", "https://localhost/work/a.css", "yuri-resource://fixture/other/a.css", "yuri-resource://fixture/work/../private", "yuri-resource://fixture/work/%2e%2e/private", "yuri-resource://fixture/work/%252e%252e/private", "yuri-resource://fixture/work/%5cprivate", "yuri-resource://fixture/work/a.css?token=x", "yuri-resource://fixture/api/config/settings", "file:///work/a.css", "yuri-resource://user@fixture/work/a.css", "yuri-resource://fixture:80/work/a.css"] {
            try rejected { _ = try files.route(URL(string: value)!, owner: owner) }
        }
        for value in ["/work/a.eficy", "/work/a.cjs", "/work2/a.html", "/work/../a.html", "/work//a.html"] { try rejected { _ = try ResourceWebPreviewScope.html(directory: "/work", path: value) } }
        for value in ["http://localhost:3000/", "http://127.0.0.1/", "http://[::1]:8000/", "https://0.0.0.0:3000/"] { _ = try ResourceWebPreviewScope.loopback(value) }
        for value in ["http://localhost.example.invalid/", "http://user@localhost/", "http://127.1/", "http://2130706433/", "file:///work/a.html", "http://localhost:0/", "http://localhost:65536/", "http://localhost/?%79uri_url_token=x", "http://localhost/?oc_client_token=x", "http://localhost/?yuri_client_token=x", "http://localhost/?authorization=x", "http://localhost/?token=x", "http://localhost/%00", "http://localhost/%5c"] { try rejected { _ = try ResourceWebPreviewScope.loopback(value) } }
        let base = "/api/preview/proxy/0123456789abcdef0123456789abcdef"
        let target = try ResourceWebPreviewScope.loopback("http://localhost:3000/report?q=one#two")
        let proxy = try ResourceWebPreviewScope.proxy(basePath: base, target: target)
        try require(proxy.entryPath == base + "/report?q=one#two", "Host proxy entry path")
        try require(try proxy.route(URL(string: "yuri-resource://fixture" + proxy.entryPath)!, owner: owner) == base + "/report?q=one", "fragment stays local")
        let root = try ResourceWebPreviewScope.proxy(basePath: base, target: ResourceWebPreviewScope.loopback("http://localhost:3000/"))
        try require(try root.route(URL(string: "yuri-resource://fixture" + root.entryPath)!, owner: owner) == base + "/", "proxy root")
        for path in ["/api/fs/serve/work/private", "/api/config/settings", base + "-other/a", "/api/preview/proxy/fedcba9876543210/a", base + "/../private", base + "/%252e%252e/private", base + "/a?yuri_url_token=x"] {
            try rejected { _ = try proxy.route(URL(string: "yuri-resource://fixture" + path)!, owner: owner) }
        }
        for bad in ["/api/preview/proxy/not-an-id", "/api/fs/serve/work", base + "/../config"] { try rejected { _ = try ResourceWebPreviewScope.proxy(basePath: bad, target: target) } }
        let html = ResourceWebPreviewResponse(status: 200, mime: "text/html; charset=utf-8", data: Data("<h1>fixture</h1>".utf8))
        try ResourceWebPreviewScope.validate(html, document: true)
        for response in [ResourceWebPreviewResponse(status: 302, mime: "text/html", data: Data()), ResourceWebPreviewResponse(status: 401, mime: "text/html", data: Data()), ResourceWebPreviewResponse(status: 200, mime: "application/json", data: Data()), ResourceWebPreviewResponse(status: 200, mime: "text/html\r\nSet-Cookie: bad", data: Data()), ResourceWebPreviewResponse(status: 200, mime: "text/html", data: Data(count: ResourceWebPreviewScope.responseLimit + 1)), ResourceWebPreviewResponse(status: 200, mime: "text/html", data: Data(), contentSecurityPolicy: "default-src *\n")] { try rejected { try ResourceWebPreviewScope.validate(response, document: true) } }
        var current = true
        var reads: [String] = []
        let transport = ResourceWebPreviewTransport(readFile: { route, limit in
            guard current else { throw CancellationError() }
            try require(limit <= ResourceWebPreviewScope.responseLimit, "bounded transport")
            reads.append(route); return html
        }, isCurrent: { current })
        let result = try await transport.readFile(files.route(entry, owner: owner), 1024)
        try require(result.data == html.data && reads.count == 1, "injected captured transport")
        try require(transport.prepareLoopback == nil, "missing proxy support is explicit")
        current = false
        try require(!transport.isCurrent(), "Host generation fence")
        do { _ = try await transport.readFile("/api/fs/serve/work/a.html", 1024); throw ResourceWebPreviewFailure.response } catch is CancellationError {}
        var nativeCurrent = true
        var requests: [(String, String, Data?, [String: String], Int)] = []
        let metadata: [String: Any] = ["id": "0123456789abcdef0123456789abcdef", "proxyBasePath": base, "previewToken": String(repeating: "a", count: 32), "expiresAt": Date().addingTimeInterval(290).timeIntervalSince1970 * 1000]
        var reply = ResourceWebPreviewResponse(status: 200, mime: "application/json", data: try JSONSerialization.data(withJSONObject: metadata))
        var invalidateDuringResponse = false
        let authorized = ResourceWebPreviewTransport.authorized(readFile: { _, _ in html }, isCurrent: { nativeCurrent }, send: { route, method, body, headers, limit in
            requests.append((route, method, body, headers, limit))
            if invalidateDuringResponse { nativeCurrent = false }
            return reply
        })
        let prepared = try await authorized.prepareLoopback!("http://localhost:3000/report?q=one#two")
        try require(prepared.basePath == base, "target metadata")
        try require(requests[0].0 == "/api/preview/targets" && requests[0].1 == "POST" && requests[0].4 == 65536, "create route and bound")
        let body = try JSONSerialization.jsonObject(with: requests[0].2!) as! [String: Any]
        try require(body["allowExternal"] as? Bool == false && body["ttlMs"] as? Int == 300000, "fixed native scope")
        try require(requests[0].3 == ["X-Yuri-Native-Preview": "1"], "no forged Origin or page credentials")
        reply = ResourceWebPreviewResponse(status: 200, mime: "text/html; charset=utf-8", data: html.data, contentSecurityPolicy: "script-src 'self'")
        let delivered = try await prepared.read(base + "/report?q=one&yuri_preview_token=obsolete", 1024)
        try require(delivered.contentSecurityPolicy == "script-src 'self'", "Host CSP preserved")
        try require(delivered.mime == "text/html; charset=utf-8", "authorized proxy retains full Content-Type")
        try require(requests.last!.0 == base + "/report?q=one" && requests.last!.1 == "GET", "old scoped URL token removed")
        try require(requests.last!.3 == ["X-Yuri-Native-Preview": "1", "X-Yuri-Preview-Token": String(repeating: "a", count: 32)], "private header scoped token")
        reply = latin
        let latinDelivered = try await prepared.read(base + "/latin.html", 1024)
        try require(latinDelivered.mime == latin.mime && latinDelivered.data == latinBytes, "authorized proxy preserves non-UTF8 headers and bytes")
        let before = requests.count
        for path in ["/api/config/settings", base + "-other/a", base + "/%2e%2e/private", base + "/%252e%252e/private", base + "/a?yuri_url_token=secret", "https://external.invalid/a"] {
            try await rejectedAsync { _ = try await prepared.read(path, 1024) }
        }
        try await rejectedAsync { _ = try await prepared.read(base + "/a", 0) }
        try await rejectedAsync { _ = try await prepared.read(base + "/a", ResourceWebPreviewScope.responseLimit + 1) }
        try require(requests.count == before, "invalid read never reaches transport")
        for bad in [ResourceWebPreviewResponse(status: 302, mime: "text/html", data: Data()), ResourceWebPreviewResponse(status: 403, mime: "application/json", data: Data()), ResourceWebPreviewResponse(status: 200, mime: "text/html", data: Data(count: 1025))] {
            reply = bad
            try await rejectedAsync { _ = try await prepared.read(base + "/a", 1024) }
        }
        for (key, value) in [("id", "bad" as Any), ("proxyBasePath", base + "other"), ("previewToken", "bad\r\n"), ("expiresAt", true), ("expiresAt", Date().addingTimeInterval(-1).timeIntervalSince1970 * 1000), ("expiresAt", Date().addingTimeInterval(600).timeIntervalSince1970 * 1000)] {
            var bad = metadata; bad[key] = value
            reply = ResourceWebPreviewResponse(status: 200, mime: "application/json", data: try JSONSerialization.data(withJSONObject: bad))
            try await rejectedAsync { _ = try await authorized.prepareLoopback!("http://localhost:3000/") }
        }
        reply = ResourceWebPreviewResponse(status: 200, mime: "text/html", data: Data("<html>SPA</html>".utf8))
        try await rejectedAsync { _ = try await authorized.prepareLoopback!("http://localhost:3000/") }
        let noSend = requests.count
        try await rejectedAsync { _ = try await authorized.prepareLoopback!("http://localhost/?yuri_preview_token=untrusted") }
        try require(requests.count == noSend, "untrusted entry token never sent")
        reply = html; invalidateDuringResponse = true
        try await rejectedAsync { _ = try await prepared.read(base + "/a", 1024) }
        let afterStale = requests.count
        try await rejectedAsync { _ = try await prepared.read(base + "/a", 1024) }
        try require(requests.count == afterStale, "stale capture never dispatches")
        nativeCurrent = true
        reply = ResourceWebPreviewResponse(status: 200, mime: "application/json", data: try JSONSerialization.data(withJSONObject: metadata))
        try await rejectedAsync { _ = try await authorized.prepareLoopback!("http://localhost:3000/") }
        print("Resource web preview Foundation contract passed")
    }
}
