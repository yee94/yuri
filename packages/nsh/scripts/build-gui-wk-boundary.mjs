#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { access, chmod, cp, mkdir, open, readFile, readdir, readlink, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspace = path.resolve(root, '../..');
if (process.argv.includes('--help')) {
  console.log('node packages/nsh/scripts/build-gui-wk-boundary.mjs\nSimulator arm64, iOS 15 deployment with iOS 26+ SDK. Set NSH_DIST or NSH_BIN for the real NativeShell.xcframework. Builds and ad-hoc signs once; never runs nsh, simctl, install, launch, Keychain or network. Unique run-8hex output and bundle ID.');
  process.exit(0);
}
if (process.argv.length !== 2) throw Error('No options supported; see --help');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', timeout: 180_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw Error(`${path.basename(command)} failed (${result.status}): ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}
async function distribution() {
  if (process.env.NSH_DIST) return path.resolve(process.env.NSH_DIST);
  const value = process.env.NSH_BIN || 'nsh';
  const candidates = value.includes('/') ? [path.resolve(value)] : (process.env.PATH || '').split(path.delimiter).map(directory => path.join(directory, value));
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); return path.resolve(path.dirname(await realpath(candidate)), '..'); } catch { /* Read the next executable path; never execute NSH. */ }
  }
  throw Error('Set NSH_DIST or NSH_BIN to the real NativeShell distribution');
}
async function tree(directory) {
  const entries = [];
  async function visit(parent) {
    for (const entry of await readdir(parent, { withFileTypes: true })) {
      const file = path.join(parent, entry.name), name = path.relative(directory, file).split(path.sep).join('/');
      if (entry.isSymbolicLink()) {
        const resolved = await realpath(file);
        if (!resolved.startsWith(directory + path.sep)) throw Error('Framework symlink leaves its snapshot: ' + name);
        entries.push({ path: name, symlink: await readlink(file) });
      } else if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) { const bytes = await readFile(file); entries.push({ path: name, bytes: bytes.length, sha256: hash(bytes) }); }
      else throw Error('Unexpected framework entry: ' + name);
    }
  }
  await visit(directory);
  return entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
async function verifySources(records, directory) {
  for (const record of records) if (hash(await readFile(path.join(directory, record.path))) !== record.sha256) throw Error('Source snapshot changed: ' + record.path);
}

const parent = path.join(root, '.nsh/gui-wk-boundary');
await mkdir(parent, { recursive: true });
let buildID, output;
for (;;) {
  buildID = 'run-' + randomBytes(4).toString('hex'); output = path.join(parent, buildID);
  try { await mkdir(output); break; } catch (error) { if (error.code !== 'EEXIST') throw error; }
}
const bundleID = 'example.nsh.gui-wk-boundary.' + buildID;
const executable = 'GuiWKBoundaryFixture';
const staging = path.join(output, executable + '.staging.app'), app = path.join(output, executable + '.app');
const manifestPath = path.join(output, 'manifest.json'), stage = path.join(output, 'frozen');
const manifest = {
  schema: 1, buildID, bundleID, status: 'building', app, manifest: manifestPath,
  platform: 'iPhoneSimulator', architecture: 'arm64', deploymentTarget: '15.0',
  profile: 'strict-production-gui-capture', installed: false, launched: false,
  nshEngineStarted: false, network: false, keychain: false,
  hostIO: 'fixture memory captures only; no sockets or Host',
  nativeStorage: 'unchanged production Storage in isolated app temporary directory',
  deviceIO: 'unchanged production bridge; fixture restores clipboard; no Photos/save UI exercised',
  result: 'Documents/result.json', frozen: stage,
};
await writeFile(manifestPath, json(manifest));
try {
  const sdk = run('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path']);
  const sdkVersion = run('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-version']);
  if (Number(sdkVersion.split('.')[0]) < 26) throw Error('iOS 26+ SDK required, matching production NativeShell build');
  const frameworkSource = path.join(await distribution(), 'embed/ios/NativeShell.xcframework/ios-arm64-simulator/NativeShell.framework');
  await access(path.join(frameworkSource, 'NativeShell'));
  const frameworkInfo = JSON.parse(run('plutil', ['-convert', 'json', '-o', '-', path.join(frameworkSource, 'Info.plist')]));
  if (frameworkInfo.MinimumOSVersion && Number.parseFloat(frameworkInfo.MinimumOSVersion) > 15) throw Error('NativeShell minimum OS exceeds the fixture deployment target');
  const framework = path.join(stage, 'frameworks/NativeShell.framework');
  const before = json(await tree(await realpath(frameworkSource)));
  await cp(frameworkSource, framework, { recursive: true, dereference: false, verbatimSymlinks: true });
  if (json(await tree(framework)) !== before || json(await tree(await realpath(frameworkSource))) !== before) throw Error('NativeShell changed while freezing');
  const frameworkHash = hash(before);
  for (const entry of await tree(framework)) if (!entry.symlink) await chmod(path.join(framework, entry.path), 0o444);
  const binaryHandle = await open(path.join(framework, 'NativeShell'), 'r');
  const magic = Buffer.alloc(8); await binaryHandle.read(magic, 0, 8, 0); await binaryHandle.close();
  const staticFramework = magic.toString() === '!<arch>\n';
  if (!staticFramework && !/dynamically linked shared library/.test(run('file', ['-b', path.join(framework, 'NativeShell')]))) throw Error('Unknown NativeShell binary type');
  const sourcePaths = [
    'packages/nsh/ios/RuntimeHostScope.swift',
    'packages/nsh/ios/ResourceWebPreviewBridge.swift',
    'packages/nsh/ios/ResourceWebPreviewView.swift',
    'packages/nsh/ios/GuiPluginPreviewBridge.swift',
    'packages/nsh/ios/GuiPluginResourceResolver.swift',
    'packages/nsh/ios/GuiPluginDeviceBridge.swift',
    'packages/mobile/ios/App/App/YuriViewExportRenderer.swift',
    'packages/nsh/tests/gui-wk-boundary/GuiPluginWKBoundaryFixture.swift',
    'packages/nsh/tests/gui-wk-boundary/main.swift',
  ].sort();
  const provenancePaths = [
    'packages/nsh/gui-plugin-browser/resource-urls.ts',
    'packages/nsh/gui-plugin-device.test.tsx',
    'packages/nsh/gui-plugin-capabilities-native.test.ts',
    'packages/nsh/gui-wk-root-proof.test.ts',
    'packages/nsh/gui-plugin-bundle.test.ts',
    'packages/nsh/scripts/build-gui-wk-boundary.mjs',
  ];
  const sources = [];
  for (const source of [...sourcePaths, ...provenancePaths].sort()) {
    const bytes = await readFile(path.join(workspace, source)), target = path.join(stage, 'sources', source);
    await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, bytes, { mode: 0o444 });
    sources.push({ path: source, bytes: bytes.length, sha256: hash(bytes), role: sourcePaths.includes(source) ? 'compiled-swift' : 'browser-regression-or-builder-provenance' });
  }
  await verifySources(sources, workspace);
  await verifySources(sources, path.join(stage, 'sources'));
  const sourceDocument = json({ schema: 1, sources });
  const sourceHash = hash(sourceDocument);
  const expectedCases = ['workspace', 'loopback', 'absoluteHost', 'workspace-nested', 'loopback-nested', 'absoluteHost-nested'];
  const build = { schema: 1, buildID, bundleID, sourceHash, profile: manifest.profile, expectedCases, frameworkHash };
  await mkdir(staging); await writeFile(path.join(staging, 'build.json'), json(build));
  await writeFile(path.join(staging, 'source-manifest.json'), sourceDocument);
  const frameworks = ['UIKit', 'Foundation', 'Security', 'AVFoundation', 'AVKit', 'QuickLook', 'Speech', 'CoreMedia', 'CoreVideo', 'CoreGraphics', 'CoreText', 'QuartzCore', 'ImageIO', 'Photos', 'PhotosUI', 'UniformTypeIdentifiers', 'WebKit', 'SafariServices', 'Network', 'SystemConfiguration', 'AudioToolbox', 'CryptoKit'];
  const compile = ['--sdk', 'iphonesimulator', 'swiftc', '-swift-version', '5', '-O', '-sdk', sdk, '-target', 'arm64-apple-ios15.0-simulator',
    '-module-cache-path', path.join(output, 'module-cache'), '-F', path.dirname(framework), '-framework', 'NativeShell',
    ...frameworks.flatMap(name => ['-framework', name]), '-lc++', '-lz', '-lsqlite3', '-Xlinker', '-ObjC', '-Xlinker', '-dead_strip',
    '-Xlinker', '-rpath', '-Xlinker', '@executable_path/Frameworks',
    ...sourcePaths.map(source => path.join(stage, 'sources', source)), '-o', path.join(staging, executable)];
  Object.assign(manifest, { sdkVersion, sourceHash, sources, frameworkHash, frameworkKind: staticFramework ? 'real-static-framework' : 'real-dynamic-framework',
    builderSHA256: hash(await readFile(fileURLToPath(import.meta.url))), compiler: run('xcrun', ['swiftc', '--version']), compile });
  await writeFile(manifestPath, json(manifest));
  run('xcrun', compile);
  await verifySources(sources, path.join(stage, 'sources'));
  if (hash(json(await tree(framework))) !== frameworkHash) throw Error('Frozen framework changed during compilation');
  if (!staticFramework) {
    const embedded = path.join(staging, 'Frameworks/NativeShell.framework');
    await cp(framework, embedded, { recursive: true, verbatimSymlinks: true });
    await chmod(path.join(embedded, 'NativeShell'), 0o755);
    run('codesign', ['--force', '--sign', '-', '--timestamp=none', embedded]);
  }
  await writeFile(path.join(staging, 'Info.plist'), json({
    CFBundleDevelopmentRegion: 'en', CFBundleDisplayName: 'GUI WK Boundary', CFBundleExecutable: executable,
    CFBundleIdentifier: bundleID, CFBundleInfoDictionaryVersion: '6.0', CFBundleName: executable,
    CFBundlePackageType: 'APPL', CFBundleShortVersionString: '1.0.0', CFBundleVersion: '1',
    CFBundleSupportedPlatforms: ['iPhoneSimulator'], MinimumOSVersion: '15.0', LSRequiresIPhoneOS: true,
    UIDeviceFamily: [1, 2], UILaunchScreen: {}, UISupportedInterfaceOrientations: ['UIInterfaceOrientationPortrait'],
  }));
  run('plutil', ['-convert', 'xml1', path.join(staging, 'Info.plist')]);
  run('plutil', ['-lint', path.join(staging, 'Info.plist')]);
  run('codesign', ['--force', '--sign', '-', '--timestamp=none', staging]);
  run('codesign', ['--verify', '--strict', staging]);
  await rename(staging, app);
  const liveSourcesChanged = [];
  for (const source of sources) if (hash(await readFile(path.join(workspace, source.path))) !== source.sha256) liveSourcesChanged.push(source.path);
  Object.assign(manifest, { status: 'built-not-run', signed: 'ad-hoc', signatureVerified: true, executableSHA256: hash(await readFile(path.join(app, executable))), liveSourcesChanged,
    commands: { install: ['xcrun', 'simctl', 'install', '<SIMULATOR_UDID>', app], launch: ['xcrun', 'simctl', 'launch', '<SIMULATOR_UDID>', bundleID], container: ['xcrun', 'simctl', 'get_app_container', '<SIMULATOR_UDID>', bundleID, 'data'], read: '<returned-data-container>/Documents/result.json' } });
  await writeFile(manifestPath, json(manifest));
  console.log(json({ buildID, bundleID, sourceHash, app, manifest: manifestPath, status: manifest.status }));
} catch (error) {
  manifest.status = 'build-failed'; manifest.failure = error.message;
  await writeFile(manifestPath, json(manifest));
  console.error('GUI WK boundary build failed; manifest: ' + manifestPath);
  throw error;
}
