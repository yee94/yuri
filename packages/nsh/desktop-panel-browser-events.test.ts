import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it.skipIf(process.platform !== 'darwin')('real NativeDesktopPanel native-component events reach production onBrowser and metadata through public EngineControl (synthetic only)', () => {
  const root = path.dirname(fileURLToPath(import.meta.url)), parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true }); const directory = mkdtempSync(path.join(parent, 'panel-browser-events-'));
  try {
    writeFileSync(path.join(directory, 'nsh.json'), JSON.stringify({ name: 'Panel browser native receipts', id: 'example.yuri.panel-browser.events', version: '0.1.0', build: 1, theme: path.join(root, 'theme.json') }));
    writeFileSync(path.join(directory, 'App.tsx'), `import ${JSON.stringify(path.join(root, 'desktop-panel-browser.fixture.tsx'))};\n`);
    const build = spawnSync(process.env.NSH_BIN || 'nsh', ['build', 'App.tsx', '--out', path.join(directory, 'bundle')], { cwd: directory, encoding: 'utf8', timeout: 60_000 });
    expect(build.status, build.stdout + build.stderr).toBe(0);
    // Resolve only the already-installed production crate graph, offline. This
    // temporary empty carrier never compiles/runs the desktop Host or adds deps.
    const manifest = readFileSync(path.join(root, 'desktop-host/Cargo.toml'), 'utf8').replace('name = "yuri-nsh-desktop"', 'name = "yuri-panel-browser-event-validation"');
    writeFileSync(path.join(directory, 'Cargo.toml'), `${manifest}\n[lib]\npath="lib.rs"\n`);
    writeFileSync(path.join(directory, 'lib.rs'), '// Existing dependency graph carrier only.\n');
    const dependencies = spawnSync(process.env.CARGO || path.join(homedir(), '.cargo/bin/cargo'), ['test', '--offline', '--no-run', '--message-format=json', '--manifest-path', path.join(directory, 'Cargo.toml'), '--target-dir', path.join(root, '.nsh/desktop-target'), '--lib'], { encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
    expect(dependencies.status, dependencies.stdout + dependencies.stderr).toBe(0);
    const artifacts = dependencies.stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
    const externs = ['nsh_core', 'nsh_engine', 'nsh_base', 'serde_json'].flatMap(name => {
      const artifact = artifacts.find(value => value.reason === 'compiler-artifact' && value.target.name === name && value.filenames.some((file: string) => file.endsWith('.rlib')));
      expect(artifact, `Missing existing ${name} artifact`).toBeDefined();
      return ['--extern', `${name}=${artifact.filenames.find((file: string) => file.endsWith('.rlib'))}`];
    });
    const binary = path.join(directory, 'browser-event-tests');
    const compile = spawnSync(process.env.RUSTC || path.join(homedir(), '.cargo/bin/rustc'), ['--edition=2024', '--crate-name=panel_browser_events_fixture', '--test', path.join(root, 'desktop-panel-browser-events.fixture.rs'), '-L', `dependency=${path.join(root, '.nsh/desktop-target/debug/deps')}`, ...externs, '-o', binary], { encoding: 'utf8', timeout: 120_000 });
    expect(compile.status, compile.stdout + compile.stderr).toBe(0);
    const result = spawnSync(binary, [], { encoding: 'utf8', timeout: 120_000, env: { ...process.env, NSH_PANEL_BROWSER_BUNDLE: path.join(directory, 'bundle/bundle.js') } });
    expect(result.error, result.stdout + result.stderr).toBeUndefined(); expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('4 passed; 0 failed');
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 200_000);
