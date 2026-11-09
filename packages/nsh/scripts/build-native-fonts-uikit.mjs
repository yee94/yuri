#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, cp, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { stageNativeApplication, validateNativeApplicationBundle } from './stage-native-application.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), repository = path.resolve(root, '../..');
if (process.argv.includes('--help')) {
  console.log('NSH_BIN=/existing/bin/nsh NSH_FONT_FIXTURE_DIRECTORY=/existing/verified-web-woff2 node packages/nsh/scripts/build-native-fonts-uikit.mjs [--sdk-only]\nBuild only: unique Simulator app, original SDK, production appearance owner + font registry, synthetic CDN reader, no UIAppFonts, install, launch, network or Keychain.');
  process.exit(0);
}
if (process.argv.slice(2).some(arg => arg !== '--sdk-only')) throw new Error('Only --sdk-only is supported');
const id = randomUUID().slice(0, 8), buildID = `${new Date().toISOString().replace(/[:.]/g, '-')}-${id}`;
const name = 'NativeFontsFixture', bundleID = `example.nsh.native-fonts.run-${id}`, entry = 'packages/nsh/tests/native-fonts/fixture.tsx';
const output = path.join(root, '.nsh/native-fonts', buildID), bundle = path.join(output, 'bundle');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const config = ts.getParsedCommandLineOfConfigFile(path.join(root, 'tsconfig.json'), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: diagnostic => { throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')); } });
const program = ts.createProgram([path.join(repository, entry), ...['globals.d.ts', 'assets.d.ts', 'tokens.d.ts'].map(file => path.join(root, '.nsh/types/nsh', file))], config.options);
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length) throw new Error(ts.formatDiagnostics(diagnostics, { getCanonicalFileName: file => file, getCurrentDirectory: ts.sys.getCurrentDirectory, getNewLine: () => '\n' }));
await mkdir(output, { recursive: true });
const stage = await stageNativeApplication({ root: path.join(output, 'stage'), workspaceRoot: repository, entry });
const nativeFiles = ['ios/NativeFontCatalog.swift', 'ios/NativeFontRegistry.swift', 'ios/NativeFontOwner.swift', 'ios/AppearanceBridge.swift', 'tests/native-fonts/FontRunEvidence.swift', 'tests/native-fonts/uikit-main.swift'];
const sourceSHA256 = Object.fromEntries(Object.entries(stage.manifest.sourceFiles).map(([file, value]) => [file, value.sha256]));
for (const relative of [...nativeFiles, 'scripts/build-native-fonts-uikit.mjs', 'tests/native-fonts/README.md']) {
  const bytes = await readFile(path.join(root, relative)), destination = path.join(stage.cwd, 'source/packages/nsh', relative);
  await mkdir(path.dirname(destination), { recursive: true }); await writeFile(destination, bytes);
  sourceSHA256[`packages/nsh/${relative}`] = hash(bytes);
}
const capabilities = ['connection.list', 'runtime.request', 'appearance.reset', 'appearance.apply', 'appearance.fonts.retry', 'font.fixture.audit', 'font.fixture.next'];
await writeFile(path.join(stage.cwd, 'nsh.json'), JSON.stringify({ name, id: bundleID, version: '0.1.0', build: 1, theme: 'theme.json', capabilities: { host: capabilities } }));
async function executable() {
  const value = process.env.NSH_BIN || 'nsh';
  for (const candidate of value.includes('/') ? [path.resolve(value)] : (process.env.PATH ?? '').split(path.delimiter).map(directory => path.join(directory, value))) {
    try { await access(candidate, constants.X_OK); return await realpath(candidate); } catch { /* Try the next installed compiler. */ }
  }
  throw new Error('Set NSH_BIN to an existing compiler; this builder installs nothing');
}
function run(command, args, capture = false) {
  const result = spawnSync(command, args, { cwd: stage.cwd, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit', timeout: 240_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} failed (${result.status})${capture ? ': ' + result.stderr : ''}`);
  return result.stdout?.trim();
}
const nsh = await executable(), dist = process.env.NSH_DIST ? path.resolve(process.env.NSH_DIST) : path.resolve(path.dirname(nsh), '..');
const framework = path.join(dist, 'embed/ios/NativeShell.xcframework/ios-arm64-simulator');
const sdk = run('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path'], true);
const fontRunDiagnostics = process.env.NSH_FONT_RUN_DIAGNOSTICS === '1';
const swift = ['--sdk', 'iphonesimulator', 'swiftc', '-swift-version', '5', '-parse-as-library', '-sdk', sdk, '-target', 'arm64-apple-ios15.0-simulator', '-F', framework,
  ...(fontRunDiagnostics ? ['-D', 'NSH_TEXT_FONT_DIAGNOSTICS'] : [])];
const sources = nativeFiles.map(file => path.join(stage.cwd, 'source/packages/nsh', file));
const manifest = { buildID, bundleID, sourceSHA256, capabilities, nativeGraph: stage.manifest,
  publicSwiftInterfaceSHA256: hash(await readFile(path.join(framework, 'NativeShell.framework/Modules/NativeShell.swiftmodule/arm64-apple-ios-simulator.swiftinterface'))),
  sourceTypechecked: true, swiftTypechecked: false, appBuilt: false, installed: false, launched: false, uiKitValidated: false,
  network: false, syntheticCDNResponses: true, hostFileAPI: false, uiAppFonts: false, keychain: false, textCTRunReadback: false, fontFixtureSHA256: {} };
manifest.textFontDiagnosticsCompiled = fontRunDiagnostics;
const evidence = () => writeFile(path.join(output, 'fixture-build.json'), JSON.stringify(manifest, null, 2) + '\n');
await evidence();
run('xcrun', [...swift, '-typecheck', ...sources]); manifest.swiftTypechecked = true; await evidence();
if (!process.argv.includes('--sdk-only')) {
  const fixtures = process.env.NSH_FONT_FIXTURE_DIRECTORY;
  if (!fixtures) throw new Error('Set NSH_FONT_FIXTURE_DIRECTORY to previously verified public Fontsource WOFF2 files; no download occurs here');
  run(nsh, ['build', stage.entry, '--release', '--out', bundle]);
  manifest.bundleSHA256 = hash(await readFile(path.join(bundle, 'bundle.nshc')));
  manifest.assetEvidence = await validateNativeApplicationBundle(bundle, stage.manifest);
  const staging = path.join(output, `${name}.staging.app`), app = path.join(output, `${name}.app`);
  await mkdir(staging); await cp(bundle, path.join(staging, 'nsh'), { recursive: true }); await mkdir(path.join(staging, 'fixture-fonts'));
  const catalog = await readFile(path.join(root, 'ios/NativeFontCatalog.swift'), 'utf8');
  for (const row of catalog.split('\n').filter(line => /^\s+font\("/.test(line))) {
    const fontID = row.match(/font\("([a-z0-9-]+)"/)?.[1];
    const records = row.match(/"([a-f0-9]{64}:\d+(?: [a-f0-9]{64}:\d+)*)"/)?.[1].split(' ');
    const weights = fontID === 'atkinson-hyperlegible' ? [400, 700] : [400, 500, 600];
    if (!fontID || !records || records.length !== weights.length) throw new Error('Invalid production font catalog row');
    for (const [index, record] of records.entries()) {
      const [expectedHash, length] = record.split(':'), filename = `${fontID}-latin-${weights[index]}-normal.woff2`;
      const bytes = await readFile(path.join(fixtures, filename));
      if (hash(bytes) !== expectedHash || bytes.length !== Number(length)) throw new Error(`Fixture resource identity mismatch: ${filename}`);
      await writeFile(path.join(staging, 'fixture-fonts', filename), bytes); manifest.fontFixtureSHA256[filename] = expectedHash;
    }
  }
  run('xcrun', [...swift, '-O', '-framework', 'NativeShell', ...['UIKit', 'Foundation', 'CoreText', 'CryptoKit', 'Security', 'AVFoundation', 'WebKit', 'SafariServices', 'Network', 'SystemConfiguration', 'AudioToolbox', 'CoreGraphics', 'QuartzCore', 'ImageIO', 'Photos', 'PhotosUI', 'UniformTypeIdentifiers', 'Speech', 'CoreMedia', 'CoreVideo'].flatMap(name => ['-framework', name]), '-lc++', '-lz', '-lsqlite3', '-Xlinker', '-ObjC', ...sources, '-o', path.join(staging, name)]);
  await writeFile(path.join(staging, 'Info.plist'), JSON.stringify({ CFBundleDevelopmentRegion: 'en', CFBundleDisplayName: 'Native Fonts QA', CFBundleExecutable: name, CFBundleIdentifier: bundleID, CFBundleInfoDictionaryVersion: '6.0', CFBundleName: name, CFBundlePackageType: 'APPL', CFBundleShortVersionString: '0.1.0', CFBundleVersion: '1', CFBundleSupportedPlatforms: ['iPhoneSimulator'], MinimumOSVersion: '15.0', LSRequiresIPhoneOS: true, UIDeviceFamily: [1, 2], UILaunchScreen: {}, FixtureBuildID: buildID, UISupportedInterfaceOrientations: ['UIInterfaceOrientationPortrait', 'UIInterfaceOrientationLandscapeLeft', 'UIInterfaceOrientationLandscapeRight'] }));
  run('plutil', ['-convert', 'xml1', path.join(staging, 'Info.plist')]); run('codesign', ['--force', '--sign', '-', '--timestamp=none', staging]); run('codesign', ['--verify', '--strict', staging]);
  await rename(staging, app); manifest.appBuilt = true; manifest.app = path.relative(root, app); manifest.executableSHA256 = hash(await readFile(path.join(app, name))); await evidence();
}
console.log(JSON.stringify({ manifest: path.relative(root, path.join(output, 'fixture-build.json')), app: manifest.app ?? null, bundleID, swiftTypechecked: manifest.swiftTypechecked, appBuilt: manifest.appBuilt }, null, 2));
