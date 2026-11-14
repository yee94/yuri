#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { access, cp, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageTerminalOfflineResources } from '../terminal-offline.mjs';
import { stageNativeApplication, validateNativeApplicationBundle } from './stage-native-application.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = path.resolve(packageRoot, '../..');
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('node packages/nsh/scripts/build-ios.mjs [--device]\nNSH_BIN: executable (default: PATH nsh)\nNSH_DIST: NSH distribution root containing embed/ios\nNSH_SIGN_IDENTITY + NSH_PROVISIONING_PROFILE: optional device development signing');
  process.exit(0);
}
if (args.some(arg => arg !== '--device')) throw new Error('Only --device is supported; see --help');
const device = args.includes('--device');
function run(command, args, capture = false, cwd = workspaceRoot) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} failed (${result.status})${capture ? `: ${result.stderr}` : ''}`);
  return result.stdout?.trim();
}
async function executable(value) {
  const candidates = value.includes('/') ? [path.resolve(value)] : (process.env.PATH ?? '').split(path.delimiter).map(dir => path.join(dir, value));
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); return await realpath(candidate); } catch { /* Try the next PATH entry. */ }
  }
  throw new Error(`Cannot find executable ${value}; set NSH_BIN`);
}
const nsh = await executable(process.env.NSH_BIN || 'nsh');
const dist = process.env.NSH_DIST ? path.resolve(process.env.NSH_DIST) : path.resolve(path.dirname(nsh), '..');
const sdkName = device ? 'iphoneos' : 'iphonesimulator';
const sdk = run('xcrun', ['--sdk', sdkName, '--show-sdk-path'], true);
const sdkVersion = run('xcrun', ['--sdk', sdkName, '--show-sdk-version'], true);
if (Number(sdkVersion.split('.')[0]) < 26) throw new Error(`iOS 26+ SDK required; found ${sdkVersion}`);
const frameworkDir = path.join(dist, 'embed/ios/NativeShell.xcframework', device ? 'ios-arm64' : 'ios-arm64-simulator');
await access(path.join(frameworkDir, 'NativeShell.framework/NativeShell'));
const output = path.join(packageRoot, '.nsh/out');
const app = path.join(output, 'YuriNative.app');
const staging = path.join(output, `YuriNative-${device ? 'device' : 'simulator'}.staging.app`);
const bundle = path.join(packageRoot, '.nsh/bundle');
await mkdir(output, { recursive: true });
// Remove only this script's staging app. A failed build preserves the last successful app.
await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
const localBrand = path.join(packageRoot, 'assets/brand');
await mkdir(localBrand, { recursive: true });
for (const name of ['yuri-b-mark-black.svg', 'yuri-b-mark-white.svg', 'yuri-wordmark-black.svg', 'yuri-wordmark-white.svg']) {
  await cp(path.join(workspaceRoot, 'assets/brand/yuri', name), path.join(localBrand, name));
}
const sourceStage = await stageNativeApplication({ root: path.join(output, `native-source-${randomUUID()}`), workspaceRoot });
try {
  run(nsh, ['build', sourceStage.entry, '--release', '--out', bundle], false, sourceStage.cwd);
  const assetEvidence = await validateNativeApplicationBundle(bundle, sourceStage.manifest);
  await writeFile(path.join(output, 'native-application-evidence.json'), JSON.stringify({
    ...sourceStage.manifest,
    bundleSHA256: createHash('sha256').update(await readFile(path.join(bundle, 'bundle.nshc'))).digest('hex'),
    assetEvidence,
  }, null, 2) + '\n');
} finally {
  await rm(sourceStage.root, { recursive: true, force: true });
}
await cp(bundle, path.join(staging, 'nsh'), { recursive: true });
await stageTerminalOfflineResources(staging, workspaceRoot);
run(process.execPath, [path.join(packageRoot, 'scripts/build-gui-plugin-preview.mjs'), '--out', path.join(staging, 'gui-plugin-preview')]);
const fontRoot = path.join(packageRoot, 'assets/fonts/jetbrains-mono');
const fontManifest = JSON.parse(await readFile(path.join(fontRoot, 'manifest.json'), 'utf8'));
const fontOutput = path.join(staging, 'fonts/jetbrains-mono');
const fontNames = [];
await mkdir(fontOutput, { recursive: true });
for (const [name, checksum] of Object.entries(fontManifest.sha256)) {
  if (!/^(JetBrainsMono-[A-Za-z]+\.ttf|OFL\.txt)$/.test(name)) throw new Error('Invalid bundled font asset name');
  const bytes = await readFile(path.join(fontRoot, name));
  if (createHash('sha256').update(bytes).digest('hex') !== checksum) throw new Error(`Bundled font checksum mismatch: ${name}`);
  await cp(path.join(fontRoot, name), path.join(fontOutput, name));
  if (name.endsWith('.ttf')) fontNames.push(`fonts/jetbrains-mono/${name}`);
}
await cp(path.join(fontRoot, 'manifest.json'), path.join(fontOutput, 'manifest.json'));
const brandCatalog = path.join(packageRoot, '.nsh/branding/YuriBrand.xcassets');
run('xcrun', ['swift', path.join(packageRoot, 'scripts/generate-branding.swift'), workspaceRoot, brandCatalog]);
const iconInfo = path.join(output, 'assetcatalog-info.plist');
run('xcrun', ['actool', brandCatalog, '--compile', staging, '--platform', sdkName, '--minimum-deployment-target', '15.0', '--target-device', 'iphone', '--target-device', 'ipad', '--app-icon', 'AppIcon', '--output-partial-info-plist', iconInfo, '--output-format', 'human-readable-text', '--warnings', '--notices']);
run('xcrun', ['ibtool', '--compile', path.join(staging, 'LaunchScreen.storyboardc'), path.join(packageRoot, 'ios/LaunchScreen.storyboard'), '--minimum-deployment-target', '15.0', '--target-device', 'iphone', '--target-device', 'ipad', '--module', 'YuriNative', '--errors', '--warnings', '--notices']);
const sources = (await readdir(path.join(packageRoot, 'ios'))).filter(name => name.endsWith('.swift')).sort().map(name => path.join(packageRoot, 'ios', name));
sources.push(path.join(workspaceRoot, 'packages/mobile/ios/App/App/YuriViewExportRenderer.swift'));
const simulatorEntitlements = path.join(output, 'simulator-entitlements.plist');
if (!device) {
  await writeFile(simulatorEntitlements, JSON.stringify({ 'application-identifier': 'com.yee94.yuri.nsh', 'keychain-access-groups': ['com.yee94.yuri.nsh'], 'get-task-allow': true }));
  run('plutil', ['-convert', 'xml1', simulatorEntitlements]);
}
// Simulator securityd reads simulated entitlements from Mach-O, as Xcode's linker does.
// Putting iOS application entitlements in the macOS ad hoc signature prevents launch.
const simulatorLinkFlags = device ? [] : ['-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__entitlements', '-Xlinker', simulatorEntitlements];
const frameworks = ['UIKit', 'UserNotifications', 'Foundation', 'Security', 'AVFoundation', 'AVKit', 'QuickLook', 'Speech', 'CoreMedia', 'CoreVideo', 'CoreGraphics', 'CoreText', 'QuartzCore', 'ImageIO', 'Photos', 'PhotosUI', 'UniformTypeIdentifiers', 'WebKit', 'SafariServices', 'Network', 'SystemConfiguration', 'AudioToolbox'];
run('xcrun', ['--sdk', sdkName, 'swiftc', '-swift-version', '5', '-O', '-sdk', sdk, '-target', `arm64-apple-ios15.0${device ? '' : '-simulator'}`, '-F', frameworkDir, '-framework', 'NativeShell', ...frameworks.flatMap(name => ['-framework', name]), '-lc++', '-lz', '-lsqlite3', '-Xlinker', '-ObjC', ...simulatorLinkFlags, ...sources, '-o', path.join(staging, 'YuriNative')]);
const photoUsage = JSON.parse(await readFile(path.join(packageRoot, 'ios/PhotoLibraryUsage.json'), 'utf8'));
const photoLocales = ['en', 'zh-Hans', 'zh-Hant', 'ja', 'ko', 'fr', 'es', 'pl', 'pt-BR', 'uk'];
if (Object.keys(photoUsage).length !== photoLocales.length || photoLocales.some(locale => typeof photoUsage[locale] !== 'string' || !photoUsage[locale].trim())) throw new Error('Missing localized photo library usage description');
for (const locale of photoLocales) {
  const localized = path.join(staging, `${locale}.lproj`);
  await mkdir(localized, { recursive: true });
  await writeFile(path.join(localized, 'InfoPlist.strings'), `"NSPhotoLibraryAddUsageDescription" = ${JSON.stringify(photoUsage[locale])};\n`);
}
const plist = {
  CFBundleDevelopmentRegion: 'en', CFBundleDisplayName: 'Yuri Native', CFBundleExecutable: 'YuriNative',
  CFBundleIdentifier: 'com.yee94.yuri.nsh', CFBundleInfoDictionaryVersion: '6.0', CFBundleName: 'YuriNative',
  CFBundlePackageType: 'APPL', CFBundleShortVersionString: '0.1.0', CFBundleVersion: '1',
  CFBundleSupportedPlatforms: [device ? 'iPhoneOS' : 'iPhoneSimulator'], MinimumOSVersion: '15.0',
  LSRequiresIPhoneOS: true, UIDeviceFamily: [1, 2], UILaunchStoryboardName: 'LaunchScreen',
  UIAppFonts: fontNames,
  UISupportedInterfaceOrientations: ['UIInterfaceOrientationPortrait', 'UIInterfaceOrientationLandscapeLeft', 'UIInterfaceOrientationLandscapeRight'],
  NSCameraUsageDescription: '扫描 Yuri Host 配对二维码，扫描后由你确认连接。',
  NSMicrophoneUsageDescription: '使用麦克风将语音输入为聊天文字。',
  NSSpeechRecognitionUsageDescription: '使用系统语音识别将语音转换为聊天文字。',
  NSLocalNetworkUsageDescription: '连接你选择的局域网 Yuri Host。',
  NSPhotoLibraryAddUsageDescription: photoUsage.en,
  NSAppTransportSecurity: { NSAllowsArbitraryLoads: true },
  CFBundleURLTypes: [{ CFBundleURLName: 'com.yee94.yuri.nsh.pairing', CFBundleURLSchemes: ['yuri'] }],
};
const info = path.join(staging, 'Info.plist');
const compiledIconInfo = JSON.parse(run('plutil', ['-convert', 'json', '-o', '-', iconInfo], true));
await writeFile(info, JSON.stringify({ ...plist, ...compiledIconInfo }));
run('plutil', ['-convert', 'xml1', info]);
await access(path.join(staging, 'Assets.car'));
if (compiledIconInfo.CFBundleIcons?.CFBundlePrimaryIcon?.CFBundleIconName !== 'AppIcon') throw new Error('Compiled asset catalog does not declare the primary AppIcon');
const identity = process.env.NSH_SIGN_IDENTITY;
const requestedWebcredentials = (process.env.NSH_WEBCREDENTIALS_DOMAINS ?? '').split(',').map(value => value.trim()).filter(Boolean);
if (new Set(requestedWebcredentials).size !== requestedWebcredentials.length || requestedWebcredentials.some(domain => {
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(domain) || domain.length > 253 || domain.split('.').some(label => !label || label.length > 63 || label.startsWith('-') || label.endsWith('-'))) return true;
  const url = new URL(`https://${domain}`);
  return url.hostname !== domain || !!url.port || url.pathname !== '/' || !!url.search || !!url.hash;
})) throw new Error('NSH_WEBCREDENTIALS_DOMAINS must contain unique canonical RP hostnames');
if (requestedWebcredentials.length && (!device || !identity)) throw new Error('Webcredentials domains require a development-signed device build');
if (device && identity) {
  if (!process.env.NSH_PROVISIONING_PROFILE) throw new Error('Development device signing requires NSH_PROVISIONING_PROFILE');
  const profile = path.resolve(process.env.NSH_PROVISIONING_PROFILE);
  const decoded = path.join(output, 'development-profile.plist');
  await writeFile(decoded, run('security', ['cms', '-D', '-i', profile], true));
  // Extract JSON-compatible fields separately: a complete profile contains Data and Date values.
  const entitlements = JSON.parse(run('plutil', ['-extract', 'Entitlements', 'json', '-o', '-', decoded], true));
  const prefixes = JSON.parse(run('plutil', ['-extract', 'ApplicationIdentifierPrefix', 'json', '-o', '-', decoded], true));
  const devices = JSON.parse(run('plutil', ['-extract', 'ProvisionedDevices', 'json', '-o', '-', decoded], true));
  const expiration = run('plutil', ['-extract', 'ExpirationDate', 'raw', '-o', '-', decoded], true);
  const appID = entitlements?.['application-identifier'];
  const expectedID = `${prefixes[0]}.com.yee94.yuri.nsh`;
  if (!appID || !(appID === expectedID || (appID.endsWith('*') && expectedID.startsWith(appID.slice(0, -1))))) throw new Error('Provisioning profile does not cover com.yee94.yuri.nsh');
  if (!devices.length || entitlements['get-task-allow'] !== true) throw new Error('Use an iOS development provisioning profile, not a distribution profile');
  if (!Number.isFinite(Date.parse(expiration)) || new Date(expiration) <= new Date()) throw new Error('Provisioning profile has expired or has no valid expiration');
  const signingEntitlements = {
    'application-identifier': expectedID,
    'com.apple.developer.team-identifier': entitlements['com.apple.developer.team-identifier'],
    'get-task-allow': true,
    'keychain-access-groups': [expectedID],
  };
  if (requestedWebcredentials.length) {
    const domains = requestedWebcredentials.map(domain => `webcredentials:${domain}`);
    const permitted = entitlements['com.apple.developer.associated-domains'];
    if (!Array.isArray(permitted) || domains.some(domain => !permitted.includes('*') && !permitted.includes(domain))) throw new Error('Provisioning profile does not authorize the requested webcredentials domains');
    signingEntitlements['com.apple.developer.associated-domains'] = domains;
    await writeFile(info, JSON.stringify({ ...plist, ...compiledIconInfo, YuriWebcredentialsDomains: domains }));
    run('plutil', ['-convert', 'xml1', info]);
  }
  const entitlementsPath = path.join(output, 'development-entitlements.plist');
  await writeFile(entitlementsPath, JSON.stringify(signingEntitlements));
  run('plutil', ['-convert', 'xml1', entitlementsPath]);
  await cp(profile, path.join(staging, 'embedded.mobileprovision'));
  run('codesign', ['--force', '--sign', identity, '--entitlements', entitlementsPath, '--timestamp=none', staging]);
} else if (!device) {
  run('codesign', ['--force', '--sign', '-', '--timestamp=none', staging]);
}
await rm(app, { recursive: true, force: true });
await rename(staging, app);
console.log(`Built ${device ? (identity ? 'development-signed device' : 'unsigned device') : 'arm64 simulator'} app: ${app}`);
