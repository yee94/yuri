import Foundation
import NativeShell
import UIKit
import AuthenticationServices


@main @MainActor enum PasskeyCallbackChecks {
    static func check(_ value: Bool, _ label: String) { precondition(value, label) }
    static func reject(_ action: () async throws -> Any?) async { do { _ = try await action(); fatalError("expected rejection") } catch {} }
    static func until(_ condition: () -> Bool) async {
        for _ in 0..<10000 { if condition() { return }; await Task.yield() }
        fatalError("callback did not arrive")
    }
    static let labels = ["title": "解锁 Yuri", "cancel": "取消", "submit": "解锁", "passwordPlaceholder": "输入密码"]
    static let scope = RuntimeHostScope(hostID: "synthetic", lease: UUID())
    static let options: [String: Any] = ["rp": ["id": "host.example"], "user": ["id": "AQI", "name": "yuri-ui"], "challenge": "AwQ", "pubKeyCredParams": [["type": "public-key", "alg": -7]]]
    static func main() async throws {
        let mode = CommandLine.arguments[1]
        let app = NshAppView(), presenter = UIViewController()
        var statusRelease: CheckedContinuation<Void, Never>?, requests = 0, binds = 0, completed = 0, cancellations = 0
        var current = true
        let transport = PasskeyTransport(origin: URL(string: "https://host.example")!, isCurrent: { current }, request: { path, _, body in
            requests += 1
            if path == "/auth/passkey/status", ["reservation", "close-status", "status-background"].contains(mode) { await withCheckedContinuation { statusRelease = $0 } }
            if path == "/auth/session" {
                check(body?["password"] as? String == "synthetic-password" && body?["trustDevice"] as? Bool == false && body?["issueClientToken"] as? Bool == false, "password login remains native-only exact session request")
                if mode == "close-login" { await withCheckedContinuation { statusRelease = $0 } }
            }
            return (200, ["authenticated": true])
        }, bind: { _, _ in binds += 1 }, complete: { _, _ in completed += 1 }, cancel: { _ in cancellations += 1 }, reset: {}, onRetire: { _ in })
        let bridge = PasskeyBridge(app: app, presenter: presenter, associatedDomains: ["webcredentials:host.example"], capture: { _ in transport })
        let authorize: [String: Any] = ["expectedHost": scope.publicValue, "labels": labels]
        let register: [String: Any] = ["expectedHost": scope.publicValue, "ceremonyID": "synthetic-ceremony", "optionsJSON": options]
        switch mode {
        case "reservation":
            let first = Task { try await app.handlers["passkey.authorizeManagement"]!(authorize) }
            await until { statusRelease != nil }
            let second = Task { try await app.handlers["passkey.authorizeManagement"]!(authorize) }
            for _ in 0..<20 { await Task.yield() }
            check(requests == 1, "second authorization must be rejected while first status is pending")
            await reject { try await second.value }
            let registration = Task { try await app.handlers["passkey.register"]!(register) }
            for _ in 0..<20 { await Task.yield() }
            check(binds == 0, "registration must be rejected while authorization status is pending")
            await reject { try await registration.value }
            check(requests == 1 && binds == 0 && StubUIKit.presentations.isEmpty && ASAuthorizationController.performed.isEmpty, "reserve before status await blocks both entry points")
            current = false; statusRelease!.resume()
            await reject { try await first.value }
            check(StubUIKit.presentations.isEmpty, "stale status cannot present")
        case "labels":
            var malformed = authorize; malformed["labels"] = ["title": "x", "cancel": "x", "submit": "x", "passwordPlaceholder": "x", "password": "must-not-be-accepted"]
            await reject { try await app.handlers["passkey.authorizeManagement"]!(malformed) }; check(requests == 0, "strict labels schema fails before I/O")
            let first = Task { try await app.handlers["passkey.authorizeManagement"]!(authorize) }
            await until { !StubUIKit.presentations.isEmpty }
            let alert = StubUIKit.presentations.last as! UIAlertController
            check(alert.title == labels["title"] && alert.actions.map(\.title) == [labels["cancel"], labels["submit"]] && alert.textFields?.first?.placeholder == labels["passwordPlaceholder"], "exact application-language labels")
            alert.actions[0].invoke(); await until { !StubUIKit.dismissals.isEmpty }; StubUIKit.finishDismissals()
            await reject { try await first.value }
        case "close-status":
            let first = Task { try await app.handlers["passkey.authorizeManagement"]!(authorize) }
            await until { statusRelease != nil }
            var closed = false
            let closing = Task { await bridge.close(); closed = true }
            for _ in 0..<20 { await Task.yield() }
            check(!closed, "close waits pending authorization operation")
            statusRelease!.resume(); await reject { try await first.value }; await closing.value
            check(closed && StubUIKit.presentations.isEmpty, "close fences late status presentation")
            await reject { try await app.handlers["passkey.register"]!(register) }
            await reject { try await app.handlers["passkey.authorizeManagement"]!(authorize) }
        case "status-background":
            let first = Task { try await app.handlers["passkey.authorizeManagement"]!(authorize) }
            await until { statusRelease != nil }
            presenter.viewIfLoaded!.window!.windowScene!.activationState = .background
            statusRelease!.resume(); await reject { try await first.value }
            check(StubUIKit.presentations.isEmpty, "actual scene foreground rechecked after status even if transport still says current")
        case "close-password":
            let first = Task { try await app.handlers["passkey.authorizeManagement"]!(authorize) }
            await until { !StubUIKit.presentations.isEmpty }
            let alert = StubUIKit.presentations.last as! UIAlertController
            alert.textFields!.first!.text = "synthetic-password"
            var closed = false; let closing = Task { await bridge.close(); closed = true }
            await until { !StubUIKit.dismissals.isEmpty }
            check(!closed && alert.textFields!.first!.text == nil, "close retains password owner until dismiss completion and clears password")
            alert.actions[1].invoke(); check(requests == 1, "late password submit does not login")
            StubUIKit.finishDismissals(); await reject { try await first.value }; await closing.value
            check(closed && requests == 1, "password dismissal drains before close")
        case "close-ceremony":
            let first = Task { try await app.handlers["passkey.register"]!(register) }
            await until { !ASAuthorizationController.performed.isEmpty }
            let controller = ASAuthorizationController.performed.last!
            var cancelled = false
            let cancelling = Task { _ = try await app.handlers["passkey.cancel"]!(["ceremonyID": "synthetic-ceremony"]); cancelled = true }
            await until { controller.cancellations == 1 }
            var closed = false; let closing = Task { await bridge.close(); closed = true }
            for _ in 0..<20 { await Task.yield() }
            check(!closed && !cancelled, "close and cancel wait system delegate completion")
            controller.completeSuccess()
            await reject { try await first.value }; _ = try await cancelling.value; await closing.value
            check(closed && cancelled && completed == 0 && cancellations > 0, "late attestation cannot verify while closing")
            await bridge.close()
        case "authorize-success", "close-login", "password-background":
            let first = Task { try await app.handlers["passkey.authorizeManagement"]!(authorize) }
            await until { !StubUIKit.presentations.isEmpty }
            let alert = StubUIKit.presentations.last as! UIAlertController
            alert.textFields!.first!.text = "synthetic-password"
            alert.actions[1].invoke()
            await until { !StubUIKit.dismissals.isEmpty }
            check(requests == 1 && alert.textFields!.first!.text == nil, "password POST waits dismissal completion and text is cleared")
            if mode == "password-background" { presenter.viewIfLoaded!.window!.windowScene!.activationState = .background }
            StubUIKit.finishDismissals()
            if mode == "password-background" {
                await reject { try await first.value }
                check(requests == 1, "scene background after password dismissal must not POST login")
                await bridge.close()
            } else if mode == "close-login" {
                await until { statusRelease != nil }
                var closed = false; let closing = Task { await bridge.close(); closed = true }
                for _ in 0..<20 { await Task.yield() }
                check(!closed, "close waits pending native login request")
                statusRelease!.resume(); await reject { try await first.value }; await closing.value
                check(closed && requests == 2, "late native login completion cannot reopen bridge")
            } else {
                let result = try await first.value
                check(result as? Bool == true && requests == 2, "successful login publishes only true")
                await bridge.close()
            }
        default: fatalError("unknown callback mode")
        }
        print("PASS: native PasskeyBridge callback \(mode)")
    }
}
