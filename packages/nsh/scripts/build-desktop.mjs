#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { access, cp, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeNotificationInstaller } from './native-notification-installer.mjs';
import { cargoExecutable, ensureNSHCompatibilityTools, ensureNSHDirectory, hashNSHTree, prepareNSHCompatibility, publishNSHDirectory, runOfflineCargo, sharedCargoTarget, sha256 } from './nsh-compat.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspace = path.resolve(root, '../..');
const args = new Set(process.argv.slice(2));
if (args.has('--help')) {
  console.log(`node packages/nsh/scripts/build-desktop.mjs [--debug] [--check-host | --test-host] [--skip-bundle]
Native NSH 0.4.0 AppKit / Win32 runner. Run on the target OS; no Electron or primary WebView.
NSH_SOURCE_DIR: required audited NSH 0.4.0 checkout; CARGO: cargo executable (offline/locked only)
CLI, physical devhost and Yuri Host consume the same project compatibility patch digest.
NSH_SIGN_IDENTITY: optional macOS development signing identity (default ad-hoc; no notarization)
NSH_ALLOW_HTTP_LOOPBACK=1: explicit runner-only HTTP loopback development exception`);
  process.exit(0);
}
for (const arg of args) if (!['--debug', '--check-host', '--test-host', '--skip-bundle'].includes(arg)) throw new Error(`Unknown option: ${arg}`);
if (!['darwin', 'win32'].includes(process.platform)) throw new Error('Build natively on macOS or Windows');
if (args.has('--check-host') && args.has('--test-host')) throw new Error('Choose --check-host or --test-host');
const out = path.join(root, '.nsh/desktop');
const prepared = await prepareNSHCompatibility();
const tools = await ensureNSHCompatibilityTools(prepared);
await ensureNSHDirectory(out);
const cargo = cargoExecutable();
const target = sharedCargoTarget(path.join(root, '.nsh'), 'yuri-host');
await ensureNSHDirectory(target);
function run(command, argv, capture = false) {
  const result = spawnSync(command, argv, { cwd: workspace, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit', env: tools.env, windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} failed (${result.status})${capture ? `: ${result.stderr}` : ''}`);
  return result.stdout?.trim() || '';
}
const lock = path.join(out, '.build.lock');
try { await mkdir(lock); }
catch (error) { if (error.code === 'EEXIST') throw new Error('nsh_desktop_build_busy'); throw error; }
let work, staging;
try {
work = await mkdtemp(path.join(out, '.work-'));
// Machine-specific paths live only in ignored .nsh, never the repository Cargo manifest.
const config = path.join(work, 'cargo-source-patch.toml');
await writeFile(config, `[patch.crates-io]\n${prepared.cargoPatches}\n`);
const host = path.join(root, 'desktop-host');
const sourceManifest = await readFile(path.join(host, 'Cargo.toml'), 'utf8');
const literal = file => JSON.stringify(file.replaceAll('\\', '/'));
const examples = (await readdir(path.join(host, 'examples'))).filter(name => name.endsWith('.rs'));
const isolatedManifest = `${sourceManifest}\n[[bin]]\nname = "yuri-nsh-desktop"\npath = ${literal(path.join(host, 'src/main.rs'))}\n${examples.map(name => `\n[[example]]\nname = ${JSON.stringify(name.slice(0, -3))}\npath = ${literal(path.join(host, 'examples', name))}\n`).join('')}`;
await writeFile(path.join(work, 'Cargo.toml'), isolatedManifest);
await copyFile(path.join(host, 'Cargo.lock'), path.join(work, 'Cargo.lock'));
const lockSha256 = sha256(await readFile(path.join(work, 'Cargo.lock')));
const verb = args.has('--check-host') ? 'check' : args.has('--test-host') ? 'test' : 'build';
const cargoArgs = ['--config', config, verb, '--offline', '--locked', '--manifest-path', path.join(work, 'Cargo.toml'), '--target-dir', target];
if (verb === 'build' && !args.has('--debug')) cargoArgs.push('--release');
runOfflineCargo(cargo, cargoArgs, work);
if (sha256(await readFile(path.join(work, 'Cargo.lock'))) !== lockSha256) throw new Error('nsh_desktop_lock_changed');
if ((await hashNSHTree(prepared.sourceDir, prepared.sourceRoots)).sha256 !== prepared.receipt.finalTreeSha256) throw new Error('nsh_desktop_compatibility_source_changed');
if (verb !== 'build') { console.log(`NSH compatibility ${prepared.digest}: ${verb} passed`); }
else {

const nsh = tools.bin;
const bundle = path.join(out, 'bundles', prepared.digest);
if (!args.has('--skip-bundle')) {
  const version = run(nsh, ['--version'], true);
  if (!/^nsh\s+0\.4\.0(?:\s|$)/.test(version)) throw new Error(`Exact NSH 0.4.0 CLI required; found ${version}`);
  const nextBundle = path.join(work, 'bundle');
  run(nsh, ['build', path.join(root, 'App.tsx'), '--release', '--out', nextBundle]);
  for (const file of ['bundle.js', 'capabilities.json', 'app.json']) await access(path.join(nextBundle, file));
  const tree = await hashNSHTree(nextBundle, await readdir(nextBundle));
  await writeFile(path.join(nextBundle, 'compatibility.json'), `${JSON.stringify({ digest: prepared.digest, files: tree.files, sha256: tree.sha256 }, null, 2)}\n`);
  await mkdir(path.dirname(bundle), { recursive: true });
  await publishNSHDirectory(nextBundle, bundle);
}
for (const file of ['bundle.js', 'capabilities.json', 'app.json']) await access(path.join(bundle, file));
const stamp = JSON.parse(await readFile(path.join(bundle, 'compatibility.json'), 'utf8'));
const bundleTree = await hashNSHTree(bundle, (await readdir(bundle)).filter(name => name !== 'compatibility.json'));
if (stamp.digest !== prepared.digest || stamp.sha256 !== bundleTree.sha256 || JSON.stringify(stamp.files) !== JSON.stringify(bundleTree.files)) throw new Error('nsh_desktop_bundle_digest_mismatch');
const appConfig = JSON.parse(await readFile(path.join(root, 'nsh.json'), 'utf8'));
const windows = process.platform === 'win32';
const destination = path.join(out, windows ? 'YuriNative-windows' : 'YuriNative.app');
staging = await mkdtemp(path.join(out, windows ? '.YuriNative-windows-' : '.YuriNative-'));
// Only script-owned staging/output paths are replaced; a failed build preserves the old app.
const binaries = windows ? staging : path.join(staging, 'Contents/MacOS');
const resources = windows ? staging : path.join(staging, 'Contents/Resources');
await mkdir(binaries, { recursive: true });
await mkdir(resources, { recursive: true });
await cp(bundle, path.join(resources, 'nsh'), { recursive: true });
// Preserve the full product asset tree as well as nsh-build's content-addressed assets.
await cp(path.join(root, 'assets'), path.join(resources, 'nsh/assets'), { recursive: true });
const executable = windows ? 'yuri-nsh-desktop.exe' : 'yuri-nsh-desktop';
await cp(path.join(target, args.has('--debug') ? 'debug' : 'release', executable), path.join(binaries, executable));
await writeFile(path.join(resources, 'nsh-compatibility.json'), `${JSON.stringify({ digest: prepared.digest, hostLockSha256: lockSha256,
  hostSha256: sha256(await readFile(path.join(binaries, executable))), cliSha256: sha256(await readFile(tools.bin)),
  runtimeReceipt: JSON.parse(await readFile(path.join(path.dirname(tools.bin), '../receipt.json'), 'utf8')), bundleSha256: bundleTree.sha256 }, null, 2)}\n`);
if (windows) await writeNotificationInstaller(staging, appConfig.id);
if (!windows) {
  const plist = { CFBundleDevelopmentRegion: 'en', CFBundleDisplayName: appConfig.name, CFBundleExecutable: executable,
    CFBundleIdentifier: appConfig.id, CFBundleInfoDictionaryVersion: '6.0', CFBundleName: 'YuriNative',
    CFBundlePackageType: 'APPL', CFBundleShortVersionString: appConfig.version, CFBundleVersion: String(appConfig.build),
    LSMinimumSystemVersion: '13.0', NSHighResolutionCapable: true };
  const info = path.join(staging, 'Contents/Info.plist');
  await writeFile(info, JSON.stringify(plist));
  run('plutil', ['-convert', 'xml1', info]);
  run('codesign', ['--force', '--sign', process.env.NSH_SIGN_IDENTITY || '-', '--timestamp=none', staging]);
}
await publishNSHDirectory(staging, destination); staging = undefined;
console.log(`Built native NSH desktop: ${destination}`);
console.log(`NSH compatibility: ${prepared.digest}\nNSH_BIN=${tools.bin}\nNSH_RUNTIME=${tools.runtime}`);
}
} finally {
  if (staging) await rm(staging, { recursive: true, force: true });
  if (work) await rm(work, { recursive: true, force: true });
  await rm(lock, { recursive: true });
}
