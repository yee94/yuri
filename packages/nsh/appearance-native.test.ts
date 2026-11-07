import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { nativeThemeTokens } from './appearance-core';
import { getThemeById } from '../ui/src/lib/theme/themes';

test('production Swift appearance contract rejects stale scopes, executable values, unknown keys and oversized payloads (no simulator)', () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const directory = mkdtempSync(path.join(tmpdir(), 'nsh-appearance-contract-'));
  try {
    const tokens = nativeThemeTokens(getThemeById('jetbrains-dark')!);
    const fixture = { hostID: 'fixture', revision: 7, mode: 'dark', cssVars: { light: tokens, dark: tokens }, fonts: { ui: 'system-ui', mono: 'monospace', assistantLight: 'JetBrains Mono', assistantDark: 'JetBrains Mono' } };
    const source = `import Foundation
let bytes = Data(${JSON.stringify(JSON.stringify(fixture))}.utf8)
let valid = try JSONSerialization.jsonObject(with: bytes) as! [String: Any]
let decoded = try NativeAppearanceContract.decode(valid, selectedHost: "fixture", revision: 7)
precondition(decoded.mode == "dark" && decoded.fonts["ui"] == "system-ui")
func rejects(_ payload: [String: Any], host: String? = "fixture", revision: Int = 7) {
    do { _ = try NativeAppearanceContract.decode(payload, selectedHost: host, revision: revision); fatalError("Invalid contract was accepted") }
    catch { }
}
rejects(valid, host: "other"); rejects(valid, revision: 8); rejects(valid, host: nil)
for value: Any in [true, "7", 7.5, NSNull()] { var data = valid; data["revision"] = value; rejects(data) }
for value in ["invalid", "DARK", "dark\\n"] { var data = valid; data["mode"] = value; rejects(data) }
var extra = valid; extra["script"] = "arbitrary code"; rejects(extra)
var missing = valid; missing.removeValue(forKey: "fonts"); rejects(missing)
for font in ["url(https://invalid.example)", "system-ui\\n", String(repeating: "a", count: 17000)] {
    var data = valid; var fonts = valid["fonts"] as! [String: String]; fonts["ui"] = font; data["fonts"] = fonts; rejects(data)
}
for color in ["red", "#123456\\n", "#xyz", "var(--surface)", "url(https://invalid.example)"] {
    var data = valid; var css = valid["cssVars"] as! [String: [String: String]]
    css["light"]!["background"] = color; data["cssVars"] = css; rejects(data)
}
var unknownToken = valid; var css = valid["cssVars"] as! [String: [String: String]]
css["light"]!["script"] = "#ffffff"; unknownToken["cssVars"] = css; rejects(unknownToken)
try NativeAppearanceContract.validateReset(["hostID": NSNull()], selectedHost: "fixture")
try NativeAppearanceContract.validateReset(["hostID": "fixture"], selectedHost: "fixture")
for value: Any in ["other", "", 4, true] {
    do { try NativeAppearanceContract.validateReset(["hostID": value], selectedHost: "fixture"); fatalError("Invalid reset accepted") }
    catch { }
}
print("appearance-contract-ok")
`;
    writeFileSync(path.join(directory, 'main.swift'), source);
    const binary = path.join(directory, 'contract');
    const compiled = spawnSync('xcrun', ['swiftc', path.join(root, 'ios/AppearanceBridge.swift'), path.join(directory, 'main.swift'), '-o', binary], { encoding: 'utf8', timeout: 60_000 });
    expect(compiled.status, compiled.stderr).toBe(0);
    const result = spawnSync(binary, [], { encoding: 'utf8', timeout: 15_000 });
    expect(result.status, result.stderr).toBe(0); expect(result.stdout.trim()).toBe('appearance-contract-ok');
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 90_000);
