import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

/** Production capture/registry, synthetic I/O only: no socket, Keychain or engine. */
test.skipIf(process.platform !== 'darwin')('native stream capture: owner CAS, scopes, authentication and all direct/relay modes', () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const temp = mkdtempSync(path.join(process.env.OPENCODE_TMP_DIR || tmpdir(), 'nsh-session-runtime-'));
  const run = (args: string[], timeout = 60000) => {
    const result = spawnSync('xcrun', ['swiftc', ...args], { encoding: 'utf8', timeout });
    expect(result.status, result.stdout + result.stderr).toBe(0);
  };
  try {
    writeFileSync(path.join(temp, 'NativeShell.swift'), `import Foundation
@MainActor public final class NshAppView {
 public var handlers: [String: @MainActor (Any?) async throws -> Any?] = [:]
 public var events: [(String, [String: Any])] = []
 public init() {}
 public func handle(_ name: String, _ handler: @escaping @MainActor (Any?) async throws -> Any?) { handlers[name] = handler }
 public func send(_ name: String, _ value: Any? = nil) { events.append((name, value as? [String: Any] ?? [:])) }
}`);
    run(['-swift-version', '5', '-emit-library', '-emit-module', '-module-name', 'NativeShell', path.join(temp, 'NativeShell.swift'), '-o', path.join(temp, 'libNativeShell.dylib')]);
    const replace = (source: string, start: string, end: string, replacement: string) => {
      const from = source.indexOf(start), to = source.indexOf(end, from + start.length);
      if (from < 0 || to < from) throw new Error('ConnectionStore fixture boundary changed');
      return source.slice(0, from) + replacement + source.slice(to);
    };
    let store = readFileSync(path.join(root, 'ios/ConnectionStore.swift'), 'utf8').replace('import Security\n', '');
    store = replace(store, '    init() throws {', '    var selected:', '    init() throws { state = State() }\n');
    store = replace(store, '    private func persist(_ data: Data) throws {', '    func save(', '    private func persist(_ data: Data) throws {}\n');
    expect(store).not.toMatch(/\b(?:SecItem\w*|kSec\w*)\b|import Security/);
    const desktop = readFileSync(path.join(root, 'ios/RemoteDesktopBridge.swift'), 'utf8');
    writeFileSync(path.join(temp, 'Contracts.swift'), store + '\n' + desktop.slice(desktop.indexOf('enum RemoteDesktopWireMessage'), desktop.indexOf('/// A deadline')));
    const sources = ['PasskeyPolicy', 'connection-editor', 'RuntimeHostScope', 'AttachmentUploadPolicy', 'VoiceRecognitionCore', 'VoiceRecognitionRuntime', 'ResourceWebPreviewBridge', 'GuiPluginPreviewBridge', 'GuiPluginDeviceBridge', 'GuiPluginResourceResolver', 'GuiPluginRuntime', 'RuntimeBridge', 'RelayTunnel', 'TerminalBridge', 'TerminalTransport', 'SessionMessageStream', 'SessionMessageStreamDirect'].map(name => path.join(root, 'ios', `${name}.swift`));
    const runner = path.join(temp, 'runner');
    run(['-parse-as-library', '-swift-version', '5', '-warnings-as-errors', '-I', temp, '-L', temp, '-lNativeShell', '-Xlinker', '-rpath', '-Xlinker', temp, path.join(temp, 'Contracts.swift'), ...sources, path.join(root, 'tests/session-stream-runtime.swift'), '-o', runner]);
    const result = spawnSync(runner, [], { encoding: 'utf8', timeout: 15000 });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('PASS native session runtime');
  } finally { rmSync(temp, { recursive: true, force: true }); }
}, 80000);
