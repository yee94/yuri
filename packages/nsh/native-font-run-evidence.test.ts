import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

test('carrier evidence validator rejects stale/missing/empty runs, wrong face/size, boolean generations and copied display generations', () => {
  const root = path.dirname(fileURLToPath(import.meta.url)), temporary = mkdtempSync(path.join(tmpdir(), 'nsh-font-run-evidence-'));
  try {
    const file = path.join(temporary, 'main.swift'), binary = path.join(temporary, 'check');
    writeFileSync(file, `import Foundation
let expected: [String: [String: Any]] = ["font-run-ui-medium": ["postScriptName": "Inter-Medium", "pointSize": 16.0, "fontVersion": "Version 1.0"], "font-run-mono-semibold": ["postScriptName": "FiraCodeLight-SemiBold", "pointSize": 13.0, "fontVersion": "Version 1.0"]]
var records: [String: [String: Any]] = [:]
for (index, id) in expected.keys.sorted().enumerated() {
 records[id] = ["captureGeneration": 7, "displayGeneration": index + 1, "layoutGeneration": 3, "runs": [["postScriptName": expected[id]!["postScriptName"]!, "pointSize": expected[id]!["pointSize"]!, "fontVersion": "Version 1.0", "glyphCount": 24]]]
}
let valid: [String: Any] = ["contract": "nsh-ctrun-after-draw-v1", "source": "TextView.drawRect/CTLine.draw", "captureGeneration": 7, "missing": [String](), "records": records]
precondition(FontRunEvidence.validates(valid, generation: 7, expected: expected))
precondition(!FontRunEvidence.validates(valid, generation: 8, expected: expected))
for (key, value): (String, Any) in [("source", "UILabel"), ("missing", ["font-run-ui-medium"]), ("captureGeneration", true), ("records", [String: Any]())] {
 var bad = valid; bad[key] = value
 precondition(!FontRunEvidence.validates(bad, generation: 7, expected: expected))
}
for (key, value): (String, Any) in [("displayGeneration", true), ("layoutGeneration", true), ("layoutGeneration", 0), ("captureGeneration", 6), ("runs", [["postScriptName": "Inter-Regular", "pointSize": 16.0, "fontVersion": "Version 1.0", "glyphCount": 24]]), ("runs", [["postScriptName": "Inter-Medium", "pointSize": 15.0, "fontVersion": "Version 1.0", "glyphCount": 24]]), ("runs", [["postScriptName": "Inter-Medium", "pointSize": 16.0, "fontVersion": "wrong-version", "glyphCount": 24]]), ("runs", [["postScriptName": "Inter-Medium", "pointSize": 16.0, "fontVersion": "Version 1.0", "glyphCount": 0]]), ("runs", [[String: Any]]())] {
 var bad = valid, changed = records; changed["font-run-ui-medium"]![key] = value; bad["records"] = changed
 precondition(!FontRunEvidence.validates(bad, generation: 7, expected: expected))
}
var duplicate = valid, copied = records
copied["font-run-ui-medium"]!["displayGeneration"] = copied["font-run-mono-semibold"]!["displayGeneration"]!
duplicate["records"] = copied
precondition(!FontRunEvidence.validates(duplicate, generation: 7, expected: expected))
print("font-run-evidence-rejects-false-proof")
`);
    const compile = spawnSync('xcrun', ['swiftc', path.join(root, 'tests/native-fonts/FontRunEvidence.swift'), file, '-o', binary], { encoding: 'utf8', timeout: 60_000 });
    expect(compile.status, compile.stderr).toBe(0);
    const result = spawnSync(binary, [], { encoding: 'utf8', timeout: 15_000 });
    expect(result.status, result.stderr).toBe(0); expect(result.stdout.trim()).toBe('font-run-evidence-rejects-false-proof');
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}, 90_000);

test('CSS weight matching keeps Atkinson at two faces: 500 selects 400 and 600 selects 700', () => {
  const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'tests/native-fonts/sdk-font-runs/text.rs.inc'), 'utf8');
  const algorithm = source.slice(source.indexOf('fn css_weight_match'), source.indexOf('chosen.map'));
  expect(algorithm).toContain('requested < 400');
  expect(algorithm).toContain('requested > 500');
  expect(algorithm).toContain('*weight >= 400');
  const temporary = mkdtempSync(path.join(tmpdir(), 'nsh-css-weight-'));
  try {
    const binary = path.join(temporary, 'check');
    const compile = spawnSync('xcrun', ['swiftc', path.join(path.dirname(fileURLToPath(import.meta.url)), 'tests/native-fonts/css-weight.swift'), '-o', binary], { encoding: 'utf8', timeout: 60_000 });
    expect(compile.status, compile.stderr).toBe(0);
    const result = spawnSync(binary, [], { encoding: 'utf8', timeout: 15_000 });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('css-font-weight-matching-keeps-atkinson-two-faces');
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}, 90_000);
