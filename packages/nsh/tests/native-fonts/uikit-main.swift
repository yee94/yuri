import Foundation
import UIKit
import NativeShell
import CoreText

@MainActor private final class FontFixtureController: UIViewController {
    private let surface = NshAppView()
    private var appearance: AppearanceBridge?
    private var registry: NativeFontRegistry?
    private let uiLabel = UILabel(), monoLabel = UILabel()
    private var baseline: [String: Bool] = [:]
    private var readCount = 0
    private var expectedReadCount = 0
    private var pair = 0
    private var prepared: Set<String> = []
    private var fontVersions: [String: String] = [:]
    #if NSH_TEXT_FONT_DIAGNOSTICS
    private var captureGeneration: UInt64 = 0
    private let runIDs = ["font-run-ui-regular", "font-run-ui-medium", "font-run-ui-semibold", "font-run-mono-regular", "font-run-mono-medium", "font-run-mono-semibold"]
    #endif
    private var uiDefinition: NativeFontDefinition { NativeFontCatalog.fonts.filter { $0.kind == "ui" }[pair] }
    private var monoDefinition: NativeFontDefinition {
        let ids = ["fira-code", "jetbrains-mono", "geist-mono", "commit-mono", "source-code-pro", "cascadia-code", "roboto-mono", "iosevka"]
        return NativeFontCatalog.fonts.first { $0.id == ids[pair] }!
    }
    override func viewDidLoad() {
        super.viewDidLoad(); view.backgroundColor = .systemBackground
        surface.frame = view.bounds; surface.autoresizingMask = [.flexibleWidth, .flexibleHeight]; view.addSubview(surface)
        for (index, label) in [uiLabel, monoLabel].enumerated() {
            label.text = index == 0 ? "UIKit UI label ABC 012" : "UIKit mono label ABC 012"
            label.accessibilityIdentifier = index == 0 ? "font-fixture-native-ui-label" : "font-fixture-native-mono-label"
            label.frame = CGRect(x: 20, y: view.bounds.height - 150 + CGFloat(index * 36), width: view.bounds.width - 40, height: 32)
            label.autoresizingMask = [.flexibleTopMargin, .flexibleWidth]; view.addSubview(label)
        }
        surface.onError = { [weak self] _ in self?.uiLabel.text = "Fixture engine failed" }
        do {
            guard Bundle.main.object(forInfoDictionaryKey: "UIAppFonts") == nil else { throw NativeFontFailure.collision }
            try preparePair()
            let registry = NativeFontRegistry(read: { [weak self] face in
                guard NativeFontCatalog.allows(face),
                      let url = Bundle.main.url(forResource: face.filename, withExtension: nil, subdirectory: "fixture-fonts") else { throw NativeFontFailure.unavailable }
                self?.readCount += 1
                // Fixed-CDN response fixture, NOT a Host file or catalog API.
                return try Data(contentsOf: url)
            })
            self.registry = registry
            appearance = AppearanceBridge(app: surface, selectedHost: { "font-fixture" }, fontRegistry: registry)
            surface.handle("connection.list") { _ async throws -> Any? in
                ["selected": "font-fixture", "runtimeScope": ["hostID": "font-fixture", "lease": "00000000-0000-4000-8000-000000000001"],
                 "connections": [["id": "font-fixture", "url": "https://host.example", "label": "Font fixture", "authorizationID": "synthetic-font-authorization", "lastUsedAt": 0]]]
            }
            surface.handle("runtime.request") { [weak self] input async throws -> Any? in
                guard let self else { throw CancellationError() }
                guard let data = input as? [String: Any], data["path"] as? String == "/api/config/settings", data["method"] as? String == "GET",
                      let scope = data["expectedHost"] as? [String: String], scope["hostID"] == "font-fixture", scope["lease"] == "00000000-0000-4000-8000-000000000001" else { throw NativeFontFailure.unsupported }
                return ["status": 200, "body": ["themeId": "nord-light", "themeVariant": "light", "useSystemTheme": false, "uiFont": self.uiDefinition.id, "monoFont": self.monoDefinition.id]]
            }
            surface.handle("font.fixture.next") { [weak self] _ async throws -> Any? in
                guard let self else { throw CancellationError() }
                self.pair = (self.pair + 1) % 8
                try self.preparePair()
                return ["pair": self.pair]
            }
            surface.handle("font.fixture.audit") { [weak self] _ async throws -> Any? in
                guard let self else { throw CancellationError() }
                #if NSH_TEXT_FONT_DIAGNOSTICS
                self.captureGeneration += 1
                try self.surface.beginTextFontDiagnostics(testIDs: self.runIDs, generation: self.captureGeneration)
                #endif
                try await Task.sleep(nanoseconds: 300_000_000)
                return try self.audit()
            }
            try surface.grantCapabilities("{\"host\":[\"connection.list\",\"runtime.request\",\"appearance.reset\",\"appearance.apply\",\"appearance.fonts.retry\",\"font.fixture.audit\",\"font.fixture.next\"]}")
            guard let bundle = Bundle.main.url(forResource: "bundle", withExtension: "nshc", subdirectory: "nsh") else { throw NativeFontFailure.unavailable }
            surface.cacheOptions = NshCacheOptions(location: .off, images: .off)
            #if NSH_TEXT_FONT_DIAGNOSTICS
            surface.params = ["fontRunDiagnostics": true]
            #endif
            try surface.loadBundle(at: bundle)
        } catch { uiLabel.text = "Fixture baseline or resources failed" }
    }
    private func preparePair() throws {
        for definition in [uiDefinition, monoDefinition] where !prepared.contains(definition.id) {
            for face in definition.faces {
                guard let url = Bundle.main.url(forResource: face.filename, withExtension: nil, subdirectory: "fixture-fonts"),
                      let descriptors = CTFontManagerCreateFontDescriptorsFromURL(url as CFURL) as? [CTFontDescriptor], descriptors.count == 1 else { throw NativeFontFailure.invalidBytes }
                let font = CTFontCreateWithFontDescriptor(descriptors[0], 16, nil), name = CTFontCopyPostScriptName(font) as String
                baseline[name] = UIFont(name: name, size: 16) == nil
                fontVersions[name] = CTFontCopyName(font, kCTFontVersionNameKey) as String?
            }
            guard baseline.values.allSatisfy({ $0 }) else { throw NativeFontFailure.collision }
            prepared.insert(definition.id); expectedReadCount += definition.faces.count
        }
    }
    private func audit() throws -> [String: Any] {
        guard let registry, let ui = registry.cached(uiDefinition), let mono = registry.cached(monoDefinition),
              let uiFont = UIFont(name: ui.postScriptNames[0], size: 16), let monoFont = UIFont(name: mono.postScriptNames[0], size: 16) else { throw NativeFontFailure.unavailable }
        uiLabel.font = uiFont; monoLabel.font = monoFont
        func record(_ font: UIFont?) -> [String: Any] {
            guard let font else { return ["missing": true] }
            return ["familyName": font.familyName, "fontName": font.fontName, "pointSize": font.pointSize]
        }
        var editors: [String: [String: Any]] = [:]
        func scan(_ node: UIView) {
            if let field = node as? UITextField, field.text == "UI input ABC 012" { editors["inheritedUI"] = record(field.font) }
            if let field = node as? UITextView, field.text == "Mono input ABC 012" { editors["inheritedMono"] = record(field.font) }
            if let field = node as? UITextView, field.text == "Skills editor ABC 012" { editors["productionEditorStyle"] = record(field.font) }
            node.subviews.forEach(scan)
        }
        scan(surface)
        var valid = baseline.values.allSatisfy { $0 } && readCount == expectedReadCount
            && uiLabel.font.fontName == ui.postScriptNames[0] && monoLabel.font.fontName == mono.postScriptNames[0]
            && editors["inheritedUI"]?["fontName"] as? String == ui.postScriptNames[0]
            && editors["inheritedMono"]?["fontName"] as? String == mono.postScriptNames[0]
            && editors["productionEditorStyle"]?["fontName"] as? String == mono.postScriptNames[0]
        var runEvidence: [String: Any] = [:]
        var runReadback = false
        #if NSH_TEXT_FONT_DIAGNOSTICS
        let data = try surface.textFontDiagnostics(generation: captureGeneration)
        runEvidence = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
        var expectations: [String: [String: Any]] = [:]
        for (kind, definition, registered, size) in [("ui", uiDefinition, ui, 16.0), ("mono", monoDefinition, mono, 13.0)] {
            for (role, requested) in [("regular", 400), ("medium", 500), ("semibold", 600)] {
                // Web CSS matching: Atkinson has 400/700, so 500→400 and 600→700.
                let weight = definition.faces.contains(where: { $0.weight == requested }) ? requested : requested <= 500 ? 400 : 700
                let index = definition.faces.firstIndex(where: { $0.weight == weight })!
                expectations["font-run-\(kind)-\(role)"] = ["postScriptName": registered.postScriptNames[index], "pointSize": size,
                    "fontVersion": fontVersions[registered.postScriptNames[index]] ?? ""]
            }
        }
        runReadback = FontRunEvidence.validates(runEvidence, generation: captureGeneration, expected: expectations)
        runEvidence["expected"] = expectations
        valid = valid && runReadback
        #endif
        let result: [String: Any] = ["valid": valid, "pair": pair, "selectedIDs": [uiDefinition.id, monoDefinition.id], "buildID": Bundle.main.object(forInfoDictionaryKey: "FixtureBuildID") ?? "unknown",
            "baselineUnavailable": baseline, "uiAppFontsAbsent": true, "readCount": readCount,
            "registeredUI": ["familyName": ui.family, "postScriptNames": ui.postScriptNames, "identity": ui.identity],
            "registeredMono": ["familyName": mono.family, "postScriptNames": mono.postScriptNames, "identity": mono.identity],
            "actualUILabel": ["ui": record(uiLabel.font), "mono": record(monoLabel.font)], "actualNSHEditors": editors,
            "network": false, "hostFileAPI": false, "nshTextUsesCoreText": true,
            "textCTRunReadback": runReadback, "actualTextRuns": runEvidence]
        let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys]).write(to: directory.appendingPathComponent("font-audit.json"), options: .atomic)
        try JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys]).write(to: directory.appendingPathComponent("font-audit-\(pair).json"), options: .atomic)
        return result
    }
}
@MainActor private final class FontFixtureDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds); window.rootViewController = FontFixtureController(); window.makeKeyAndVisible(); self.window = window; return true
    }
}
@main private struct FontFixtureMain {
    static func main() { UIApplicationMain(CommandLine.argc, CommandLine.unsafeArgv, nil, NSStringFromClass(FontFixtureDelegate.self)) }
}
