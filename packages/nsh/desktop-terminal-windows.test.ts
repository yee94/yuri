import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
// @ts-expect-error Test fixture is intentionally dependency-free JavaScript.
import { checkTerminalDocument } from './desktop-terminal-document.fixture.mjs';

test.skipIf(process.platform !== 'darwin')('actual Windows renderer source typechecks against public NSH shell; local COM ABI tests (not Windows SDK/runtime)', async () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const source = path.join(root, 'desktop-host/src');
  const temporary = mkdtempSync(path.join(process.env.OPENCODE_TMP_DIR || tmpdir(), 'terminal-windows-'));
  try {
    const manifest = readFileSync(path.join(root, 'desktop-host/Cargo.toml'), 'utf8').replace('name = "yuri-nsh-desktop"', 'name = "yuri-terminal-windows-validation"');
    writeFileSync(path.join(temporary, 'Cargo.toml'), `${manifest}\n[lib]\npath="lib.rs"\n[[bin]]\nname="terminal-document-fixture"\npath="document.rs"\n`);
    writeFileSync(path.join(temporary, 'document.rs'), `fn main(){let value=serde_json::json!({"palette":{"background":"#ffffff","foreground":"#212121","cursor":"#212121","selectionBackground":"#cccccc"},"family":"monospace","size":18,"lineHeight":1.625,"label":"Synthetic","bridge":{"owner":"fixture","generation":1,"expectedHost":{"hostID":"synthetic","lease":"00000000-0000-4000-8000-000000000007"}}});print!("{}",yuri_terminal_windows_validation::document::render(&value).unwrap());}`);
    writeFileSync(path.join(temporary, 'lib.rs'), `#![allow(dead_code)]
extern crate self as nsh_platform_windows;
#[path=${JSON.stringify(path.join(source, 'terminal_desktop_windows_typecheck.rs'))}] mod shell;
pub use shell::{Components,ComponentContext,NativeComponent};
pub mod windows {pub use crate::shell::Win32;}
#[path=${JSON.stringify(path.join(source, 'policy.rs'))}] pub mod policy;
#[path=${JSON.stringify(path.join(source, 'terminal_viewport.rs'))}] pub mod terminal_viewport;
pub use terminal_viewport::{Registration,COMPONENT,document};
type Result<T> = std::result::Result<T,String>;
#[path=${JSON.stringify(path.join(source, 'terminal_desktop_windows.rs'))}] pub mod renderer;
`);
    const args = ['test', '--offline', '--manifest-path', path.join(temporary, 'Cargo.toml'), '--target-dir', path.join(root, '.nsh/desktop-target'), '--lib'];
    const result = spawnSync(process.env.CARGO || path.join(homedir(), '.cargo/bin/cargo'), args, { encoding: 'utf8', timeout: 120_000 });
    expect(result.error, result.stdout + result.stderr).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('callback_iunknown_layout_and_hresult_are_system_abi ... ok');
    expect(result.stdout).toContain('owner_generation_and_exact_lease_all_fence_commands ... ok');
    expect(result.stdout).toContain('fixed_offline_document_is_one_shot_and_never_an_arbitrary_resource_proxy ... ok');
    expect(result.stdout).toContain('late_controller_completion_closes_and_teardown_removes_tokens_before_close ... ok');
    expect(result.stdout).toContain('link_events_are_bounded_data_not_a_navigation_or_host_bridge ... ok');
    const lint = spawnSync(process.env.CARGO || path.join(homedir(), '.cargo/bin/cargo'), ['clippy', '--offline', '--manifest-path', path.join(temporary, 'Cargo.toml'), '--target-dir', path.join(root, '.nsh/desktop-target'), '--lib', '--tests', '--', '-D', 'warnings'], { encoding: 'utf8', timeout: 120_000 });
    expect(lint.status, lint.stdout + lint.stderr).toBe(0);
    const generated = spawnSync(process.env.CARGO || path.join(homedir(), '.cargo/bin/cargo'), ['run', '--offline', '--quiet', '--manifest-path', path.join(temporary, 'Cargo.toml'), '--target-dir', path.join(root, '.nsh/desktop-target'), '--bin', 'terminal-document-fixture'], { encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
    expect(generated.status, generated.stderr).toBe(0);
    expect(Buffer.byteLength(generated.stdout, 'utf16le')).toBeGreaterThan(2 * 1024 * 1024);
    expect(Buffer.byteLength(generated.stdout, 'utf8')).toBeLessThan(8 * 1024 * 1024);
    await checkTerminalDocument(generated.stdout);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}, 150_000);
