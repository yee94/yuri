import Foundation

/// Read-only memory I/O. No URLSession, sockets, credentials or real Host.
@MainActor final class ResourcePageSyntheticHost {
    let scope = RuntimeHostScope(hostID: "synthetic-resource-page", lease: UUID())
    private(set) var current = true
    private var version = 1
    private var counts: [String: Int] = [:]
    private var journal: [[String: String]] = []
    private var files: [String: (String, Data)] = [:]
    init() {
        func put(_ name: String, _ mime: String, _ text: String) { files["/fixture/" + name] = (mime, Data(text.utf8)) }
        put("plain.txt", "text/plain", "Synthetic production resource text.\nNo real Host was accessed.\n")
        put("note.md", "text/markdown", "# Synthetic Markdown\n\nProduction TextView.\n\n![SVG data image](art.svg)\n")
        put("index.html", "text/html; charset=utf-8", """
        <!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="./style.css"><script src="./app.js" defer></script></head><body><h1>Synthetic production resource page</h1><p id="css">Relative CSS</p><p id="js">JS pending</p><img id="image" src="./pixel.png" alt="Relative PNG"><p id="decoded">Image pending</p><button id="mark">Mark DOM (no reload expected)</button><p id="count">DOM mark: 0</p><button id="watch">Advance synthetic stat locally</button><p id="watch-state">Waiting</p></body></html>
        """)
        put("style.css", "text/css", "body{font:18px system-ui;padding:16px}#css{border:3px solid green}button{padding:12px;margin:8px}img{width:24px;height:24px}")
        // Native test code advances metadata after the actual DOM button click is
        // observed through a narrow read-only synthetic asset request, no main bridge.
        put("app.js", "text/javascript", """
        document.getElementById('js').textContent='Relative JS executed';let n=0;document.getElementById('mark').onclick=()=>document.getElementById('count').textContent='DOM mark: '+(++n);const image=document.getElementById('image');const decoded=()=>document.getElementById('decoded').textContent=image.naturalWidth>0?'Relative PNG decoded':'Decode failed';if(image.complete)decoded();else image.onload=decoded;document.getElementById('watch').onclick=()=>{document.getElementById('watch-state').textContent='Stat trigger requested';const i=new Image();i.src='./watch.png';document.body.appendChild(i)};
        """)
        let pixel = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=")!
        files["/fixture/pixel.png"] = ("image/png", pixel)
        files["/fixture/watch.png"] = ("image/png", pixel)
        put("art.svg", "image/svg+xml", """
        <svg xmlns="http://www.w3.org/2000/svg" width="240" height="120" viewBox="0 0 240 120"><rect width="240" height="120" fill="green"/><text x="8" y="32" fill="white">Synthetic SVG data image</text><image x="8" y="48" width="48" height="48" href="data:image/png;base64,\(pixel.base64EncodedString())"/></svg>
        """)
    }
    func count(_ key: String) { counts[key, default: 0] += 1 }
    private func reject(_ reason: String) -> NSError { count("rejected"); return NSError(domain: "SyntheticResourcePage", code: 1, userInfo: [NSLocalizedDescriptionKey: reason]) }
    func admit(_ expected: RuntimeHostScope) throws { guard current, expected == scope else { throw reject("stale synthetic receipt") }; count("captures") }
    func bump() { version += 1; count("statBumps") }
    func invalidate() { current = false }
    func audit() -> [String: Any] { count("auditReads"); return ["syntheticOnly": true, "realHost": false, "counts": counts, "journal": journal, "statVersion": version] }
    func snapshot() -> [String: Any] {
        ["connections": [["id": scope.hostID, "url": "https://synthetic.invalid", "name": "Synthetic memory only", "transportID": "syntheticResourcePage", "authorizationID": "syntheticOnly"]], "selected": scope.hostID, "runtimeScope": scope.publicValue]
    }
    private func metadata(_ path: String) throws -> [String: Any] {
        guard let file = files[path] else { throw reject("unknown synthetic file") }
        return ["isFile": true, "isDirectory": false, "size": file.1.count, "mtimeMs": version, "isBinary": file.0 == "image/png"]
    }
    private func record(_ route: String, _ method: String) {
        count("requests"); journal.append(["method": method, "route": route]); if journal.count > 48 { journal.removeFirst() }
    }
    /// Exact routes and exact query keys. Unknown GETs fail, all writes reject.
    func read(_ route: String, limit: Int) throws -> ResourceWebPreviewResponse {
        record(route, "GET"); count("reads")
        guard current, limit > 0, let components = URLComponents(string: route), components.scheme == nil, components.host == nil, components.fragment == nil else { throw reject("invalid read") }
        let items = components.queryItems ?? []
        let response: ResourceWebPreviewResponse
        if components.percentEncodedPath == "/api/fs/stat", items.count == 1, items[0].name == "path", let path = items[0].value {
            count("statReads"); response = try json(metadata(path))
        } else if items.isEmpty, route.hasPrefix("/api/fs/serve/"), let file = files[String(route.dropFirst("/api/fs/serve".count))] {
            let path = String(route.dropFirst("/api/fs/serve".count))
            if path == "/fixture/watch.png" { bump() }
            count("file:" + path); response = ResourceWebPreviewResponse(status: 200, mime: file.0, data: file.1)
        } else if route == "/api/config/settings" { response = try json(["useSystemTheme": true, "fontSize": 100, "terminalFontSize": 13]) }
        else if route == "/api/config/themes" { response = try json(["themes": []]) }
        else if route == "/api/fs/list?path=%2Ffixture" {
            response = try json(["entries": ["index.html", "note.md", "plain.txt", "art.svg"].map { ["path": "/fixture/" + $0, "name": $0, "isDirectory": false] as [String: Any] }])
        } else { throw reject("unmapped synthetic GET") }
        guard response.data.count <= limit else { throw reject("read limit") }; return response
    }
    func request(_ input: Any?) throws -> Any {
        guard let args = input as? [String: Any], Set(args.keys).isSubset(of: ["path", "method", "expectedHost", "body"]), let path = args["path"] as? String, let method = args["method"] as? String else { throw reject("invalid runtime request") }
        try admit(RuntimeHostScope(args["expectedHost"]))
        guard method == "GET" else { record(path, method); count("deniedHostWrites"); throw reject("Host writes forbidden") }
        guard args["body"] == nil else { throw reject("GET body forbidden") }
        let response = try read(path, limit: 1_000_000)
        return ["status": response.status, "body": try JSONSerialization.jsonObject(with: response.data)]
    }
    func gui(_ expected: RuntimeHostScope, _ request: GuiPluginPreviewRequest, _ limit: Int) throws -> GuiPluginPreviewResponse {
        try admit(expected); record(request.route, request.method)
        guard request.method == "GET", request.body == nil else { count("deniedHostWrites"); throw reject("GUI writes forbidden") }
        // Empty authoritative inventory goes through the actual production registry.
        guard request.route == "/api/plugin" || request.route == "/api/plugin?location%5Bdirectory%5D=%2Ffixture" else { throw reject("unmapped GUI GET") }
        count("guiInventoryReads"); let data = Data("[]".utf8)
        guard data.count <= limit else { throw reject("GUI limit") }
        return GuiPluginPreviewResponse(status: 200, mime: "application/json", data: data)
    }
    private func json(_ value: Any) throws -> ResourceWebPreviewResponse { ResourceWebPreviewResponse(status: 200, mime: "application/json", data: try JSONSerialization.data(withJSONObject: value)) }
}
