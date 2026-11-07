#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, cp, mkdir, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('node packages/nsh/scripts/build-remote-desktop-uikit.mjs [--bundle-only] [--image-probe]\nNSH_BIN: NSH executable; NSH_DIST: distribution root (optional). Simulator arm64 only. Unique output per build; never installs, launches or modifies other artifacts.');
  process.exit(0);
}
if (args.some(arg => !['--bundle-only', '--image-probe'].includes(arg))) throw new Error('Only --bundle-only and --image-probe are supported');
const probe = args.includes('--image-probe');
const bundleID = probe ? 'example.yuri.remote-desktop-image-probe' : 'example.yuri.remote-desktop-uikit';
const entry = probe ? 'image-probe.tsx' : 'fixture.tsx';
const buildID = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
const parent = path.join(root, '.nsh/remote-desktop-uikit');
await mkdir(parent, { recursive: true });
const output = path.join(parent, buildID);
await mkdir(output); // Never reuse or remove an existing artifact, including our own.
const project = path.join(output, 'project');
const bundle = path.join(output, 'bundle');
await mkdir(project);
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
const hostCalls = probe ? [] : ['runtime.request', 'remoteDesktop.open', 'remoteDesktop.close', 'remoteDesktop.input', 'remoteDesktop.view', 'remoteDesktop.ack'];
await writeFile(path.join(project, 'nsh.json'), JSON.stringify({
  name: probe ? 'Remote Image UIKit Probe' : 'Remote Desktop UIKit Fixture', id: bundleID, version: '0.1.0', build: 1,
  appearance: 'system', theme: path.relative(project, path.join(root, 'theme.json')),
  capabilities: hostCalls.length ? { host: hostCalls } : {},
}));
await writeFile(path.join(project, 'App.tsx'), `import ${JSON.stringify(path.relative(project, path.join(root, 'tests/remote-desktop', entry)))};\n`);
run(nsh, ['build', path.join(project, 'App.tsx'), '--release', '--out', bundle]);
await access(path.join(bundle, 'bundle.nshc'));
if (args.includes('--bundle-only')) {
  console.log(JSON.stringify({ bundleID, mode: probe ? 'image-probe' : 'remote-desktop', bundle: path.relative(root, bundle), installed: false, launched: false }));
  process.exit(0);
}
const dist = process.env.NSH_DIST ? path.resolve(process.env.NSH_DIST) : path.resolve(path.dirname(nsh), '..');
const framework = path.join(dist, 'embed/ios/NativeShell.xcframework/ios-arm64-simulator');
await access(path.join(framework, 'NativeShell.framework/NativeShell'));
const sdk = run('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path'], true);
const version = run('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-version'], true);
if (Number(version.split('.')[0]) < 26) throw new Error('iOS 26+ SDK required');
const name = probe ? 'RemoteImageUIKitProbe' : 'RemoteDesktopUIKitFixture';
const staging = path.join(output, `${name}.staging.app`);
const app = path.join(output, `${name}.app`);
await mkdir(staging);
await cp(bundle, path.join(staging, 'nsh'), { recursive: true });
// These are NativeShell's link dependencies, not feature network/credential APIs.
const frameworks = ['UIKit', 'Foundation', 'Security', 'AVFoundation', 'Speech', 'CoreMedia', 'CoreVideo', 'CoreGraphics', 'CoreText', 'QuartzCore', 'ImageIO', 'Photos', 'PhotosUI', 'UniformTypeIdentifiers', 'WebKit', 'SafariServices', 'Network', 'SystemConfiguration', 'AudioToolbox'];
run('xcrun', ['--sdk', 'iphonesimulator', 'swiftc', '-swift-version', '5', '-O', '-sdk', sdk, '-target', 'arm64-apple-ios15.0-simulator', '-F', framework,
  '-framework', 'NativeShell', ...frameworks.flatMap(value => ['-framework', value]), '-lc++', '-lz', '-lsqlite3', '-Xlinker', '-ObjC',
  path.join(root, 'tests/remote-desktop/uikit-main.swift'), '-o', path.join(staging, name)]);
await writeFile(path.join(staging, 'Info.plist'), JSON.stringify({
  CFBundleDevelopmentRegion: 'en', CFBundleDisplayName: probe ? 'Image Decode QA' : 'Remote Desktop QA', CFBundleExecutable: name,
  CFBundleIdentifier: bundleID, CFBundleInfoDictionaryVersion: '6.0', CFBundleName: name,
  CFBundlePackageType: 'APPL', CFBundleShortVersionString: '0.1.0', CFBundleVersion: '1',
  CFBundleSupportedPlatforms: ['iPhoneSimulator'], MinimumOSVersion: '15.0', LSRequiresIPhoneOS: true, UIDeviceFamily: [1, 2],
  UILaunchScreen: {}, UISupportedInterfaceOrientations: ['UIInterfaceOrientationPortrait', 'UIInterfaceOrientationLandscapeLeft', 'UIInterfaceOrientationLandscapeRight'],
}));
run('plutil', ['-convert', 'xml1', path.join(staging, 'Info.plist')]);
run('codesign', ['--force', '--sign', '-', '--timestamp=none', staging]);
await rename(staging, app);
const manifest = {
  bundleID, mode: probe ? 'image-probe' : 'remote-desktop', entry: `tests/remote-desktop/${entry}`,
  swiftSources: ['tests/remote-desktop/uikit-main.swift'], capabilities: hostCalls,
  app: path.relative(root, app), installed: false, launched: false,
};
await writeFile(path.join(output, 'fixture-build.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest, null, 2));
