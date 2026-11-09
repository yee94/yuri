// Metadata-only frontend check. No Windows DLL is linked or executed; no Vault is opened.
import { spawnSync } from 'node:child_process';
import { access, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const fixtures = path.dirname(fileURLToPath(import.meta.url));
const target = path.resolve(fixtures, '../../.nsh/desktop-target');
const deps = path.join(target, 'debug/deps');
const candidates = (await readdir(deps)).filter(name => /^libserde_json-[\da-f]+\.rlib$/.test(name));
if (!process.env.SERDE_JSON_RLIB && candidates.length !== 1) throw new Error('Build the host first; if multiple serde_json builds exist, select the matching rlib with SERDE_JSON_RLIB');
const serde = process.env.SERDE_JSON_RLIB || path.join(deps, candidates[0]);
const installed = path.join(os.homedir(), '.cargo/bin/rustc');
const rustc = process.env.RUSTC || await access(installed).then(() => installed, () => 'rustc');
const result = spawnSync(rustc, ['--edition', '2024', '--crate-type', 'lib', '--emit', 'metadata', '--crate-name', 'windows_vault_typecheck',
  path.join(fixtures, 'windows-vault-typecheck.rs'), '--extern', `serde_json=${serde}`, '-L', `dependency=${deps}`,
  '-o', path.join(target, 'windows-vault-typecheck.rmeta')], { stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
console.log('Windows Vault actual FFI/transaction source: metadata typecheck passed (not a Windows target/SDK/runtime check)');
