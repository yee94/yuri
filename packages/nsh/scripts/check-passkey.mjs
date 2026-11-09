import { copyFile, mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = await mkdtemp(path.join(tmpdir(), 'nsh-passkey-'));
const run = (args) => execFileSync('xcrun', args, { stdio: 'inherit' });
try {
  run(['swiftc', '-swift-version', '5', '-parse-as-library', path.join(root, 'ios/PasskeyPolicy.swift'), path.join(root, 'tests/passkey/main.swift'), '-o', path.join(out, 'checks')]);
  execFileSync(path.join(out, 'checks'), [], { stdio: 'inherit' });
  const sdk = execFileSync('xcrun', ['--sdk', 'iphoneos', '--show-sdk-path'], { encoding: 'utf8' }).trim();
  const flags = ['-swift-version', '5', '-sdk', sdk, '-target', 'arm64-apple-ios15.0'];
  run(['swiftc', ...flags, '-emit-module', '-module-name', 'NativeShell', path.join(root, 'tests/passkey/NativeShell.swift'), '-emit-module-path', path.join(out, 'NativeShell.swiftmodule')]);
  run(['swiftc', ...flags, '-I', out, '-typecheck', path.join(root, 'ios/RuntimeHostScope.swift'), path.join(root, 'ios/PasskeyPolicy.swift'), path.join(root, 'ios/PasskeyBridge.swift')]);
  let store = (await readFile(path.join(root, 'ios/ConnectionStore.swift'), 'utf8')).replace('import Security\n', '');
  function replace(from, to, replacement) {
    const start = store.indexOf(from), end = store.indexOf(to, start + from.length);
    if (start < 0 || end <= start) throw Error('ConnectionStore fixture boundary changed');
    store = store.slice(0, start) + replacement + store.slice(end);
  }
  replace('    init() throws {', '    var selected:', '    var failNextWrite = false\n    init(memoryData: Data) throws { state = try JSONDecoder().decode(State.self, from: memoryData) }\n');
  replace('    private func persist(_ data: Data) throws {', '    func save(', '    private func persist(_ data: Data) throws { if failNextWrite { failNextWrite = false; throw ConnectionEditorFailure.storage } }\n');
  if (/\b(?:SecItem\w*|kSec\w*)\b|import Security/.test(store)) throw Error('Keychain must not enter memory fixture');
  const desktop = await readFile(path.join(root, 'ios/RemoteDesktopBridge.swift'), 'utf8');
  const contract = desktop.slice(desktop.indexOf('enum RemoteDesktopWireMessage'), desktop.indexOf('/// A deadline'));
  await writeFile(path.join(out, 'Contracts.swift'), store + '\n' + contract);
  const sources = ['PasskeyPolicy.swift', 'connection-editor.swift', 'RuntimeHostScope.swift', 'AttachmentUploadPolicy.swift', 'AttachmentReceiptJournal.swift', 'VoiceRecognitionCore.swift', 'VoiceRecognitionRuntime.swift', 'ResourceWebPreviewBridge.swift', 'GuiPluginPreviewBridge.swift', 'GuiPluginResourceResolver.swift', 'GuiPluginDeviceBridge.swift', 'GuiPluginRuntime.swift', 'RuntimeBridge.swift', 'SessionMessageStream.swift', 'SessionMessageStreamDirect.swift', 'RelayTunnel.swift', 'TerminalBridge.swift', 'TerminalTransport.swift'].map(file => path.join(root, 'ios', file));
  run(['swiftc', ...flags, '-I', out, '-parse-as-library', '-typecheck', path.join(out, 'Contracts.swift'), ...sources, path.join(root, '../mobile/ios/App/App/YuriViewExportRenderer.swift')]);
  run(['swiftc', '-swift-version', '5', '-emit-library', '-emit-module', '-module-name', 'NativeShell', path.join(root, 'tests/passkey/NativeShell.swift'), '-o', path.join(out, 'libNativeShell.dylib')]);
  const callbackModules = path.join(out, 'callbacks');
  await mkdir(callbackModules);
  await copyFile(path.join(out, 'NativeShell.swiftmodule'), path.join(callbackModules, 'NativeShell.swiftmodule'));
  run(['swiftc', '-swift-version', '5', '-emit-library', '-emit-module', '-module-name', 'UIKit', path.join(root, 'tests/passkey/UIKit.swift'), '-emit-module-path', path.join(callbackModules, 'UIKit.swiftmodule'), '-o', path.join(out, 'libUIKit.dylib')]);
  run(['swiftc', '-swift-version', '5', '-I', callbackModules, '-L', out, '-lUIKit', '-emit-library', '-emit-module', '-module-name', 'AuthenticationServices', path.join(root, 'tests/passkey/AuthenticationServices.swift'), '-emit-module-path', path.join(callbackModules, 'AuthenticationServices.swiftmodule'), '-o', path.join(out, 'libAuthenticationServices.dylib')]);
  run(['swiftc', '-swift-version', '5', '-parse-as-library', '-I', callbackModules, '-L', out, '-lNativeShell', '-lUIKit', '-lAuthenticationServices', '-Xlinker', '-rpath', '-Xlinker', out, path.join(root, 'ios/RuntimeHostScope.swift'), path.join(root, 'ios/PasskeyPolicy.swift'), path.join(root, 'ios/PasskeyBridge.swift'), path.join(root, 'tests/passkey/callbacks.swift'), '-o', path.join(out, 'callback-checks')]);
  for (const mode of ['reservation', 'labels', 'status-background', 'password-background', 'authorize-success', 'close-status', 'close-password', 'close-login', 'close-ceremony']) execFileSync(path.join(out, 'callback-checks'), [mode], { stdio: 'inherit' });
  execFileSync('bun', [path.join(root, 'tests/passkey/labels.ts')], { stdio: 'inherit' });
  run(['swiftc', '-swift-version', '5', '-parse-as-library', '-I', out, '-L', out, '-lNativeShell', '-Xlinker', '-rpath', '-Xlinker', out, path.join(out, 'Contracts.swift'), ...sources, path.join(root, 'ios/ResourceBridge.swift'), path.join(root, 'tests/passkey/runtime.swift'), '-o', path.join(out, 'runtime-checks')]);
  execFileSync(path.join(out, 'runtime-checks'), [], { stdio: 'inherit' });
} finally {
  await rm(out, { recursive: true, force: true });
}
