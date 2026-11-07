import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expect, test } from 'vitest';

/** Apple SDK typecheck only. The NSH registration boundary is a declaration-only
 * stub, never the engine; no executable, UIKit app, recorder or permission runs. */
test.skipIf(process.platform !== 'darwin')('production ASR runtime, Relay and AVAudioRecorder compile against the real iOS SDK', () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const temporary = mkdtempSync(path.join(process.env.OPENCODE_TMP_DIR || tmpdir(), 'recognition-sdk-check-'));
  const run = (args: string[]) => {
    const result = spawnSync('xcrun', args, { encoding: 'utf8', timeout: 60_000 });
    expect(result.status, result.stdout + result.stderr).toBe(0); return result.stdout.trim();
  };
  try {
    const sdk = run(['--sdk', 'iphonesimulator', '--show-sdk-path']);
    const stub = path.join(temporary, 'NativeShell.swift');
    writeFileSync(stub, `import Foundation
@MainActor public final class NshAppView {
 public func handle(_ name: String, _ handler: @escaping @MainActor (Any?) async throws -> Any?) {}
 public func send(_ name: String, _ value: Any? = nil) {}
}`);
    const flags = ['-swift-version', '5', '-sdk', sdk, '-target', 'arm64-apple-ios15.0-simulator'];
    run(['swiftc', ...flags, '-emit-module', '-module-name', 'NativeShell', stub, '-emit-module-path', path.join(temporary, 'NativeShell.swiftmodule')]);
    run(['swiftc', ...flags, '-I', temporary, '-parse-as-library', '-typecheck',
      ...['ConnectionStore.swift', 'connection-editor.swift', 'RuntimeHostScope.swift', 'ResourceWebPreviewBridge.swift', 'RemoteDesktopBridge.swift', 'VoiceRecognitionCore.swift', 'VoiceRecognitionBridge.swift',
        'VoiceRecognitionRuntime.swift', 'GuiPluginPreviewBridge.swift', 'GuiPluginRuntime.swift', 'RuntimeBridge.swift', 'RelayTunnel.swift', 'TerminalBridge.swift', 'TerminalTransport.swift'].map(file => path.join(root, 'ios', file))]);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}, 130_000);
