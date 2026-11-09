import Foundation
import UIKit
import PhotosUI
enum NativeFailure: Error { case message(String) }
@MainActor final class RuntimeBridge {
    var upload: (Data, String, String) async throws -> [String: Any] = { _, _, _ in [:] }
    var reconciliations = 0, retirements = 0
    var retirementFails = false
    func attachmentUploader(expectedHost: RuntimeHostScope?, assistantID: String?) throws -> (Data, String, String) async throws -> [String: Any] { upload }
    func attachmentUploader(expectedHost: RuntimeHostScope?) throws -> (Data, String, String) async throws -> [String: Any] { upload }
    func validateAttachmentHost(_ expectedHost: RuntimeHostScope) throws {}
    func restoreAttachmentOperation(_ record: AttachmentReceiptRecord, expectedHost: RuntimeHostScope? = nil, journal: AttachmentReceiptJournal) throws -> NativeAttachmentOperation { throw AttachmentUploadFailure.invalid }
    func contactAttachmentOperation(expectedHost: RuntimeHostScope, assistantID: String, expectedGeneration: Int, requestID: String, context: AttachmentDraftContext, journal: AttachmentReceiptJournal) async throws -> NativeAttachmentOperation {
        NativeAttachmentOperation(upload: upload, reconcile: { self.reconciliations += 1; return ["type": "file", "generation": 3] }, retire: {
            self.retirements += 1
            if self.retirementFails { throw URLError(.notConnectedToInternet) }
        }, acknowledge: { _ in })
    }
}
@main @MainActor enum AttachmentCallbacks {
    static func until(_ condition: () -> Bool) async { for _ in 0..<10000 { if condition() { return }; await Task.yield() }; fatalError("callback timeout") }
    static func main() async throws {
        let scope = RuntimeHostScope(hostID: "fixture", lease: UUID())
        let presenter = UIViewController(), runtime = RuntimeBridge(), bridge = AttachmentBridge(controller: presenter, runtime: runtime, journal: AttachmentReceiptJournal(load: { nil }, save: { _ in }))
        func args(_ request: String, _ kind: String = "images") -> [String: Any] { ["kind": kind, "requestId": request, "expectedHost": scope.publicValue, "assistantID": "bot", "contactGeneration": 3, "draftIdentity": "fixture", "draftRevision": 1, "pageOperation": "page_1"] }
        for kind in ["images", "files", "cancel"] {
            var settled = false
            let pending = Task { defer { settled = true }; return try await bridge.pick(args(kind, kind == "files" ? "files" : "images")) }
            await until { presenter.presentedViewController != nil }
            let old = presenter.presentedViewController!
            if kind == "images" { bridge.picker(old as! PHPickerViewController, didFinishPicking: []) }
            else if kind == "files" { bridge.documentPickerWasCancelled(old as! UIDocumentPickerViewController) }
            else { try bridge.cancelPick(args(kind)) }
            for _ in 0..<20 { await Task.yield() }
            precondition(!settled, "continuation settled before actual dismiss completion")
            await until { !AttachmentUIKit.dismissals.isEmpty }
            AttachmentUIKit.completeDismissal()
            do { _ = try await pending.value } catch { precondition(kind == "cancel") }
            precondition(presenter.presentedViewController == nil)
            // Late old delegate/completion cannot finish the newly presented selection.
            let next = Task { try await bridge.pick(args("next-" + kind)) }
            await until { presenter.presentedViewController != nil }
            bridge.presentationControllerDidDismiss(old.presentationController!)
            try bridge.cancelPick(args("next-" + kind))
            await until { !AttachmentUIKit.dismissals.isEmpty }; AttachmentUIKit.completeDismissal()
            do { _ = try await next.value; fatalError("cancel") } catch { }
        }
        let file = URL(fileURLWithPath: CommandLine.arguments[1])
        var providerSettled = false, uploads = 0
        runtime.upload = { _, _, _ in uploads += 1; return [:] }
        let waiting = Task { defer { providerSettled = true }; return try await bridge.pick(args("provider-wait")) }
        await until { presenter.presentedViewController != nil }
        let waitingPicker = presenter.presentedViewController as! PHPickerViewController, waitingProvider = AttachmentProvider()
        bridge.picker(waitingPicker, didFinishPicking: [PHPickerResult(waitingProvider)])
        await until { !AttachmentUIKit.dismissals.isEmpty }; AttachmentUIKit.completeDismissal()
        for _ in 0..<20 { await Task.yield() }
        precondition(!providerSettled && uploads == 0, "dismissal does not invent provider result or release its owner")
        try bridge.cancelPick(args("provider-wait"))
        do { _ = try await waiting.value; fatalError("provider cancellation") } catch { }
        var replacementSettled = false
        let replacement = Task { defer { replacementSettled = true }; return try await bridge.pick(args("replacement")) }
        await until { presenter.presentedViewController != nil }
        waitingProvider.reply!(file, nil)
        for _ in 0..<100 { await Task.yield() }
        precondition(!replacementSettled && uploads == 0, "old provider result must neither upload nor finish replacement")
        try bridge.cancelPick(args("replacement"))
        await until { !AttachmentUIKit.dismissals.isEmpty }; AttachmentUIKit.completeDismissal()
        do { _ = try await replacement.value; fatalError("replacement cancellation") } catch { }
        var pending: Task<Any?, Error>!
        runtime.upload = { _, _, _ in pending.cancel(); return ["attachmentID": "att_synthetic"] }
        pending = Task { try await bridge.pick(args("late-cancel")) }
        await until { presenter.presentedViewController != nil }
        let photos = presenter.presentedViewController as! PHPickerViewController, provider = AttachmentProvider()
        bridge.picker(photos, didFinishPicking: [PHPickerResult(provider)])
        await until { provider.reply != nil }; provider.reply!(file, nil)
        await until { !AttachmentUIKit.dismissals.isEmpty }; AttachmentUIKit.completeDismissal()
        do { _ = try await pending.value; fatalError("cancelled success") }
        catch { precondition(error as? AttachmentUploadFailure == .unknown, "post-success parent cancel must be unknown") }
        // The picker defer released presentation, but not this exact receipt.
        _ = try await bridge.reconcilePick(args("late-cancel"))
        precondition(runtime.reconciliations == 1)
        runtime.retirementFails = true
        do { try await bridge.retirePick(args("late-cancel")); fatalError("cleanup ACK fabricated") } catch { }
        runtime.retirementFails = false
        try await bridge.retirePick(args("late-cancel"))
        precondition(runtime.retirements >= 2 && FileManager.default.fileExists(atPath: file.path))
        do { _ = try await bridge.reconcilePick(args("late-cancel")); fatalError("retired receipt retained") } catch { }
        print("Attachment production callbacks passed")
    }
}
