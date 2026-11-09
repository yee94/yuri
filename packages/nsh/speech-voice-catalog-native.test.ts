import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const directory = path.dirname(fileURLToPath(import.meta.url));

function swift(program: string, sources: string[]) {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'nsh-speech-voice-catalog-'));
  try {
    const main = path.join(temporary, 'main.swift');
    const binary = path.join(temporary, 'contract');
    writeFileSync(main, program);
    const compile = spawnSync('xcrun', ['swiftc', '-swift-version', '5', ...sources.map(source => path.join(directory, 'ios', source)), main, '-o', binary], { encoding: 'utf8', timeout: 60000 });
    expect(compile.status, compile.stdout + compile.stderr).toBe(0);
    const result = spawnSync(binary, { encoding: 'utf8', timeout: 10000 });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('passed');
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

test('browser voice names resolve exactly once in the current directory, with empty-only system default', () => {
  swift(`import Foundation
struct Voice: Equatable { let identifier: String; let name: String }
func check(_ value: Bool) { precondition(value) }
let one = Voice(identifier: "native.one", name: "Samantha")
let two = Voice(identifier: "native.two", name: "Samantha")
func resolve(_ name: String, _ voices: [Voice]) throws -> Voice? {
  try NativeBrowserSpeechVoice.resolve(name: name, voices: voices, nameOf: { $0.name })
}
func unavailable(_ work: () throws -> Void) {
  do { try work(); fatalError("Expected unavailable") }
  catch SpeechFailure.unavailable {} catch { fatalError("Wrong error") }
}
check(try resolve("", []) == nil)
check(try resolve("Samantha", [one]) == one)
unavailable { _ = try resolve("native.one", [one]) }
unavailable { _ = try resolve("samantha", [one]) }
unavailable { _ = try resolve(" Samantha", [one]) }
unavailable { _ = try resolve(" ", [one]) }
unavailable { _ = try resolve("Samantha", []) }
unavailable { _ = try resolve("Samantha", [one, two]) }
unavailable { _ = try resolve("Samantha", [one, one]) }
let accented = Voice(identifier: "native.accented", name: "Caf\\u{00E9}")
unavailable { _ = try resolve("Cafe\\u{0301}", [accented]) }
check(try resolve("Caf\\u{00E9}", [accented]) == accented)
check(try resolve("Samantha", [two]) == two)
print("Browser voice policy passed")
`, ['RuntimeHostScope.swift', 'SpeechVoiceCatalogPolicy.swift', 'SpeechPlaybackBridge.swift']);
}, 90000);

test('read-only directory admits exact captured Host lease and checks current/foreground before and after projection', () => {
  swift(`import Foundation
@MainActor func run() throws {
  let expected = RuntimeHostScope(hostID: "host-a", lease: UUID())
  let otherHost = RuntimeHostScope(hostID: "host-b", lease: expected.lease)
  let otherLease = RuntimeHostScope(hostID: expected.hostID, lease: UUID())
  let input: [String: Any] = ["expectedHost": expected.publicValue]
  var active = true, current = true, captures = 0, reads = 0
  var captured = expected
  var afterCapture: () -> Void = {}
  var afterRead: () -> Void = {}
  func capture(_ requested: RuntimeHostScope) throws -> NativeSpeechVoiceScope {
    precondition(requested == expected)
    captures += 1
    afterCapture()
    return NativeSpeechVoiceScope(expectedHost: captured, isCurrent: { current })
  }
  func read(_ input: Any?) throws -> [String: Any] {
    try NativeSpeechVoiceCatalog.read(input, capture: capture, foreground: { active }, voices: {
      reads += 1; afterRead()
      return [NativeSpeechVoiceIdentity(identifier: "actual.identifier", name: "Voice", language: "en-US"),
              NativeSpeechVoiceIdentity(identifier: "second.identifier", name: "Voice", language: "en-GB")]
    })
  }
  func reject(_ input: Any?, _ failure: RuntimeHostScopeFailure) {
    do { _ = try read(input); fatalError("Expected rejection") }
    catch let error as RuntimeHostScopeFailure { precondition(error == failure) }
    catch { fatalError("Wrong error") }
  }
  let result = try read(input)
  let rows = result["voices"] as! [[String: String]]
  precondition(Set(result.keys) == ["voices"] && rows.count == 2)
  precondition(rows[0] == ["identifier": "actual.identifier", "name": "Voice", "language": "en-US"])
  precondition(rows[1]["name"] == "Voice")
  precondition(captures == 1 && reads == 1)
  for invalid: Any in [[:], ["expectedHost": expected.publicValue, "owner": "forbidden"], ["expectedHost": ["hostID": expected.hostID]], ["expectedHost": ["hostID": expected.hostID, "lease": "invalid"]]] {
    reject(invalid, .invalid)
  }
  precondition(captures == 1 && reads == 1)
  active = false; reject(input, .background)
  precondition(captures == 1 && reads == 1)
  active = true; current = false; reject(input, .stale)
  precondition(reads == 1)
  current = true; afterCapture = { active = false }; reject(input, .background)
  precondition(reads == 1)
  active = true; afterCapture = {}
  current = true
  for wrong in [otherHost, otherLease] { captured = wrong; reject(input, .stale) }
  precondition(reads == 1)
  captured = expected; afterRead = { current = false }; reject(input, .stale)
  current = true; afterRead = { active = false }; reject(input, .background)
  active = true; afterRead = {}
  _ = try read(input)
  let empty = try NativeSpeechVoiceCatalog.read(input, capture: capture, foreground: { true }, voices: { [] })
  precondition((empty["voices"] as! [[String: String]]).isEmpty)
  do {
    _ = try NativeSpeechVoiceCatalog.read(input, capture: { _ in throw RuntimeHostScopeFailure.unavailable }, foreground: { true }, voices: { fatalError("Unauthorized directory read") })
    fatalError("Expected capture failure")
  } catch RuntimeHostScopeFailure.unavailable {}
  print("Scoped voice directory policy passed")
}
try MainActor.assumeIsolated { try run() }
`, ['RuntimeHostScope.swift', 'SpeechVoiceCatalogPolicy.swift']);
}, 90000);

test('native handler projects real AVFoundation identities without playback, microphone, network or owner mutation', () => {
  const source = readFileSync(path.join(directory, 'ios/SpeechPlaybackBridge.swift'), 'utf8');
  const handler = source.split('app.handle("speech.voices")')[1].split('app.handle("speech.prepare")')[0];
  expect(handler).toContain('guard let captureVoices else { throw SpeechFailure.unavailable }');
  expect(handler).toContain('NativeSpeechVoiceCatalog.read(input, capture: captureVoices');
  expect(handler).toContain('UIApplication.shared.applicationState == .active');
  expect(handler).toContain('AVSpeechSynthesisVoice.speechVoices().map');
  expect(handler).toContain('identifier: $0.identifier, name: $0.name, language: $0.language');
  expect(handler).not.toMatch(/AVAudioSession|AVSpeechSynthesizer|AVSpeechUtterance|\.speech\b|self\.|URLSession|requestRecordPermission/);
  expect(source).not.toContain('$0.identifier == settings.voice || $0.name == settings.voice');
  expect(source).toContain('if let browserVoice { utterance.voice = browserVoice }');
  expect(source).toContain('if let failure = error as? SpeechFailure, case .unavailable = failure { throw failure }');
});

test.skipIf(process.platform !== 'darwin')('production voice handler and playback typecheck against the iOS SDK without running NSH or audio', () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'nsh-speech-voice-sdk-'));
  const run = (args: string[]) => {
    const result = spawnSync('xcrun', args, { encoding: 'utf8', timeout: 60000 });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    return result.stdout.trim();
  };
  try {
    const sdk = run(['--sdk', 'iphonesimulator', '--show-sdk-path']);
    const flags = ['-swift-version', '5', '-sdk', sdk, '-target', 'arm64-apple-ios15.0-simulator'];
    const stub = path.join(temporary, 'NativeShell.swift');
    writeFileSync(stub, `import Foundation
@MainActor public final class NshAppView {
  public func handle(_ name: String, _ handler: @escaping @MainActor (Any?) async throws -> Any?) {}
  public func send(_ name: String, _ value: Any? = nil) {}
}`);
    run(['swiftc', ...flags, '-emit-module', '-module-name', 'NativeShell', stub, '-emit-module-path', path.join(temporary, 'NativeShell.swiftmodule')]);
    const transport = path.join(temporary, 'Transport.swift');
    const runtime = readFileSync(path.join(directory, 'ios/RuntimeBridge.swift'), 'utf8');
    const declarations = runtime.slice(runtime.indexOf('struct SpeechResourceResponse {'), runtime.indexOf('private actor ResourceBytesBuffer {'));
    writeFileSync(transport, `import Foundation\n${declarations}`);
    const assembly = path.join(temporary, 'Assembly.swift');
    writeFileSync(assembly, `import NativeShell
@MainActor func assemble(_ app: NshAppView, transport: @escaping () throws -> ResourceTransport,
                        scoped: @escaping (RuntimeHostScope) throws -> ResourceTransport) {
  _ = SpeechPlaybackBridge(app: app, capture: transport)
  _ = SpeechPlaybackBridge(app: app, captureVoices: { expected in
    let captured = try scoped(expected)
    return NativeSpeechVoiceScope(expectedHost: expected, isCurrent: captured.isCurrent)
  }, capture: transport)
}`);
    run(['swiftc', ...flags, '-I', temporary, '-parse-as-library', '-typecheck',
      ...['RuntimeHostScope.swift', 'SpeechVoiceCatalogPolicy.swift', 'SpeechPlaybackBridge.swift'].map(file => path.join(directory, 'ios', file)), transport, assembly]);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}, 130000);
