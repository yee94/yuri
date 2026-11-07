#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { access, cp, mkdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('node packages/nsh/scripts/build-history-uikit.mjs [--bundle-only]\nNSH_BIN: NSH executable; NSH_DIST: distribution root (optional). Simulator arm64 only. Never installs or launches.');
  process.exit(0);
}
if (args.some(arg => arg !== '--bundle-only')) throw new Error('Only --bundle-only is supported');
const output = path.join(root, '.nsh/history-uikit');
const project = path.join(output, 'project');
const bundle = path.join(output, 'bundle');
function run(command, argv, capture = false) {
  const result = spawnSync(command, argv, { cwd: project, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} failed (${result.status})${capture ? `: ${result.stderr}` : ''}`);
  return result.stdout?.trim();
}
async function executable(value) {
  const candidates = value.includes('/') ? [path.resolve(value)] : (process.env.PATH ?? '').split(path.delimiter).map(dir => path.join(dir, value));
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); return await realpath(candidate); } catch { /* Try the next executable. */ }
  }
  throw new Error('Cannot find NSH; set NSH_BIN');
}
const nsh = await executable(process.env.NSH_BIN || 'nsh');
await mkdir(project, { recursive: true });
// An isolated project prevents discovery of the production capabilities/config.
await writeFile(path.join(project, 'nsh.json'), JSON.stringify({ name: 'History UIKit Fixture', id: 'com.yee94.yuri.nsh.history-fixture', version: '0.1.0', build: 1, appearance: 'system', capabilities: {} }));
await writeFile(path.join(project, 'App.tsx'), `import ${JSON.stringify(path.relative(project, path.join(root, 'history-uikit-fixture.tsx')))};\n`);
run(nsh, ['build', path.join(project, 'App.tsx'), '--release', '--out', bundle]);
await access(path.join(bundle, 'bundle.nshc'));
if (args.includes('--bundle-only')) {
  console.log(`Built fixture bundle: ${bundle}`);
  process.exit(0);
}
const dist = process.env.NSH_DIST ? path.resolve(process.env.NSH_DIST) : path.resolve(path.dirname(nsh), '..');
const framework = path.join(dist, 'embed/ios/NativeShell.xcframework/ios-arm64-simulator');
await access(path.join(framework, 'NativeShell.framework/NativeShell'));
const sdk = run('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path'], true);
const version = run('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-version'], true);
if (Number(version.split('.')[0]) < 26) throw new Error('iOS 26+ SDK required');
const staging = path.join(output, 'HistoryUIKitFixture.staging.app');
const app = path.join(output, 'HistoryUIKitFixture.app');
await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
await cp(bundle, path.join(staging, 'nsh'), { recursive: true });
const frameworks = ['UIKit', 'Foundation', 'Security', 'AVFoundation', 'Speech', 'CoreMedia', 'CoreVideo', 'CoreGraphics', 'CoreText', 'QuartzCore', 'ImageIO', 'Photos', 'PhotosUI', 'UniformTypeIdentifiers', 'WebKit', 'SafariServices', 'Network', 'SystemConfiguration', 'AudioToolbox'];
run('xcrun', ['--sdk', 'iphonesimulator', 'swiftc', '-swift-version', '5', '-O', '-sdk', sdk, '-target', 'arm64-apple-ios15.0-simulator', '-F', framework, '-framework', 'NativeShell', ...frameworks.flatMap(name => ['-framework', name]), '-lc++', '-lz', '-lsqlite3', '-Xlinker', '-ObjC', path.join(root, 'tests/history-uikit/main.swift'), '-o', path.join(staging, 'HistoryUIKitFixture')]);
await writeFile(path.join(staging, 'Info.plist'), JSON.stringify({
  CFBundleDevelopmentRegion: 'en', CFBundleDisplayName: 'History Fixture', CFBundleExecutable: 'HistoryUIKitFixture',
  CFBundleIdentifier: 'com.yee94.yuri.nsh.history-fixture', CFBundleInfoDictionaryVersion: '6.0', CFBundleName: 'HistoryUIKitFixture',
  CFBundlePackageType: 'APPL', CFBundleShortVersionString: '0.1.0', CFBundleVersion: '1',
  CFBundleSupportedPlatforms: ['iPhoneSimulator'], MinimumOSVersion: '15.0', LSRequiresIPhoneOS: true, UIDeviceFamily: [1, 2],
  UILaunchScreen: {},
  UISupportedInterfaceOrientations: ['UIInterfaceOrientationPortrait', 'UIInterfaceOrientationLandscapeLeft', 'UIInterfaceOrientationLandscapeRight'],
}));
run('plutil', ['-convert', 'xml1', path.join(staging, 'Info.plist')]);
run('codesign', ['--force', '--sign', '-', '--timestamp=none', staging]);
// Replace only our last successful fixture; never touch production output/signing.
await rm(app, { recursive: true, force: true });
await rename(staging, app);
console.log(`Built arm64 simulator fixture (not installed/launched): ${app}`);
