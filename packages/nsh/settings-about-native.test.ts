import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expect, test } from 'vitest';
import { aboutDiagnosticTypes } from './settings-about-diagnostics';

/** Foundation-only safety tests: no UIKit, Host, Keychain, device or NSH engine. */
test.skipIf(process.platform !== 'darwin')('native projection validates again and export leases clean all terminal outcomes', () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const temporary = mkdtempSync(path.join(process.env.OPENCODE_TMP_DIR || tmpdir(), 'about-native-check-'));
  try {
    const executable = path.join(temporary, 'about-native-check');
    const compiled = spawnSync('xcrun', ['swiftc', '-parse-as-library', path.join(root, 'ios/DiagnosticsBridge.swift'), path.join(root, 'tests/settings-about-native-fixture.swift'), '-o', executable], { encoding: 'utf8', timeout: 60_000 });
    expect(compiled.status, compiled.stdout + compiled.stderr).toBe(0);
    const result = spawnSync(executable, [JSON.stringify(aboutDiagnosticTypes)], { encoding: 'utf8', timeout: 10_000 });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('About native projection and file lease passed');
  } finally { rmSync(temporary, { force: true, recursive: true }); }
}, 75_000);
