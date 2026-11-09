// Real WinHTTP adapter + common socket frontend, Darwin std only. No Windows DLL calls.
import { spawnSync } from 'node:child_process';
import { access, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.resolve(here, '../src');
const target = path.resolve(here, '../../.nsh/desktop-target');
const deps = path.join(target, 'debug/deps');
const candidates = (await readdir(deps)).filter(name => /^libserde_json-[\da-f]+\.rlib$/.test(name));
if (!process.env.SERDE_JSON_RLIB && candidates.length !== 1) throw new Error('Build the host first; select its serde_json rlib with SERDE_JSON_RLIB if ambiguous');
const serde = process.env.SERDE_JSON_RLIB || path.join(deps, candidates[0]);
const common = await readFile(path.join(source, 'terminal_socket.rs'), 'utf8');
const boundary = common.indexOf('#[cfg(target_os');
if (boundary < 0 || !common.slice(boundary).includes('terminal_socket_windows.rs')) throw new Error('Native selection boundary changed; audit this checker');
const selected = path.join(target, 'windows-terminal-socket-selected.rs');
await writeFile(selected, `${common.slice(0, boundary)}\n#[path=${JSON.stringify(path.join(source, 'terminal_socket_windows.rs'))}] mod native;\npub use native::Socket;\n`);
const wrapper = path.join(target, 'windows-terminal-socket-check.rs');
await writeFile(wrapper, `#![allow(dead_code)]\n#[path=${JSON.stringify(path.join(source, 'policy.rs'))}] mod policy;\n#[path=${JSON.stringify(selected)}] mod socket;\npub use socket::Socket;\n`);
const installed = path.join(os.homedir(), '.cargo/bin/rustc');
const rustc = process.env.RUSTC || await access(installed).then(() => installed, () => 'rustc');
const result = spawnSync(rustc, ['--edition', '2024', '--crate-type', 'lib', '--emit', 'metadata', '--crate-name', 'windows_terminal_socket_check',
  wrapper, '--extern', `serde_json=${serde}`, '-L', `dependency=${deps}`, '-D', 'warnings', '-o', path.join(target, 'windows-terminal-socket.rmeta')], { stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
console.log('Actual WinHTTP WebSocket adapter/common frontend passed; Darwin std, NOT Windows target/SDK/link/runtime verification');
