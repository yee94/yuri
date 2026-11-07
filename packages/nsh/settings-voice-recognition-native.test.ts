import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expect, test } from 'vitest';

/** Foundation only: no real microphone, OS prompt, network, Host or NSH engine. */
test.skipIf(process.platform !== 'darwin')('production ASR owner handles WAV, configured routes, cancellation, replay and stale generations', () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const temporary = mkdtempSync(path.join(process.env.OPENCODE_TMP_DIR || tmpdir(), 'recognition-native-check-'));
  try {
    const executable = path.join(temporary, 'recognition-check');
    const compiled = spawnSync('xcrun', ['swiftc', '-parse-as-library', path.join(root, 'ios/RuntimeHostScope.swift'), path.join(root, 'ios/VoiceRecognitionCore.swift'), path.join(root, 'tests/settings-voice-recognition-native.swift'), '-o', executable], { encoding: 'utf8', timeout: 60_000 });
    expect(compiled.status, compiled.stdout + compiled.stderr).toBe(0);
    const result = spawnSync(executable, [], { encoding: 'utf8', timeout: 15_000 });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('Native configured ASR fake-audio / synthetic-transport checks passed');
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}, 80_000);
