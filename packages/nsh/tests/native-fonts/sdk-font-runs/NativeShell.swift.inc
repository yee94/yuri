
    #if NSH_TEXT_FONT_DIAGNOSTICS
    /// Test SDK only. Captures actual CTFont attributes from CTLines AFTER draw.
    /// Explicit neutral test IDs only, no text content or private class access.
    public func beginTextFontDiagnostics(testIDs: [String], generation: UInt64) throws {
        let data = try JSONSerialization.data(withJSONObject: testIDs)
        guard let json = String(data: data, encoding: .utf8) else { throw NshError(message: "invalid diagnostic IDs") }
        try check(nsh_app_text_font_diagnostics_begin(app, json, generation))
    }
    public func textFontDiagnostics(generation: UInt64) throws -> Data {
        guard let json = nsh_app_text_font_diagnostics_read(app, generation) else { throw NshError(message: "diagnostic result missing") }
        defer { nsh_string_free(json) }
        return Data(String(cString: json).utf8)
    }
    public func stopTextFontDiagnostics() { nsh_app_text_font_diagnostics_stop(app) }
    #endif
