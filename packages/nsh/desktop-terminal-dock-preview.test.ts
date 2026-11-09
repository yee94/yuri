import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

test.skipIf(process.platform !== 'darwin')('actual NSH Dock preview button -> production callback factory -> native browser intent; no window or network', () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const temporary = mkdtempSync(path.join(process.env.OPENCODE_TMP_DIR || tmpdir(), 'terminal-dock-intent-'));
  try {
    const manifest = readFileSync(path.join(root, 'desktop-host/Cargo.toml'), 'utf8').replace('name = "yuri-nsh-desktop"', 'name = "yuri-terminal-dock-intent-validation"');
    writeFileSync(path.join(temporary, 'Cargo.toml'), `${manifest}\n[lib]\npath="lib.rs"\n`);
    writeFileSync(path.join(temporary, 'lib.rs'), '// Dependency carrier only; no application or native window.\n');
    writeFileSync(path.join(temporary, 'nsh.json'), JSON.stringify({ name: 'Synthetic terminal Dock intent', id: 'example.terminal.dockintent', version: '0.1.0', build: 1, theme: path.join(root, 'theme.json'), capabilities: { host: true, openUrl: { schemes: ['https', 'http'] } } }));
    writeFileSync(path.join(temporary, 'App.tsx'), `import ${JSON.stringify(path.join(root, 'desktop-terminal-dock-preview.fixture.tsx'))};`);
    const build = spawnSync(process.env.NSH_BIN || 'nsh', ['build', 'App.tsx', '--out', path.join(temporary, 'bundle')], { cwd: temporary, encoding: 'utf8', timeout: 60_000 });
    expect(build.status, build.stdout + build.stderr).toBe(0);
    // Reuse the production graph's exact prebuilt artifacts, including its
    // existing transitive nsh-base. No new crate, dependency or toolchain.
    const dependencies = spawnSync(process.env.CARGO || path.join(homedir(), '.cargo/bin/cargo'), ['test', '--offline', '--no-run', '--message-format=json', '--manifest-path', path.join(temporary, 'Cargo.toml'), '--target-dir', path.join(root, '.nsh/desktop-target'), '--lib'], { encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
    expect(dependencies.status, dependencies.stdout + dependencies.stderr).toBe(0);
    const artifacts = dependencies.stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
    const externs = ['nsh_core', 'nsh_engine', 'nsh_base', 'serde_json'].flatMap(name => {
      const artifact = artifacts.find(value => value.reason === 'compiler-artifact' && value.target.name === name && value.filenames.some((file: string) => file.endsWith('.rlib')));
      expect(artifact, `Missing existing ${name} artifact`).toBeDefined();
      return ['--extern', `${name}=${artifact.filenames.find((file: string) => file.endsWith('.rlib'))}`];
    });
    const binary = path.join(temporary, 'dock-intent-test');
    const compile = spawnSync(process.env.RUSTC || path.join(homedir(), '.cargo/bin/rustc'), ['--edition=2024', '--test', path.join(root, 'desktop-host/src/terminal_desktop_intent_fixture.rs'), '-L', `dependency=${path.join(root, '.nsh/desktop-target/debug/deps')}`, ...externs, '-o', binary], { encoding: 'utf8', timeout: 120_000 });
    expect(compile.status, compile.stdout + compile.stderr).toBe(0);
    const result = spawnSync(binary, [], { encoding: 'utf8', timeout: 120_000, env: { ...process.env, NSH_TERMINAL_DOCK_INTENT_BUNDLE: path.join(temporary, 'bundle/bundle.js') } });
    expect(result.error, result.stdout + result.stderr).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('actual_dock_preview_button_and_native_links_reach_production_browser_intents_headless ... ok');
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}, 190_000);
