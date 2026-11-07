import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, test } from 'vitest';

const root = path.dirname(fileURLToPath(import.meta.url));
let temporary: string;
let fixture: ReturnType<typeof spawn>;
let configURL: string;
let fixtureErrors = '';
async function run(command: string, args: string[], timeout = 60_000) {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
  try {
    await new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error(output || `exit ${code}`))); });
    return output.trim();
  } finally { clearTimeout(timer); }
}

/** Local synthetic authentication/mux only: no microphone, permission, provider or persisted credentials. */
beforeAll(async () => {
  temporary = await mkdtemp(path.join(process.env.OPENCODE_TMP_DIR || tmpdir(), 'nsh-recognition-relay-'));
  await writeFile(path.join(temporary, 'NativeShell.swift'), `import Foundation
@MainActor public final class NshAppView {
 public init() {}
 public func handle(_ name: String, _ handler: @escaping @MainActor (Any?) async throws -> Any?) {}
 public func send(_ name: String, _ data: Any? = nil) {}
}`);
  await run('xcrun', ['swiftc', '-swift-version', '5', '-emit-library', '-emit-module', '-module-name', 'NativeShell', path.join(temporary, 'NativeShell.swift'), '-o', path.join(temporary, 'libNativeShell.dylib')]);
  const desktop = await readFile(path.join(root, 'ios/RemoteDesktopBridge.swift'), 'utf8');
  let store = (await readFile(path.join(root, 'ios/ConnectionStore.swift'), 'utf8')).replace('import Security\n', '');
  function replaceStore(from: string, to: string, replacement: string) {
    const start = store.indexOf(from), end = store.indexOf(to, start + from.length);
    if (start < 0 || end <= start) throw new Error('Production store fixture boundary changed');
    store = store.slice(0, start) + replacement + store.slice(end);
  }
  // Preserve production metadata/auth semantics, replacing only Keychain I/O.
  replaceStore('    init() throws {', '    var selected:', '    init(memoryData: Data?) throws { state = try memoryData.map { try JSONDecoder().decode(State.self, from: $0) } ?? State() }\n');
  replaceStore('    private func persist(_ data: Data) throws {', '    func save(', '    private func persist(_ data: Data) throws {}\n');
  expect(store).not.toMatch(/\b(?:SecItem\w*|kSec\w*)\b|import Security/);
  await writeFile(path.join(temporary, 'DesktopContract.swift'), store + '\n' + desktop.slice(desktop.indexOf('enum RemoteDesktopWireMessage'), desktop.indexOf('/// A deadline')));
  const sources = ['connection-editor.swift', 'RuntimeHostScope.swift', 'VoiceRecognitionCore.swift', 'VoiceRecognitionRuntime.swift', 'ResourceWebPreviewBridge.swift', 'GuiPluginPreviewBridge.swift', 'GuiPluginRuntime.swift', 'RuntimeBridge.swift', 'RelayTunnel.swift', 'TerminalBridge.swift', 'TerminalTransport.swift'];
  await run('xcrun', ['swiftc', '-parse-as-library', '-swift-version', '5', '-warnings-as-errors', '-I', temporary, '-L', temporary, '-lNativeShell', '-Xlinker', '-rpath', '-Xlinker', temporary,
    ...sources.map(file => path.join(root, 'ios', file)), path.join(temporary, 'DesktopContract.swift'), path.join(root, 'tests/voice-recognition-relay/Runner.swift'), '-o', path.join(temporary, 'runner')]);
  fixture = spawn('bun', [path.join(root, 'tests/remote-desktop-transport/fixture.mjs')], { stdio: ['ignore', 'pipe', 'pipe'] });
  fixture.stderr!.on('data', data => { fixtureErrors += data; });
  configURL = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Synthetic fixture startup timed out')), 5_000);
    fixture.stdout!.once('data', data => { clearTimeout(timer); resolve(JSON.parse(String(data)).configURL); });
    fixture.once('error', reject);
  });
}, 90_000);
afterAll(async () => {
  if (fixture?.exitCode === null) {
    const closed = new Promise(resolve => fixture.once('close', resolve));
    fixture.kill('SIGTERM'); await closed;
  }
  if (temporary) await rm(temporary, { recursive: true, force: true });
});
for (const mode of ['direct', 'relay']) for (const scenario of ['voice-messages', 'voice-denied']) {
  test(`production ASR ${mode}: ${scenario} through authenticated loopback and real Host mux`, async () => {
    expect(await run(path.join(temporary, 'runner'), [configURL, mode, scenario], 15_000)).toBe(`PASS ${mode} ${scenario}`);
    expect(fixtureErrors).toBe('');
  }, 20_000);
}
