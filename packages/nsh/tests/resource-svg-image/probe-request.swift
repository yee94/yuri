import Foundation

/// Fixture-only request-line classification. Never retain headers, bodies,
/// query strings, endpoints or arbitrary text from an unexpected local peer.
enum SVGFixtureProbeRequest {
    static let byteLimit = 2048
    private static let paths: [String: String] = [
        "/native-navigation-probe": "native-navigation",
        "/image": "outer-image", "/css": "outer-css", "/script": "outer-script", "/top": "outer-top", "/event": "outer-event",
        "/nested-event": "nested-event", "/nested-top": "nested-top", "/nested-css": "nested-css", "/nested-font": "nested-font",
        "/nested-script": "nested-script", "/nested-script-top": "nested-script-top", "/nested-image": "nested-image"
    ]
    static func classify(_ bytes: Data) -> [String: String]? {
        guard let end = bytes.prefix(byteLimit).firstIndex(of: 10) else { return nil }
        guard let line = String(data: bytes.prefix(upTo: end), encoding: .utf8) else { return ["method": "other", "path": "unknown", "kind": "unknown"] }
        let fields = line.trimmingCharacters(in: .newlines).split(separator: " ")
        guard fields.count == 3, fields[2].hasPrefix("HTTP/") else { return ["method": "other", "path": "unknown", "kind": "unknown"] }
        let method = ["GET", "HEAD", "POST", "OPTIONS", "CONNECT"].contains(String(fields[0])) ? String(fields[0]) : "other"
        let path = String(fields[1])
        guard let kind = paths[path] else { return ["method": method, "path": "unknown", "kind": "unknown"] }
        return ["method": method, "path": path, "kind": kind]
    }
}
