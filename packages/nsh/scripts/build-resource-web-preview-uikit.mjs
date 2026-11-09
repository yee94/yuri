#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('node packages/nsh/scripts/build-resource-web-preview-uikit.mjs [--svg]\nSimulator arm64 only. NSH_DIST or NSH_BIN locates NativeShell for linking; no NSH engine, bundle build, install, launch, Host, Keychain or network operation. Unique output per build. --svg prepares the separate WK SVG image/lease fixture.');
  process.exit(0);
}
if (args.some(arg => arg !== '--svg') || args.length > 1) throw new Error('Unsupported build option; see --help');
const svg = args.includes('--svg');
async function distribution() {
  if (process.env.NSH_DIST) return path.resolve(process.env.NSH_DIST);
  const value = process.env.NSH_BIN || 'nsh';
  const candidates = value.includes('/') ? [path.resolve(value)] : (process.env.PATH ?? '').split(path.delimiter).map(dir => path.join(dir, value));
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); return path.resolve(path.dirname(await realpath(candidate)), '..'); } catch { /* Try the next executable. */ }
  }
  throw new Error('Cannot find NativeShell distribution; set NSH_DIST or NSH_BIN');
}
function run(command, argv, capture = false) {
  const result = spawnSync(command, argv, { cwd: root, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} failed (${result.status})${capture ? `: ${result.stderr}` : ''}`);
  return result.stdout?.trim();
}
const framework = path.join(await distribution(), 'embed/ios/NativeShell.xcframework/ios-arm64-simulator');
await access(path.join(framework, 'NativeShell.framework/NativeShell'));
const sdk = run('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path'], true);
if (Number(run('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-version'], true).split('.')[0]) < 26) throw new Error('iOS 26+ SDK required');
const parent = path.join(root, svg ? '.nsh/resource-svg-image-uikit' : '.nsh/resource-web-preview-uikit');
await mkdir(parent, { recursive: true });
const output = path.join(parent, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
await mkdir(output);
const name = svg ? 'ResourceSVGImageUIKitFixture' : 'ResourceWebPreviewUIKitFixture';
const bundleID = svg ? 'example.yuri.resource-svg-image-uikit' : 'example.yuri.resource-web-preview-uikit';
const staging = path.join(output, `${name}.staging.app`);
const app = path.join(output, `${name}.app`);
await mkdir(staging);
const sources = svg ? ['ios/RuntimeHostScope.swift', 'ios/ResourceBridge.swift', 'ios/ResourceWebPreviewBridge.swift', 'ios/ResourceWebPreviewView.swift', 'tests/resource-svg-image/probe-request.swift', 'tests/resource-svg-image/uikit-main.swift']
  : ['ios/RuntimeHostScope.swift', 'ios/ResourceWebPreviewBridge.swift', 'ios/ResourceWebPreviewView.swift', 'tests/resource-web-preview/uikit-main.swift'];
const frameworks = ['UIKit', 'Foundation', 'Security', 'AVFoundation', 'Speech', 'CoreMedia', 'CoreVideo', 'CoreGraphics', 'CoreText', 'QuartzCore', 'ImageIO', 'Photos', 'PhotosUI', 'UniformTypeIdentifiers', 'WebKit', 'SafariServices', 'Network', 'SystemConfiguration', 'AudioToolbox'];
if (svg) frameworks.push('AVKit', 'QuickLook');
run('xcrun', ['--sdk', 'iphonesimulator', 'swiftc', '-swift-version', '5', '-O', '-sdk', sdk, '-target', 'arm64-apple-ios15.0-simulator', '-F', framework,
  '-framework', 'NativeShell', ...frameworks.flatMap(value => ['-framework', value]), '-lc++', '-lz', '-lsqlite3', '-Xlinker', '-ObjC',
  ...sources.map(value => path.join(root, value)), '-o', path.join(staging, name)]);
await writeFile(path.join(staging, 'Info.plist'), JSON.stringify({
  CFBundleDevelopmentRegion: 'zh_CN', CFBundleDisplayName: '资源预览 QA', CFBundleExecutable: name,
  CFBundleIdentifier: bundleID, CFBundleInfoDictionaryVersion: '6.0', CFBundleName: name,
  CFBundlePackageType: 'APPL', CFBundleShortVersionString: '0.1.0', CFBundleVersion: '1',
  CFBundleSupportedPlatforms: ['iPhoneSimulator'], MinimumOSVersion: '15.0', LSRequiresIPhoneOS: true, UIDeviceFamily: [1, 2],
  UILaunchScreen: {}, UISupportedInterfaceOrientations: ['UIInterfaceOrientationPortrait', 'UIInterfaceOrientationLandscapeLeft', 'UIInterfaceOrientationLandscapeRight'],
  ...(svg ? { NSAppTransportSecurity: { NSAllowsLocalNetworking: true } } : {}),
}));
run('plutil', ['-convert', 'xml1', path.join(staging, 'Info.plist')]);
run('codesign', ['--force', '--sign', '-', '--timestamp=none', staging]);
await rename(staging, app);
const manifest = { bundleID, swiftSources: sources, app: path.relative(root, app), syntheticOnly: true,
  nshEngineStarted: false, installed: false, launched: false, hostAccess: false, keychainAccess: false };
await writeFile(path.join(output, 'fixture-build.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest, null, 2));
