import { it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.dirname(fileURLToPath(import.meta.url));
it('executes production cold Bridge recovery, deferred durable adoption and local ACK after lease retirement with exact cleanup retry', () => {
  const temp = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'attachment-cold-ack-'));
  try {
    const fixture = path.join(root, 'tests/attachment-upload');
    for (const name of ['UniformTypeIdentifiers', 'UIKit', 'PhotosUI']) {
      run(['swiftc', '-swift-version', '5', '-I', temp, '-L', temp, '-emit-library', '-emit-module', '-module-name', name, path.join(fixture, `${name}.swift`), '-emit-module-path', path.join(temp, `${name}.swiftmodule`), '-o', path.join(temp, `lib${name}.dylib`), ...(name === 'UIKit' ? ['-lUniformTypeIdentifiers'] : name === 'PhotosUI' ? ['-lUIKit', '-lUniformTypeIdentifiers'] : [])]);
    }
    const runtime = readFileSync(path.join(root, 'ios/RuntimeBridge.swift'), 'utf8');
    const methods = runtime.slice(runtime.indexOf('    func contactAttachmentOperation('), runtime.indexOf('    func attachmentUploader('));
    const store = readFileSync(path.join(root, 'ios/ConnectionStore.swift'), 'utf8');
    const lookup = store.slice(store.indexOf('    func attachmentConnection('), store.indexOf('    var snapshot:'));
    const shared = readFileSync(path.join(fixture, 'journal.swift'), 'utf8');
    const source = path.join(temp, 'ColdACK.swift'), binary = path.join(temp, 'cold-ack');
    writeFileSync(source, shared.slice(0, shared.indexOf('@main struct JournalContract')) + readFileSync(path.join(fixture, 'cold-ack.swift'), 'utf8') + `\nextension RuntimeBridge {\n${methods}\n}\nextension ConnectionStore {\n${lookup}\n}\n`);
    run(['swiftc', '-swift-version', '5', '-parse-as-library', '-I', temp, '-L', temp, '-lUIKit', '-lPhotosUI', '-lUniformTypeIdentifiers', path.join(root, 'ios/RuntimeHostScope.swift'), path.join(root, 'ios/AttachmentUploadPolicy.swift'), path.join(root, 'ios/AttachmentReceiptJournal.swift'), path.join(root, 'ios/AttachmentBridge.swift'), source, '-o', binary]);
    const result = spawnSync(binary, [], { encoding: 'utf8', timeout: 15_000, env: { ...process.env, DYLD_LIBRARY_PATH: temp } });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('Production cold recovery local ACK contract passed');
  } finally { rmSync(temp, { recursive: true, force: true }); }
}, 150_000);
it('executes production native journal restart, exact original authorization lookup and GET/DELETE recovery without sockets', () => {
  const temp = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'attachment-journal-'));
  try {
    const runtime = readFileSync(path.join(root, 'ios/RuntimeBridge.swift'), 'utf8');
    const methods = runtime.slice(runtime.indexOf('    func contactAttachmentOperation('), runtime.indexOf('    func attachmentUploader('));
    const store = readFileSync(path.join(root, 'ios/ConnectionStore.swift'), 'utf8');
    const lookup = store.slice(store.indexOf('    func attachmentConnection('), store.indexOf('    var snapshot:'));
    const fixture = path.join(temp, 'Journal.swift'), binary = path.join(temp, 'journal');
    writeFileSync(fixture, readFileSync(path.join(root, 'tests/attachment-upload/journal.swift'), 'utf8') + `\nextension RuntimeBridge {\n${methods}\n}\nextension ConnectionStore {\n${lookup}\n}\n`);
    run(['swiftc', '-swift-version', '5', '-parse-as-library', path.join(root, 'ios/RuntimeHostScope.swift'), path.join(root, 'ios/AttachmentUploadPolicy.swift'), path.join(root, 'ios/AttachmentReceiptJournal.swift'), fixture, '-o', binary]);
    const result = spawnSync(binary, [], { encoding: 'utf8', timeout: 15_000 });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('Attachment journal restart contract passed');
  } finally { rmSync(temp, { recursive: true, force: true }); }
}, 150_000);
function run(args: string[]) {
  const result = spawnSync('xcrun', args, { encoding: 'utf8', timeout: 120_000 });
  expect(result.error, result.error?.message).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  return result.stdout.trim();
}
it('executes production contact upload callbacks with synthetic transport only', () => {
  const temp = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'attachment-upload-'));
  try {
    const binary = path.join(temp, 'contract');
    run(['swiftc', '-swift-version', '5', '-parse-as-library', path.join(root, 'ios/RuntimeHostScope.swift'), path.join(root, 'ios/AttachmentUploadPolicy.swift'), path.join(root, 'tests/attachment-upload/main.swift'), '-o', binary]);
    const result = spawnSync(binary, [], { encoding: 'utf8', timeout: 10_000 });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('Attachment upload contract passed');
  } finally { rmSync(temp, { recursive: true, force: true }); }
}, 150_000);

it('typechecks the production picker and exact Runtime uploader against the iOS SDK', () => {
  const temp = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'attachment-sdk-'));
  try {
    const sdk = run(['--sdk', 'iphonesimulator', '--show-sdk-path']);
    const runtime = readFileSync(path.join(root, 'ios/RuntimeBridge.swift'), 'utf8');
    const method = runtime.slice(runtime.indexOf('    func contactAttachmentOperation('), runtime.indexOf('    private func connect('));
    const stub = path.join(temp, 'Runtime.swift');
    writeFileSync(stub, `import Foundation
import CryptoKit
enum NativeFailure: Error { case message(String) }
struct SavedConnection { let id = "fixture"; let authorizationID: String? = "fixture-auth"; let transportID: String? = "fixture-transport"; let editorVersion: String? = "fixture-version" }
struct ConnectionStore {
  func attachmentConnection(connectionID: String, transportID: String, authorizationID: String, version: String) throws -> SavedConnection { SavedConnection() }
}
struct Admission { let connection = SavedConnection(); let generation = 0; let expectedHost: RuntimeHostScope }
@MainActor final class RuntimeBridge {
  private let store = ConnectionStore()
  private func requireForeground() throws { }
  private func admit(_ scope: RuntimeHostScope?, required: Bool) throws -> Admission { Admission(expectedHost: scope!) }
  private func checkHost(_ connection: SavedConnection, generation: Int, expected: RuntimeHostScope? = nil) throws { }
  private func makeRequest(_ path: String, connection: SavedConnection, method: String) throws -> URLRequest { URLRequest(url: URL(string: "https://fixture.invalid")!) }
  private func scopedJSON(_ request: URLRequest, connection: SavedConnection, scope: Int, expectedHost: RuntimeHostScope? = nil) async throws -> (Int, Any) { (201, [:]) }
  private func json(_ request: URLRequest, connection: SavedConnection) async throws -> (Int, Any) { (200, [:]) }
${method}
}`);
    run(['swiftc', '-swift-version', '5', '-sdk', sdk, '-target', 'arm64-apple-ios15.0-simulator', '-typecheck', path.join(root, 'ios/RuntimeHostScope.swift'), path.join(root, 'ios/AttachmentUploadPolicy.swift'), path.join(root, 'ios/AttachmentReceiptJournal.swift'), path.join(root, 'ios/AttachmentBridge.swift'), stub]);
  } finally { rmSync(temp, { recursive: true, force: true }); }
}, 150_000);

it('executes the actual production picker delegates with delayed UIKit dismissal doubles', () => {
  const temp = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'attachment-callbacks-'));
  try {
    const fixture = path.join(root, 'tests/attachment-upload');
    for (const name of ['UniformTypeIdentifiers', 'UIKit', 'PhotosUI']) {
      run(['swiftc', '-swift-version', '5', '-I', temp, '-L', temp, '-emit-library', '-emit-module', '-module-name', name, path.join(fixture, `${name}.swift`), '-emit-module-path', path.join(temp, `${name}.swiftmodule`), '-o', path.join(temp, `lib${name}.dylib`), ...(name === 'UIKit' ? ['-lUniformTypeIdentifiers'] : name === 'PhotosUI' ? ['-lUIKit', '-lUniformTypeIdentifiers'] : [])]);
    }
    const binary = path.join(temp, 'callbacks'), file = path.join(temp, 'photo.png'); writeFileSync(file, 'synthetic');
    run(['swiftc', '-swift-version', '5', '-parse-as-library', '-I', temp, '-L', temp, '-lUIKit', '-lPhotosUI', '-lUniformTypeIdentifiers', path.join(root, 'ios/RuntimeHostScope.swift'), path.join(root, 'ios/AttachmentUploadPolicy.swift'), path.join(root, 'ios/AttachmentReceiptJournal.swift'), path.join(root, 'ios/AttachmentBridge.swift'), path.join(fixture, 'callbacks.swift'), '-o', binary]);
    const result = spawnSync(binary, [file], { encoding: 'utf8', timeout: 15_000, env: { ...process.env, DYLD_LIBRARY_PATH: temp } });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('Attachment production callbacks passed');
  } finally { rmSync(temp, { recursive: true, force: true }); }
}, 150_000);

it('executes production contact resource admission/integrity and typechecks the real preview bridge', () => {
  const temp = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'contact-preview-sdk-'));
  try {
    const binary = path.join(temp, 'preview');
    run(['swiftc', '-swift-version', '5', '-parse-as-library', path.join(root, 'ios/RuntimeHostScope.swift'), path.join(root, 'ios/ResourceBridge.swift'), path.join(root, 'tests/attachment-upload/resource.swift'), '-o', binary]);
    const result = spawnSync(binary, [], { encoding: 'utf8', timeout: 10_000 });
    expect(result.status, result.stdout + result.stderr).toBe(0); expect(result.stdout).toContain('Contact preview contract passed');
    const sdk = run(['--sdk', 'iphonesimulator', '--show-sdk-path']);
    const stub = path.join(temp, 'NativeShell.swift');
    writeFileSync(stub, '@MainActor public final class NshAppView { public func handle(_ name: String, _ body: @escaping @MainActor (Any?) async throws -> Any?) {} }');
    const flags = ['-swift-version', '5', '-sdk', sdk, '-target', 'arm64-apple-ios15.0-simulator'];
    run(['swiftc', ...flags, '-emit-module', '-module-name', 'NativeShell', stub, '-emit-module-path', path.join(temp, 'NativeShell.swiftmodule')]);
    const runtime = readFileSync(path.join(root, 'ios/RuntimeBridge.swift'), 'utf8'), transport = path.join(temp, 'ResourceTransport.swift');
    writeFileSync(transport, 'import Foundation\n' + runtime.slice(runtime.indexOf('struct SpeechResourceResponse'), runtime.indexOf('private actor ResourceBytesBuffer')));
    run(['swiftc', ...flags, '-I', temp, '-typecheck', path.join(root, 'ios/RuntimeHostScope.swift'), path.join(root, 'ios/ResourceBridge.swift'), transport]);
  } finally { rmSync(temp, { recursive: true, force: true }); }
}, 150_000);
