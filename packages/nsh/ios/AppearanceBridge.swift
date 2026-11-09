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
    private var contract: NativeAppearanceContract?
    private let fontRegistry: NativeFontRegistry
    private lazy var fonts = NativeFontOwner(dependencies: .registry(fontRegistry)) { [weak self] hostID, revision, projection in
        guard let self, hostID == self.selectedHost(), revision == self.revision, self.contract != nil else { return }
        do {
            try self.renderFonts(projection)
            self.app?.send("appearance.fonts", projection.value.merging(["hostID": hostID, "fontRevision": revision]) { _, new in new })
        } catch { self.app?.send("appearance.error", ["message": "原生字体应用失败"]) }
    }
    init(app: NshAppView, selectedHost: @escaping () -> String?, fontRegistry: NativeFontRegistry? = nil) {
        self.app = app; self.selectedHost = selectedHost; self.fontRegistry = fontRegistry ?? .shared
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
        app.handle("appearance.fonts.retry") { [weak self] input async throws -> Any? in
            guard let self, let data = input as? [String: Any], Set(data.keys) == ["hostID", "fontRevision", "fontTicket"],
                  let hostID = data["hostID"] as? String, hostID == self.selectedHost(),
                  let revision = data["fontRevision"] as? NSNumber, CFGetTypeID(revision) != CFBooleanGetTypeID(), revision.doubleValue == Double(self.revision),
                  let ticket = data["fontTicket"] as? NSNumber, CFGetTypeID(ticket) != CFBooleanGetTypeID(), ticket.doubleValue == Double(self.fonts.projection.ticket),
                  let contract = self.contract else { throw CancellationError() }
            let projection = self.fonts.select(hostID: hostID, revision: self.revision, fonts: contract.fonts, retry: true)
            try self.renderFonts(projection)
            return projection.value.merging(["hostID": hostID, "fontRevision": self.revision]) { _, new in new }
        }
    }
    func invalidate() throws {
        revision += 1
        contract = nil
        fonts.invalidate()
        try app?.setThemeOverrides(nil)
        app?.fontScale = nil
        app?.overrideUserInterfaceStyle = .unspecified
    }
    private func apply(_ input: Any?) throws -> [String: Any] {
        let contract = try NativeAppearanceContract.decode(input, selectedHost: selectedHost(), revision: revision)
        guard let app, let hostID = selectedHost() else { throw CancellationError() }
        // Validate the entire contract before changing any previously valid native appearance.
        self.contract = contract
        let projection = fonts.select(hostID: hostID, revision: revision, fonts: contract.fonts)
        try renderFonts(projection)
        app.fontScale = 1 // Host percentages are applied to semantic TextStyle sizes, not twice via Dynamic Type.
        app.overrideUserInterfaceStyle = contract.mode == "system" ? .unspecified : contract.mode == "dark" ? .dark : .light
        return projection.value.merging(["fontRevision": revision,
            "systemColorScheme": UIScreen.main.traitCollection.userInterfaceStyle == .dark ? "dark" : "light"]) { _, new in new }
    }
    private func renderFonts(_ projection: NativeFontProjection) throws {
        guard let app, let contract else { throw CancellationError() }
        // setThemeOverrides replaces the override document. Merge font tokens into
        // the CURRENT contract; a font completion never captures/replays a palette.
        var cssVars = contract.cssVars
        for variant in ["light", "dark"] {
            cssVars[variant]?["font-sans"] = projection.ui
            cssVars[variant]?["font-mono"] = projection.mono
        }
        let encoded = try JSONSerialization.data(withJSONObject: ["cssVars": cssVars])
        guard let json = String(data: encoded, encoding: .utf8) else { throw CancellationError() }
        try app.setThemeOverrides(json)
    }
}
#endif
