#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, cp, mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { stageNativeApplication, validateNativeApplicationBundle } from './stage-native-application.mjs';
import { featuresUIKitSeed } from '../tests/features-uikit/seed.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), repository = path.resolve(root, '../..');
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('node packages/nsh/scripts/build-features-uikit.mjs [--stage-only | --sdk-only | --bundle-only]\nDefault: unique ad-hoc Simulator app. No install, launch, NSH test engine, network or Keychain. NSH_BIN / NSH_DIST select an existing distribution. --stage-only: TS/Bun graph/SHA only; --sdk-only: also Swift SDK typecheck, no NSH compiler.');
  process.exit(0);
}
if (args.length > 1 || args.some(arg => !['--stage-only', '--sdk-only', '--bundle-only'].includes(arg))) throw new Error('Use at most one documented build mode');
const suffix = randomUUID().slice(0, 8), buildID = `${new Date().toISOString().replace(/[:.]/g, '-')}-${suffix}`;
const bundleID = `example.nsh.features-uikit.run-${suffix}`, name = 'FeaturesUIKitFixture';
const output = path.join(root, '.nsh/features-uikit', buildID), bundle = path.join(output, 'bundle');
const entry = 'packages/nsh/tests/features-uikit/fixture.tsx';
const nativeSources = ['tests/features-uikit/SyntheticHost.swift', 'tests/features-uikit/uikit-main.swift', 'ios/SheetPresentation.swift', 'ios/DatePicker.swift', 'ios/AppearanceBridge.swift', 'ios/ScheduleDateBridge.swift'];
const capabilities = ['connection.list', 'runtime.request', 'features.fixture.identity', 'features.fixture.configure', 'features.fixture.audit', 'appearance.reset', 'appearance.apply', 'schedule.dateContext'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const config = ts.getParsedCommandLineOfConfigFile(path.join(root, 'tsconfig.json'), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: diagnostic => { throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')); } });
const types = ['globals.d.ts', 'assets.d.ts', 'tokens.d.ts'].map(file => path.join(root, '.nsh/types/nsh', file));
const program = ts.createProgram([path.join(repository, entry), ...types], config.options);
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length) throw new Error(ts.formatDiagnostics(diagnostics, { getCanonicalFileName: file => file, getCurrentDirectory: ts.sys.getCurrentDirectory, getNewLine: () => '\n' }));
await mkdir(output, { recursive: true });
const stage = await stageNativeApplication({ root: path.join(output, 'stage'), workspaceRoot: repository, entry });
const sourceSHA256 = {};
for (const [file, value] of Object.entries(stage.manifest.sourceFiles)) sourceSHA256[file] = value.sha256;
async function freeze(relative) {
  const bytes = await readFile(path.join(root, relative)), destination = path.join(stage.cwd, 'source/packages/nsh', relative);
  await mkdir(path.dirname(destination), { recursive: true }); await writeFile(destination, bytes);
  if (!bytes.equals(await readFile(destination))) throw new Error(`Frozen source mismatch: ${relative}`);
  sourceSHA256[`packages/nsh/${relative}`] = hash(bytes); return destination;
}
for (const file of [...nativeSources, 'features-memory-host.js', 'tests/features-uikit/seed.mjs', 'tests/features-uikit/README.md', 'scripts/build-features-uikit.mjs', 'scripts/stage-native-application.mjs']) await freeze(file);
const seed = JSON.stringify(featuresUIKitSeed(), null, 2) + '\n';
await mkdir(path.join(stage.cwd, 'fixture')); await writeFile(path.join(stage.cwd, 'fixture/seed.json'), seed);
const profile = { name, id: bundleID, version: '0.1.0', build: 1, appearance: 'system', theme: 'theme.json', capabilities: { host: capabilities } };
await writeFile(path.join(stage.cwd, 'nsh.json'), JSON.stringify(profile));
const manifest = { buildID, bundleID, entry, sourceSHA256, nativeGraph: stage.manifest, seedSHA256: hash(seed), profileSHA256: hash(JSON.stringify(profile)),
  sourceTypechecked: true, nativeSources, capabilities, syntheticOnly: true, network: false, keychain: false, modelInvocations: false,
  productionUI: ['BotEditor', 'TaskEditor', 'FeaturesTaskHistory'], nativeBridges: ['NativeSheetPresentation', 'NativeDatePicker', 'AppearanceBridge', 'ScheduleDateBridge', 'NativeShell NavStack/AlertDialog/Select'],
  engineStarted: false, installed: false, launched: false, bundleBuilt: false, swiftTypechecked: false, appBuilt: false, uiKitValidated: false };
async function evidence() { await writeFile(path.join(output, 'fixture-build.json'), JSON.stringify(manifest, null, 2) + '\n'); }
await evidence();
function run(command, argv, capture = false) {
  const result = spawnSync(command, argv, { cwd: stage.cwd, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit', timeout: 240_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} failed (${result.status})${capture ? ': ' + result.stderr : ''}`);
  return result.stdout?.trim();
}
async function executable() {
  const value = process.env.NSH_BIN || 'nsh';
  for (const candidate of value.includes('/') ? [path.resolve(value)] : (process.env.PATH ?? '').split(path.delimiter).map(directory => path.join(directory, value))) {
    try { await access(candidate, constants.X_OK); return await realpath(candidate); } catch { /* Try the next existing compiler. */ }
  }
  throw new Error('Set NSH_BIN to an installed compiler; this builder never installs dependencies');
}
async function files(directory, prefix = '') {
  const result = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(prefix, item.name);
    if (item.isDirectory()) result.push(...await files(path.join(directory, item.name), file)); else result.push(file);
  }
  return result.sort();
}
if (!args.includes('--stage-only')) {
  const nsh = await executable();
  if (!args.includes('--sdk-only')) {
    run(nsh, ['build', stage.entry, '--release', '--out', bundle]);
    manifest.bundleBuilt = true; manifest.bundleSHA256 = hash(await readFile(path.join(bundle, 'bundle.nshc')));
    manifest.assetEvidence = await validateNativeApplicationBundle(bundle, stage.manifest);
    manifest.assetSHA256 = Object.fromEntries(await Promise.all((await files(bundle)).map(async file => [file, hash(await readFile(path.join(bundle, file)))])));
    manifest.compilerVersion = run(nsh, ['--version'], true); await evidence();
  }
  if (!args.includes('--bundle-only')) {
    const dist = process.env.NSH_DIST ? path.resolve(process.env.NSH_DIST) : path.resolve(path.dirname(nsh), '..');
    const framework = path.join(dist, 'embed/ios/NativeShell.xcframework/ios-arm64-simulator');
    await access(path.join(framework, 'NativeShell.framework/NativeShell'));
    manifest.publicSwiftInterfaceSHA256 = hash(await readFile(path.join(framework, 'NativeShell.framework/Modules/NativeShell.swiftmodule/arm64-apple-ios-simulator.swiftinterface')));
    manifest.sdkVersion = run('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-version'], true);
    if (Number(manifest.sdkVersion.split('.')[0]) < 26) throw new Error('iOS 26+ SDK required');
    const sdk = run('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path'], true), target = 'arm64-apple-ios15.0-simulator';
    const swiftSources = nativeSources.map(file => path.join(stage.cwd, 'source/packages/nsh', file));
    const swift = ['--sdk', 'iphonesimulator', 'swiftc', '-swift-version', '5', '-parse-as-library', '-sdk', sdk, '-target', target, '-F', framework];
    run('xcrun', [...swift, '-typecheck', ...swiftSources]); manifest.swiftTypechecked = true; await evidence();
    if (!args.includes('--sdk-only')) {
      const staging = path.join(output, `${name}.staging.app`), app = path.join(output, `${name}.app`);
      await mkdir(staging); await cp(bundle, path.join(staging, 'nsh'), { recursive: true }); await cp(path.join(stage.cwd, 'fixture'), path.join(staging, 'fixture'), { recursive: true });
      const fonts = JSON.parse(await readFile(path.join(root, 'assets/fonts/jetbrains-mono/manifest.json'), 'utf8')), fontNames = [];
      for (const [file, sha] of Object.entries(fonts.sha256)) {
        if (!/^(JetBrainsMono-[A-Za-z]+\.ttf|OFL\.txt)$/.test(file)) throw new Error('Invalid font manifest');
        const source = await freeze(`assets/fonts/jetbrains-mono/${file}`);
        if (hash(await readFile(source)) !== sha) throw new Error('Font SHA mismatch');
        const destination = path.join(staging, 'fonts', file); await mkdir(path.dirname(destination), { recursive: true }); await cp(source, destination);
        if (file.endsWith('.ttf')) fontNames.push(`fonts/${file}`);
      }
      await freeze('assets/fonts/jetbrains-mono/manifest.json');
      const frameworks = ['UIKit', 'Foundation', 'Security', 'AVFoundation', 'AVKit', 'QuickLook', 'Speech', 'CoreMedia', 'CoreVideo', 'CoreGraphics', 'CoreText', 'QuartzCore', 'ImageIO', 'Photos', 'PhotosUI', 'UniformTypeIdentifiers', 'WebKit', 'SafariServices', 'Network', 'SystemConfiguration', 'AudioToolbox'];
      run('xcrun', [...swift, '-O', '-framework', 'NativeShell', ...frameworks.flatMap(value => ['-framework', value]), '-lc++', '-lz', '-lsqlite3', '-Xlinker', '-ObjC', ...swiftSources, '-o', path.join(staging, name)]);
      await writeFile(path.join(staging, 'Info.plist'), JSON.stringify({ CFBundleDevelopmentRegion: 'en', CFBundleDisplayName: 'Features UIKit QA', CFBundleExecutable: name, CFBundleIdentifier: bundleID, CFBundleInfoDictionaryVersion: '6.0', CFBundleName: name, CFBundlePackageType: 'APPL', CFBundleShortVersionString: '0.1.0', CFBundleVersion: '1', CFBundleSupportedPlatforms: ['iPhoneSimulator'], MinimumOSVersion: '15.0', LSRequiresIPhoneOS: true, UIDeviceFamily: [1, 2], UILaunchScreen: {}, UIAppFonts: fontNames, FixtureBuildID: buildID, UISupportedInterfaceOrientations: ['UIInterfaceOrientationPortrait', 'UIInterfaceOrientationLandscapeLeft', 'UIInterfaceOrientationLandscapeRight'] }));
      run('plutil', ['-convert', 'xml1', path.join(staging, 'Info.plist')]);
      run('codesign', ['--force', '--sign', '-', '--timestamp=none', staging]); run('codesign', ['--verify', '--strict', staging]);
      await rename(staging, app); manifest.appBuilt = true; manifest.signatureVerified = true; manifest.app = path.relative(root, app); manifest.executableSHA256 = hash(await readFile(path.join(app, name)));
      manifest.appAssetSHA256 = Object.fromEntries(await Promise.all((await files(app)).filter(file => file !== name && !file.startsWith('_CodeSignature/')).map(async file => [file, hash(await readFile(path.join(app, file)))])));
    }
  }
}
await evidence();
console.log(JSON.stringify({ manifest: path.relative(root, path.join(output, 'fixture-build.json')), buildID, bundleID, app: manifest.app ?? null, appBuilt: manifest.appBuilt, swiftTypechecked: manifest.swiftTypechecked }, null, 2));
