import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

it.skipIf(process.platform !== 'darwin')('runs the actual fixture persistence actor and native post-window trigger offline, without UIKit or NSH engine', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const output = mkdtempSync(path.join(tmpdir(), 'opencode/nsh-terminal-storage-'));
  const binary = path.join(output, 'checks');
  const built = spawnSync('swiftc', ['-swift-version', '5', '-parse-as-library', path.join(here, 'TerminalCaptureStorage.swift'), path.join(here, 'native-tests/CaptureStorageChecks.swift'), '-o', binary], { encoding: 'utf8' });
  expect(built.status, built.stderr).toBe(0);
  const result = spawnSync(binary, [output], { encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('awaited disk ACK sees full prefix');
}, 30_000);
