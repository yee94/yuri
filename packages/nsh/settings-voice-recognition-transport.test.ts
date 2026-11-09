import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, test } from 'vitest';

// Entirely in-memory native I/O. No ports, HTTP/WS requests, Host, Keychain,
// microphone, NSH engine or UIKit are started by this fixture.
const root = path.dirname(fileURLToPath(import.meta.url));
let temporary: string, runner: string, retirementRunner: string;
beforeAll(() => {
  temporary = mkdtempSync(path.join(process.env.OPENCODE_TMP_DIR || tmpdir(), 'recognition-runtime-check-'));
  const run = (args: string[]) => {
    const result = spawnSync('xcrun', args, { encoding: 'utf8', timeout: 60_000 });
    expect(result.status, result.stdout + result.stderr).toBe(0);
  };
  const stub = path.join(temporary, 'NativeShell.swift');
  writeFileSync(stub, `import Foundation
@MainActor public final class NshAppView {
 public init() {}
 public var handlers: [String: @MainActor (Any?) async throws -> Any?] = [:]
 public var events: [(String, Any?)] = []
 public func handle(_ name: String, _ handler: @escaping @MainActor (Any?) async throws -> Any?) { handlers[name] = handler }
 public func send(_ name: String, _ value: Any? = nil) { events.append((name, value)) }
}`);
  run(['swiftc', '-swift-version', '5', '-emit-library', '-emit-module', '-module-name', 'NativeShell', stub, '-o', path.join(temporary, 'libNativeShell.dylib')]);
  let store = readFileSync(path.join(root, 'ios/ConnectionStore.swift'), 'utf8').replace('import Security\n', '');
  function replace(from: string, to: string, replacement: string) {
    const start = store.indexOf(from), end = store.indexOf(to, start + from.length);
    if (start < 0 || end <= start) throw new Error('Production store fixture boundary changed');
    store = store.slice(0, start) + replacement + store.slice(end);
  }
  // Keep production connection/auth metadata behavior. Replace only Keychain I/O.
  replace('    init() throws {', '    var selected:', `    var failNextWrite = false
    private(set) var memoryPersisted = Data()
    private(set) var memoryWrites = 0
    init(memoryData: Data?) throws {
        state = try memoryData.map { try JSONDecoder().decode(State.self, from: $0) } ?? State()
        memoryPersisted = memoryData ?? Data()
    }
`);
  replace('    private func persist(_ data: Data) throws {', '    func save(', `    private func persist(_ data: Data) throws {
        if failNextWrite { failNextWrite = false; throw ConnectionEditorFailure.storage }
        memoryPersisted = data; memoryWrites += 1
    }
`);
  expect(store).not.toMatch(/\b(?:SecItem\w*|kSec\w*)\b|import Security/);
  const desktop = readFileSync(path.join(root, 'ios/RemoteDesktopBridge.swift'), 'utf8');
  const seam = desktop.slice(desktop.indexOf('enum RemoteDesktopWireMessage'), desktop.indexOf('/// A deadline'));
  const contracts = path.join(temporary, 'Contracts.swift'); writeFileSync(contracts, store + '\n' + seam);
  runner = path.join(temporary, 'runner');
  const inputs = ['swiftc', '-parse-as-library', '-swift-version', '5', '-warnings-as-errors', '-I', temporary, '-L', temporary, '-lNativeShell', '-Xlinker', '-rpath', '-Xlinker', temporary,
    contracts, ...['PasskeyPolicy.swift', 'connection-editor.swift', 'RuntimeHostScope.swift', 'AttachmentUploadPolicy.swift', 'ResourceBridge.swift', 'ResourceWebPreviewBridge.swift', 'GuiPluginPreviewBridge.swift', 'GuiPluginDeviceBridge.swift', 'GuiPluginResourceResolver.swift', 'GuiPluginRuntime.swift', 'VoiceRecognitionCore.swift', 'VoiceRecognitionRuntime.swift', 'RuntimeBridge.swift', 'SessionMessageStream.swift', 'SessionMessageStreamDirect.swift', 'RelayTunnel.swift', 'TerminalBridge.swift', 'TerminalTransport.swift'].map(file => path.join(root, 'ios', file))];
  run([...inputs, path.join(root, 'tests/settings-voice-recognition-transport.swift'), '-o', runner]);
  retirementRunner = path.join(temporary, 'retirement-runner');
  run([...inputs, path.join(root, 'tests/runtime-authorization-retirement.swift'), '-o', retirementRunner]);
}, 90_000);
afterAll(() => { if (temporary) rmSync(temporary, { recursive: true, force: true }); });

const scenarios = ['routes', 'file-limit', 'bad-credential', 'response-oversize', 'response-html', 'response-unauthorized', 'response-redirect', 'response-private-error',
  'cancel-http', 'generation-http', 'select-http', 'cancel-file', 'generation-file', 'cancel-open', 'generation-open', 'late-open', 'cancel-receive', 'generation-receive', 'close-receive', 'cancel-send', 'generation-send',
  'incoming-limit', 'outgoing-limit', 'closed', 'stale', 'rename', 'credential-change', 'isolation'];
for (const mode of ['direct', 'relay']) {
  for (const scenario of scenarios) {
    test(`${mode} synthetic native RuntimeBridge: ${scenario}`, () => {
      const result = spawnSync(runner, [scenario, mode], { encoding: 'utf8', timeout: 8_000 });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe(`PASS ${scenario} ${mode === 'relay'}`);
    });
  }
}
for (const scenario of ['unpaired', 'cancel-mint', 'generation-mint', ...['denied', 'redirect', 'html', 'oversize', 'bearer', 'empty', 'whitespace', 'newline', 'long', 'expired', 'bool'].map(value => `mint-${value}`)]) {
  test(`relay strict auth/no direct fallback: ${scenario}`, () => {
    const result = spawnSync(runner, [scenario, 'relay'], { encoding: 'utf8', timeout: 8_000 });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(`PASS ${scenario} true`);
  });
}
for (const scenario of ['host-snapshot', 'host-startup-deny', 'host-required', 'host-legacy-get', 'host-a-b-a', 'host-select-failure', 'host-remove-failure',
  'resource-admission', 'resource-authorization-change', 'resource-queued-retire',
  'resource-start-current', 'resource-start-a-b-a', 'resource-start-background', 'resource-start-missing', 'resource-start-invalid', 'resource-start-extra-scope',
  'host-reauth-failure', 'host-reauth-storage-failure', 'host-reauth-success', 'host-reauth-noncurrent', 'host-reauth-background', 'host-background', 'host-queued-resume',
  'authorization-legacy', 'authorization-roundtrip', 'authorization-replacements', 'authorization-failed-write', 'authorization-remove-readd',
  'voice-admission-missing', 'voice-admission-invalid', 'voice-admission-forged', 'voice-admission-other-host', 'voice-admission-background', 'voice-admission-resume', 'voice-admission-order', 'voice-cleanup-retired', 'voice-queued-background']) {
  test(`native Host receipt/durable authorization (memory only): ${scenario}`, () => {
    const result = spawnSync(runner, [scenario, 'direct'], { encoding: 'utf8', timeout: 8_000 });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(`PASS ${scenario} false`);
  });
}
for (const scenario of ['retirement-cold-no-hook', 'retirement-cold-retry', 'retirement-cleanup-failure', 'retirement-ack-failure', 'retirement-partial',
  'retirement-dedup', 'retirement-late-old', 'retirement-metadata', 'retirement-remove', 'retirement-remove-failure',
  'retirement-connect', 'retirement-connect-failure', 'retirement-cancel']) {
  test(`native durable retirement (memory only): ${scenario}`, () => {
    const result = spawnSync(retirementRunner, [scenario], { encoding: 'utf8', timeout: 8_000 });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(`PASS ${scenario} false`);
  });
}
