import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, test } from 'vitest';

const root = path.dirname(fileURLToPath(import.meta.url));
let temporary: string;
let fixture: ReturnType<typeof spawn>;
let configURL: string;
let fixtureErrors = '';

async function run(command: string, args: string[], timeout = 45_000) {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
  try {
    await new Promise<void>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', code => code === 0 ? resolve() : reject(new Error(output || `exit ${code}`)));
    });
    return output.trim();
  } finally { clearTimeout(timer); }
}

beforeAll(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), 'nsh-desktop-transport-'));
  await writeFile(path.join(temporary, 'NativeShell.swift'), `
import Foundation
@MainActor public final class NshAppView {
 public init() {}
 public func handle(_ name: String, _ handler: @escaping @MainActor (Any?) async throws -> Any?) {}
 public func send(_ name: String, _ data: Any? = nil) {}
}`);
  await run('xcrun', ['swiftc', '-swift-version', '5', '-emit-library', '-emit-module', '-module-name', 'NativeShell', path.join(temporary, 'NativeShell.swift'), '-o', path.join(temporary, 'libNativeShell.dylib')]);
  const store = await readFile(path.join(root, 'ios/ConnectionStore.swift'), 'utf8');
  const bridge = await readFile(path.join(root, 'ios/RemoteDesktopBridge.swift'), 'utf8');
  const seam = bridge.slice(bridge.indexOf('enum RemoteDesktopWireMessage'), bridge.indexOf('/// A deadline'));
  function substitute(source: string, start: string, end: string, replacement: string) {
    const from = source.indexOf(start), to = source.indexOf(end, from + start.length);
    if (from < 0 || to < from) throw new Error('Production ConnectionStore fixture boundary changed');
    return source.slice(0, from) + replacement + source.slice(to);
  }
  let fixtureStore = store.replace('import Security\n', '');
  fixtureStore = substitute(fixtureStore, '    init() throws {', '    var selected:', '    init() throws { state = State() }\n');
  fixtureStore = substitute(fixtureStore, '    private func persist(_ data: Data) throws {', '    func save(', '    private func persist(_ data: Data) throws {}\n');
  expect(fixtureStore).not.toMatch(/\b(?:SecItem\w*|kSec\w*)\b|import Security/);
  await writeFile(path.join(temporary, 'Contracts.swift'), fixtureStore + '\n' + seam);
  await run('xcrun', ['swiftc', '-parse-as-library', '-swift-version', '5', '-warnings-as-errors', '-I', temporary, '-L', temporary, '-lNativeShell', '-Xlinker', '-rpath', '-Xlinker', temporary,
    path.join(temporary, 'Contracts.swift'), path.join(root, 'ios/PasskeyPolicy.swift'), path.join(root, 'ios/connection-editor.swift'), path.join(root, 'ios/RuntimeHostScope.swift'), path.join(root, 'ios/AttachmentUploadPolicy.swift'), path.join(root, 'ios/VoiceRecognitionCore.swift'), path.join(root, 'ios/VoiceRecognitionRuntime.swift'), path.join(root, 'ios/ResourceWebPreviewBridge.swift'), path.join(root, 'ios/GuiPluginPreviewBridge.swift'), path.join(root, 'ios/GuiPluginDeviceBridge.swift'), path.join(root, 'ios/GuiPluginResourceResolver.swift'), path.join(root, 'ios/GuiPluginRuntime.swift'), path.join(root, 'ios/RuntimeBridge.swift'), path.join(root, 'ios/SessionMessageStream.swift'), path.join(root, 'ios/SessionMessageStreamDirect.swift'), path.join(root, 'ios/RelayTunnel.swift'), path.join(root, 'ios/TerminalBridge.swift'), path.join(root, 'ios/TerminalTransport.swift'), path.join(root, 'tests/remote-desktop-transport/Runner.swift'), '-o', path.join(temporary, 'runner')]);
  console.info('Swift 5 macOS contract compile: PASS (RuntimeBridge.swift + RelayTunnel.swift; -warnings-as-errors)');
  fixture = spawn('bun', [path.join(root, 'tests/remote-desktop-transport/fixture.mjs')], { stdio: ['ignore', 'pipe', 'pipe'] });
  fixture.stderr!.on('data', data => { fixtureErrors += data; });
  configURL = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('fixture timeout')), 5_000);
    fixture.stdout!.once('data', data => { clearTimeout(timer); resolve(JSON.parse(String(data)).configURL); });
    fixture.once('error', reject);
  });
}, 60_000);

afterAll(async () => {
  if (fixture?.exitCode === null) {
    const closed = new Promise(resolve => fixture.once('close', resolve));
    fixture.kill('SIGTERM');
    await closed;
  }
  if (temporary) await rm(temporary, { recursive: true, force: true });
});

for (const mode of ['direct', 'relay']) {
  for (const scenario of ['messages', 'cancel', 'close', 'oversize', 'outgoing', 'flood', 'unauthorized', 'disabled', 'unsupported', 'occupied', 'redirect', 'stale', 'cancel-upgrade', 'runtime-close', 'selected-host', 'multiplex', 'local-close']) {
    test(`${mode}: ${scenario}`, async () => {
      expect(await run(path.join(temporary, 'runner'), [configURL, mode, scenario], 12_000)).toBe(`PASS ${mode} ${scenario}`);
      expect(fixtureErrors).toBe('');
    }, 15_000);
  }
}

for (const scenario of ['unpaired', 'upgrade-timeout', 'invalid-path', 'carrier-redirect', 'old-socket', 'bad-open', 'bad-close', 'bad-abort', 'bad-text', 'control-fragment', 'cancel-mint', 'switch-mint', 'bearer-url', 'expired-url', 'bad-mint', 'mint-denied']) {
  test(`relay: ${scenario}`, async () => {
    expect(await run(path.join(temporary, 'runner'), [configURL, 'relay', scenario], 12_000)).toBe(`PASS relay ${scenario}`);
    expect(fixtureErrors).toBe('');
  }, 15_000);
}

for (const scenario of ['fragments', 'invalid-utf8', 'fragment-overflow', 'queue-limit', 'closed-pending', 'duplicate-open']) {
  test(`native inbox: ${scenario}`, async () => {
    expect(await run(path.join(temporary, 'runner'), [configURL, 'core', scenario], 5_000)).toBe(`PASS core ${scenario}`);
  });
}
