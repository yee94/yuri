import Foundation
#if canImport(UIKit)
import UIKit
import AuthenticationServices
import NativeShell

/// main owns this bridge and supplies only its real visible presenter and the
/// RuntimeBridge's captured native transport. No WebView or JS auth fallback.
@MainActor final class PasskeyBridge: NSObject, ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
    private weak var presenter: UIViewController?
    private let capture: (RuntimeHostScope) throws -> PasskeyTransport
    private let associatedDomains: Set<String>
    private var active: Ceremony?
    private let admission = PasskeyPresentationAdmission()
    private var login: Login?
    private var authorizationID: UUID?
    private var authorizationRequest: Task<(Int, [String: Any]), Error>?
    private var resets: [String: () async throws -> Void] = [:]
    private var completed: [String: PasskeyTransport] = [:]
    private var cancelledIDs = Set<String>()
    private final class Login {
        let id: UUID
        let alert: UIAlertController
        let continuation: CheckedContinuation<String, Error>
        var result: Result<String, Error>?
        var dismissing = false
        var presented = false
        init(id: UUID, alert: UIAlertController, continuation: CheckedContinuation<String, Error>) { self.id = id; self.alert = alert; self.continuation = continuation }
    }
    private final class Ceremony {
        let id: String
        let transport: PasskeyTransport
        let controller: ASAuthorizationController
        let window: UIWindow
        let continuation: CheckedContinuation<Any?, Error>
        var cancelled = false
        var waiters: [CheckedContinuation<Void, Never>] = []
        init(id: String, transport: PasskeyTransport, controller: ASAuthorizationController, window: UIWindow, continuation: CheckedContinuation<Any?, Error>) {
            self.id = id; self.transport = transport; self.controller = controller; self.window = window; self.continuation = continuation
        }
    }
    init(app: NshAppView, presenter: UIViewController, associatedDomains: Set<String>, capture: @escaping (RuntimeHostScope) throws -> PasskeyTransport) {
        self.presenter = presenter; self.capture = capture; self.associatedDomains = associatedDomains
        super.init()
        app.handle("passkey.register") { [weak self] input async throws -> Any? in
            guard let self else { throw PasskeyFailure.presentation }
            return try await self.register(input)
        }
        app.handle("passkey.cancel") { [weak self] input async throws -> Any? in
            guard let self, let args = input as? [String: Any], Set(args.keys) == ["ceremonyID"], let id = args["ceremonyID"] as? String, !id.isEmpty, id.utf8.count <= 256 else { throw PasskeyFailure.invalid }
            await self.cancel(id); return true
        }
        app.handle("passkey.authorizeManagement") { [weak self] input async throws -> Any? in
            guard let self else { throw PasskeyFailure.presentation }
            try await self.authorize(input); return true
        }
        app.handle("passkey.authReset") { [weak self] input async throws -> Any? in
            guard let self else { throw PasskeyFailure.presentation }
            try self.admission.requireOpen()
            let scope = try self.scope(input), key = self.key(scope)
            if let reset = self.resets[key] { try await reset(); return true }
            let transport = try self.capture(scope)
            self.resets[key] = transport.reset
            try await transport.reset(); return true
        }
    }
    /// The shutdown owner must retain this bridge until all native presentation
    /// completions and their suspended operations have drained.
    func close() async {
        admission.beginClose()
        if let id = authorizationID { cancelAuthorization(id) }
        if let owner = active { beginCancel(owner) }
        let previous = completed; completed.removeAll(); previous.forEach { $0.value.cancel($0.key) }
        await admission.drain()
    }
    private func key(_ scope: RuntimeHostScope) -> String { scope.hostID + "\n" + scope.lease.uuidString }
    private func scope(_ input: Any?) throws -> RuntimeHostScope {
        guard let args = input as? [String: Any], Set(args.keys) == ["expectedHost"] else { throw PasskeyFailure.invalid }
        return try RuntimeHostScope(args["expectedHost"])
    }
    private func window() throws -> UIWindow {
        guard let presenter, presenter.presentedViewController == nil, let window = presenter.viewIfLoaded?.window,
              window.isKeyWindow, window.windowScene?.activationState == .foregroundActive else { throw PasskeyFailure.presentation }
        return window
    }
    private func register(_ input: Any?) async throws -> Any? {
        // Reliable controller cancellation and exclusions need iOS 17.4. Do not
        // start a ceremony on older systems that cannot honor the wire contract.
        guard #available(iOS 17.4, *) else { throw PasskeyFailure.systemVersion }
        guard let args = input as? [String: Any], Set(args.keys) == ["expectedHost", "ceremonyID", "optionsJSON"],
              let id = args["ceremonyID"] as? String, !id.isEmpty, id.utf8.count <= 256,
              let json = args["optionsJSON"] as? [String: Any] else { throw PasskeyFailure.invalid }
        let reservation = try admission.reserve()
        defer { admission.release(reservation) }
        if completed[id] != nil || cancelledIDs.contains(id) { throw PasskeyFailure.cancelled }
        let transport = try capture(RuntimeHostScope(args["expectedHost"]))
        // iOS exposes no public SecTask entitlement reader. main must provide the
        // exact build's declared webcredentials entries; AuthenticationServices
        // independently verifies the signed entitlement and the RP's AASA file.
        let options = try PasskeyRegistrationOptions(json, origin: transport.origin, associatedDomains: associatedDomains)
        let anchor = try window()
        try transport.bind(json, id)
        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: options.rpID)
        let request = provider.createCredentialRegistrationRequest(challenge: options.challenge, name: options.name, userID: options.userID)
        request.userVerificationPreference = ASAuthorizationPublicKeyCredentialUserVerificationPreference(rawValue: options.verification)
        request.attestationPreference = .none
        request.excludedCredentials = options.excluded.map { ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: $0) }
        let controller = ASAuthorizationController(authorizationRequests: [request])
        controller.delegate = self; controller.presentationContextProvider = self
        let result: Any? = try await withTaskCancellationHandler(operation: {
            try await withCheckedThrowingContinuation { continuation in
                let owner = Ceremony(id: id, transport: transport, controller: controller, window: anchor, continuation: continuation)
                active = owner
                transport.onRetire { [weak self, weak owner] in
                    guard let self, let owner, self.active === owner else { return }
                    self.beginCancel(owner)
                }
                guard admission.isCurrent(reservation), transport.isCurrent(), !Task.isCancelled else { finish(owner, result: .failure(PasskeyFailure.cancelled)); return }
                controller.performRequests()
            }
        }, onCancel: { Task { @MainActor [weak self] in await self?.cancel(id) } })
        try admission.check(reservation)
        guard transport.isCurrent(), presenter?.viewIfLoaded?.window?.windowScene?.activationState == .foregroundActive else { throw PasskeyFailure.cancelled }
        return result
    }
    private func authorize(_ input: Any?) async throws {
        let id = try admission.reserve()
        authorizationID = id
        defer { if authorizationID == id { authorizationID = nil }; admission.release(id) }
        guard let args = input as? [String: Any], Set(args.keys) == ["expectedHost", "labels"] else { throw PasskeyFailure.invalid }
        let labels = try PasskeyManagementLabels(args["labels"])
        let transport = try capture(RuntimeHostScope(args["expectedHost"]))
        transport.onRetire { [weak self] in self?.cancelAuthorization(id) }
        let (status, body) = try await requestAuthorization(id, transport: transport, path: "/auth/passkey/status", method: "GET", body: nil)
        try admission.check(id)
        guard transport.isCurrent() else { throw CancellationError() }
        guard status == 200, body["tunnelLocked"] as? Bool != true else { throw PasskeyFailure.locked }
        _ = try window()
        let password: String = try await withTaskCancellationHandler(operation: {
            try await withCheckedThrowingContinuation { continuation in
                let alert = UIAlertController(title: labels.title, message: transport.origin.host, preferredStyle: .alert)
                alert.addTextField { field in field.isSecureTextEntry = true; field.textContentType = .password; field.autocorrectionType = .no; field.placeholder = labels.passwordPlaceholder }
                let owner = Login(id: id, alert: alert, continuation: continuation)
                login = owner
                alert.addAction(UIAlertAction(title: labels.cancel, style: .cancel) { [weak self, weak owner] _ in
                    guard let owner else { return }; self?.resolveLogin(owner, .failure(PasskeyFailure.cancelled))
                })
                alert.addAction(UIAlertAction(title: labels.submit, style: .default) { [weak self, weak owner] _ in
                    guard let self, let owner, self.admission.isCurrent(id), !owner.dismissing else { return }
                    self.resolveLogin(owner, .success(owner.alert.textFields?.first?.text ?? ""))
                })
                guard admission.isCurrent(id), transport.isCurrent(), !Task.isCancelled else { resolveLogin(owner, .failure(PasskeyFailure.cancelled)); return }
                owner.presented = true
                presenter?.present(alert, animated: true)
            }
        }, onCancel: { Task { @MainActor [weak self] in self?.cancelAuthorization(id) } })
        try admission.check(id)
        guard transport.isCurrent() else { throw CancellationError() }
        let (code, result) = try await requestAuthorization(id, transport: transport, path: "/auth/session", method: "POST", body: ["password": password, "trustDevice": false, "issueClientToken": false])
        try admission.check(id)
        guard code == 200, result["authenticated"] as? Bool == true else { throw PasskeyFailure.session }
    }
    private func requestAuthorization(_ id: UUID, transport: PasskeyTransport, path: String, method: String, body: [String: Any]?) async throws -> (Int, [String: Any]) {
        try admission.check(id)
        guard transport.isCurrent(), presenter?.viewIfLoaded?.window?.windowScene?.activationState == .foregroundActive else { throw CancellationError() }
        let work = Task {
            try self.admission.check(id)
            guard transport.isCurrent(), self.presenter?.viewIfLoaded?.window?.windowScene?.activationState == .foregroundActive else { throw CancellationError() }
            return try await transport.request(path, method, body)
        }
        authorizationRequest = work
        defer { if authorizationID == id { authorizationRequest = nil } }
        let response = try await withTaskCancellationHandler(operation: { try await work.value }, onCancel: { work.cancel() })
        try admission.check(id)
        guard transport.isCurrent(), presenter?.viewIfLoaded?.window?.windowScene?.activationState == .foregroundActive else { throw CancellationError() }
        return response
    }
    private func resolveLogin(_ owner: Login, _ result: Result<String, Error>) {
        guard login === owner else { return }
        owner.alert.textFields?.first?.text = nil
        owner.result = admission.isCurrent(owner.id) ? result : .failure(PasskeyFailure.cancelled)
        guard !owner.dismissing else { return }; owner.dismissing = true
        let finish: () -> Void = { [self, owner] in
            guard login === owner else { return }; login = nil
            let result = admission.isCurrent(owner.id) ? owner.result ?? .failure(PasskeyFailure.cancelled) : .failure(PasskeyFailure.cancelled)
            owner.result = nil; owner.continuation.resume(with: result)
        }
        if owner.presented { owner.alert.dismiss(animated: false, completion: finish) }
        else { finish() }
    }
    private func cancelAuthorization(_ id: UUID) {
        guard authorizationID == id else { return }
        admission.cancel(id); authorizationRequest?.cancel()
        if let owner = login, owner.id == id { resolveLogin(owner, .failure(PasskeyFailure.cancelled)) }
    }
    private func beginCancel(_ owner: Ceremony) {
        guard !owner.cancelled else { return }; owner.cancelled = true
        owner.transport.cancel(owner.id)
        if #available(iOS 16.0, *) { owner.controller.cancel() }
        // Keep ownership until the system delegate cancellation completion. A late
        // successful attestation is discarded and never grants a verify permit.
    }
    private func cancel(_ id: String) async {
        cancelledIDs.insert(id)
        completed.removeValue(forKey: id)?.cancel(id)
        guard let owner = active, owner.id == id else { return }
        await withCheckedContinuation { continuation in owner.waiters.append(continuation); beginCancel(owner) }
    }
    private func finish(_ owner: Ceremony, result: Result<Any?, Error>) {
        guard active === owner else { return }; active = nil
        owner.controller.delegate = nil; owner.controller.presentationContextProvider = nil
        owner.continuation.resume(with: result); owner.waiters.forEach { $0.resume() }; owner.waiters.removeAll()
    }
    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        // This delegate is installed only after admission captured a real window.
        precondition(active?.controller === controller)
        return active!.window
    }
    func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        guard let owner = active, owner.controller === controller else { return }
        guard !owner.cancelled, owner.transport.isCurrent(), presenter?.viewIfLoaded?.window?.windowScene?.activationState == .foregroundActive else { owner.transport.cancel(owner.id); finish(owner, result: .failure(PasskeyFailure.cancelled)); return }
        do {
            guard let credential = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialRegistration,
                  let attestation = credential.rawAttestationObject, !attestation.isEmpty, !credential.credentialID.isEmpty, !credential.rawClientDataJSON.isEmpty else { throw PasskeyFailure.response }
            let id = PasskeyWire.encode(credential.credentialID)
            try owner.transport.complete(owner.id, id)
            completed[owner.id] = owner.transport
            let ceremonyID = owner.id
            owner.transport.onRetire { [weak self] in self?.completed.removeValue(forKey: ceremonyID) }
            let value: [String: Any] = ["id": id, "rawId": id, "type": "public-key", "response": ["clientDataJSON": PasskeyWire.encode(credential.rawClientDataJSON), "attestationObject": PasskeyWire.encode(attestation)], "clientExtensionResults": [:]]
            finish(owner, result: .success(value))
        } catch { owner.transport.cancel(owner.id); finish(owner, result: .failure(error)) }
    }
    func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        guard let owner = active, owner.controller === controller else { return }
        owner.transport.cancel(owner.id)
        let failure: Error
        if owner.cancelled || (error as? ASAuthorizationError)?.code == .canceled { failure = PasskeyFailure.cancelled }
        else if let system = error as? ASAuthorizationError { failure = PasskeySystemFailure(code: system.code.rawValue) }
        else { failure = PasskeyFailure.presentation }
        finish(owner, result: .failure(failure))
    }
}
#endif
