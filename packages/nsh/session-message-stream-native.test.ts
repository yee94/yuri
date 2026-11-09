import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

test.skipIf(process.platform !== 'darwin')('session stream production controller: deferred cancellation, wire and recovery', () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const temp = mkdtempSync(path.join(process.env.OPENCODE_TMP_DIR || tmpdir(), 'nsh-session-stream-'));
  try {
    const runner = path.join(temp, 'runner');
    const compile = spawnSync('xcrun', ['swiftc', '-parse-as-library', '-swift-version', '5', '-warnings-as-errors', path.join(root, 'ios/SessionMessageStream.swift'), path.join(root, 'tests/session-message-stream.swift'), '-o', runner], { encoding: 'utf8', timeout: 60000 });
    expect(compile.status, compile.stdout + compile.stderr).toBe(0);
    const result = spawnSync(runner, [], { encoding: 'utf8', timeout: 15000 });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('PASS session stream');
  } finally { rmSync(temp, { recursive: true, force: true }); }
}, 80000);
