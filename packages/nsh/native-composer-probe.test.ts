import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
// @ts-expect-error The isolated test build script is plain ESM, matching existing fixture scripts.
import { compiledProbeGrants, identity, options, swiftInputs, verifyCompiledProbe } from './tests/native-composer-spellcheck/build-probe.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const here = path.join(root, 'tests/native-composer-spellcheck');
const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

it('executes the metadata-only bounded weak ledger, without UIKit or a Host', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'opencode', 'composer-probe-'));
  try {
    const binary = path.join(directory, 'ledger-checks');
    execFileSync('xcrun', ['swiftc', '-swift-version', '5', '-parse-as-library', path.join(here, 'ProbeLedger.swift'), path.join(here, 'ProbeLedgerChecks.swift'), '-o', binary], { timeout: 110_000, encoding: 'utf8' });
    expect(execFileSync(binary, { timeout: 10_000, encoding: 'utf8' })).toContain('11 probe ledger checks passed');
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 120_000);

it('defaults diagnostics off and generates a new app and URL scheme without touching old fixture builds', () => {
  expect(options([])).toEqual({ sdkOnly: false, diagnostics: false, device: false });
  expect(options(['--sdk-only', '--diagnostics']).diagnostics).toBe(true);
  expect(() => options(['--launch'])).toThrow();
  expect(identity('run-a')).not.toEqual(identity('run-b'));
  expect(() => identity('run-a', 'com.yee94.yuri.nsh')).toThrow();
  expect(swiftInputs).toHaveLength(7);
  expect(swiftInputs.every((input: string) => !input.includes('Observer') && !input.includes('SyntheticHost') && input !== 'ios/main.swift')).toBe(true);
  expect(() => verifyCompiledProbe({ id: 'example.probe' }, compiledProbeGrants, 'example.probe')).not.toThrow();
  expect(() => verifyCompiledProbe({ id: 'example.probe' }, {}, 'example.probe')).toThrow();
  expect(() => verifyCompiledProbe({ id: 'example.probe' }, { ...compiledProbeGrants, host: [] }, 'example.probe')).toThrow();
  expect(() => verifyCompiledProbe({ id: 'wrong.probe' }, compiledProbeGrants, 'example.probe')).toThrow();
});

it('reads public traits through the frozen production resolver with no editor mutation or tree/window search', () => {
  const diagnostics = readFileSync(path.join(here, 'ProbeDiagnostics.swift'), 'utf8');
  expect(diagnostics).toContain('NativeComposerSpellcheckTree<UIView>');
  expect(diagnostics).toContain('editor.spellCheckingType.rawValue');
  expect(diagnostics).toContain('editor.markedTextRange != nil');
  expect(diagnostics).not.toMatch(/spellCheckingType\s*=(?!=)|setMarkedText|\.text\b|selectedRange|reloadInputViews|becomeFirstResponder|resignFirstResponder|\.delegate\s*=|connectedScenes|UIApplication\.shared\.windows/);
  const fixture = readFileSync(path.join(here, 'fixture.tsx'), 'utf8');
  expect(fixture).toContain("host.params.composerReadbackEnabled === true");
  expect(fixture).toContain('<Input testID="composer"');
});

it.skipIf(!process.env.NSH_DIST)('compiles the complete isolated UIKit probe against the real SDK without running an App or engine', () => {
  const frozen = (swiftInputs as string[]).map(input => [input, sha(path.join(root, input))]);
  const output = JSON.parse(execFileSync('node', [path.join(here, 'build-probe.mjs'), '--sdk-only'], { encoding: 'utf8', timeout: 110_000, env: process.env }));
  const manifest = JSON.parse(readFileSync(output.manifest, 'utf8'));
  expect(manifest.diagnosticsEnabled).toBe(false);
  expect(manifest.sdkOnly).toBe(true);
  expect(readFileSync(output.artifact).length).toBeGreaterThan(0);
  for (const [input, original] of frozen) expect(sha(path.join(root, input))).toBe(original);
}, 120_000);
