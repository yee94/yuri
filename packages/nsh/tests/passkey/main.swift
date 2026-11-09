import Foundation

func expect(_ condition: @autoclosure () -> Bool, _ label: String) { precondition(condition(), label) }
func rejects(_ label: String, _ action: () throws -> Void) { do { try action(); fatalError(label) } catch {} }
@MainActor func rejectsAsync(_ label: String, _ action: () async throws -> Void) async { do { try await action(); fatalError(label) } catch {} }

@main struct PasskeyChecks {
    @MainActor static func main() async throws {
        let admission = PasskeyPresentationAdmission()
        let firstReservation = try admission.reserve()
        rejects("another presentation blocked by synchronous reservation") { _ = try admission.reserve() }
        admission.release(UUID())
        rejects("wrong receipt cannot release reservation") { _ = try admission.reserve() }
        admission.cancel(firstReservation)
        rejects("cancelled receipt remains occupied until owner drains") { _ = try admission.reserve() }
        admission.release(firstReservation)
        let secondReservation = try admission.reserve()
        admission.release(firstReservation)
        expect(admission.isCurrent(secondReservation), "late old defer cannot clear newer owner")
        admission.beginClose()
        rejects("closed admission rejects new work") { _ = try admission.reserve() }
        var drained = false
        let drain = Task { await admission.drain(); drained = true }
        for _ in 0..<20 { await Task.yield() }
        expect(!drained, "close waits exact live owner release")
        admission.release(secondReservation); await drain.value; expect(drained, "owner release completes close")
        let validLabels: [String: Any] = ["title": "解锁 Yuri", "cancel": "取消", "submit": "解锁", "passwordPlaceholder": "输入密码"]
        _ = try PasskeyManagementLabels(validLabels)
        var invalidLabels = validLabels; invalidLabels["password"] = "not-permitted"
        rejects("label extra keys rejected") { _ = try PasskeyManagementLabels(invalidLabels) }
        for invalid: Any in ["", "\n", String(repeating: "x", count: 513), 42, NSNull()] {
            var labels = validLabels; labels["submit"] = invalid
            rejects("label content/type bounded") { _ = try PasskeyManagementLabels(labels) }
        }
        let origin = URL(string: "https://host.example")!
        let options: [String: Any] = ["rp": ["id": "host.example", "name": "Yuri"], "user": ["id": "AQI", "name": "yuri-ui"], "challenge": "AwQ", "pubKeyCredParams": [["type": "public-key", "alg": -7]], "excludeCredentials": [["id": "BQY", "type": "public-key"]], "authenticatorSelection": ["residentKey": "required", "userVerification": "required"], "attestation": "none"]
        let parsed = try PasskeyRegistrationOptions(options, origin: origin, associatedDomains: ["webcredentials:host.example"])
        expect(parsed.userID == Data([1, 2]) && parsed.excluded == [Data([5, 6])], "real base64url options")
        for invalid in ["AQ==", "+w", "A", " AB", "AB"] { rejects("noncanonical base64url") { _ = try PasskeyWire.decode(invalid) } }
        rejects("missing entitlement") { _ = try PasskeyRegistrationOptions(options, origin: origin, associatedDomains: []) }
        rejects("relay RP substitution") { _ = try PasskeyRegistrationOptions(options, origin: URL(string: "https://relay.example")!, associatedDomains: ["webcredentials:host.example"]) }
        var unsupported = options; unsupported["pubKeyCredParams"] = [["type": "public-key", "alg": -257]]
        rejects("unsupported algorithms") { _ = try PasskeyRegistrationOptions(unsupported, origin: origin, associatedDomains: ["webcredentials:host.example"]) }
        for path in ["/api/passkeys/../auth/reset", "/api/passkeys/abc?token=secret", "/auth/passkey/register/options?x=1", "/api/passkeys/abc%2fdef", "/api/passkeys/", "/auth/session"] { expect(!PasskeyWire.management(path, "POST"), "exact path admission") }
        expect(PasskeyWire.management("/api/passkeys/AQ-_", "DELETE"), "exact credential deletion")
        var requests: [URLRequest] = [], current = true, cookieSeen = false
        let owner = PasskeyManagementSession(origin: origin, current: { current }) { request in
            requests.append(request)
            expect(request.value(forHTTPHeaderField: "Authorization") == nil, "client bearer never promoted")
            expect(request.value(forHTTPHeaderField: "Origin") == nil && request.url?.query == nil, "no fake origin or URL credential")
            switch request.url!.path {
            case "/auth/session": return (200, ["Set-Cookie": "yuri_ui_session=fixture-session; Path=/; Secure; HttpOnly"], ["authenticated": true])
            case "/api/passkeys": cookieSeen = request.value(forHTTPHeaderField: "Cookie") == "yuri_ui_session=fixture-session"; return (cookieSeen ? 200 : 401, [:], ["passkeys": []])
            case "/auth/passkey/register/options": return (200, [:], ["requestId": "request-1", "optionsJSON": options])
            case "/auth/passkey/register/verify": return (200, [:], ["verified": true])
            case "/api/auth/reset": return (200, [:], ["cleared": true, "signedOutEverywhere": true])
            default: return (404, [:], [:])
            }
        }
        let initial = try await owner.request("/api/passkeys", "GET", nil)
        expect(initial.0 == 401, "no full session before native login")
        _ = try await owner.request("/auth/session", "POST", ["password": "fixture-only", "issueClientToken": false])
        _ = try await owner.request("/api/passkeys", "GET", nil); expect(cookieSeen, "full session captured natively")
        _ = try await owner.request("/auth/passkey/register/options", "POST", ["label": "Yuri iOS"])
        try owner.bind(options, ceremony: "cancelled"); owner.cancel("cancelled")
        rejects("late attestation cannot complete") { try owner.complete("cancelled", credential: "AQI") }
        let proof: [String: Any] = ["requestId": "request-1", "response": ["id": "AQI", "rawId": "AQI"]]
        let beforeCancelledVerify = requests.count
        await rejectsAsync("cancelled ceremony must not verify") { _ = try await owner.request("/auth/passkey/register/verify", "POST", proof) }
        expect(requests.count == beforeCancelledVerify, "no cancelled verify I/O")
        _ = try await owner.request("/auth/passkey/register/options", "POST", nil)
        try owner.bind(options, ceremony: "success"); try owner.complete("success", credential: "AQI")
        var wrong = proof; wrong["response"] = ["id": "other", "rawId": "other"]
        await rejectsAsync("exact credential only") { _ = try await owner.request("/auth/passkey/register/verify", "POST", wrong) }
        _ = try await owner.request("/auth/passkey/register/verify", "POST", proof)
        await rejectsAsync("one verify attempt") { _ = try await owner.request("/auth/passkey/register/verify", "POST", proof) }
        let other = PasskeyManagementSession(origin: URL(string: "https://other.example")!, current: { true }) { request in
            expect(request.value(forHTTPHeaderField: "Cookie") == nil, "other Host never receives session"); return (401, [:], [:])
        }
        _ = try await other.request("/api/passkeys", "GET", nil)
        _ = try await owner.request("/api/auth/reset", "POST", nil)
        expect(owner.resetAcknowledged, "only true reset ACK permits cleanup")
        let beforeResetRetry = requests.count
        await rejectsAsync("no automatic reset replay") { _ = try await owner.request("/api/auth/reset", "POST", nil) }
        expect(requests.count == beforeResetRetry, "no second reset POST")
        var retired = 0; owner.observeRetirement { retired += 1 }; owner.retire(); owner.retire(); expect(retired == 1, "retire completion once")
        await rejectsAsync("retired cannot use session") { _ = try await owner.request("/api/passkeys", "GET", nil) }
        var lockedCalls = 0
        let locked = PasskeyManagementSession(origin: origin, current: { true }) { _ in lockedCalls += 1; return (200, [:], ["tunnelLocked": true]) }
        await rejectsAsync("unknown public locked") { _ = try await locked.request("/auth/passkey/status", "GET", nil) }
        expect(lockedCalls == 1, "does not login after locked status")
        let client = PasskeyManagementSession(origin: origin, current: { true }) { _ in (200, [:], ["authenticated": true, "scope": "client", "clientToken": "fixture-bearer"]) }
        await rejectsAsync("bearer response not full session") { _ = try await client.request("/auth/session", "POST", ["password": "fixture-only"]) }
        let late = PasskeyManagementSession(origin: origin, current: { current }) { _ in current = false; return (200, [:], ["cleared": true, "signedOutEverywhere": true]) }
        await rejectsAsync("late reset ACK fenced") { _ = try await late.request("/api/auth/reset", "POST", nil) }
        expect(!late.resetAcknowledged, "stale Host ACK cannot authorize cleanup")
        var unknownPosts = 0
        let unknown = PasskeyManagementSession(origin: origin, current: { true }) { _ in unknownPosts += 1; throw URLError(.networkConnectionLost) }
        await rejectsAsync("unknown reset") { _ = try await unknown.request("/api/auth/reset", "POST", nil) }
        await rejectsAsync("unknown reset no replay") { _ = try await unknown.request("/api/auth/reset", "POST", nil) }
        expect(!unknown.resetAcknowledged && unknownPosts == 1, "unknown reset cannot cleanup or replay")
        var release: CheckedContinuation<Void, Never>?, cancelledFlight = false
        let pending = PasskeyManagementSession(origin: origin, current: { true }) { _ in
            await withCheckedContinuation { release = $0 }
            cancelledFlight = Task.isCancelled
            return (200, [:], ["passkeys": []])
        }
        let flight = Task { try await pending.request("/api/passkeys", "GET", nil) }
        while release == nil { await Task.yield() }
        pending.retire(); release!.resume()
        await rejectsAsync("inflight retire") { _ = try await flight.value }
        expect(cancelledFlight, "retirement physically cancels native IO task")
        print("PASS: passkey policy, native UI-session isolation, exact credential, cancellation, retirement and reset memory checks")
    }
}
