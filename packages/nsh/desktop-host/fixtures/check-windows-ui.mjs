// Frontend-only: no DLL linking/execution, no target installation, no fake std or dependency install.
import { spawnSync } from 'node:child_process';
import { access, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
const fixtures = path.dirname(fileURLToPath(import.meta.url));
const source = path.resolve(fixtures, '../src');
const target = path.resolve(fixtures, '../../.nsh/desktop-target');
const deps = path.join(target, 'debug/deps');
const modules = ['policy', 'appearance', 'close', 'vault', 'window_state', 'window_persistence', 'window_sampling', 'window_kernel', 'native_ui_windows'];
const windowState = await readFile(path.join(source, 'window_state.rs'), 'utf8');
const windowLimit = windowState.match(/^pub const MAX_WINDOWS: usize = \d+;$/m)?.[0];
if (!windowLimit) throw Error('Audit the frozen main window admission limit');
const browser = await readFile(path.join(source, 'browser_view.rs'), 'utf8');
// Select only this module's existing Windows branch in an ignored build copy. The Rust target,
// std and all function bodies remain unchanged. Never rewrite the actual browser implementation.
const selected = browser.replace('#[cfg(target_os = "macos")]', '#[cfg(any())]')
  .replace('#[cfg(target_os = "windows")]', '#[cfg(all())]')
  .replace('#[path = "browser_view_macos.rs"]', `#[path = ${JSON.stringify(path.join(source, 'browser_view_macos.rs'))}]`)
  .replace('#[path = "browser_view_windows.rs"]', `#[path = ${JSON.stringify(path.join(source, 'browser_view_windows.rs'))}]`);
if (!selected.includes('#[cfg(all())]') || !selected.includes('#[cfg(any())]')) throw Error('Browser cfg selection changed; audit the harness before continuing');
const core = path.join(target, 'windows-browser-selected.rs');
await writeFile(core, selected);
// Select the frozen tab module's actual Windows implementation as well; this
// remains a Darwin metadata frontend, never a Windows SDK/runtime substitute.
const tabs = (await readFile(path.join(source, 'desktop_tab.rs'), 'utf8'))
  .replaceAll('#[cfg(target_os = "macos")]', '#[cfg(any())]')
  .replaceAll('#[cfg(target_os = "windows")]', '#[cfg(all())]')
  .replace('#[path = "desktop_tab_macos.rs"]', `#[path = ${JSON.stringify(path.join(source, 'desktop_tab_macos.rs'))}]`)
  .replace('#[path = "desktop_tab_windows.rs"]', `#[path = ${JSON.stringify(path.join(source, 'desktop_tab_windows.rs'))}]`)
  .replace('#[path = "desktop_tab_tests.rs"]', `#[path = ${JSON.stringify(path.join(source, 'desktop_tab_tests.rs'))}]`);
const tabCore = path.join(target, 'windows-tab-selected.rs');
await writeFile(tabCore, tabs);
// Exercise the actual geometry adapter, including its real HWND borrow body. This only
// selects cfg in an ignored frontend copy; the SDK type itself remains an audited stand-in.
const geometryWindows = path.join(target, 'windows-geometry-selected.rs');
await writeFile(geometryWindows, (await readFile(path.join(source, 'window_geometry_windows.rs'), 'utf8'))
  .replaceAll('#[cfg(target_os = "windows")]', '#[cfg(all())]'));
const geometryCore = path.join(target, 'windows-geometry-core-selected.rs');
await writeFile(geometryCore, (await readFile(path.join(source, 'window_geometry.rs'), 'utf8'))
  .replace('#[cfg(target_os = "macos")]', '#[cfg(any())]')
  .replace('#[cfg(target_os = "windows")]', '#[cfg(all())]')
  .replace('#[path = "window_geometry_macos.rs"]', `#[path = ${JSON.stringify(path.join(source, 'window_geometry_macos.rs'))}]`)
  .replace('#[path = "window_geometry_windows.rs"]', `#[path = ${JSON.stringify(geometryWindows)}]`));
const template = await readFile(path.join(fixtures, 'windows-ui-typecheck.rs'), 'utf8');
const wrapper = path.join(target, 'windows-ui-typecheck.rs');
await writeFile(wrapper, template.replace('// __ACTUAL_MODULES__', [
  `#[path = ${JSON.stringify(geometryCore)}] mod window_geometry;`,
  ...modules.map(name => `#[path = ${JSON.stringify(path.join(source, `${name}.rs`))}] mod ${name};`),
  `#[path = ${JSON.stringify(core)}] mod browser_view;`,
  `#[path = ${JSON.stringify(tabCore)}] mod desktop_tab;`,
].join('\n')));
const files = await readdir(deps);
const externs = [];
for (const name of ['serde_json', 'nsh_core', 'nsh_engine']) {
  let candidates = files.filter(file => new RegExp(`^lib${name}-[a-f\\d]+\\.rlib$`).test(file));
  if (candidates.length > 1 && process.env.NSH_SOURCE_DIR && name.startsWith('nsh_')) {
    const crate = path.join(path.resolve(process.env.NSH_SOURCE_DIR), 'crates', name.replaceAll('_', '-'));
    const matching = await Promise.all(candidates.map(async file => {
      const provenance = await readFile(path.join(deps, file.replace(/^lib/, '').replace(/\.rlib$/, '.d')), 'utf8');
      return provenance.includes(`${crate}/src/`) ? file : null;
    }));
    candidates = matching.filter(Boolean);
  }
  const override = process.env[`${name.toUpperCase()}_RLIB`];
  if (!override && candidates.length !== 1) throw Error(`Build the host first; select a matching ${name} rlib explicitly if multiple exist`);
  externs.push('--extern', `${name}=${override || path.join(deps, candidates[0])}`);
}
const installed = path.join(os.homedir(), '.cargo/bin/rustc');
const rustc = process.env.RUSTC || await access(installed).then(() => installed, () => 'rustc');
const result = spawnSync(rustc, ['--edition', '2024', '--cfg', 'test', '-D', 'warnings', '--crate-type', 'lib', '--emit', 'metadata', '--crate-name', 'windows_ui_typecheck', wrapper,
  ...externs, '-L', `dependency=${deps}`, '-o', path.join(target, 'windows-ui-typecheck.rmeta')], { stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
console.log('Actual native_ui_windows + browser_view_windows + desktop_tab_windows frontend check passed against audited signature/ABI stand-ins; NOT a Windows-target/SDK/link/runtime check');
