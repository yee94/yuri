import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
export async function runTerminalFixture(command, args, timeout = 60000) {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] }); let output = '';
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
  try { await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error(output || `exit ${code}`))); }); return output.trim(); }
  finally { clearTimeout(timer); }
}
/** Production bridge/store code; substitute only Keychain persistence. Never access Security. */
export async function compileTerminalRuntime(root, temporary, harness, runnerName = 'runner') {
  const stub = path.join(temporary, 'NativeShell.swift');
  await writeFile(stub, `import Foundation
@MainActor public final class NshAppView {
 public init() {}
 public var handlers: [String: @MainActor (Any?) async throws -> Any?] = [:]
 public var events: [(String, [String: Any])] = []
 public func handle(_ name: String, _ handler: @escaping @MainActor (Any?) async throws -> Any?) { handlers[name] = handler }
 public func send(_ name: String, _ value: Any? = nil) { events.append((name, value as? [String: Any] ?? [:])) }
}`);
  await runTerminalFixture('xcrun', ['swiftc', '-swift-version', '5', '-emit-library', '-emit-module', '-module-name', 'NativeShell', stub, '-o', path.join(temporary, 'libNativeShell.dylib')]);
  let store = (await readFile(path.join(root, 'ios/ConnectionStore.swift'), 'utf8')).replace('import Security\n', '');
  function replace(from, to, value) { const start = store.indexOf(from), end = store.indexOf(to, start + from.length); if (start < 0 || end <= start) throw new Error('Store fixture boundary changed'); store = store.slice(0, start) + value + store.slice(end); }
  replace('    init() throws {', '    var selected:', '    var failNextWrite = false\n    private(set) var memoryPersisted = Data()\n    private(set) var memoryWrites = 0\n    init(memoryData: Data? = nil) throws { state = try memoryData.map { try JSONDecoder().decode(State.self, from: $0) } ?? State() }\n');
  replace('    private func persist(_ data: Data) throws {', '    func save(', '    private func persist(_ data: Data) throws { if failNextWrite { failNextWrite = false; throw ConnectionEditorFailure.storage }; memoryPersisted = data; memoryWrites += 1 }\n');
  if (/\b(?:SecItem\w*|kSec\w*)\b|import Security/.test(store)) throw new Error('Keychain must not enter fixture');
  const desktop = await readFile(path.join(root, 'ios/RemoteDesktopBridge.swift'), 'utf8');
  const contracts = path.join(temporary, 'Contracts.swift');
  await writeFile(contracts, store + '\n' + desktop.slice(desktop.indexOf('enum RemoteDesktopWireMessage'), desktop.indexOf('/// A deadline')));
  const sources = ['PasskeyPolicy.swift', 'connection-editor.swift', 'RuntimeHostScope.swift', 'AttachmentUploadPolicy.swift', 'VoiceRecognitionCore.swift', 'VoiceRecognitionRuntime.swift', 'ResourceBridge.swift', 'ResourceWebPreviewBridge.swift', 'ResourceWebPreviewView.swift', 'GuiPluginPreviewBridge.swift', 'GuiPluginDeviceBridge.swift', 'GuiPluginResourceResolver.swift', 'GuiPluginRuntime.swift', 'RuntimeBridge.swift', 'SessionMessageStream.swift', 'SessionMessageStreamDirect.swift', 'RelayTunnel.swift', 'TerminalBridge.swift', 'TerminalTransport.swift'];
  // Parse/typecheck the actual production RuntimeBridge against Apple's iOS SDK;
  // the host registration stub is declaration-only, not the NSH engine.
  const sdk = await runTerminalFixture('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path']);
  const iosFlags = ['-swift-version', '5', '-sdk', sdk, '-target', 'arm64-apple-ios15.0-simulator'];
  await runTerminalFixture('xcrun', ['swiftc', ...iosFlags, '-emit-module', '-module-name', 'NativeShell', stub, '-emit-module-path', path.join(temporary, 'NativeShell-ios.swiftmodule')]);
  // Separate the architecture's module from the macOS fixture module.
  const { mkdir, copyFile } = await import('node:fs/promises');
  const iosModules = path.join(temporary, 'ios-modules'); await mkdir(iosModules, { recursive: true });
  await copyFile(path.join(temporary, 'NativeShell-ios.swiftmodule'), path.join(iosModules, 'NativeShell.swiftmodule'));
  await runTerminalFixture('xcrun', ['swiftc', ...iosFlags, '-I', iosModules, '-parse-as-library', '-typecheck', contracts,
    ...sources.filter(file => file !== 'ResourceBridge.swift').map(file => path.join(root, 'ios', file)), path.join(root, '../mobile/ios/App/App/YuriViewExportRenderer.swift')]);
  const runner = path.join(temporary, runnerName);
  await runTerminalFixture('xcrun', ['swiftc', '-parse-as-library', '-swift-version', '5', '-warnings-as-errors', '-I', temporary, '-L', temporary, '-lNativeShell', '-Xlinker', '-rpath', '-Xlinker', temporary,
    contracts, ...sources.map(file => path.join(root, 'ios', file)), harness, '-o', runner]);
  return runner;
}
