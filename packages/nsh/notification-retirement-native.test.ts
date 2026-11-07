import { afterAll, beforeAll, expect, test } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.dirname(fileURLToPath(import.meta.url));
let temporary: string, binary: string;
beforeAll(() => {
  temporary = mkdtempSync(path.join(tmpdir(), 'notification-retirement-'));
  let source = readFileSync(path.join(root, 'ios/NotificationBridge.swift'), 'utf8').split('#if canImport(UIKit) && canImport(NativeShell)', 1)[0];
  source = source.replace('    private let file: URL', '    var failNextWrite = false\n    private(set) var memoryPersisted: Data?\n    private(set) var writes = 0');
  const opening = `    init(file: URL) throws {
        self.file = file
        guard FileManager.default.fileExists(atPath: file.path) else { return }
        let data = try Data(contentsOf: file)`;
  expect(source).toContain(opening);
  source = source.replace(opening, `    init(memoryData: Data? = nil) throws {
        memoryPersisted = memoryData
        guard let data = memoryData else { return }`);
  const start = source.indexOf('        try FileManager.default.createDirectory');
  const end = source.indexOf('        records = next;', start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  source = source.slice(0, start) + `        if failNextWrite { failNextWrite = false; throw NativeNotificationFailure.unavailable }
        memoryPersisted = data; writes += 1
` + source.slice(end);
  expect(source).not.toMatch(/FileManager|Data\(contentsOf:|data\.write|UNUserNotificationCenter|import UIKit|SecItem/);
  writeFileSync(path.join(temporary, 'MemoryInbox.swift'), source);
  binary = path.join(temporary, 'retirement');
  const result = spawnSync('xcrun', ['swiftc', '-swift-version', '5', '-warnings-as-errors', path.join(temporary, 'MemoryInbox.swift'), path.join(root, 'tests/notification-retirement.swift'), '-parse-as-library', '-o', binary], { encoding: 'utf8', timeout: 60_000 });
  expect(result.status, result.stderr || result.error?.message).toBe(0);
}, 90_000);
afterAll(() => { if (temporary) rmSync(temporary, { recursive: true, force: true }); });

for (const scenario of ['legacy', 'begin-crash', 'begin-failure', 'os-before-ack', 'ack-failure', 'readback', 'capacity', 'malformed', 'precise-ack', 'queued-retirement', 'late-add', 'cancelled']) {
  test(`notification tombstone transaction: ${scenario}`, () => {
    const result = spawnSync(binary, [scenario], { encoding: 'utf8', timeout: 10_000 });
    expect(result.status, result.stderr || result.error?.message).toBe(0);
    expect(result.stdout.trim()).toBe(`PASS ${scenario}`);
  });
}
test('a separate process restores pending receipt identifiers after begin persisted and retries only that pair', () => {
  const first = spawnSync(binary, ['export'], { encoding: 'utf8', timeout: 10_000 });
  expect(first.status, first.stderr).toBe(0);
  const next = spawnSync(binary, ['restore'], { input: first.stdout, encoding: 'utf8', timeout: 10_000 });
  expect(next.status, next.stderr).toBe(0); expect(next.stdout.trim()).toBe('PASS restore');
});
