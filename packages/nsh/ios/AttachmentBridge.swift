import UIKit
import UniformTypeIdentifiers
import PhotosUI
import Darwin

private struct NativeAttachment: Sendable {
    let data: Data
    let name: String
    let mime: String
}

/// Pickers own file access. Only the completed Host descriptor crosses the NSH bridge.
@MainActor final class AttachmentBridge: NSObject, UIDocumentPickerDelegate, PHPickerViewControllerDelegate, UIAdaptivePresentationControllerDelegate {
    private weak var controller: UIViewController?
    private let runtime: RuntimeBridge
    private var continuation: CheckedContinuation<NativeAttachment?, Error>?
    private var operation: UUID?
    private var presentedPicker: UIViewController?
    private var dismissalStarted = false
    private var dismissalComplete = false
    private var pickerResult: Result<NativeAttachment?, Error>?
    private var backgroundObserver: NSObjectProtocol?
    private var requestID: String?
    private var expectedHost: RuntimeHostScope?
    private var invalidated = false
    private var uploadTask: Task<[String: Any], Error>?
    private struct ReceiptOwner {
        let host: RuntimeHostScope
        let operation: NativeAttachmentOperation
    }
    private var receipts: [String: ReceiptOwner] = [:]
    private struct LocalAcknowledgementOwner {
        let host: RuntimeHostScope
        let acknowledge: (Any?) throws -> Void
    }
    private var recoveredAcknowledgements: [String: LocalAcknowledgementOwner] = [:]
    private let journal: AttachmentReceiptJournal
    private var confirmedRetirements: [String] = []
    private var confirmedAdmissions: [(String, RuntimeHostScope, [String: Any])] = []
    init(controller: UIViewController, runtime: RuntimeBridge, journal: AttachmentReceiptJournal) { self.controller = controller; self.runtime = runtime; self.journal = journal }

    func pendingReceipts(_ input: Any?) throws -> Any {
        guard let args = input as? [String: Any], let assistantID = args["assistantID"] as? String else { throw AttachmentUploadFailure.invalid }
        let expected = try RuntimeHostScope(args["expectedHost"]), context = try AttachmentDraftContext(args)
        try runtime.validateAttachmentHost(expected)
        return try journal.records().filter { $0.connectionID == expected.hostID && $0.assistantID == assistantID && $0.draftID == context.identity }.map { saved in
            var value = saved.publicValue
            if let live = receipts[saved.requestID] {
                // A newly opened JS page cannot inherit an older page's live
                // adopter. It can only retire that exact captured operation.
                value["phase"] = "retiring"; value["cleanupHost"] = live.host.publicValue
            }
            return value
        }
    }

    func pick(_ input: Any?) async throws -> Any? {
        let args = input as? [String: Any] ?? [:]
        guard args["assistantID"] == nil || args["assistantID"] is String else { throw AttachmentUploadFailure.invalid }
        guard let kind = args["kind"] as? String, ["images", "files"].contains(kind) else { throw NativeFailure.message("无效的附件类型") }
        guard let controller, controller.presentedViewController == nil, operation == nil else { throw NativeFailure.message("请先关闭当前选择窗口") }
        let expected = try RuntimeHostScope(args["expectedHost"])
        guard let requestID = args["requestId"] as? String, !requestID.isEmpty, requestID.utf8.count <= 128,
              !requestID.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { throw AttachmentUploadFailure.invalid }
        if args["assistantID"] != nil {
            guard receipts[requestID] == nil, try journal.records().count < 64 else { throw AttachmentUploadFailure.capacity }
        }
        // Reserve the picker before awaiting generation/protocol capture so a
        // second bridge call cannot race presentation or reuse the request ID.
        let ticket = UUID()
        operation = ticket
        self.requestID = requestID
        expectedHost = expected
        invalidated = false
        dismissalStarted = false
        dismissalComplete = false
        pickerResult = nil
        defer {
            if let backgroundObserver { NotificationCenter.default.removeObserver(backgroundObserver) }
            backgroundObserver = nil
            operation = nil
            presentedPicker = nil
            self.requestID = nil
            expectedHost = nil
            uploadTask = nil
        }
        let upload: (Data, String, String) async throws -> [String: Any]
        if let assistantID = args["assistantID"] as? String {
            let context = try AttachmentDraftContext(args), contactGeneration = try AttachmentUploadPolicy.safeInteger(args["contactGeneration"])
            let captured: NativeAttachmentOperation
            do { captured = try await runtime.contactAttachmentOperation(expectedHost: expected, assistantID: assistantID, expectedGeneration: contactGeneration, requestID: requestID, context: context, journal: journal) }
            catch { throw NativeFailure.message("attachment_capture_not_dispatched:\((error as? AttachmentUploadFailure)?.rawValue ?? "attachment_upload_invalid")") }
            receipts[requestID] = ReceiptOwner(host: expected, operation: captured)
            guard !invalidated, !Task.isCancelled else { try await captured.retire(); receipts.removeValue(forKey: requestID); confirmRetirement(requestID); throw CancellationError() }
            upload = captured.upload
        } else { upload = try runtime.attachmentUploader(expectedHost: expected) }
        do {
        let attachment = try await withTaskCancellationHandler(operation: {
            try await withCheckedThrowingContinuation { continuation in
                self.continuation = continuation
                if Task.isCancelled { finish(.failure(CancellationError()), ticket: ticket); return }
                let picker: UIViewController
                if kind == "images" {
                    var configuration = PHPickerConfiguration()
                    configuration.filter = .images; configuration.selectionLimit = 1
                    configuration.preferredAssetRepresentationMode = .current
                    let photos = PHPickerViewController(configuration: configuration)
                    photos.delegate = self; picker = photos
                } else {
                    let documents = UIDocumentPickerViewController(forOpeningContentTypes: [.item], asCopy: true)
                    documents.allowsMultipleSelection = false; documents.delegate = self; picker = documents
                }
                presentedPicker = picker
                backgroundObserver = NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
                    Task { @MainActor in self?.cancel(ticket) }
                }
                controller.present(picker, animated: true)
                picker.presentationController?.delegate = self
            }
        }, onCancel: { [weak self] in Task { @MainActor in self?.cancel(ticket) } })
        guard let attachment else {
            if let receipt = receipts[requestID] { try await receipt.operation.retire(); receipts.removeValue(forKey: requestID); confirmRetirement(requestID) }
            return nil
        }
        try Task.checkCancellation()
        guard !invalidated else { throw CancellationError() }
        let work = Task { try await upload(attachment.data, attachment.name, attachment.mime) }
        uploadTask = work
        let result = try await withTaskCancellationHandler(operation: { try await work.value }, onCancel: { work.cancel() })
        guard !Task.isCancelled, !invalidated else { throw AttachmentUploadFailure.unknown }
        return result
        } catch {
            if let receipt = receipts[requestID], !receipt.operation.dispatched() { throw AttachmentUploadFailure.notDispatched }
            throw error
        }
    }

    /// Exact old page cleanup is allowed after its Host lease has retired. It
    /// cannot capture a fresh Host or dismiss/cancel another selection's work.
    func cancelPick(_ input: Any?) throws {
        guard let args = input as? [String: Any], let requestID = args["requestId"] as? String else { throw AttachmentUploadFailure.invalid }
        let expected = try RuntimeHostScope(args["expectedHost"])
        guard requestID == self.requestID, expected == expectedHost, let ticket = operation else { return }
        cancel(ticket)
    }
    /// The async bridge must await this ACK: picker dismissal alone cannot ACK
    /// a lost upload or an exact tombstone write.
    func retirePick(_ input: Any?) async throws {
        guard let args = input as? [String: Any], let requestID = args["requestId"] as? String else { throw AttachmentUploadFailure.invalid }
        let expected = try RuntimeHostScope(args["expectedHost"])
        try cancelPick(input)
        guard let receipt = receipts[requestID] else {
            // A generation capture may still be in flight; absence is not ACK.
            guard self.requestID != requestID else { throw AttachmentUploadFailure.unknown }
            if let saved = try journal.records().first(where: { $0.requestID == requestID }) {
                guard saved.connectionID == expected.hostID else { throw AttachmentUploadFailure.invalid }
                recoveredAcknowledgements.removeValue(forKey: requestID)
                if saved.phase == "retired" { try journal.remove(requestID: requestID, uploadID: saved.uploadID) }
                else { try await runtime.restoreAttachmentOperation(saved, journal: journal).retire() }
                confirmRetirement(requestID)
            } else if args["assistantID"] != nil && !confirmedRetirements.contains(requestID) { throw AttachmentUploadFailure.unknown }
            return
        }
        guard receipt.host == expected else { throw AttachmentUploadFailure.invalid }
        try await receipt.operation.retire()
        receipts.removeValue(forKey: requestID)
        confirmRetirement(requestID)
    }
    private func confirmRetirement(_ requestID: String) {
        confirmedRetirements.removeAll { $0 == requestID }; confirmedRetirements.append(requestID)
        if confirmedRetirements.count > 64 { confirmedRetirements.removeFirst() }
    }
    func reconcilePick(_ input: Any?) async throws -> Any? {
        guard let args = input as? [String: Any], let requestID = args["requestId"] as? String else { throw AttachmentUploadFailure.invalid }
        let expected = try RuntimeHostScope(args["expectedHost"])
        if let receipt = receipts[requestID] {
            guard receipt.host == expected else { throw AttachmentUploadFailure.invalid }
            return try await receipt.operation.reconcile()
        }
        guard let saved = try journal.records().first(where: { $0.requestID == requestID }) else { throw AttachmentUploadFailure.unknown }
        let recovered = try runtime.restoreAttachmentOperation(saved, expectedHost: expected, journal: journal)
        let descriptor = try await recovered.reconcile()
        if descriptor != nil {
            // Retain only exact local disposal after a successful cold GET. No
            // GET/PUT capability or fresh lease can be obtained from this owner.
            recoveredAcknowledgements[requestID] = LocalAcknowledgementOwner(host: expected, acknowledge: recovered.acknowledge)
        }
        return descriptor
    }
    func acknowledgePick(_ input: Any?) throws {
        guard let args = input as? [String: Any], let requestID = args["requestId"] as? String else { throw AttachmentUploadFailure.invalid }
        let expected = try RuntimeHostScope(args["expectedHost"])
        if let prior = confirmedAdmissions.first(where: { $0.0 == requestID }) {
            guard prior.1 == expected, let descriptor = args["descriptor"] as? [String: Any], NSDictionary(dictionary: prior.2).isEqual(to: descriptor) else { throw AttachmentUploadFailure.invalid }
            return
        }
        if let receipt = receipts[requestID] {
            guard receipt.host == expected else { throw AttachmentUploadFailure.invalid }
            try receipt.operation.acknowledge(args["descriptor"])
            receipts.removeValue(forKey: requestID)
        } else if let recovered = recoveredAcknowledgements[requestID] {
            guard recovered.host == expected else { throw AttachmentUploadFailure.invalid }
            try recovered.acknowledge(args["descriptor"])
            recoveredAcknowledgements.removeValue(forKey: requestID)
        } else { throw AttachmentUploadFailure.unknown }
        guard let descriptor = args["descriptor"] as? [String: Any] else { throw AttachmentUploadFailure.invalid }
        confirmedAdmissions.append((requestID, expected, descriptor))
        if confirmedAdmissions.count > 64 { confirmedAdmissions.removeFirst() }
    }
    private func cancel(_ ticket: UUID) {
        guard operation == ticket else { return }
        invalidated = true
        uploadTask?.cancel()
        finish(.failure(CancellationError()), ticket: ticket)
    }
    private func finish(_ result: Result<NativeAttachment?, Error>, ticket: UUID) {
        guard operation == ticket, let continuation else { return }
        if invalidated { pickerResult = .failure(CancellationError()) }
        else if pickerResult == nil { pickerResult = result }
        if !dismissalComplete { dismissPicker(ticket); return }
        guard let pickerResult else { return }
        self.continuation = nil
        continuation.resume(with: pickerResult)
    }
    private func dismissPicker(_ ticket: UUID) {
        guard operation == ticket, !dismissalStarted else { return }
        guard let picker = presentedPicker else {
            dismissalComplete = true
            if let pickerResult { finish(pickerResult, ticket: ticket) }
            return
        }
        dismissalStarted = true
        picker.dismiss(animated: true) { [weak self, weak picker] in
            guard let self, let picker, self.operation == ticket, self.presentedPicker === picker else { return }
            self.dismissalComplete = true
            if let result = self.pickerResult { self.finish(result, ticket: ticket) }
        }
    }
    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        guard controller === presentedPicker, let ticket = operation else { return }
        finish(.success(nil), ticket: ticket)
    }
    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        guard presentationController.presentedViewController === presentedPicker, let ticket = operation else { return }
        dismissalComplete = true
        finish(.success(nil), ticket: ticket)
    }
    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard controller === presentedPicker, let ticket = operation else { return }
        guard let url = urls.first else { finish(.success(nil), ticket: ticket); return }
        Task {
            do {
                let value = try await Task.detached(priority: .userInitiated) { try Self.read(url, name: url.lastPathComponent) }.value
                finish(.success(value), ticket: ticket)
            } catch { finish(.failure(NativeFailure.message("无法读取附件，请重新选择文件")), ticket: ticket) }
        }
    }
    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        guard picker === presentedPicker, let ticket = operation else { return }
        dismissPicker(ticket)
        guard let provider = results.first?.itemProvider else { finish(.success(nil), ticket: ticket); return }
        guard let identifier = provider.registeredTypeIdentifiers.first(where: { UTType($0)?.conforms(to: .image) == true }) else { finish(.failure(NativeFailure.message("无法读取所选图片")), ticket: ticket); return }
        let type = UTType(identifier)
        var name = provider.suggestedName ?? "image"
        if (name as NSString).pathExtension.isEmpty, let ext = type?.preferredFilenameExtension { name += ".\(ext)" }
        let filename = name
        provider.loadFileRepresentation(forTypeIdentifier: identifier) { [weak self] url, error in
            // The provider removes this temporary URL when its callback returns.
            let result: Result<NativeAttachment?, Error>
            do {
                if let error { throw error }
                guard let url else { throw NativeFailure.message("无法读取所选图片") }
                result = .success(try Self.read(url, name: filename, mime: type?.preferredMIMEType))
            } catch { result = .failure(NativeFailure.message("无法读取所选图片")) }
            Task { @MainActor in self?.finish(result, ticket: ticket) }
        }
    }

    nonisolated private static func read(_ url: URL, name: String, mime: String? = nil) throws -> NativeAttachment {
        guard url.isFileURL else { throw NativeFailure.message("附件必须是本地文件") }
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let descriptor = open(url.path, O_RDONLY | O_NOFOLLOW)
        guard descriptor >= 0 else { throw NativeFailure.message("无法读取附件，请重新选择文件") }
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        defer { try? handle.close() }
        var info = stat()
        guard fstat(descriptor, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG else { throw NativeFailure.message("不支持目录或符号链接，请选择单个文件") }
        let limit = 25 * 1024 * 1024
        guard info.st_size > 0, info.st_size <= limit else { throw NativeFailure.message("附件须为非空文件，且不超过 25 MiB") }
        var data = Data()
        while let chunk = try handle.read(upToCount: min(64 * 1024, limit + 1 - data.count)), !chunk.isEmpty {
            data.append(chunk)
            guard data.count <= limit else { throw NativeFailure.message("附件超过 25 MiB 限制") }
        }
        guard !data.isEmpty else { throw NativeFailure.message("附件为空") }
        let filename = (name as NSString).lastPathComponent
        guard !filename.isEmpty, filename.utf8.count <= 1024, !filename.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { throw NativeFailure.message("无效的附件文件名") }
        let contentType = mime ?? UTType(filenameExtension: (filename as NSString).pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        return NativeAttachment(data: data, name: filename, mime: contentType)
    }
}
