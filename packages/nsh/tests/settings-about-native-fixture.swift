import Foundation

@main struct SettingsAboutNativeFixture {
    static func main() throws {
        let jsTypes = try JSONSerialization.jsonObject(with: Data(CommandLine.arguments[1].utf8)) as! [String]
        precondition(Set(jsTypes) == NativeEventDiagnostics.types)
        let info: [String: Any] = ["CFBundleShortVersionString": "0.1.0", "CFBundleVersion": "42.2", "private": "private-info"]
        let missing = NativeAboutSnapshot.metadata(info: [:])
        precondition(missing["version"] is NSNull && missing["build"] is NSNull)
        precondition(NativeAboutSnapshot.version("١.٢.٣") == nil)
        precondition(NativeAboutSnapshot.version("https://private.example.test") == nil)
        precondition(NativeAboutSnapshot.build("42oops") == nil)
        precondition(NativeAboutSnapshot.build("42\n") == nil)
        let raw: [String: Any] = [
            "schemaVersion": 1, "client": ["version": "99.99.99"], "hostID": "private-host",
            "token": "private-token", "message": "private-body", "paths": ["/private/user"],
            "host": ["status": "ready", "version": "2.3.0", "pid": 999, "runtime": "private-runtime"],
            "opencode": ["status": "failed", "version": "2.1.0", "management": "manual-external", "canManage": false, "guidance": "private-guidance"],
            "hostUpdate": ["status": "ready", "supported": true, "operation": "restarting", "error": "private-error", "serverId": "private-server", "checkFailed": true]
        ]
        let data = try NativeAboutSnapshot.make(raw, info: info)
        let text = String(decoding: data, as: UTF8.self)
        precondition(!text.contains("private") && !text.contains("99.99.99"))
        precondition(text.contains("0.1.0") && text.contains("42.2") && text.contains("2.1.0"))
        let body = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        precondition(Set(body.keys) == ["schemaVersion", "kind", "mode", "client", "host", "opencode", "hostUpdate"])
        var hostile = raw
        hostile["opencode"] = ["version": "Bearer private-token", "canManage": 1, "management": "private-guidance", "status": "private-error"]
        hostile["hostUpdate"] = ["operation": "private-error", "supported": 1, "checkFailed": "private-error"]
        let sanitized = try NativeAboutSnapshot.make(hostile, info: [:])
        precondition(!String(decoding: sanitized, as: UTF8.self).contains("private"))
        let safe = try JSONSerialization.jsonObject(with: sanitized) as! [String: Any]
        precondition((safe["opencode"] as! [String: Any])["canManage"] is NSNull)
        for value in [true, 1.5, 2, "1"] as [Any] {
            do { _ = try NativeAboutSnapshot.make(["schemaVersion": value], info: info); preconditionFailure("invalid schema accepted") }
            catch { }
        }
        let recorder = NativeEventDiagnostics()
        precondition(!recorder.enabled && recorder.lease == nil && recorder.count == 0)
        let event: [String: Any] = ["at": 42, "feat": "transcript", "kind": "sse-event", "sessionID": "session-1", "source": "sse", "sseType": "session.status", "surfaceKind": "global"]
        do { try recorder.append([event], lease: "unknown"); preconditionFailure("default-open recorder") } catch { }
        recorder.setEnabled(true)
        let firstLease = recorder.lease!
        try recorder.append([event], lease: firstLease)
        for type in NativeEventDiagnostics.types {
            var next = event; next["sseType"] = type
            try recorder.append([next], lease: firstLease)
        }
        var invalidEvents: [[String: Any]] = []
        for key in ["text", "token", "directory", "transport", "attachments", "files", "message", "pairingLink", "error"] {
            var invalid = event; invalid[key] = "private-sensitive"; invalidEvents.append(invalid)
        }
        for (key, value) in [("at", true), ("at", -1), ("at", Double.infinity), ("sessionID", "private-identifier"), ("sseType", "message.part.delta"), ("sseType", "private-event"), ("feat", "private-feat"), ("surfaceKind", "private-url")] as [(String, Any)] {
            var invalid = event; invalid[key] = value; invalidEvents.append(invalid)
        }
        let beforeInvalid = recorder.count
        for invalid in invalidEvents {
            do { try recorder.append([event, invalid], lease: firstLease); preconditionFailure("unsafe event accepted") } catch { }
            precondition(recorder.count == beforeInvalid) // whole-batch atomicity
        }
        do { try recorder.append(Array(repeating: event, count: 33), lease: firstLease); preconditionFailure("oversized batch accepted") } catch { }
        for index in 0..<10_000 {
            var next = event; next["at"] = index
            try recorder.append([next], lease: firstLease)
        }
        precondition(recorder.count == 500 && recorder.bytes <= NativeEventDiagnostics.maxBytes && recorder.dropped > 9_500)
        let report = try recorder.report(snapshot: raw, info: info)
        let reportText = String(decoding: report, as: UTF8.self)
        precondition(report.count <= NativeEventDiagnostics.maxExportBytes && !reportText.contains("private") && !reportText.contains("sensitive"))
        let exported = try JSONSerialization.jsonObject(with: report) as! [String: Any]
        precondition(exported["eventCount"] as? Int == 500 && exported["mode"] as? String == "event-recorder")
        precondition(exported["schema"] as? String == "yuri.client-diagnostics.v1" && exported["feats"] as? [String] == ["transcript"])
        let events = exported["events"] as! [[String: Any]]
        precondition(events.first?["at"] as? Int == 9_500 && events.last?["at"] as? Int == 9_999)
        recorder.invalidate()
        precondition(recorder.enabled && recorder.count == 0 && recorder.lease != firstLease)
        do { try recorder.append([event], lease: firstLease); preconditionFailure("stale Host lease accepted") } catch { }
        recorder.setEnabled(false)
        precondition(recorder.lease == nil && recorder.count == 0)
        do { _ = try recorder.report(snapshot: raw, info: info); preconditionFailure("disabled export accepted") } catch { }
        let temporary = FileManager.default.temporaryDirectory.appendingPathComponent("about-native-test-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: temporary, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: temporary) }
        for _ in ["shared", "cancelled", "failed"] {
            let lease = try NativeDiagnosticsFile(data: data, temporaryDirectory: temporary)
            let written = try Data(contentsOf: lease.url)
            precondition(written == data)
            let permissions = try FileManager.default.attributesOfItem(atPath: lease.url.path)[.posixPermissions] as! NSNumber
            precondition(permissions.intValue == 0o600)
            try lease.cleanup(); try lease.cleanup()
            precondition(!FileManager.default.fileExists(atPath: lease.folder.path))
        }
        for outcome in ["shared", "cancelled", "failed"] {
            var current = true
            let share = try NativeDiagnosticsShare(data: report, temporaryDirectory: temporary, isCurrent: { current })
            precondition(FileManager.default.fileExists(atPath: share.file.url.path))
            if outcome == "cancelled" { current = false }
            precondition(share.finish(outcome) == outcome)
            precondition(!FileManager.default.fileExists(atPath: share.file.folder.path))
            precondition(share.finish("shared") == nil) // late OS completion cannot settle twice
        }
        var hostCurrent = true
        let fencedShare = try NativeDiagnosticsShare(data: report, temporaryDirectory: temporary, isCurrent: { hostCurrent })
        hostCurrent = false
        precondition(fencedShare.finish("shared") == "cancelled")
        precondition(!FileManager.default.fileExists(atPath: fencedShare.file.folder.path))
        do { _ = try NativeDiagnosticsFile(data: Data(repeating: 0, count: NativeEventDiagnostics.maxExportBytes + 1), temporaryDirectory: temporary); preconditionFailure("oversized export accepted") }
        catch { }
        let remaining = try FileManager.default.contentsOfDirectory(atPath: temporary.path)
        precondition(remaining.isEmpty)
        print("About native projection and file lease passed")
    }
}
