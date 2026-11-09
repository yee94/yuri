import Foundation

enum GuiPluginDeviceFailure: String, Error {
    case invalid = "GUI_PLUGIN_INVALID_INPUT", unsupported = "GUI_PLUGIN_UNSUPPORTED", aborted = "GUI_PLUGIN_ABORTED"
    case unavailable = "GUI_PLUGIN_UNAVAILABLE", busy = "EXPORT_BUSY", save = "EXPORT_SAVE_FAILED"
    case photosConfiguration = "GUI_PHOTOS_USAGE_DESCRIPTION_CORE_GAP"
}

/// Validated before UIKit, clipboard, OS URL or filesystem effects.
enum GuiPluginDevicePolicy {
    static let saveLimit = 32 * 1024 * 1024
    static func filename(_ value: Any?) throws -> String {
        guard let name = value as? String, !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              name.utf8.count <= 240, name != ".", name != "..", !name.contains("/"), !name.contains("\\"),
              name.rangeOfCharacter(from: .controlCharacters) == nil else { throw GuiPluginDeviceFailure.invalid }
        return name
    }
    static func external(_ input: Any?) throws -> URL {
        guard let value = input as? String, value.utf8.count <= 8192,
              !value.unicodeScalars.contains(where: { $0.value <= 32 || $0.value == 127 }), !value.contains("\\"),
              let parts = URLComponents(string: value), ["http", "https", "mailto"].contains(parts.scheme?.lowercased() ?? ""),
              parts.user == nil, parts.password == nil, let url = parts.url else { throw GuiPluginDeviceFailure.invalid }
        // Host-local links belong to the scoped resource resolver, never Safari on the phone.
        if ["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"].contains(parts.host?.lowercased() ?? "") { throw GuiPluginDeviceFailure.unsupported }
        guard parts.scheme?.lowercased() == "mailto" || parts.host?.isEmpty == false else { throw GuiPluginDeviceFailure.invalid }
        return url
    }
    static func text(_ input: Any?, limit: Int = saveLimit) throws -> String {
        guard let text = input as? String, text.utf8.count <= limit else { throw GuiPluginDeviceFailure.invalid }
        return text
    }
    static func toast(_ input: [String: Any]) throws -> (String, Double, Bool) {
        if input["icon"] != nil || input["actions"] != nil { throw GuiPluginDeviceFailure.unsupported }
        guard Set(input.keys).isSubset(of: ["title", "description", "variant", "duration", "persistent"]),
              let title = input["title"] as? String, title.utf8.count <= 16384,
              input["description"] == nil || input["description"] is String,
              input["variant"] == nil || input["variant"] is String,
              input["duration"] == nil || input["duration"] is NSNumber,
              ["default", "success", "error", "loading"].contains(input["variant"] as? String ?? "default"),
              input["persistent"] == nil || input["persistent"] is Bool else { throw GuiPluginDeviceFailure.invalid }
        let duration = input["duration"] as? NSNumber ?? 5000
        guard CFGetTypeID(duration) != CFBooleanGetTypeID(), duration.doubleValue.isFinite, duration.doubleValue >= 0 else { throw GuiPluginDeviceFailure.invalid }
        let description = input["description"] as? String
        guard (description?.utf8.count ?? 0) <= 16384 else { throw GuiPluginDeviceFailure.invalid }
        return (title + (description.map { "\n" + $0 } ?? ""), duration.doubleValue / 1000, input["persistent"] as? Bool ?? false)
    }
    static func toastIdentity(owner: String, input: [String: Any]) throws -> String {
        guard !owner.isEmpty, owner.utf8.count <= 128 else { throw GuiPluginDeviceFailure.invalid }
        let (_, seconds, persistent) = try toast(input)
        let value: [String: Any] = ["owner": owner, "title": input["title"]!, "description": input["description"] ?? NSNull(), "duration": seconds, "persistent": persistent, "variant": input["variant"] as? String ?? "default"]
        return String(data: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), encoding: .utf8)!
    }
}

#if canImport(UIKit) && canImport(WebKit)
import UIKit
import WebKit
import Photos

/// Device-only GUI boundary. Reuses the production mobile WebKit renderer;
/// the composition target must compile YuriViewExportRenderer.swift too.
@MainActor final class GuiPluginDeviceBridge: NSObject, UIDocumentPickerDelegate, UIAdaptivePresentationControllerDelegate {
    private weak var controller: UIViewController?
    private let current: () -> Bool
    private let progress: ([String: Any]) -> Void
    private var renderer: YuriViewExportRenderer?
    private var picker: UIDocumentPickerViewController?
    private var pending: CheckedContinuation<Any, Error>?
    private var directory: URL?
    private var taskID: String?
    private var fileSave = false
    private var savingPhoto = false, cancelRequested = false, terminating = false, stopped = false
    private var toastLabels: [String: UIView] = [:]
    private var toastKeys: [String: String] = [:]
    private var toastOrder: [String] = []
    private var toastStack: UIStackView?
    private var toastTimers: [String: DispatchWorkItem] = [:]
    init(controller: UIViewController, current: @escaping () -> Bool, progress: @escaping ([String: Any]) -> Void) {
        self.controller = controller; self.current = current; self.progress = progress
    }
    private func check() throws { try Task.checkCancellation(); guard !stopped, current() else { throw GuiPluginDeviceFailure.aborted } }
    func synchronous(_ method: String, input: [String: Any]) throws -> Any {
        try check()
        switch method {
        case "openExternal":
            guard Set(input.keys) == ["url"] else { throw GuiPluginDeviceFailure.invalid }
            let url = try GuiPluginDevicePolicy.external(input["url"])
            UIApplication.shared.open(url, options: [:]); return true
        case "toast.show":
            guard Set(input.keys) == ["owner", "toast"], let owner = input["owner"] as? String, let toast = input["toast"] as? [String: Any] else { throw GuiPluginDeviceFailure.invalid }
            let (text, seconds, persistent) = try GuiPluginDevicePolicy.toast(toast)
            let variant = toast["variant"] as? String ?? "default"
            let key = try GuiPluginDevicePolicy.toastIdentity(owner: owner, input: toast)
            let existing = toastKeys[key]
            guard existing != nil || toastLabels.count < 32, let view = controller?.view else { throw GuiPluginDeviceFailure.unavailable }
            let id = existing ?? UUID().uuidString
            if existing == nil {
                if toastStack == nil {
                    let stack = UIStackView(); stack.axis = .vertical; stack.spacing = 8; stack.translatesAutoresizingMaskIntoConstraints = false
                    view.addSubview(stack)
                    NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 16), stack.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -16), stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 16)])
                    toastStack = stack
                }
                let row = UIStackView(); row.axis = .horizontal; row.alignment = .center; row.spacing = 8
                row.isLayoutMarginsRelativeArrangement = true; row.layoutMargins = UIEdgeInsets(top: 12, left: 12, bottom: 12, right: 12)
                row.backgroundColor = .secondarySystemBackground; row.layer.cornerRadius = 10
                if variant == "loading" { let activity = UIActivityIndicatorView(style: .medium); activity.startAnimating(); row.addArrangedSubview(activity) }
                let label = UILabel(); label.text = text; label.numberOfLines = 0; label.font = .preferredFont(forTextStyle: .subheadline)
                label.textColor = variant == "error" ? .systemRed : variant == "success" ? .systemGreen : .label
                row.addArrangedSubview(label); toastStack?.insertArrangedSubview(row, at: 0)
                toastLabels[id] = row; toastKeys[key] = id; toastOrder.append(id); reflowToasts()
                UIAccessibility.post(notification: .announcement, argument: text)
            }
            toastTimers.removeValue(forKey: id)?.cancel()
            if !persistent { let timer = DispatchWorkItem { [weak self] in self?.dismissToast(id) }; toastTimers[id] = timer; DispatchQueue.main.asyncAfter(deadline: .now() + min(seconds, Double(Int32.max) / 1000), execute: timer) }
            return id
        case "toast.dismiss":
            guard Set(input.keys) == ["id"], let id = input["id"] as? String else { throw GuiPluginDeviceFailure.invalid }
            dismissToast(id); return true
        default: throw GuiPluginDeviceFailure.unsupported
        }
    }
    private func reflowToasts() { let visible = Set(toastOrder.suffix(3)); for (id, view) in toastLabels { view.isHidden = !visible.contains(id) } }
    private func dismissToast(_ id: String) {
        toastTimers.removeValue(forKey: id)?.cancel(); toastLabels.removeValue(forKey: id)?.removeFromSuperview()
        toastKeys = toastKeys.filter { $0.value != id }; toastOrder.removeAll { $0 == id }; reflowToasts()
        if toastLabels.isEmpty { toastStack?.removeFromSuperview(); toastStack = nil }
    }
    func request(_ method: String, input: [String: Any]) async throws -> Any {
        try check()
        if method == "capabilities" { return ["version": 1, "exportPDF": true, "exportLongImage": true, "limits": YuriViewExportRequest.limits] }
        if method == "cancel" { if input["taskId"] as? String == taskID { finish(.success(["status": "cancelled"])) }; return true }
        if method == "copy" {
            guard Set(input.keys) == ["text"] else { throw GuiPluginDeviceFailure.invalid }
            let text = try GuiPluginDevicePolicy.text(input["text"]); try check(); UIPasteboard.general.string = text; return true
        }
        guard pending == nil, !terminating else { throw GuiPluginDeviceFailure.busy }
        guard let controller, controller.view.window != nil, controller.presentedViewController == nil else { throw GuiPluginDeviceFailure.unavailable }
        let export: YuriViewExportRequest?
        let content: Data?
        let name: String
        if method == "save" {
            guard Set(input.keys) == ["name", "content"] else { throw GuiPluginDeviceFailure.invalid }
            name = try GuiPluginDevicePolicy.filename(input["name"])
            content = Data(try GuiPluginDevicePolicy.text(input["content"]).utf8); export = nil
        } else if method == "exportPDF" || method == "exportLongImage" {
            let request = try YuriViewExportRequest(input, pdf: method == "exportPDF")
            export = request; name = request.filename; content = nil
        } else { throw GuiPluginDeviceFailure.unsupported }
        try check()
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("gui-device-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: false)
        directory = folder; taskID = export?.taskId ?? UUID().uuidString; fileSave = method == "save"
        let ticket = taskID
        return try await withTaskCancellationHandler(operation: {
            try await withCheckedThrowingContinuation { continuation in
                pending = continuation
                if let export {
                    let render = YuriViewExportRenderer(request: export, directory: folder, progress: { [weak self] stage, completed, total in
                        guard let self, self.taskID == export.taskId, !self.stopped else { return }
                        var event: [String: Any] = ["taskId": export.taskId, "stage": stage]
                        if let completed { event["completed"] = completed }; if let total { event["total"] = total }
                        self.progress(event)
                    }, completion: { [weak self] result in
                        guard let self, self.taskID == export.taskId else { return }
                        do {
                            try self.check()
                            switch result {
                            case .success(let url): if export.pdf { try self.presentSave(url) } else { self.savePhoto(url) }
                            case .failure(let error): self.finish(.failure(error))
                            }
                        } catch { self.finish(.failure(error)) }
                    })
                    renderer = render; render.start(in: controller.view)
                } else {
                    do { let file = folder.appendingPathComponent(name); try content!.write(to: file, options: [.atomic, .completeFileProtection]); try presentSave(file) }
                    catch { finish(.failure(error)) }
                }
            }
        }, onCancel: { Task { @MainActor [weak self] in if self?.taskID == ticket { self?.finish(.failure(GuiPluginDeviceFailure.aborted)) } } })
    }
    private func presentSave(_ file: URL) throws {
        try check()
        guard let controller, controller.view.window != nil, controller.presentedViewController == nil else { throw GuiPluginDeviceFailure.save }
        renderer = nil
        if let taskID { progress(["taskId": taskID, "stage": "saving"]) }
        let picker = UIDocumentPickerViewController(forExporting: [file], asCopy: true)
        try check(); guard pending != nil, !terminating else { throw GuiPluginDeviceFailure.aborted }
        self.picker = picker; picker.delegate = self; picker.shouldShowFileExtensions = true
        controller.present(picker, animated: true) { [weak self, weak picker] in picker?.presentationController?.delegate = self }
    }
    private func savePhoto(_ url: URL) {
        renderer = nil
        let ticket = taskID
        guard Bundle.main.object(forInfoDictionaryKey: "NSPhotoLibraryAddUsageDescription") is String else { finish(.failure(GuiPluginDeviceFailure.photosConfiguration)); return }
        if let taskID { progress(["taskId": taskID, "stage": "saving"]) }
        PHPhotoLibrary.requestAuthorization(for: .addOnly) { [weak self] status in
            Task { @MainActor in
                guard let self, self.taskID == ticket else { return }
                guard self.pending != nil, !self.stopped, self.current(), !self.cancelRequested else { self.finish(.success(["status": "cancelled"])); return }
                guard status == .authorized || status == .limited else { self.finish(.failure(GuiPluginDeviceFailure.save)); return }
                self.savingPhoto = true
                PHPhotoLibrary.shared().performChanges({ PHAssetChangeRequest.creationRequestForAssetFromImage(atFileURL: url) }) { [weak self] saved, _ in
                    Task { @MainActor in
                        guard let self else { return }; self.savingPhoto = false
                        self.finish(saved ? .success(["status": "saved"]) : .failure(GuiPluginDeviceFailure.save))
                    }
                }
            }
        }
    }
    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) { if controller === picker { finish(urls.isEmpty ? .failure(GuiPluginDeviceFailure.save) : .success(["status": "saved"])) } }
    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { if controller === picker { finish(.success(["status": "cancelled"])) } }
    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) { if presentationController.presentedViewController === picker { finish(.success(["status": "cancelled"])) } }
    private func finish(_ result: Result<Any, Error>) {
        guard pending != nil, !terminating else { return }
        if savingPhoto { cancelRequested = true; return }
        terminating = true
        let settled = result.map { value -> Any in fileSave ? ((value as? [String: String])?["status"] == "saved") : value }
        let cleanup = { [self] in
            if let directory { try? FileManager.default.removeItem(at: directory) }
            let pending = self.pending; self.pending = nil; directory = nil; taskID = nil; picker = nil; renderer = nil; cancelRequested = false; terminating = false
            pending?.resume(with: settled)
        }
        let afterRender = { [self] in
            if let picker, picker.presentingViewController != nil { picker.delegate = nil; picker.dismiss(animated: false, completion: cleanup) }
            else { cleanup() }
        }
        if let renderer { renderer.cancel(completion: afterRender) } else { afterRender() }
    }
    func stop() { stopped = true; for id in Array(toastLabels.keys) { dismissToast(id) }; finish(.failure(GuiPluginDeviceFailure.aborted)) }
    static func reply(_ result: Result<Any, Error>) -> [String: Any] {
        switch result {
        case .success(let value): return ["ok": true, "value": value]
        case .failure(let error):
            let code = (error as? GuiPluginDeviceFailure)?.rawValue ?? (error as? YuriViewExportError)?.code ?? "GUI_PLUGIN_FAILED"
            return ["ok": false, "error": ["code": code]]
        }
    }
}
#endif
