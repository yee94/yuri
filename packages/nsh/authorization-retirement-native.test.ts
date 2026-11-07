import { beforeAll, afterAll, expect, test } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.dirname(fileURLToPath(import.meta.url));
let temporary: string, binary: string;
function replaceBetween(source: string, start: string, end: string, replacement: string) {
  const from = source.indexOf(start), to = source.indexOf(end, from + start.length);
  if (from < 0 || to <= from) throw new Error('Production persistence seam changed');
  return source.slice(0, from) + replacement + source.slice(to);
}
beforeAll(() => {
  temporary = mkdtempSync(path.join(tmpdir(), 'authorization-retirement-'));
  let store = readFileSync(path.join(root, 'ios/ConnectionStore.swift'), 'utf8').replace('import Security\n', '');
  store = replaceBetween(store, '    init() throws {', '    var selected:', `    var failNextWrite = false
    private(set) var memoryPersisted: Data?
    private(set) var writes = 0
    init(memoryData: Data? = nil) throws {
        state = try memoryData.map { try JSONDecoder().decode(State.self, from: $0) } ?? State()
        memoryPersisted = memoryData
    }
`);
  store = replaceBetween(store, '    private func persist(_ data: Data) throws {', '    func save(', `    private func persist(_ data: Data) throws {
        if failNextWrite { failNextWrite = false; throw ConnectionEditorFailure.storage }
        memoryPersisted = data; writes += 1
    }
`);
  expect(store).not.toMatch(/\b(?:SecItem\w*|kSec\w*)\b|import Security/);
  writeFileSync(path.join(temporary, 'MemoryStore.swift'), store);

  // Exercise the production notification retire/filter/commit lane, replacing
  // only its disk I/O. Never compile or run UNUserNotificationCenter here.
  let inbox = readFileSync(path.join(root, 'ios/NotificationBridge.swift'), 'utf8').split('#if canImport(UIKit) && canImport(NativeShell)', 1)[0];
  inbox = inbox.replace('    private let file: URL', '    var failNextWrite = false\n    private(set) var memoryPersisted: Data?');
  const opening = `    init(file: URL) throws {
        self.file = file
        guard FileManager.default.fileExists(atPath: file.path) else { return }
        let data = try Data(contentsOf: file)`;
  expect(inbox).toContain(opening);
  inbox = inbox.replace(opening, `    init(memoryData: Data? = nil) throws {
        memoryPersisted = memoryData
        guard let data = memoryData else { return }`);
  inbox = replaceBetween(inbox, '        try FileManager.default.createDirectory', '        records = next;', `        if failNextWrite { failNextWrite = false; throw NativeNotificationFailure.unavailable }
        memoryPersisted = data
`);
  expect(inbox).not.toMatch(/FileManager|Data\(contentsOf:|data\.write|UNUserNotificationCenter|SecItem/);
  writeFileSync(path.join(temporary, 'MemoryInbox.swift'), inbox);
  binary = path.join(temporary, 'contract');
  const compiled = spawnSync('xcrun', ['swiftc', '-swift-version', '5', '-warnings-as-errors', path.join(temporary, 'MemoryStore.swift'), path.join(temporary, 'MemoryInbox.swift'), path.join(root, 'ios/connection-editor.swift'), path.join(root, 'tests/authorization-retirement.swift'), '-o', binary], { encoding: 'utf8', timeout: 60_000 });
  expect(compiled.status, compiled.stderr || compiled.error?.message).toBe(0);
}, 90_000);
afterAll(() => { if (temporary) rmSync(temporary, { recursive: true, force: true }); });
for (const scenario of ['legacy', 'atomic', 'metadata', 'replacement', 'ack', 'aba-relay', 'replacement-variants', 'ack-generation', 'capacity', 'malformed', 'notification-idempotence']) {
  test(`durable authorization retirement: ${scenario}`, () => {
    const result = spawnSync(binary, [scenario], { encoding: 'utf8', timeout: 10_000 });
    expect(result.status, result.stderr || result.error?.message).toBe(0);
    expect(result.stdout.trim()).toBe(`PASS ${scenario}`);
  });
}
test('retirement is restored in a separate process, independently of a runtime ledger', () => {
  const first = spawnSync(binary, ['export'], { encoding: 'utf8', timeout: 10_000 });
  expect(first.status, first.stderr).toBe(0);
  const second = spawnSync(binary, ['restore'], { encoding: 'utf8', input: first.stdout, timeout: 10_000 });
  expect(second.status, second.stderr).toBe(0);
  expect(second.stdout.trim()).toBe('PASS restore');
});

test('production ConnectionStore and records typecheck against Apple SDK without executing Keychain', () => {
  const sdk = spawnSync('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path'], { encoding: 'utf8' });
  expect(sdk.status, sdk.stderr).toBe(0);
  const result = spawnSync('xcrun', ['swiftc', '-swift-version', '5', '-sdk', sdk.stdout.trim(), '-target', 'arm64-apple-ios15.0-simulator', '-typecheck', path.join(root, 'ios/ConnectionStore.swift'), path.join(root, 'ios/connection-editor.swift')], { encoding: 'utf8', timeout: 60_000 });
  expect(result.status, result.stderr || result.error?.message).toBe(0);
});
