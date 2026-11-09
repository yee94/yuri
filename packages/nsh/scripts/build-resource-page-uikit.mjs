#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, cp, mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { stageNativeApplication, validateNativeApplicationBundle } from './stage-native-application.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), repository = path.resolve(root, '../..');
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('node packages/nsh/scripts/build-resource-page-uikit.mjs [--stage-only | --bundle-only]\nUnique synthetic-only production ResourcePreviewPage UIKit fixture. Default: typecheck, bundle, SDK full build and ad-hoc sign; never engine run, install, launch, real Host, Keychain, Git or dependency installation. --stage-only freezes/typechecks; --bundle-only also compiles NSH. NSH_BIN / NSH_DIST locate the existing distribution.');
  process.exit(0);
}
if (args.length > 1 || args.some(value => !['--stage-only', '--bundle-only'].includes(value))) throw Error('Unsupported option');
const buildID = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
const output = path.join(root, '.nsh/resource-page-uikit', buildID);
await mkdir(output, { recursive: true });
const entry = 'packages/nsh/tests/resource-page-uikit/fixture.tsx';
const stage = await stageNativeApplication({ root: path.join(output, 'frozen'), workspaceRoot: repository, entry });
const hash = value => createHash('sha256').update(value).digest('hex');
const sources = { ...stage.manifest.sourceFiles };
async function freeze(relative) {
  const bytes = await readFile(path.join(repository, relative)), target = path.join(stage.cwd, 'source', relative);
  await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, bytes);
  if (!bytes.equals(await readFile(target))) throw Error('Freeze mismatch');
  sources[relative] = { bytes: bytes.length, sha256: hash(bytes) }; return target;
}
function run(command, argv, cwd = stage.cwd, capture = false) {
  const result = spawnSync(command, argv, { cwd, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit', timeout: 240_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw Error(`${path.basename(command)} failed (${result.status})${capture ? ': ' + result.stderr : ''}`);
  return result.stdout?.trim();
}
const capabilities = { host: ['connection.list', 'runtime.request', 'resources.read', 'resources.present', 'resources.release', 'resources.cancel', 'resources.close', 'resources.web.present', 'resources.web.close', 'plugins.preview.present', 'plugins.preview.close', 'appearance.reset', 'appearance.apply', 'fixture.resourcePage.audit', 'fixture.resourcePage.bumpStat'] };
const name = 'ResourcePageUIKitFixture', bundleID = 'example.nsh.resource-page-uikit.run-' + buildID.slice(-8);
await writeFile(path.join(stage.cwd, 'nsh.json'), JSON.stringify({ name, id: bundleID, version: '0.1.0', build: 1, appearance: 'system', theme: 'theme.json', capabilities }));
const types = [];
for (const file of await readdir(path.join(root, '.nsh/types/nsh'))) if (file.endsWith('.d.ts')) types.push(await freeze('packages/nsh/.nsh/types/nsh/' + file));
// Discover type-only inputs too. Production bundling intentionally omits them.
const options = ts.getParsedCommandLineOfConfigFile(path.join(root, 'tsconfig.json'), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: diagnostic => { throw Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')); } }).options;
const roots = [path.join(repository, entry), ...['globals.d.ts', 'assets.d.ts', 'tokens.d.ts'].map(file => path.join(root, '.nsh/types/nsh', file)), path.join(repository, 'packages/ui/src/types/desktop.d.ts')];
const discovery = ts.createProgram(roots, options), frozenTypes = new Map();
for (const source of discovery.getSourceFiles()) {
  const relative = path.relative(repository, source.fileName);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw Error('Type input outside repository');
  const bytes = await readFile(source.fileName);
  if (relative.startsWith('packages/')) await freeze(relative);
  else {
    const target = path.join(output, 'typecheck-inputs', relative); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, bytes);
    sources[relative] = { bytes: bytes.length, sha256: hash(bytes) };
  }
  frozenTypes.set(source.fileName, bytes.toString('utf8'));
}
// Keep original resolution identities while the compiler consumes frozen bytes.
const compilerHost = ts.createCompilerHost(options), originalRead = compilerHost.readFile;
compilerHost.readFile = file => {
  if (frozenTypes.has(file)) return frozenTypes.get(file);
  if (/\.[cm]?[jt]sx?$/.test(file) && path.resolve(file).startsWith(repository + path.sep)) throw Error('Type graph changed during freeze');
  return originalRead(file);
};
const diagnostics = ts.getPreEmitDiagnostics(ts.createProgram(roots, options, compilerHost));
if (diagnostics.length) throw Error(ts.formatDiagnostics(diagnostics, { getCanonicalFileName: file => file, getCurrentDirectory: () => stage.cwd, getNewLine: () => '\n' }));
// Compile actual production declarations; RuntimeBridge is linked but never constructed.
const swiftSources = (await readdir(path.join(root, 'ios'))).filter(file => file.endsWith('.swift') && file !== 'main.swift').sort().map(file => 'packages/nsh/ios/' + file);
swiftSources.push('packages/mobile/ios/App/App/YuriViewExportRenderer.swift', 'packages/nsh/tests/resource-page-uikit/SyntheticHost.swift', 'packages/nsh/tests/resource-page-uikit/uikit-main.swift');
for (const source of swiftSources) await freeze(source);
for (const source of ['packages/nsh/tests/resource-page-uikit/README.md', 'packages/nsh/tests/resource-page-uikit/check-gui-unmatched.mjs', 'packages/nsh/tests/resource-page-uikit/wire.test.ts', 'packages/nsh/tests/resource-page-uikit/wire-contract.swift', 'packages/nsh/tests/resource-page-uikit/vitest.config.ts', 'packages/nsh/scripts/build-gui-plugin-preview.mjs', 'packages/nsh/scripts/build-resource-page-uikit.mjs', 'packages/nsh/scripts/stage-native-application.mjs']) await freeze(source);
for (const source of ['gui-plugin-browser.ts', 'gui-plugin-factory.ts', 'gui-plugin-browser.test.tsx', 'gui-plugin-artifact.test.tsx', 'gui-plugin-browser.tsconfig.json', 'GUI-PLUGIN-CONTRACT.md']) await freeze('packages/nsh/' + source);
const sdkPackage = 'packages/ui/node_modules/@yuriai/opencode-gui-client';
await freeze(sdkPackage + '/package.json');
async function freezeSDK(directory) {
  for (const item of await readdir(path.join(repository, directory), { withFileTypes: true })) {
    const source = directory + '/' + item.name;
    if (item.isDirectory()) await freezeSDK(source);
    else if (item.isFile()) await freeze(source);
    else throw Error('Unexpected SDK package symlink');
  }
}
await freezeSDK(sdkPackage + '/dist');
const manifest = { buildID, bundleID, syntheticOnly: true, realHost: false, networkGranted: false, keychainAccess: false, hostWrites: false,
  productionUI: ['ResourcePreviewPage', 'ResourceFilesPage', 'ResourceHtmlViewer', 'ResourceSVGImage'], provesAppNavigation: false,
  capabilities, sourceTypechecked: true, sources, swiftSources, installed: false, launched: false, engineStarted: false, bundleBuilt: false, appBuilt: false,
  guiAssets: 'Fresh production GUI adapter built into this unique output; original browser input source provenance is not re-proved here' };
if (!args.includes('--stage-only')) {
  const guiAssets = path.join(output, 'gui-plugin-preview');
  // A production GUI source fix must not leave the fixture on an old global bundle.
  run(process.execPath, [path.join(root, 'scripts/build-gui-plugin-preview.mjs'), '--out', guiAssets]);
  for (const source of ['gui-plugin-browser.ts', 'gui-plugin-factory.ts']) {
    const key = 'packages/nsh/' + source;
    if (hash(await readFile(path.join(repository, key))) !== sources[key].sha256) throw Error('GUI seam changed while building adapter');
  }
  await writeFile(path.join(output, 'fixture-build.json'), JSON.stringify(manifest, null, 2) + '\n');
  run(process.execPath, [path.join(root, 'tests/resource-page-uikit/check-gui-unmatched.mjs'), guiAssets, path.join(output, 'gui-unmatched-contract.json')]);
  manifest.guiUnmatchedContract = true;
  const value = process.env.NSH_BIN || 'nsh'; let nsh;
  for (const candidate of value.includes('/') ? [path.resolve(value)] : (process.env.PATH ?? '').split(path.delimiter).map(directory => path.join(directory, value))) {
    try { await access(candidate, constants.X_OK); nsh = await realpath(candidate); break; } catch { /* Try the next installed compiler. */ }
  }
  if (!nsh) throw Error('Set NSH_BIN to the installed NSH compiler');
  const bundle = path.join(output, 'bundle'); run(nsh, ['build', stage.entry, '--release', '--out', bundle]);
  manifest.bundleBuilt = true; manifest.bundleSHA256 = hash(await readFile(path.join(bundle, 'bundle.nshc')));
  manifest.assetEvidence = await validateNativeApplicationBundle(bundle, stage.manifest);
  if (!args.includes('--bundle-only')) {
    const dist = process.env.NSH_DIST ? path.resolve(process.env.NSH_DIST) : path.resolve(path.dirname(nsh), '..');
    const framework = path.join(output, 'frameworks'); await mkdir(framework);
    await cp(path.join(dist, 'embed/ios/NativeShell.xcframework/ios-arm64-simulator/NativeShell.framework'), path.join(framework, 'NativeShell.framework'), { recursive: true });
    manifest.nativeShellSHA256 = hash(await readFile(path.join(framework, 'NativeShell.framework/NativeShell')));
    manifest.publicInterfaceSHA256 = hash(await readFile(path.join(framework, 'NativeShell.framework/Modules/NativeShell.swiftmodule/arm64-apple-ios-simulator.swiftinterface')));
    const sdk = run('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path'], stage.cwd, true);
    manifest.sdkVersion = run('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-version'], stage.cwd, true);
    if (Number(manifest.sdkVersion.split('.')[0]) < 26) throw Error('iOS 26+ SDK required');
    const swift = ['--sdk', 'iphonesimulator', 'swiftc', '-swift-version', '5', '-parse-as-library', '-sdk', sdk, '-target', 'arm64-apple-ios15.0-simulator', '-F', framework];
    const frozen = swiftSources.map(source => path.join(stage.cwd, 'source', source));
    run('xcrun', [...swift, '-typecheck', ...frozen]); manifest.swiftTypechecked = true;
    const staging = path.join(output, name + '.staging.app'), app = path.join(output, name + '.app'); await mkdir(staging);
    await cp(bundle, path.join(staging, 'nsh'), { recursive: true });
    await cp(guiAssets, path.join(staging, 'gui-plugin-preview'), { recursive: true });
    const guiManifest = JSON.parse(await readFile(path.join(staging, 'gui-plugin-preview/manifest.json'), 'utf8'));
    for (const [file, record] of Object.entries(guiManifest.assets)) {
      if (!/^\/(?:index\.html|assets\/[\w./-]+)$/.test(file) || file.split('/').includes('..')) throw Error('Invalid GUI asset path');
      const bytes = await readFile(path.join(staging, 'gui-plugin-preview', file.slice(1)));
      if (bytes.length !== record.bytes || hash(bytes) !== record.sha256) throw Error('Frozen GUI asset mismatch');
    }
    manifest.guiAssetManifestSHA256 = hash(await readFile(path.join(staging, 'gui-plugin-preview/manifest.json')));
    const frameworks = ['UIKit', 'UserNotifications', 'Foundation', 'Security', 'AVFoundation', 'AVKit', 'QuickLook', 'Speech', 'CoreMedia', 'CoreVideo', 'CoreGraphics', 'CoreText', 'QuartzCore', 'ImageIO', 'Photos', 'PhotosUI', 'UniformTypeIdentifiers', 'WebKit', 'SafariServices', 'Network', 'SystemConfiguration', 'AudioToolbox'];
    run('xcrun', [...swift, '-O', '-framework', 'NativeShell', ...frameworks.flatMap(value => ['-framework', value]), '-lc++', '-lz', '-lsqlite3', '-Xlinker', '-ObjC', ...frozen, '-o', path.join(staging, name)]);
    await writeFile(path.join(staging, 'Info.plist'), JSON.stringify({ CFBundleDevelopmentRegion: 'en', CFBundleDisplayName: 'Synthetic Resource UIKit QA', CFBundleExecutable: name, CFBundleIdentifier: bundleID, CFBundleInfoDictionaryVersion: '6.0', CFBundleName: name, CFBundlePackageType: 'APPL', CFBundleShortVersionString: '0.1.0', CFBundleVersion: '1', CFBundleSupportedPlatforms: ['iPhoneSimulator'], MinimumOSVersion: '15.0', LSRequiresIPhoneOS: true, UIDeviceFamily: [1, 2], UILaunchScreen: {}, FixtureBuildID: buildID, UISupportedInterfaceOrientations: ['UIInterfaceOrientationPortrait'] }));
    run('plutil', ['-convert', 'xml1', path.join(staging, 'Info.plist')]); run('codesign', ['--force', '--sign', '-', '--timestamp=none', staging]); run('codesign', ['--verify', '--strict', staging]);
    await rename(staging, app); manifest.appBuilt = true; manifest.app = path.relative(root, app); manifest.executableSHA256 = hash(await readFile(path.join(app, name)));
  }
}
await writeFile(path.join(output, 'fixture-build.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ ...manifest, sources: `${Object.keys(sources).length} frozen inputs`, swiftSources: swiftSources.length, manifest: path.relative(root, path.join(output, 'fixture-build.json')) }, null, 2));
