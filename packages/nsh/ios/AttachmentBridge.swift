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
    init(controller: UIViewController, runtime: RuntimeBridge) { self.controller = controller; self.runtime = runtime }

    func pick(_ input: Any?) async throws -> Any? {
        let args = input as? [String: Any] ?? [:]
        guard args["assistantID"] == nil else { throw NativeFailure.message("当前原生附件仅支持会话，暂不支持助理附件") }
        guard let kind = args["kind"] as? String, ["images", "files"].contains(kind) else { throw NativeFailure.message("无效的附件类型") }
        guard let controller, controller.presentedViewController == nil, continuation == nil else { throw NativeFailure.message("请先关闭当前选择窗口") }
        let upload = try runtime.attachmentUploader()
        let attachment = try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
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
            picker.presentationController?.delegate = self
            controller.present(picker, animated: true)
        }
        guard let attachment else { return nil }
        return try await upload(attachment.data, attachment.name, attachment.mime)
    }

    private func finish(_ result: Result<NativeAttachment?, Error>) {
        guard let continuation else { return }
        self.continuation = nil
        continuation.resume(with: result)
    }
    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { finish(.success(nil)) }
    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) { finish(.success(nil)) }
    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let url = urls.first else { finish(.success(nil)); return }
        Task {
            do {
                let value = try await Task.detached(priority: .userInitiated) { try Self.read(url, name: url.lastPathComponent) }.value
                finish(.success(value))
            } catch { finish(.failure(error)) }
        }
    }
    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        picker.dismiss(animated: true)
        guard let provider = results.first?.itemProvider else { finish(.success(nil)); return }
        guard let identifier = provider.registeredTypeIdentifiers.first(where: { UTType($0)?.conforms(to: .image) == true }) else { finish(.failure(NativeFailure.message("无法读取所选图片"))); return }
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
            } catch { result = .failure(error) }
            Task { @MainActor in self?.finish(result) }
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
