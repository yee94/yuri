import Foundation

struct NativeSpeechVoiceIdentity {
    let identifier: String
    let name: String
    let language: String
    var publicValue: [String: String] { ["identifier": identifier, "name": name, "language": language] }
}

/// Read-only admission receipt; contains no transport, credentials, or playback owner.
@MainActor struct NativeSpeechVoiceScope {
    let expectedHost: RuntimeHostScope
    let isCurrent: () -> Bool
}

enum NativeSpeechVoiceCatalog {
    @MainActor static func read(_ input: Any?, capture: (RuntimeHostScope) throws -> NativeSpeechVoiceScope,
                                foreground: () -> Bool, voices: () -> [NativeSpeechVoiceIdentity]) throws -> [String: Any] {
        guard let value = input as? [String: Any], Set(value.keys) == ["expectedHost"] else { throw RuntimeHostScopeFailure.invalid }
        let expected = try RuntimeHostScope(value["expectedHost"])
        try Task.checkCancellation()
        guard foreground() else { throw RuntimeHostScopeFailure.background }
        let captured = try capture(expected)
        try Task.checkCancellation()
        guard foreground() else { throw RuntimeHostScopeFailure.background }
        guard captured.expectedHost == expected, captured.isCurrent() else { throw RuntimeHostScopeFailure.stale }
        let result = voices().map { $0.publicValue }
        try Task.checkCancellation()
        guard foreground() else { throw RuntimeHostScopeFailure.background }
        guard captured.isCurrent() else { throw RuntimeHostScopeFailure.stale }
        return ["voices": result]
    }
}
