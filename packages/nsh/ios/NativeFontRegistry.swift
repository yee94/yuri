import Foundation
import CoreText
import CryptoKit

enum NativeFontFailure: Error { case unavailable, invalidBytes, collision, unsupported }

struct NativeRegisteredFont {
    let family: String
    let postScriptNames: [String]
    let identity: String
}

/// Two byte readers across all selections. Only 47 immutable catalog faces can
/// enter the process cache; neither Host IDs nor arbitrary family names are keys.
actor NativeFontReadBudget {
    private var count = 0
    private var waiters: [CheckedContinuation<Void, Never>] = []
    func acquire() async {
        if count < 2 { count += 1; return }
        await withCheckedContinuation { waiters.append($0) }
    }
    func release() {
        if waiters.isEmpty { count -= 1 } else { waiters.removeFirst().resume() }
    }
}

private final class NativeFontRedirectPolicy: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

enum NativeFontDownload {
    static func read(_ face: NativeFontFace) async throws -> Data {
        guard NativeFontCatalog.allows(face), face.byteCount > 0, face.byteCount <= 1_048_576 else { throw NativeFontFailure.unsupported }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 20
        configuration.timeoutIntervalForResource = 45
        configuration.httpCookieStorage = nil
        configuration.urlCredentialStorage = nil
        configuration.urlCache = nil
        let session = URLSession(configuration: configuration, delegate: NativeFontRedirectPolicy(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        var request = URLRequest(url: face.url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20)
        request.setValue("font/woff2", forHTTPHeaderField: "Accept")
        do {
            let (stream, response) = try await session.bytes(for: request)
            guard let response = response as? HTTPURLResponse, response.statusCode == 200, response.url == face.url,
                  response.expectedContentLength < 0 || response.expectedContentLength == face.byteCount else { throw NativeFontFailure.unavailable }
            var bytes = Data(); bytes.reserveCapacity(face.byteCount)
            for try await byte in stream {
                guard bytes.count < face.byteCount else { throw NativeFontFailure.invalidBytes }
                bytes.append(byte)
            }
            guard bytes.count == face.byteCount else { throw NativeFontFailure.invalidBytes }
            return bytes
        } catch let error as NativeFontFailure { throw error }
        catch { throw NativeFontFailure.unavailable }
    }
}

/// Process registration only. Files are content-addressed temporary registration
/// inputs, not a durable cache. Never trusts a pre-existing family/PS-name match.
@MainActor final class NativeFontRegistry {
    typealias Read = (NativeFontFace) async throws -> Data
    typealias Authorization = @MainActor () -> Bool
    static let shared = NativeFontRegistry()
    private let read: Read
    private let bundle: Bundle
    private let budget = NativeFontReadBudget()
    private var faces: [String: NativeRegisteredFont] = [:]
    private var registeredURLs: [String: URL] = [:]
    private var validatedBytes: [String: Data] = [:]
    private var flights: [String: Task<[Data], Error>] = [:]
    private var directory: URL?
    init(bundle: Bundle = .main, read: @escaping Read = NativeFontDownload.read) { self.bundle = bundle; self.read = read }
    static func digest(_ bytes: Data) -> String { SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined() }
    func cached(_ definition: NativeFontDefinition) -> NativeRegisteredFont? {
        let values = definition.faces.compactMap(owned)
        guard values.count == definition.faces.count, let first = values.first else { return nil }
        return NativeRegisteredFont(family: first.family, postScriptNames: values.flatMap(\.postScriptNames), identity: definition.faces.map(\.key).joined(separator: ";"))
    }
    private func owned(_ face: NativeFontFace) -> NativeRegisteredFont? {
        guard let value = faces[face.key], value.identity == face.key, let expectedURL = registeredURLs[face.key],
              let name = value.postScriptNames.first, let bytes = try? Data(contentsOf: expectedURL),
              bytes.count == face.byteCount, Self.digest(bytes) == face.sha256 else { return nil }
        let actual = CTFontCreateWithName(name as CFString, 16, nil)
        guard CTFontCopyPostScriptName(actual) as String == name,
              let actualURL = CTFontCopyAttribute(actual, kCTFontURLAttribute) as? URL,
              actualURL.standardizedFileURL == expectedURL.standardizedFileURL else { return nil }
        return value
    }
    /// Shared flights have NO registration authority. A retired caller may fill
    /// the immutable byte cache, but only a current caller can register/replace.
    private func prepare(_ definition: NativeFontDefinition) async throws -> [Data] {
        let key = definition.faces.map(\.key).joined(separator: ";")
        if let task = flights[key] { return try await task.value }
        let task = Task { () throws -> [Data] in
            var inputs: [Data] = []
            for face in definition.faces {
                guard NativeFontCatalog.allows(face) else { throw NativeFontFailure.unsupported }
                if let bytes = validatedBytes[face.key] { inputs.append(bytes); continue }
                await budget.acquire()
                let bytes: Data
                do { bytes = try await read(face) }
                catch { await budget.release(); throw error }
                await budget.release()
                guard bytes.count == face.byteCount, bytes.starts(with: [0x77, 0x4f, 0x46, 0x32]), Self.digest(bytes) == face.sha256 else { throw NativeFontFailure.invalidBytes }
                validatedBytes[face.key] = bytes
                inputs.append(bytes)
            }
            return inputs
        }
        flights[key] = task
        do {
            let value = try await task.value
            flights.removeValue(forKey: key)
            return value
        } catch { flights.removeValue(forKey: key); throw error }
    }
    func load(_ definition: NativeFontDefinition, authorized: @escaping Authorization = { !Task.isCancelled }) async throws -> NativeRegisteredFont {
        guard authorized() else { throw CancellationError() }
        if let value = cached(definition) { return value }
        let inputs = try await prepare(definition)
        guard authorized() else { throw CancellationError() }
        // No suspension point in this transaction. Existing exact own faces are
        // reused and are never included in this invocation's rollback journal.
        var added: [(face: NativeFontFace, value: NativeRegisteredFont, url: URL, replaced: URL?)] = []
        do {
            for (face, bytes) in zip(definition.faces, inputs) {
                if owned(face) != nil { continue }
                let value = try register(bytes, face: face, authorized: authorized)
                added.append((face, value.font, value.url, value.replaced))
            }
        } catch {
            for item in added.reversed() {
                _ = CTFontManagerUnregisterFontsForURL(item.url as CFURL, .process, nil)
                if let replaced = item.replaced { _ = CTFontManagerRegisterFontsForURL(replaced as CFURL, .process, nil) }
            }
            throw error
        }
        for item in added { faces[item.face.key] = item.value; registeredURLs[item.face.key] = item.url }
        guard let value = cached(definition) else { throw NativeFontFailure.unavailable }
        return value
    }
    private func register(_ bytes: Data, face: NativeFontFace, authorized: Authorization) throws -> (font: NativeRegisteredFont, url: URL, replaced: URL?) {
        guard let descriptors = CTFontManagerCreateFontDescriptorsFromData(bytes as CFData) as? [CTFontDescriptor], descriptors.count == 1 else { throw NativeFontFailure.invalidBytes }
        let descriptor = descriptors[0], font = CTFontCreateWithFontDescriptor(descriptor, 16, nil)
        let family = CTFontCopyFamilyName(font) as String, psName = CTFontCopyPostScriptName(font) as String
        guard !family.isEmpty, !psName.isEmpty else { throw NativeFontFailure.invalidBytes }
        if directory == nil {
            let location = FileManager.default.temporaryDirectory.appendingPathComponent("nsh-font-registration-" + UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: location, withIntermediateDirectories: true)
            directory = location
        }
        let url = directory!.appendingPathComponent(face.sha256 + ".woff2")
        try bytes.write(to: url, options: .atomic)
        let existing = CTFontCreateWithName(psName as CFString, 16, nil)
        let existed = CTFontCopyPostScriptName(existing) as String == psName
        guard authorized() else { throw CancellationError() }
        let replaced = try retireBundledOverlap(face: face, psName: psName)
        // CoreText may accept or merge identical bytes under another URL. That
        // does not authorize an existing registration owned outside this cache.
        guard !existed || replaced != nil else { throw NativeFontFailure.collision }
        var error: Unmanaged<CFError>?
        guard CTFontManagerRegisterFontsForURL(url as CFURL, .process, &error) else {
            if let replaced { _ = CTFontManagerRegisterFontsForURL(replaced as CFURL, .process, nil) }
            _ = error?.takeRetainedValue()
            throw NativeFontFailure.collision
        }
        let actual = CTFontCreateWithName(psName as CFString, 16, nil)
        guard CTFontCopyPostScriptName(actual) as String == psName,
              let actualURL = CTFontCopyAttribute(actual, kCTFontURLAttribute) as? URL,
              actualURL.standardizedFileURL == url.standardizedFileURL else {
            _ = CTFontManagerUnregisterFontsForURL(url as CFURL, .process, nil)
            if let replaced { _ = CTFontManagerRegisterFontsForURL(replaced as CFURL, .process, nil) }
            throw NativeFontFailure.collision
        }
        return (NativeRegisteredFont(family: family, postScriptNames: [psName], identity: face.key), url, replaced)
    }
    // The app's bundled 2.304 and Web's pinned 2.211 have identical PS names.
    // Only these SHA-verified app resources may be replaced; never system fonts
    // or another owner's identically named registration. Nothing is uninstalled.
    private func retireBundledOverlap(face: NativeFontFace, psName: String) throws -> URL? {
        guard face.id == "jetbrains-mono", let item = Self.bundledFaces[face.weight], psName == item.name,
              let url = bundle.url(forResource: item.name, withExtension: "ttf", subdirectory: "fonts/jetbrains-mono"),
              let bytes = try? Data(contentsOf: url), Self.digest(bytes) == item.hash else { return nil }
        let actual = CTFontCreateWithName(psName as CFString, 16, nil)
        guard let actualURL = CTFontCopyAttribute(actual, kCTFontURLAttribute) as? URL,
              actualURL.standardizedFileURL == url.standardizedFileURL else { return nil }
        guard CTFontManagerUnregisterFontsForURL(url as CFURL, .process, nil) else { throw NativeFontFailure.collision }
        return url
    }
    func bundledMono() -> String? {
        guard let item = Self.bundledFaces[400], let url = bundle.url(forResource: item.name, withExtension: "ttf", subdirectory: "fonts/jetbrains-mono"),
              let bytes = try? Data(contentsOf: url), Self.digest(bytes) == item.hash else { return nil }
        let actual = CTFontCreateWithName(item.name as CFString, 16, nil)
        guard let actualURL = CTFontCopyAttribute(actual, kCTFontURLAttribute) as? URL,
              actualURL.standardizedFileURL == url.standardizedFileURL else { return nil }
        return CTFontCopyFamilyName(actual) as String
    }
    private static let bundledFaces: [Int: (name: String, hash: String)] = [
        400: ("JetBrainsMono-Regular", "a0bf60ef0f83c5ed4d7a75d45838548b1f6873372dfac88f71804491898d138f"),
        500: ("JetBrainsMono-Medium", "31c92d01a8a08528b718a43addf0ad3df0af2ca4b7b3290a452f70f358e14d3d"),
        600: ("JetBrainsMono-SemiBold", "1b3bfa1ed5665a4ce3f9feb68d2d4e40e70bf8b4b7d9a3edd418f321b4e166a0")
    ]
}
