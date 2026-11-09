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
  console.log('node packages/nsh/scripts/build-contact-resource-uikit.mjs [--stage-only | --bundle-only]\nIndependent synthetic contact preview fixture. Build/typecheck/link/sign only; never install, launch, engine run, Host/network, credentials, Git or dependency installation.');
  process.exit(0);
}
if (args.length > 1 || args.some(arg => !['--stage-only', '--bundle-only'].includes(arg))) throw Error('Unsupported option');
const buildID = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
const output = path.join(root, '.nsh/contact-resource-uikit', buildID), fixture = 'packages/nsh/tests/contact-resource-uikit', entry = fixture + '/fixture.tsx';
await mkdir(output, { recursive: true });
const stage = await stageNativeApplication({ root: path.join(output, 'frozen'), workspaceRoot: repository, entry });
const hash = value => createHash('sha256').update(value).digest('hex'), sources = { ...stage.manifest.sourceFiles }, inputs = new Map();
async function freeze(relative) {
  const bytes = await readFile(path.join(repository, relative)), target = path.join(stage.cwd, 'source', relative);
  await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, bytes);
  sources[relative] = { bytes: bytes.length, sha256: hash(bytes) }; return bytes.toString('utf8');
}
function run(command, argv, capture = false) {
  const result = spawnSync(command, argv, { cwd: stage.cwd, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit', timeout: 300_000 });
  if (result.error || result.status !== 0) throw Error(String(result.error ?? `${command} failed: ${result.stderr}`));
  return result.stdout?.trim();
}
await freeze('packages/nsh/nsh.json'); await freeze('packages/nsh/theme.json');
const options = ts.getParsedCommandLineOfConfigFile(path.join(root, 'tsconfig.json'), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: value => { throw Error(ts.flattenDiagnosticMessageText(value.messageText, '\n')); } }).options;
const roots = [path.join(repository, entry), ...['globals.d.ts', 'assets.d.ts', 'tokens.d.ts'].map(file => path.join(root, '.nsh/types/nsh', file)), path.join(repository, 'packages/ui/src/types/desktop.d.ts')];
for (const source of ts.createProgram(roots, options).getSourceFiles()) {
  const relative = path.relative(repository, source.fileName);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw Error('Input outside repository');
  if (relative.startsWith('packages/')) inputs.set(source.fileName, await freeze(relative));
  else {
    const bytes = await readFile(source.fileName), target = path.join(output, 'typecheck-inputs', relative);
    await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, bytes);
    sources[relative] = { bytes: bytes.length, sha256: hash(bytes) }; inputs.set(source.fileName, bytes.toString('utf8'));
  }
}
const compilerHost = ts.createCompilerHost(options), originalRead = compilerHost.readFile;
compilerHost.readFile = file => inputs.get(file) ?? originalRead(file);
const diagnostics = ts.getPreEmitDiagnostics(ts.createProgram(roots, options, compilerHost));
if (diagnostics.length) throw Error(ts.formatDiagnostics(diagnostics, { getCanonicalFileName: file => file, getCurrentDirectory: () => repository, getNewLine: () => '\n' }));
const swiftSources = (await readdir(path.join(root, 'ios'))).filter(file => file.endsWith('.swift') && file !== 'main.swift').sort().map(file => 'packages/nsh/ios/' + file);
swiftSources.push('packages/mobile/ios/App/App/YuriViewExportRenderer.swift', fixture + '/uikit-main.swift');
for (const file of [...swiftSources, fixture + '/README.md', 'packages/nsh/scripts/build-contact-resource-uikit.mjs', 'packages/nsh/scripts/stage-native-application.mjs', 'packages/nsh/resource-contact-generation.test.ts', 'packages/nsh/tests/resource-contact-generation-contract.swift', 'packages/nsh/tests/resource-contact-permission-boundary.swift']) await freeze(file);
const name = 'ContactResourceUIKitFixture', bundleID = 'example.nsh.contact-resource.run-' + buildID.slice(-8);
const methods = ['resources.read', 'resources.present', 'resources.release', 'resources.cancel', 'resources.close', 'fixture.contactResource.select', 'fixture.contactResource.reset', 'fixture.contactResource.audit'];
await writeFile(path.join(stage.cwd, 'nsh.json'), JSON.stringify({ name, id: bundleID, version: '0.1.0', build: 1, appearance: 'system', theme: 'theme.json', capabilities: { host: methods } }));
const manifest = { buildID, bundleID, syntheticOnly: true, realHost: false, networkGranted: false, keychain: false, photosPicker: false,
  sourceTypechecked: true, swiftOptimization: 'Onone', sources, swiftSources, installed: false, launched: false, engineStarted: false, appBuilt: false, actualPreviewValidated: false };
if (!args.includes('--stage-only')) {
  const executable = process.env.NSH_BIN || 'nsh'; let nsh;
  for (const candidate of executable.includes('/') ? [path.resolve(executable)] : (process.env.PATH ?? '').split(path.delimiter).map(directory => path.join(directory, executable))) {
    try { await access(candidate, constants.X_OK); nsh = await realpath(candidate); break; } catch { /* Try the next installed compiler. */ }
  }
  if (!nsh) throw Error('Set NSH_BIN to the installed compiler');
  const bundle = path.join(output, 'bundle'); run(nsh, ['build', stage.entry, '--release', '--out', bundle]);
  manifest.bundleSHA256 = hash(await readFile(path.join(bundle, 'bundle.nshc'))); manifest.assetEvidence = await validateNativeApplicationBundle(bundle, stage.manifest);
  if (!args.includes('--bundle-only')) {
    const dist = process.env.NSH_DIST ? path.resolve(process.env.NSH_DIST) : path.resolve(path.dirname(nsh), '..'), framework = path.join(output, 'frameworks');
    await mkdir(framework); await cp(path.join(dist, 'embed/ios/NativeShell.xcframework/ios-arm64-simulator/NativeShell.framework'), path.join(framework, 'NativeShell.framework'), { recursive: true });
    manifest.nativeShellSHA256 = hash(await readFile(path.join(framework, 'NativeShell.framework/NativeShell')));
    const sdk = run('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path'], true), frozen = swiftSources.map(file => path.join(stage.cwd, 'source', file));
    const flags = ['--sdk', 'iphonesimulator', 'swiftc', '-swift-version', '5', '-parse-as-library', '-sdk', sdk, '-target', 'arm64-apple-ios15.0-simulator', '-F', framework];
    run('xcrun', [...flags, '-typecheck', ...frozen]); manifest.swiftTypechecked = true;
    const staging = path.join(output, name + '.staging.app'), app = path.join(output, name + '.app'); await mkdir(staging); await cp(bundle, path.join(staging, 'nsh'), { recursive: true });
    const frameworks = ['UIKit', 'UserNotifications', 'Foundation', 'Security', 'AVFoundation', 'AVKit', 'QuickLook', 'Speech', 'CoreMedia', 'CoreVideo', 'CoreGraphics', 'CoreText', 'QuartzCore', 'ImageIO', 'Photos', 'PhotosUI', 'UniformTypeIdentifiers', 'WebKit', 'SafariServices', 'Network', 'SystemConfiguration', 'AudioToolbox'];
    run('xcrun', [...flags, '-Onone', '-framework', 'NativeShell', ...frameworks.flatMap(value => ['-framework', value]), '-lc++', '-lz', '-lsqlite3', '-Xlinker', '-ObjC', ...frozen, '-o', path.join(staging, name)]);
    await writeFile(path.join(staging, 'Info.plist'), JSON.stringify({ CFBundleDevelopmentRegion: 'en', CFBundleDisplayName: 'Synthetic Contact Preview QA', CFBundleExecutable: name, CFBundleIdentifier: bundleID, CFBundleInfoDictionaryVersion: '6.0', CFBundleName: name, CFBundlePackageType: 'APPL', CFBundleShortVersionString: '0.1.0', CFBundleVersion: '1', CFBundleSupportedPlatforms: ['iPhoneSimulator'], MinimumOSVersion: '15.0', LSRequiresIPhoneOS: true, UIDeviceFamily: [1, 2], UILaunchScreen: {}, FixtureBuildID: buildID, UISupportedInterfaceOrientations: ['UIInterfaceOrientationPortrait'] }));
    run('plutil', ['-convert', 'xml1', path.join(staging, 'Info.plist')]); run('codesign', ['--force', '--sign', '-', '--timestamp=none', staging]); run('codesign', ['--verify', '--strict', staging]);
    await rename(staging, app); manifest.appBuilt = true; manifest.app = app; manifest.executableSHA256 = hash(await readFile(path.join(app, name)));
  }
}
manifest.changedAfterSnapshot = [];
for (const [file, record] of Object.entries(sources)) if (hash(await readFile(path.join(repository, file))) !== record.sha256) manifest.changedAfterSnapshot.push(file);
await writeFile(path.join(output, 'fixture-build.json'), JSON.stringify(manifest, null, 2) + '\n');
if (manifest.changedAfterSnapshot.length) throw Error('Source changed after snapshot; inspect manifest');
console.log(JSON.stringify({ buildID, bundleID, app: manifest.app ?? null, sourceTypechecked: true, swiftTypechecked: manifest.swiftTypechecked ?? false,
  installed: false, launched: false, engineStarted: false, actualPreviewValidated: false, manifest: path.join(output, 'fixture-build.json') }, null, 2));
