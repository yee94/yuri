import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, cp, mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { stageNativeApplication, validateNativeApplicationBundle } from '../../scripts/stage-native-application.mjs';
import { instrumentPointerRow } from './instrument.mjs';
import { instrumentAssistantPage, instrumentListRow } from '../assistants-list-pointer/instrument.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repository = path.resolve(root, '../..'), args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('node packages/nsh/tests/assistants-pointer/build.mjs [--production-list] [--stage-only | --bundle-only]\nFrozen production row + staged-only bounded pointer trace. --production-list uses actual AssistantHome/List/avatar, read-only synthetic Host, and builds without running engine. Default row fixture includes its focused headless startup check. Never device install/launch, real Host, Git or dependency installation.');
  process.exit(0);
}
if (new Set(args).size !== args.length || args.some(arg => !['--stage-only', '--bundle-only', '--production-list'].includes(arg)) || (args.includes('--stage-only') && args.includes('--bundle-only'))) throw Error('Unsupported option');
const productionList = args.includes('--production-list'), fixture = productionList ? 'assistants-list-pointer' : 'assistants-pointer';
const buildID = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
const output = path.join(root, '.nsh', fixture, buildID);
await mkdir(output, { recursive: true });
const entry = `packages/nsh/tests/${fixture}/fixture.tsx`;
const stage = await stageNativeApplication({ root: path.join(output, 'frozen'), workspaceRoot: repository, entry });
const hash = value => createHash('sha256').update(value).digest('hex');
const sources = { ...stage.manifest.sourceFiles }, instrumented = {};
const row = 'packages/nsh/assistants-swipe.tsx';
const original = await readFile(path.join(stage.cwd, 'source', row), 'utf8');
const patched = productionList ? instrumentListRow(original) : instrumentPointerRow(original);
const patches = new Map([[row, patched]]);
await writeFile(path.join(stage.cwd, 'source', row), patched);
instrumented[row] = { originalSHA256: hash(original), stagedSHA256: hash(patched) };
if (productionList) {
  const page = 'packages/nsh/assistants.tsx', before = await readFile(path.join(stage.cwd, 'source', page), 'utf8');
  const after = instrumentAssistantPage(before);
  await writeFile(path.join(stage.cwd, 'source', page), after); patches.set(page, after);
  instrumented[page] = { originalSHA256: hash(before), stagedSHA256: hash(after) };
}
async function freeze(relative, bytes) {
  bytes ??= await readFile(path.join(repository, relative));
  const target = path.join(stage.cwd, 'source', relative);
  await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, bytes);
  sources[relative] = { bytes: Buffer.byteLength(bytes), sha256: hash(bytes) };
  return target;
}
function run(command, argv, capture = false, input) {
  const result = spawnSync(command, argv, { cwd: stage.cwd, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit', timeout: 240000, input });
  if (result.error || result.status !== 0) throw Error(path.basename(command) + ' failed: ' + (result.stderr ?? result.error?.message ?? result.status));
  return input === undefined ? result.stdout?.trim() : [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
}
const config = ts.getParsedCommandLineOfConfigFile(path.join(root, 'tests', fixture, 'tsconfig.json'), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: diagnostic => { throw Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')); } });
const discovery = ts.createProgram(config.fileNames, config.options), frozen = new Map();
for (const source of discovery.getSourceFiles()) {
  const relative = path.relative(repository, source.fileName);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw Error('Type input outside repository');
  const bytes = patches.get(relative) ?? await readFile(source.fileName, 'utf8');
  if (relative.startsWith('packages/')) await freeze(relative, bytes);
  else {
    const target = path.join(output, 'typecheck-inputs', relative);
    await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, bytes);
  }
  frozen.set(source.fileName, bytes);
}
const host = ts.createCompilerHost(config.options), originalRead = host.readFile;
host.readFile = file => frozen.has(file) ? frozen.get(file) : originalRead(file);
const diagnostics = ts.getPreEmitDiagnostics(ts.createProgram(config.fileNames, config.options, host));
if (diagnostics.length) throw Error(ts.formatDiagnostics(diagnostics, { getCanonicalFileName: value => value, getCurrentDirectory: () => stage.cwd, getNewLine: () => '\n' }));
const swift = await freeze('packages/nsh/tests/assistants-pointer/uikit-main.swift');
const swiftSources = [swift];
if (productionList) {
  swiftSources.push(await freeze('packages/nsh/tests/assistants-list-pointer/SyntheticHost.swift'));
  for (const file of ['instrument.mjs', 'README.md', 'tsconfig.json']) await freeze('packages/nsh/tests/assistants-list-pointer/' + file);
}
for (const file of ['build.mjs', 'instrument.mjs', 'README.md', 'tsconfig.json', 'startup.steps.js']) await freeze('packages/nsh/tests/assistants-pointer/' + file);
await freeze('packages/nsh/scripts/stage-native-application.mjs');
const name = productionList ? 'AssistantListPointerUIKitFixture' : 'AssistantPointerUIKitFixture', bundleID = `example.nsh.${productionList ? 'assistant-list-pointer' : 'assistant-pointer'}.run-` + buildID.slice(-8);
const capabilities = productionList ? { host: ['connection.list', 'runtime.request'] } : {};
await writeFile(path.join(stage.cwd, 'nsh.json'), JSON.stringify({ name, id: bundleID, version: '0.1.0', build: 1, appearance: 'system', theme: 'theme.json', capabilities }));
const manifest = { buildID, bundleID, sources, instrumented, capabilities, fixture, traceLimit: 64, sourceTypechecked: true,
  syntheticOnly: true, realHost: false, keychainAccess: false, installed: false, launched: false, engineStarted: false, appBuilt: false };
if (!args.includes('--stage-only')) {
  let nsh;
  const requested = process.env.NSH_BIN || 'nsh';
  for (const candidate of requested.includes('/') ? [path.resolve(requested)] : (process.env.PATH ?? '').split(path.delimiter).map(dir => path.join(dir, requested))) {
    try { await access(candidate); nsh = await realpath(candidate); break; } catch { /* Discover installed compiler. */ }
  }
  if (!nsh) throw Error('Set NSH_BIN to installed compiler');
  const bundle = path.join(output, 'bundle'); run(nsh, ['build', stage.entry, '--release', '--out', bundle]);
  manifest.bundleSHA256 = hash(await readFile(path.join(bundle, 'bundle.nshc')));
  manifest.assetEvidence = await validateNativeApplicationBundle(bundle, stage.manifest);
  if (!productionList) {
    const steps = await readFile(path.join(stage.cwd, 'source/packages/nsh/tests/assistants-pointer/startup.steps.js'), 'utf8');
    const startup = run(nsh, ['test', stage.entry], true, steps);
    await writeFile(path.join(output, 'headless-startup.log'), startup + '\n');
    if (!startup.includes('POINTER_STARTUP_PASS')) throw Error('Pointer startup verdict missing');
    manifest.engineStarted = true; manifest.headlessStartupPassed = true;
  }
  if (!args.includes('--bundle-only')) {
    const dist = process.env.NSH_DIST ? path.resolve(process.env.NSH_DIST) : path.resolve(path.dirname(nsh), '..');
    const framework = path.join(output, 'frameworks'); await mkdir(framework);
    await cp(path.join(dist, 'embed/ios/NativeShell.xcframework/ios-arm64-simulator/NativeShell.framework'), path.join(framework, 'NativeShell.framework'), { recursive: true });
    manifest.nativeShellSHA256 = hash(await readFile(path.join(framework, 'NativeShell.framework/NativeShell')));
    manifest.publicInterfaceSHA256 = hash(await readFile(path.join(framework, 'NativeShell.framework/Modules/NativeShell.swiftmodule/arm64-apple-ios-simulator.swiftinterface')));
    const sdk = run('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path'], true);
    manifest.sdkVersion = run('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-version'], true);
    const flags = ['--sdk', 'iphonesimulator', 'swiftc', '-swift-version', '5', '-parse-as-library', '-sdk', sdk, '-target', 'arm64-apple-ios15.0-simulator', '-F', framework, ...(productionList ? ['-D', 'ASSISTANT_LIST_POINTER'] : [])];
    run('xcrun', [...flags, '-typecheck', ...swiftSources]); manifest.swiftTypechecked = true;
    const staging = path.join(output, name + '.staging.app'), app = path.join(output, name + '.app');
    await mkdir(staging); await cp(bundle, path.join(staging, 'nsh'), { recursive: true });
    if (!(await stat(path.join(staging, 'nsh/bundle.nshc'))).isFile()) throw Error('Native load resource is not a file');
    manifest.nativeLoadResource = 'nsh/bundle.nshc';
    const frameworks = ['UIKit', 'Foundation', 'Security', 'AVFoundation', 'AVKit', 'QuickLook', 'Speech', 'CoreMedia', 'CoreVideo', 'CoreGraphics', 'CoreText', 'QuartzCore', 'ImageIO', 'Photos', 'PhotosUI', 'UniformTypeIdentifiers', 'WebKit', 'SafariServices', 'Network', 'SystemConfiguration', 'AudioToolbox', 'UserNotifications'];
    run('xcrun', [...flags, '-O', '-framework', 'NativeShell', ...frameworks.flatMap(value => ['-framework', value]), '-lc++', '-lz', '-lsqlite3', '-Xlinker', '-ObjC', ...swiftSources, '-o', path.join(staging, name)]);
    await writeFile(path.join(staging, 'Info.plist'), JSON.stringify({ CFBundleDevelopmentRegion: 'en', CFBundleDisplayName: productionList ? 'Assistant List Pointer UIKit QA' : 'Assistant Pointer UIKit QA', CFBundleExecutable: name, CFBundleIdentifier: bundleID, CFBundleInfoDictionaryVersion: '6.0', CFBundleName: name, CFBundlePackageType: 'APPL', CFBundleShortVersionString: '0.1.0', CFBundleVersion: '1', CFBundleSupportedPlatforms: ['iPhoneSimulator'], MinimumOSVersion: '15.0', LSRequiresIPhoneOS: true, UIDeviceFamily: [1, 2], UILaunchScreen: {}, FixtureBuildID: buildID, UISupportedInterfaceOrientations: ['UIInterfaceOrientationPortrait'] }));
    run('plutil', ['-convert', 'xml1', path.join(staging, 'Info.plist')]);
    run('codesign', ['--force', '--sign', '-', '--timestamp=none', staging]); run('codesign', ['--verify', '--strict', staging]);
    await rename(staging, app); manifest.appBuilt = true; manifest.app = path.relative(root, app);
    manifest.executableSHA256 = hash(await readFile(path.join(app, name)));
  }
}
for (const [relative, evidence] of Object.entries(instrumented)) {
  if (hash(await readFile(path.join(repository, relative))) !== evidence.originalSHA256) throw Error('Production source changed during build');
}
await writeFile(path.join(output, 'fixture-build.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ ...manifest, sources: Object.keys(sources).length, manifest: path.relative(root, path.join(output, 'fixture-build.json')) }, null, 2));
