#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { access, cp, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { terminalHostCalls, verifyBuiltTerminalCapabilities, verifyTerminalConfig } from '../tests/history-terminal/capabilities.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('node packages/nsh/scripts/build-history-terminal-uikit.mjs [--bundle-only]\nNSH_BIN / NSH_DIST required when not on PATH. Unique output per build. Builds only; never installs, launches, or invokes test engines.');
  process.exit(0);
}
if (args.some(arg => arg !== '--bundle-only')) throw new Error('Only --bundle-only is supported');
async function executable(value) {
  const candidates = value.includes('/') ? [path.resolve(value)] : (process.env.PATH ?? '').split(path.delimiter).map(dir => path.join(dir, value));
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); return await realpath(candidate); } catch { /* Try next path. */ }
  }
  throw new Error('Cannot find NSH; set NSH_BIN');
}
const nsh = await executable(process.env.NSH_BIN || 'nsh');
const base = path.join(root, '.nsh/history-terminal');
await mkdir(base, { recursive: true });
const output = await mkdtemp(path.join(base, 'build-'));
const project = path.join(output, 'project'), bundle = path.join(output, 'bundle');
await mkdir(project);
const bundleID = 'com.yee94.yuri.nsh.history-terminal';
const executableName = 'HistoryTerminalFixture';
function run(command, argv, capture = false) {
  const result = spawnSync(command, argv, { cwd: project, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} failed (${result.status})${capture ? `: ${result.stderr}` : ''}`);
  return result.stdout?.trim();
}
const relative = value => path.relative(root, value);
const sha = async file => createHash('sha256').update(await readFile(file)).digest('hex');
const config = JSON.parse(await readFile(path.join(root, 'tests/history-terminal/nsh.json'), 'utf8'));
verifyTerminalConfig(config);
if (config.id !== bundleID) throw new Error('Fixture config bundle ID mismatch');
const sourcePaths = ['history-terminal-fixture.tsx', 'history-footer.ts', 'history-rows.ts', 'history-scroll.ts', 'transcript-body-model.ts', 'model.ts', 'tests/history-terminal/scenario.ts', 'tests/history-terminal/footer-natural.ts', 'tests/history-terminal/footer-release.ts', 'tests/history-terminal/sync-verdict.ts', 'tests/history-terminal/check-sync-capture.ts', 'tests/history-terminal/nsh.json', 'tests/history-terminal/capabilities.mjs', 'scripts/build-history-terminal-uikit.mjs'];
// Discover only this isolated fixture's Swift sources, never production ios/*.swift.
const swift = (await readdir(path.join(root, 'tests/history-terminal'))).filter(name => name.endsWith('.swift')).sort().map(name => path.join(root, 'tests/history-terminal', name));
for (const file of swift) sourcePaths.push(relative(file));
const manifest = {
   schema: 1, fixture: 'history-terminal', build: config.build, bundleID, executable: executableName, platform: 'iPhoneSimulator', architecture: 'arm64',
  installed: false, launched: false, engineRun: false, externalHost: false, keychain: false,
  body: 'Synthetic naturally sized nsh/base TextView; NOT NativeTranscriptBody',
  scrollOwner: 'NSH inverted List; production history-scroll intent only; no offset writes',
  output: relative(output), bundle: relative(bundle), sources: Object.fromEntries(await Promise.all(sourcePaths.map(async file => [file, await sha(path.join(root, file))]))),
  ax: { list: 'terminal-transcript', counters: 'terminal-counters', markerPattern: 'terminal-marker-record-NNNN',
    footer: 'terminal-footer', loading: 'history-load-older', error: 'terminal-native-error',
     naturalFooter: 'terminal-footer-natural', controls: ['terminal-next', 'terminal-arm-page', 'terminal-commit', 'terminal-probe', 'terminal-toggle-footer', 'terminal-toggle-metadata', 'terminal-toggle-hold', 'terminal-toggle-release-mode', 'terminal-capture'] },
  captures: 'Documents/history-terminal/captures.json', status: 'building',
   defaults: { footerEnabled: true, metadataEnabled: true, footerExperiment: false, releaseMode: 'sync', firstPageMessages: 20, totalPages: 20, finalMessages: 400, delayMs: 1200, topPt: 144, bottomPt: 152 },
  experiment: { module: 'history-footer.ts', defaultEnabled: false, measuredFootprintOnly: true, releaseUIKitVerified: false, noScrollWrites: true },
   captureContract: { schema: 2, nativeClock: 'ProcessInfo.systemUptime milliseconds', jsClock: 'performance.now milliseconds; not assumed native clock', frameRetention: 12000, diagnosticFrameRetention: 600, continuousInSyncMode: true, releasePre: 'existing CADisplayLink ring only', eventRetention: 512, readOnlyGeometry: true, autoPublishReleasePrefixMs: 4000, captureReturnsAfterPersistedACK: true, prefixFrontierMetadata: true },
   pureTestFiles: ['tests/history-terminal/scenario.test.ts', 'tests/history-terminal/capabilities.test.ts', 'tests/history-terminal/footer.test.ts', 'tests/history-terminal/footer-wiring.test.ts', 'tests/history-terminal/footer-authority.test.ts', 'tests/history-terminal/footer-natural.test.ts', 'tests/history-terminal/footer-release.test.ts', 'tests/history-terminal/sync-verdict.test.ts', 'tests/history-terminal/raw-sync-replay.test.ts', 'tests/history-terminal/native-storage.test.ts'],
  preparedNotRun: ['tests/history-terminal/engine.steps.js'],
};
const saveManifest = () => writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2));
async function verifySourcesUnchanged() {
  for (const [file, expected] of Object.entries(manifest.sources)) {
    if (await sha(path.join(root, file)) === expected) continue;
    manifest.status = 'source-changed-during-build'; await saveManifest();
    throw new Error(`Source changed during isolated build: ${file}; artifact is not a delivery candidate`);
  }
}
await saveManifest();
await writeFile(path.join(project, 'nsh.json'), JSON.stringify(config));
await writeFile(path.join(project, 'App.tsx'), `import ${JSON.stringify(path.relative(project, path.join(root, 'history-terminal-fixture.tsx')))};\n`);
run(nsh, ['build', path.join(project, 'App.tsx'), '--release', '--out', bundle]);
await access(path.join(bundle, 'bundle.nshc'));
manifest.bundleSHA256 = await sha(path.join(bundle, 'bundle.nshc'));
manifest.capabilities = JSON.parse(await readFile(path.join(bundle, 'capabilities.json'), 'utf8'));
verifyBuiltTerminalCapabilities(manifest.capabilities);
manifest.capabilityContract = { verifiedBuiltBundle: true, hostCalls: [...terminalHostCalls],
  swiftGrantSource: 'nsh/capabilities.json (same bytes as the bundled compiler output)',
  capabilitiesSHA256: await sha(path.join(bundle, 'capabilities.json')) };
if (args.includes('--bundle-only')) {
  await verifySourcesUnchanged();
  manifest.status = 'bundle-only'; await saveManifest(); console.log(path.join(output, 'manifest.json')); process.exit(0);
}
const dist = process.env.NSH_DIST ? path.resolve(process.env.NSH_DIST) : path.resolve(path.dirname(nsh), '..');
const framework = path.join(dist, 'embed/ios/NativeShell.xcframework/ios-arm64-simulator');
await access(path.join(framework, 'NativeShell.framework/NativeShell'));
const sdk = run('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path'], true);
manifest.sdkVersion = run('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-version'], true);
if (Number(manifest.sdkVersion.split('.')[0]) < 26) throw new Error('iOS 26+ SDK required');
manifest.nshVersion = run(nsh, ['--version'], true);
manifest.nativeShellSHA256 = await sha(path.join(framework, 'NativeShell.framework/NativeShell'));
const app = path.join(output, `${executableName}.app`);
await mkdir(app);
await cp(bundle, path.join(app, 'nsh'), { recursive: true });
const packagedCapabilities = path.join(app, 'nsh/capabilities.json');
verifyBuiltTerminalCapabilities(JSON.parse(await readFile(packagedCapabilities, 'utf8')));
if (await sha(packagedCapabilities) !== manifest.capabilityContract.capabilitiesSHA256) throw new Error('Packaged Swift grants differ from verified bundle capabilities');
manifest.capabilityContract.verifiedPackagedApp = true;
const frameworks = ['UIKit', 'Foundation', 'Security', 'AVFoundation', 'Speech', 'CoreMedia', 'CoreVideo', 'CoreGraphics', 'CoreText', 'QuartzCore', 'ImageIO', 'Photos', 'PhotosUI', 'UniformTypeIdentifiers', 'WebKit', 'SafariServices', 'Network', 'SystemConfiguration', 'AudioToolbox'];
run('xcrun', ['--sdk', 'iphonesimulator', 'swiftc', '-swift-version', '5', '-O', '-sdk', sdk, '-target', 'arm64-apple-ios15.0-simulator', '-F', framework, '-framework', 'NativeShell', ...frameworks.flatMap(name => ['-framework', name]), '-lc++', '-lz', '-lsqlite3', '-Xlinker', '-ObjC', ...swift, '-o', path.join(app, executableName)]);
await writeFile(path.join(app, 'Info.plist'), JSON.stringify({ CFBundleDevelopmentRegion: 'en', CFBundleDisplayName: 'Terminal Fixture',
  CFBundleExecutable: executableName, CFBundleIdentifier: bundleID, CFBundleInfoDictionaryVersion: '6.0', CFBundleName: executableName,
  CFBundlePackageType: 'APPL', CFBundleShortVersionString: config.version, CFBundleVersion: String(config.build), CFBundleSupportedPlatforms: ['iPhoneSimulator'],
  MinimumOSVersion: '15.0', LSRequiresIPhoneOS: true, UIDeviceFamily: [1, 2], UILaunchScreen: {}, UISupportedInterfaceOrientations: ['UIInterfaceOrientationPortrait'] }));
run('plutil', ['-convert', 'xml1', path.join(app, 'Info.plist')]);
run('codesign', ['--force', '--sign', '-', '--timestamp=none', app]);
manifest.app = relative(app); manifest.executableSHA256 = await sha(path.join(app, executableName));
await verifySourcesUnchanged();
manifest.status = 'built-not-run'; await saveManifest();
console.log(`Built only: ${app}\nManifest: ${path.join(output, 'manifest.json')}`);
