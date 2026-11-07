import Foundation
import CoreFoundation

struct NativeAppearanceContract {
    let mode: String
    let cssVars: [String: [String: String]]
    let fonts: [String: String]
    private enum Failure: LocalizedError {
        case invalid
        var errorDescription: String? { "原生外观范围已失效或数据无效" }
    }
    private static let tokenNames: Set<String> = [
        "background", "foreground", "card", "card-foreground", "primary", "primary-foreground",
        "secondary", "secondary-foreground", "muted", "muted-foreground", "accent", "accent-foreground",
        "border", "input", "ring", "destructive", "success", "chat-user", "chat-user-foreground",
        "chat-assistant", "chat-assistant-foreground"
    ]
    private static func payload(_ value: Any?, keys: Set<String>) throws -> [String: Any] {
        guard let data = value as? [String: Any], Set(data.keys) == keys,
              JSONSerialization.isValidJSONObject(data),
              try JSONSerialization.data(withJSONObject: data).count <= 16_384 else {
            throw Failure.invalid
        }
        return data
    }
    private static func palette(_ value: Any?) throws -> [String: String] {
        guard let colors = value as? [String: String], Set(colors.keys) == Self.tokenNames,
              colors.values.allSatisfy({ color in
                  color.hasPrefix("#") && [4, 5, 7, 9].contains(color.utf8.count) && color.dropFirst().utf8.allSatisfy({
                      (48...57).contains($0) || (65...70).contains($0) || (97...102).contains($0)
                  })
              }) else {
            throw Failure.invalid
        }
        return colors
    }
    static func validateReset(_ input: Any?, selectedHost: String?) throws {
        let data = try payload(input, keys: ["hostID"])
        guard data["hostID"] is NSNull || (data["hostID"] as? String).map({ !$0.isEmpty && $0.utf8.count <= 512 && $0 == selectedHost }) == true else { throw Failure.invalid }
    }
    static func decode(_ input: Any?, selectedHost: String?, revision: Int) throws -> NativeAppearanceContract {
        let data = try payload(input, keys: ["hostID", "revision", "mode", "cssVars", "fonts"])
        guard let host = data["hostID"] as? String, !host.isEmpty, host.utf8.count <= 512, host == selectedHost,
              let captured = data["revision"] as? NSNumber, CFGetTypeID(captured) != CFBooleanGetTypeID(),
              captured.doubleValue == Double(revision),
              let mode = data["mode"] as? String, ["light", "dark", "system"].contains(mode),
              let vars = data["cssVars"] as? [String: Any], Set(vars.keys) == ["light", "dark"],
              let fonts = data["fonts"] as? [String: String], Set(fonts.keys) == ["ui", "mono", "assistantLight", "assistantDark"],
              fonts.values.allSatisfy({ !$0.isEmpty && $0.utf8.count <= 64 && $0.utf8.allSatisfy({
                  (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || $0 == 32 || $0 == 45
              }) }) else {
            throw Failure.invalid
        }
        let colors = ["light": try palette(vars["light"]), "dark": try palette(vars["dark"])]
        return NativeAppearanceContract(mode: mode, cssVars: colors, fonts: fonts)
    }
}

#if canImport(UIKit) && canImport(NativeShell)
import UIKit
import NativeShell

/// Accepts data-only semantic colors and font family names, never CSS or executable code.
@MainActor final class AppearanceBridge {
    private weak var app: NshAppView?
    private let selectedHost: () -> String?
    private var revision = 0
    init(app: NshAppView, selectedHost: @escaping () -> String?) {
        self.app = app; self.selectedHost = selectedHost
        app.handle("appearance.reset") { [weak self] input async throws -> Any? in
            guard let self else { throw CancellationError() }
            try NativeAppearanceContract.validateReset(input, selectedHost: self.selectedHost())
            try self.invalidate()
            return ["revision": self.revision]
        }
        app.handle("appearance.apply") { [weak self] input async throws -> Any? in
            guard let self else { throw CancellationError() }
            return try self.apply(input)
        }
    }
    func invalidate() throws {
        revision += 1
        try app?.setThemeOverrides(nil)
        app?.fontScale = nil
        app?.overrideUserInterfaceStyle = .unspecified
    }
    private func apply(_ input: Any?) throws -> [String: Any] {
        let contract = try NativeAppearanceContract.decode(input, selectedHost: selectedHost(), revision: revision)
        let encoded = try JSONSerialization.data(withJSONObject: ["cssVars": contract.cssVars])
        guard let json = String(data: encoded, encoding: .utf8), let app else { throw CancellationError() }
        // Validate the entire contract before changing any previously valid native appearance.
        try app.setThemeOverrides(json)
        app.fontScale = 1 // Host percentages are applied to semantic TextStyle sizes, not twice via Dynamic Type.
        app.overrideUserInterfaceStyle = contract.mode == "system" ? .unspecified : contract.mode == "dark" ? .dark : .light
        var unsupported: [String] = []
        func family(_ name: String, fallback: String) -> String {
            if name == "system-ui" || name == "monospace" { return name }
            if UIFont.familyNames.contains(name) { return name }
            unsupported.append(name)
            return fallback
        }
        let ui = family(contract.fonts["ui"]!, fallback: "system-ui")
        let mono = family(contract.fonts["mono"]!, fallback: "monospace")
        let assistantLight = family(contract.fonts["assistantLight"]!, fallback: ui)
        let assistantDark = family(contract.fonts["assistantDark"]!, fallback: ui)
        return ["uiFontFamily": ui, "monoFontFamily": mono,
                "assistantFontFamilies": ["light": assistantLight, "dark": assistantDark], "unsupportedFonts": Array(Set(unsupported)).sorted(),
                "systemColorScheme": UIScreen.main.traitCollection.userInterfaceStyle == .dark ? "dark" : "light"]
    }
}
#endif
