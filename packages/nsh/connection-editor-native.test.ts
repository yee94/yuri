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
