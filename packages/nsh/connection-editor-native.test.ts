import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('production connection metadata transitions pass a Foundation-only synthetic harness without Keychain or network', () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const temporary = mkdtempSync(path.join(tmpdir(), 'nsh-connection-editor-'));
  try {
    const source = readFileSync(path.join(root, 'ios/ConnectionStore.swift'), 'utf8');
    const marker = source.indexOf('/// One atomic Keychain');
    expect(marker).toBeGreaterThan(0);
    const types = source.slice(0, marker).replace('import Security\n', '');
    expect(types).not.toContain('SecItem');
    writeFileSync(path.join(temporary, 'Types.swift'), types);
    const binary = path.join(temporary, 'check');
    const compile = spawnSync('swiftc', ['-swift-version', '5', path.join(temporary, 'Types.swift'), path.join(root, 'ios/connection-editor.swift'), path.join(root, 'connection-editor-harness.swift'), '-o', binary], { encoding: 'utf8', timeout: 60_000 });
    expect(compile.status, compile.stderr || compile.error?.message).toBe(0);
    const run = spawnSync(binary, [], { encoding: 'utf8', timeout: 15_000 });
    expect(run.status, run.stderr || run.error?.message).toBe(0);
    expect(run.stdout.trim()).toBe('connection-editor Foundation synthetic harness passed');
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}, 90_000);

it('production transport partition migration and mutations are atomic with synthetic persistence and no Keychain/network', () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const temporary = mkdtempSync(path.join(process.env.OPENCODE_TMP_DIR || tmpdir(), 'nsh-connection-transport-'));
  try {
    let source = readFileSync(path.join(root, 'ios/ConnectionStore.swift'), 'utf8').replace('import Security\n', '');
    const opening = source.indexOf('    init() throws {'), migration = source.indexOf('        if state.transportPartitions', opening);
    expect(opening).toBeGreaterThan(0); expect(migration).toBeGreaterThan(opening);
    // Replace only secure read/write I/O. The real startup migration and commit
    // order, connection mutation and snapshot code stay in this synthetic store.
    source = source.slice(0, opening) + `    var failWrites = false
    private(set) var persisted: Data?
    init(memoryData: Data? = nil, failWrites: Bool = false) throws {
        self.failWrites = failWrites; persisted = memoryData
        state = try memoryData.map { try JSONDecoder().decode(State.self, from: $0) } ?? State()
` + source.slice(migration);
    const writing = source.indexOf('    private func persist(_ data: Data) throws {'), saving = source.indexOf('    func save(', writing);
    expect(saving).toBeGreaterThan(writing);
    source = source.slice(0, writing) + `    private func persist(_ data: Data) throws {
        if failWrites { throw ConnectionEditorFailure.storage }
        persisted = data
    }
` + source.slice(saving);
    expect(source).not.toMatch(/SecItem|kSec|import Security/);
    writeFileSync(path.join(temporary, 'Store.swift'), source);
    const binary = path.join(temporary, 'check');
    const compile = spawnSync('swiftc', ['-swift-version', '5', '-warnings-as-errors', path.join(temporary, 'Store.swift'), path.join(root, 'ios/connection-editor.swift'), path.join(root, 'tests/connection-transport.swift'), '-o', binary], { encoding: 'utf8', timeout: 60_000 });
    expect(compile.status, compile.stderr || compile.error?.message).toBe(0);
    const run = spawnSync(binary, [], { encoding: 'utf8', timeout: 15_000 });
    expect(run.status, run.stderr || run.error?.message).toBe(0);
    expect(run.stdout.trim()).toBe('connection-transport atomic harness passed');
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}, 90_000);
