import Foundation
import CoreText

@main struct NativeFontChecks {
    @MainActor static func main() async throws {
        let mode = CommandLine.arguments.dropFirst().first ?? "owner"
        if mode == "catalog" {
            let rows: [[String: Any]] = NativeFontCatalog.fonts.map { font in
                ["id": font.id, "family": font.family, "kind": font.kind, "version": font.version,
                 "faces": font.faces.map { ["weight": $0.weight, "sha256": $0.sha256, "bytes": $0.byteCount, "url": $0.url.absoluteString] as [String: Any] }]
            }
            print(String(data: try JSONSerialization.data(withJSONObject: rows, options: .sortedKeys), encoding: .utf8)!); return
        }
        if ["register", "collision", "collision-late", "cache-replaced", "partial-recovery", "retired-bundled", "shared-authority", "bundled-overlap", "bundled-malformed"].contains(mode) {
            let directory = URL(fileURLWithPath: CommandLine.arguments[2])
            let selected = NativeFontCatalog.fonts.first { $0.id == "inter" }!
            var reads = 0
            var bundle = Bundle.main
            if ["bundled-overlap", "bundled-malformed", "retired-bundled", "shared-authority"].contains(mode) {
                bundle = Bundle(url: URL(fileURLWithPath: CommandLine.arguments[3]))!
                for file in ["JetBrainsMono-Regular", "JetBrainsMono-Medium", "JetBrainsMono-SemiBold"] {
                    let url = bundle.url(forResource: file, withExtension: "ttf", subdirectory: "fonts/jetbrains-mono")!
                    precondition(CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil))
                }
            }
            if mode == "shared-authority" {
                var waiting: CheckedContinuation<Void, Never>?, reads = 0, firstActive = true, secondStarted = false
                let registry = NativeFontRegistry(bundle: bundle, read: { face in
                    reads += 1
                    if reads == 1 { await withCheckedContinuation { waiting = $0 } }
                    return try Data(contentsOf: directory.appendingPathComponent(face.filename))
                })
                let definition = NativeFontCatalog.family("JetBrains Mono")!
                let first = Task { try await registry.load(definition, authorized: { firstActive }) }
                while waiting == nil { await Task.yield() }
                let second = Task { secondStarted = true; return try await registry.load(definition, authorized: { true }) }
                while !secondStarted { await Task.yield() }
                firstActive = false; waiting!.resume()
                do { _ = try await first.value; fatalError("Retired subscriber gained registration authority") } catch is CancellationError { }
                _ = try await second.value
                let actual = CTFontCreateWithName("JetBrainsMono-Regular" as CFString, 16, nil)
                precondition((CTFontCopyName(actual, kCTFontVersionNameKey) as String?)?.contains("2.211") == true)
                precondition(reads == 3 && registry.cached(definition) != nil)
                print("shared-byte-flight-distinct-consumer-registration-authority"); return
            }
            if mode == "retired-bundled" {
                var waiting: CheckedContinuation<Void, Never>?, reads = 0, published = 0, completed = false
                let registry = NativeFontRegistry(bundle: bundle, read: { face in
                    reads += 1
                    if reads == 1 { await withCheckedContinuation { waiting = $0 } }
                    return try Data(contentsOf: directory.appendingPathComponent(face.filename))
                })
                let dependencies = NativeFontOwner.Dependencies(cached: registry.cached, load: { font, authorized in
                    defer { completed = true }
                    return try await registry.load(font, authorized: authorized)
                }, bundledMono: registry.bundledMono)
                let owner = NativeFontOwner(dependencies: dependencies, changed: { _, _, _ in published += 1 })
                let fonts = ["ui": "system-ui", "mono": "JetBrains Mono", "assistantLight": "JetBrains Mono", "assistantDark": "JetBrains Mono"]
                _ = owner.select(hostID: "A", revision: 1, fonts: fonts)
                while waiting == nil { await Task.yield() }
                owner.invalidate()
                _ = owner.select(hostID: "B", revision: 2, fonts: ["ui": "system-ui", "mono": "monospace", "assistantLight": "JetBrains Mono", "assistantDark": "JetBrains Mono"])
                waiting!.resume()
                while !completed { await Task.yield() }
                let freshB = CTFontCreateWithName("JetBrainsMono-Regular" as CFString, 16, nil)
                precondition((CTFontCopyName(freshB, kCTFontVersionNameKey) as String?)?.contains("2.304") == true, "Retired A changed B's new CoreText font")
                precondition(published == 0)
                completed = false
                _ = owner.select(hostID: "B", revision: 2, fonts: fonts)
                while !completed || published == 0 { await Task.yield() }
                let freshExplicit = CTFontCreateWithName("JetBrainsMono-Regular" as CFString, 16, nil)
                precondition((CTFontCopyName(freshExplicit, kCTFontVersionNameKey) as String?)?.contains("2.211") == true)
                precondition(reads == 3 && published == 1)
                print("retired-byte-completion-keeps-new-B-bundled-font-explicit-selection-reuses-bytes"); return
            }
            let heldPrior = mode == "bundled-overlap" ? CTFontCreateWithName("JetBrainsMono-Regular" as CFString, 16, nil) : nil
            let registry = NativeFontRegistry(bundle: bundle, read: { face in
                reads += 1
                precondition(NativeFontCatalog.allows(face))
                if mode == "bundled-malformed", face.weight == 500 { return Data(repeating: 0, count: face.byteCount) }
                return try Data(contentsOf: directory.appendingPathComponent(face.filename))
            })
            if mode == "partial-recovery" {
                let prior = try await registry.load(selected)
                let sharedURLs = [0, 2].map { index -> URL in
                    let actual = CTFontCreateWithName(prior.postScriptNames[index] as CFString, 16, nil)
                    return CTFontCopyAttribute(actual, kCTFontURLAttribute) as! URL
                }
                let medium = CTFontCreateWithName(prior.postScriptNames[1] as CFString, 16, nil)
                let oldURL = CTFontCopyAttribute(medium, kCTFontURLAttribute) as! URL
                precondition(CTFontManagerUnregisterFontsForURL(oldURL as CFURL, .process, nil))
                let foreign = directory.appendingPathComponent(selected.faces[1].filename)
                precondition(CTFontManagerRegisterFontsForURL(foreign as CFURL, .process, nil))
                do { _ = try await registry.load(selected); fatalError("Foreign medium was accepted") } catch NativeFontFailure.collision { }
                for (index, url) in zip([0, 2], sharedURLs) {
                    let actual = CTFontCreateWithName(prior.postScriptNames[index] as CFString, 16, nil)
                    precondition(CTFontCopyAttribute(actual, kCTFontURLAttribute) as? URL == url)
                }
                precondition(CTFontManagerUnregisterFontsForURL(foreign as CFURL, .process, nil))
                let restored = try await registry.load(selected)
                precondition(restored.identity == prior.identity)
                precondition(reads == 3, "Recovery re-downloaded immutable verified bytes")
                for index in [0, 2] {
                    let actual = CTFontCreateWithName(prior.postScriptNames[index] as CFString, 16, nil)
                    precondition(CTFontCopyPostScriptName(actual) as String == prior.postScriptNames[index])
                    precondition(CTFontCopyAttribute(actual, kCTFontURLAttribute) as? URL == sharedURLs[index == 0 ? 0 : 1])
                }
                print("one-face-conflict-removal-restores-all-without-disturbing-shared-own-faces"); return
            }
            if mode == "cache-replaced" {
                let prior = try await registry.load(selected)
                for (face, name) in zip(selected.faces, prior.postScriptNames) {
                    let actual = CTFontCreateWithName(name as CFString, 16, nil)
                    let url = CTFontCopyAttribute(actual, kCTFontURLAttribute) as! URL
                    precondition(CTFontManagerUnregisterFontsForURL(url as CFURL, .process, nil))
                    precondition(CTFontManagerRegisterFontsForURL(directory.appendingPathComponent(face.filename) as CFURL, .process, nil))
                }
                precondition(registry.cached(selected) == nil)
                do { _ = try await registry.load(selected); fatalError("Replaced same-name cache was trusted") }
                catch NativeFontFailure.collision { print("replaced-registration-invalidates-source-cache"); return }
            }
            if mode == "bundled-malformed" {
                let mono = NativeFontCatalog.family("JetBrains Mono")!
                do { _ = try await registry.load(mono); fatalError("Malformed second face accepted") } catch NativeFontFailure.invalidBytes { }
                precondition(registry.cached(mono) == nil)
                let prior = CTFontCreateWithName("JetBrainsMono-Regular" as CFString, 16, nil)
                precondition((CTFontCopyName(prior, kCTFontVersionNameKey) as String?)?.contains("2.304") == true)
                print("all-bytes-validated-before-registration-prior-retained"); return
            }
            if mode == "collision" || mode == "collision-late" {
                let collisionFace = selected.faces[mode == "collision" ? 0 : 1]
                precondition(CTFontManagerRegisterFontsForURL(directory.appendingPathComponent(collisionFace.filename) as CFURL, .process, nil))
                do { _ = try await registry.load(selected); fatalError("Same PSName registration was trusted") }
                catch NativeFontFailure.collision {
                    precondition(registry.cached(selected) == nil)
                    if mode == "collision-late" {
                        let first = CTFontCreateWithName("Inter-Regular" as CFString, 16, nil)
                        precondition(CTFontCopyPostScriptName(first) as String != "Inter-Regular")
                    }
                    print("collision-rejected"); return
                }
            }
            let fonts = mode == "bundled-overlap" ? NativeFontCatalog.fonts.filter { $0.id == "jetbrains-mono" } : NativeFontCatalog.fonts
            for font in fonts {
                async let first = registry.load(font)
                async let second = registry.load(font)
                let (one, two) = try await (first, second)
                precondition(one.identity == two.identity && one.postScriptNames.count == font.faces.count)
                for name in one.postScriptNames {
                    let actual = CTFontCreateWithName(name as CFString, 16, nil)
                    precondition(CTFontCopyFamilyName(actual) as String == one.family)
                    precondition(CTFontCopyPostScriptName(actual) as String == name)
                    if mode == "bundled-overlap" { precondition((CTFontCopyName(actual, kCTFontVersionNameKey) as String?)?.contains("2.211") == true) }
                }
            }
            let expected = fonts.reduce(0) { $0 + $1.faces.count }
            precondition(reads == expected)
            if let heldPrior { precondition((CTFontCopyName(heldPrior, kCTFontVersionNameKey) as String?)?.contains("2.304") == true) }
            print("registered-faces-\(expected)-exact-source-no-duplicate-reads"); return
        }
        if mode == "budget" {
            var active = 0, maximum = 0, reads = 0
            let registry = NativeFontRegistry(read: { face in
                active += 1; reads += 1; maximum = max(maximum, active)
                try await Task.sleep(nanoseconds: 40_000_000)
                active -= 1
                return Data(repeating: 0, count: face.byteCount)
            })
            async let first = try? registry.load(NativeFontCatalog.fonts[0])
            async let second = try? registry.load(NativeFontCatalog.fonts[1])
            async let third = try? registry.load(NativeFontCatalog.fonts[2])
            _ = await (first, second, third)
            precondition(maximum == 2 && active == 0 && reads == 3)
            print("two-readers-across-three-selected-sources"); return
        }
        if mode == "malformed" {
            var reads = 0
            let registry = NativeFontRegistry(read: { face in reads += 1; return Data(repeating: 0, count: face.byteCount) })
            for _ in 0..<3 {
                do { _ = try await registry.load(NativeFontCatalog.fonts[0]); fatalError("Malformed bytes accepted") }
                catch NativeFontFailure.invalidBytes { }
            }
            precondition(reads == 3); print("malformed-retry-budget-released"); return
        }
        let inter = NativeFontCatalog.fonts.first { $0.id == "inter" }!, mono = NativeFontCatalog.fonts.first { $0.id == "fira-code" }!
        var loads = 0, completions = 0, cached: [String: NativeRegisteredFont] = [:]
        var waiting: [String: CheckedContinuation<NativeRegisteredFont, Error>] = [:]
        let dependencies = NativeFontOwner.Dependencies(cached: { cached[$0.id] }, load: { font, _ in
            loads += 1
            return try await withCheckedThrowingContinuation { waiting[font.id] = $0 }
        }, bundledMono: { nil })
        let owner = NativeFontOwner(dependencies: dependencies, changed: { _, _, _ in completions += 1 })
        let system = ["ui": "system-ui", "mono": "monospace", "assistantLight": "system-ui", "assistantDark": "system-ui"]
        let chosen = ["ui": "Inter", "mono": "Fira Code", "assistantLight": "Inter", "assistantDark": "Inter"]
        func settle() async { for _ in 0..<30 { await Task.yield() } }
        func complete(_ definition: NativeFontDefinition, family: String) {
            let value = NativeRegisteredFont(family: family, postScriptNames: [definition.id], identity: definition.id + "@fixture")
            cached[definition.id] = value
            waiting.removeValue(forKey: definition.id)!.resume(returning: value)
        }
        _ = owner.select(hostID: "one", revision: 1, fonts: system)
        for _ in 0..<100 { _ = owner.select(hostID: "one", revision: 1, fonts: system) }
        await settle(); precondition(loads == 0 && completions == 0)
        _ = owner.select(hostID: "one", revision: 1, fonts: ["ui": "unknown-id", "mono": "monospace", "assistantLight": "Secret Raw Family", "assistantDark": "system-ui"])
        precondition(owner.projection.status == "unsupported"); await settle(); precondition(loads == 0)
        _ = owner.select(hostID: "one", revision: 1, fonts: chosen)
        await settle(); precondition(loads == 2 && owner.projection.status == "loading")
        complete(inter, family: "Verified Inter"); await settle()
        precondition(owner.projection.ui == "Verified Inter, system-ui" && owner.projection.mono == "monospace")
        waiting.removeValue(forKey: mono.id)!.resume(throwing: NativeFontFailure.unavailable); await settle()
        precondition(owner.projection.status == "failed" && owner.projection.ui == "Verified Inter, system-ui")
        let before = completions
        for _ in 0..<100 { _ = owner.select(hostID: "one", revision: 1, fonts: chosen) }
        await settle(); precondition(loads == 2 && completions == before)
        _ = owner.select(hostID: "one", revision: 1, fonts: chosen, retry: true); await settle()
        precondition(loads == 3)
        owner.invalidate()
        _ = owner.select(hostID: "two", revision: 2, fonts: system)
        complete(mono, family: "Verified Mono"); await settle()
        precondition(owner.projection.ui == "system-ui" && owner.projection.mono == "monospace" && completions == before)
        _ = owner.select(hostID: "two", revision: 2, fonts: chosen); await settle()
        precondition(loads == 3 && owner.projection.status == "ready" && owner.projection.mono == "Verified Mono, monospace")
        // A new same-Host revision must retire the old asynchronous selection.
        cached.removeValue(forKey: mono.id)
        _ = owner.select(hostID: "two", revision: 3, fonts: chosen); await settle()
        _ = owner.select(hostID: "two", revision: 4, fonts: system)
        complete(mono, family: "Late Same Host"); await settle()
        precondition(owner.projection.ui == "system-ui" && owner.projection.mono == "monospace" && completions == before)
        print("owner-system-noop-unknown-partial-failure-retry-host-revision-late-ok")
    }
}
