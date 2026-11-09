import Foundation
import UIKit

public typealias ASPresentationAnchor = UIWindow
public struct ASAuthorizationPublicKeyCredentialUserVerificationPreference { public init(rawValue: String) {} }
public enum ASAuthorizationPublicKeyCredentialAttestationKind { case none }
@MainActor public final class ASAuthorizationPlatformPublicKeyCredentialDescriptor { public init(credentialID: Data) {} }
@MainActor public final class ASAuthorizationPlatformPublicKeyCredentialRegistrationRequest {
    public var userVerificationPreference = ASAuthorizationPublicKeyCredentialUserVerificationPreference(rawValue: "preferred")
    public var attestationPreference = ASAuthorizationPublicKeyCredentialAttestationKind.none
    public var excludedCredentials: [ASAuthorizationPlatformPublicKeyCredentialDescriptor] = []
}
@MainActor public final class ASAuthorizationPlatformPublicKeyCredentialProvider {
    public init(relyingPartyIdentifier: String) {}
    public func createCredentialRegistrationRequest(challenge: Data, name: String, userID: Data) -> ASAuthorizationPlatformPublicKeyCredentialRegistrationRequest { ASAuthorizationPlatformPublicKeyCredentialRegistrationRequest() }
}
public struct ASAuthorizationError: Error {
    public enum Code: Int { case canceled = 1001, failed = 1004 }
    public let code: Code
    public init(_ code: Code) { self.code = code }
}
@MainActor public protocol ASAuthorizationControllerDelegate: AnyObject {
    func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization)
    func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error)
}
@MainActor public protocol ASAuthorizationControllerPresentationContextProviding: AnyObject { func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor }
@MainActor public final class ASAuthorizationPlatformPublicKeyCredentialRegistration {
    public let rawAttestationObject: Data? = Data([3])
    public let credentialID = Data([1])
    public let rawClientDataJSON = Data([2])
    public init() {}
}
@MainActor public final class ASAuthorization { public let credential: Any; public init(credential: Any) { self.credential = credential } }
@MainActor public final class ASAuthorizationController: NSObject {
    public static var performed: [ASAuthorizationController] = []
    public weak var delegate: ASAuthorizationControllerDelegate?
    public weak var presentationContextProvider: ASAuthorizationControllerPresentationContextProviding?
    public private(set) var cancellations = 0
    public init(authorizationRequests: [ASAuthorizationPlatformPublicKeyCredentialRegistrationRequest]) {}
    public func performRequests() { Self.performed.append(self) }
    public func cancel() { cancellations += 1 }
    public func completeCancel() { delegate?.authorizationController(controller: self, didCompleteWithError: ASAuthorizationError(.canceled)) }
    public func completeSuccess() { delegate?.authorizationController(controller: self, didCompleteWithAuthorization: ASAuthorization(credential: ASAuthorizationPlatformPublicKeyCredentialRegistration())) }
}
