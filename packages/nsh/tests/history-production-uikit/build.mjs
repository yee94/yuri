import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, cp, mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageNativeApplication, validateNativeApplicationBundle } from '../../scripts/stage-native-application.mjs';
import assert from 'node:assert/strict';
import { runSwiftBuildStage } from './build-process.mjs';
import { createReadStream } from 'node:fs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repo = path.resolve(packageRoot, '../..');
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const methods = ['connection.list', 'feedback.layout', 'runtime.request', 'runtime.stream', 'runtime.stop', 'native.diagnostics.status', 'notification.configure', 'notification.launch.peek', 'speech.prepare', 'speech.stop', 'speech.release', 'speech.voices', 'appearance.reset', 'appearance.apply', 'authorization.cache.ready', 'authorization.cache.list', 'authorization.cache.claim', 'authorization.cache.ack', 'authorization.cache.retry', 'history.qa.ready', 'history.qa.clock', 'history.qa.clockAck'];
const swiftSources = ['tests/history-production-uikit/SyntheticHost.swift', 'tests/history-production-uikit/ClockContract.swift', 'tests/history-production-uikit/Observer.swift', 'tests/history-production-uikit/v4/SnapshotValue.swift', 'tests/history-production-uikit/v4/NativeSnapshotValue.swift', 'tests/history-production-uikit/v4/CoverageReadMemo.swift', 'tests/history-production-uikit/v4/ControlValueSnapshot.swift', 'tests/history-production-uikit/v4/ControlReadContext.swift', 'tests/history-production-uikit/v4/TypedGeometry.swift', 'tests/history-production-uikit/v4/SegmentWriter.swift', 'tests/history-production-uikit/v4/CapturePipeline.swift', 'tests/history-production-uikit/main.swift', 'ios/AppearanceBridge.swift', 'ios/FeedbackLayoutBridge.swift', 'ios/NativeFontCatalog.swift', 'ios/NativeFontRegistry.swift', 'ios/NativeFontOwner.swift', 'ios/SheetPresentation.swift', 'ios/DatePicker.swift', 'ios/ChatHeaderCollapse.swift', 'ios/NewSessionPickerOwners.swift', 'ios/NativeInputMetadataBinding.swift', 'ios/NativeInputMetadataOwner.swift', 'ios/NativeComposerSpellcheckLease.swift', 'ios/NativeComposerSpellcheck.swift', 'ios/AuthorizationCacheCleanup.swift', 'ios/AuthorizationCacheCleanupBridge.swift'];
const toolSources = ['ClockClient.swift', 'PixelMeasure.swift', 'check.py', 'moving-check.py', 'smoke.py', 'SMOKE.md', 'README.md'];

export function experimentOverride(source, enabled) {
  if (!enabled) return source;
  const needle = 'const footerExperiment = signal(false);';
  if (source.split(needle).length !== 2) throw new Error('Expected exactly one explicit production OFF seam');
  return source.replace(needle, 'const footerExperiment = signal(true);');
}
export function validateGrants(value, compiled = false) {
  const expected = compiled ? { network: { hosts: [], http: [] }, process: { execute: [], exit: false, env: [] }, fs: { read: [], write: [] }, statusBar: false, clipboard: false, picker: false, openUrl: false, host: methods } : { host: methods };
  assert.deepEqual(value, expected, 'Fixture capability ceiling mismatch');
}
export async function stageHistoryProduction({ output, scenario = 'terminal', experimentOn = false, observerVersion = 'v3', observerProfile = 'continuous', readPhases = false }) {
  assert.equal(new Set(swiftSources).size, swiftSources.length, 'Duplicate frozen Swift inputs');
  if (!['v3', 'v4'].includes(observerVersion)) throw new Error('Explicit observer version required');
  if (!['continuous', 'identity-only'].includes(observerProfile) || observerProfile === 'identity-only' && (observerVersion !== 'v4' || experimentOn)) throw new Error('Identity-only requires isolated OFF v4');
  if (!['normal', 'terminal', 'partial', 'growth'].includes(scenario)) throw new Error('Invalid history scenario');
  const staged = await stageNativeApplication({ root: path.join(output, 'stage') });
  const application = 'packages/nsh/application.tsx', target = path.join(staged.cwd, 'source', application);
  const original = await readFile(target), modified = Buffer.from(experimentOverride(original.toString('utf8'), experimentOn));
  if (experimentOn) await writeFile(target, modified);
  staged.manifest.sourceFiles[application] = { bytes: modified.length, sha256: hash(modified), upstreamSHA256: hash(original) };
  const sidecarPath = path.join(packageRoot, 'tests/history-production-uikit/sidecar.ts'), sidecar = await readFile(sidecarPath);
  await writeFile(path.join(staged.cwd, 'history-qa.ts'), sidecar);
  await writeFile(path.join(staged.cwd, 'App.tsx'), "import './history-qa';\nimport './source/packages/nsh/App';\n");
  const frozen = {};
  await mkdir(path.join(output, 'native'));
  for (const source of swiftSources) {
    const bytes = await readFile(path.join(packageRoot, source)); frozen[source] = hash(bytes);
    await writeFile(path.join(output, 'native', path.basename(source)), bytes);
  }
  for (const source of ['tests/history-production-uikit/build.mjs', 'tests/history-production-uikit/build-process.mjs', 'tests/history-production-uikit/ClockClient.swift', 'scripts/stage-native-application.mjs']) frozen[source] = hash(await readFile(path.join(packageRoot, source)));
  const tools = {}; await mkdir(path.join(output, 'tools'));
  for (const source of toolSources) {
    const bytes = await readFile(path.join(packageRoot, 'tests/history-production-uikit', source));
    tools[source] = hash(bytes); await writeFile(path.join(output, 'tools', source), bytes);
  }
  if (observerVersion === 'v4') {
    const bytes = await readFile(path.join(packageRoot, 'tests/history-production-uikit/v4/stream_reader.py'));
    tools['stream_reader_v4.py'] = hash(bytes); await writeFile(path.join(output, 'tools/stream_reader_v4.py'), bytes);
  }
  if (observerProfile === 'identity-only') {
    const bytes = await readFile(path.join(packageRoot, 'tests/history-production-uikit/v4/identity_probe.py'));
    tools['identity-probe.py'] = hash(bytes); await writeFile(path.join(output, 'tools/identity-probe.py'), bytes);
  }
  const bundleID = 'example.nsh.history-production.run-' + randomUUID().slice(0, 8);
  const config = { name: 'HistoryProductionUIKit', id: bundleID, version: '0.1.0', build: 1, theme: 'theme.json', appearance: 'system', capabilities: { host: methods } };
  await writeFile(path.join(staged.cwd, 'nsh.json'), JSON.stringify(config));
  const manifest = { schema: 1, buildID: path.basename(output), bundleID, scenario, synthetic: true, original53ptSameScenario: false, experimentOn,
    sourceEntry: 'packages/nsh/App.tsx', unchangedProductionChat: !experimentOn, sourceGraph: staged.manifest, swiftSources: frozen, tools,
    stagedEntrySHA256: hash(await readFile(path.join(staged.cwd, 'App.tsx'))), sidecarSHA256: hash(sidecar), configurationSHA256: hash(JSON.stringify(config)),
    experimentOverride: experimentOn ? { file: application, from: hash(original), to: hash(modified), change: 'only footerExperiment false to true; isolated artifact' } : null,
    capabilities: config.capabilities, protocol: { messages: 500, pageSize: 20, host: 'Foundation-only memory; strict admitted expectedHost', sdkAdoptionIdentity: null },
    startupGate: 'Unchanged NativeStartup; real AuthorizationCacheCleanupBridge with empty pending; root connection rejected until native afterSweep',
    observerContract: 'instrumented-v3; synthetic-ax-id-v3; control-safety-v1; identifier-immediate-readback-v1; explicit prepare-ax accessibilityIdentifier writes; window-header-v1; unchanged pan-read-v1 fields; synthetic diagnostic only; no strict PASS or original53pt closure',
    engineStarted: false, deviceAccessed: false, appBuilt: false, geometryValidated: false, production53ptVerdict: 'unresolved' };
  manifest.observerVersion = observerVersion;
  manifest.observerProfile = observerProfile;
  if (readPhases && observerVersion !== 'v4') throw new Error('Read phases require explicit v4');
  if (observerVersion === 'v4') manifest.readPhases = readPhases;
  if (observerVersion === 'v4') {
    manifest.observerContract = 'history-native-segments-v4; control-safety-v1; identifier-immediate-readback-v1; sibling-subtree-coverage-v1; scroll-insets-v1; native-freeze-v1; control-read-sharing-v2; explicit independent stream reader; no automatic input or strict acceptance';
    manifest.diagnosticRevision = 'control-read-sharing-v2';
    manifest.sdkIdentifierWritePort = 'owned by independent SDK setter port; actual per-object public getter readback remains authoritative';
    manifest.scrollInsetsRevision = 'scroll-insets-v1';
    manifest.captureDirectory = 'history-production-v4/segments';
    manifest.exportBudget = { batchFrames: 16, batchAllocatorBytes: 33554432, accumulatingBatches: 1, encodingBatches: 1, nextReadReservationBytes: 4194304, recentBaselineFrames: 64 };
  }
  if (observerProfile === 'identity-only') {
    manifest.observerContract += '; identity-only-v1; no display-link registration; no mark or automatic input';
    manifest.periodicSampling = false; manifest.historyDriverAdmission = false;
    manifest.identityBaseline = { trigger: 'single explicit prepare-ax only', targetSpanMs: 275, maximumDurationMs: 600, maximumFrames: 24, readBudgetMs: 5, originalStableBaselineMs: 250 };
  }
  await writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return { ...staged, manifest };
}
export async function verifyStage(output, manifest) {
  const project = path.join(output, 'stage/project');
  for (const [name, record] of Object.entries(manifest.sourceGraph.sourceFiles)) {
    const file = ['packages/nsh/nsh.json', 'packages/nsh/theme.json'].includes(name) ? path.join(project, path.basename(name)) : path.join(project, 'source', name);
    if (name === 'packages/nsh/nsh.json') continue; // Exact restrictive fixture config is checked separately.
    if (hash(await readFile(file)) !== record.sha256) throw new Error('Frozen source changed: ' + name);
  }
  for (const [name, dependency] of Object.entries(manifest.sourceGraph.dependencies)) for (const location of dependency.locations) for (const [file, record] of Object.entries(dependency.files)) {
    if (hash(await readFile(path.join(project, location, file))) !== record.sha256) throw new Error('Frozen installed dependency changed: ' + name);
  }
  const config = await readFile(path.join(project, 'nsh.json'));
  if (hash(config) !== manifest.configurationSHA256) throw new Error('Fixture config drift');
  validateGrants(JSON.parse(config).capabilities);
  if (hash(await readFile(path.join(project, 'App.tsx'))) !== manifest.stagedEntrySHA256 || hash(await readFile(path.join(project, 'history-qa.ts'))) !== manifest.sidecarSHA256) throw new Error('Fixture entry/clock sidecar drift');
  for (const name of swiftSources) if (hash(await readFile(path.join(output, 'native', path.basename(name)))) !== manifest.swiftSources[name]) throw new Error('Frozen native source drift');
  for (const [name, expected] of Object.entries(manifest.tools)) if (hash(await readFile(path.join(output, 'tools', name))) !== expected) throw new Error('Frozen offline tool drift');
}
function run(command, args, cwd, capture = false, stage = path.basename(command) + ':' + args[0]) {
  const started = Date.now();
  console.log(JSON.stringify({ stage, phase: 'start', at: new Date(started).toISOString(), timeoutMs: 240000 }));
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit', timeout: 240000 });
  const failed = result.error || result.status !== 0;
  console.log(JSON.stringify({ stage, phase: failed ? 'error' : 'end', at: new Date().toISOString(), elapsedMs: Date.now() - started,
    status: result.status, signal: result.signal, errorStage: failed ? stage : undefined, code: result.error?.code }));
  if (failed) throw new Error(stage + ' failed: ' + (result.error?.message || result.stderr || String(result.status)));
  return result.stdout?.trim();
}
async function executable(name) {
  for (const file of name.includes('/') ? [path.resolve(name)] : (process.env.PATH ?? '').split(path.delimiter).map(dir => path.join(dir, name))) {
    try { await access(file); return await realpath(file); } catch { /* Continue installed compiler discovery. */ }
  }
  throw new Error('Set NSH_BIN to an installed compiler');
}
export async function main(args) {
  if (args.includes('--help')) { console.log('node packages/nsh/scripts/build-history-production-uikit.mjs [--stage-only | --bundle-only] [--scenario normal|terminal|partial|growth] [--experiment-on] [--observer-v4]\nDefault v3; explicit v4 uses an independent directory and stream reader. Compiles only. No install, engine, device, network or dependency installation.'); return; }
  let scenario = 'terminal';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--scenario') { scenario = args[++i]; continue; }
    if (!['--stage-only', '--bundle-only', '--experiment-on', '--observer-v4', '--identity-only', '--read-phases'].includes(args[i])) throw new Error('Unknown argument');
  }
  const output = path.join(packageRoot, args.includes('--identity-only') ? '.nsh/history-production-uikit-v4-identity' : args.includes('--observer-v4') ? '.nsh/history-production-uikit-v4' : '.nsh/history-production-uikit', new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8));
  await mkdir(output, { recursive: true });
  const stage = await stageHistoryProduction({ output, scenario, experimentOn: args.includes('--experiment-on'), observerVersion: args.includes('--observer-v4') ? 'v4' : 'v3', observerProfile: args.includes('--identity-only') ? 'identity-only' : 'continuous', readPhases: args.includes('--read-phases') }), manifest = stage.manifest;
  await verifyStage(output, manifest);
  if (!args.includes('--stage-only')) {
    const nsh = await executable(process.env.NSH_BIN || 'nsh'), bundle = path.join(output, 'bundle');
    manifest.compilerVersion = run(nsh, ['--version'], stage.cwd, true);
    run(nsh, ['build', 'App.tsx', '--release', '--out', bundle], stage.cwd);
    manifest.assets = await validateNativeApplicationBundle(bundle, manifest.sourceGraph);
    validateGrants(JSON.parse(await readFile(path.join(bundle, 'capabilities.json'), 'utf8')), true);
    manifest.capabilitiesSHA256 = hash(await readFile(path.join(bundle, 'capabilities.json')));
    manifest.bundleSHA256 = hash(await readFile(path.join(bundle, 'bundle.nshc')));
    if (!args.includes('--bundle-only')) {
      const dist = process.env.NSH_DIST ? path.resolve(process.env.NSH_DIST) : path.resolve(path.dirname(nsh), '..');
      const framework = path.join(dist, 'embed/ios/NativeShell.xcframework/ios-arm64-simulator');
      const sdk = run('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path'], stage.cwd, true);
      manifest.sdkVersion = run('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-version'], stage.cwd, true);
      const interfaceFile = path.join(framework, 'NativeShell.framework/Modules/NativeShell.swiftmodule/arm64-apple-ios-simulator.swiftinterface');
       manifest.publicSwiftInterfaceSHA256 = hash(await readFile(interfaceFile));
       const frameworkHash = createHash('sha256');
       for await (const chunk of createReadStream(path.join(framework, 'NativeShell.framework/NativeShell'))) frameworkHash.update(chunk);
       manifest.nativeShellFrameworkSHA256 = frameworkHash.digest('hex');
      manifest.target = 'arm64-apple-ios15.0-simulator';
      const app = path.join(output, 'HistoryProductionUIKit.app'), partial = path.join(output, 'HistoryProductionUIKit.partial.app');
      await mkdir(partial); await cp(bundle, path.join(partial, 'nsh'), { recursive: true });
      const fontRoot = path.join(packageRoot, 'assets/fonts/jetbrains-mono'), fonts = JSON.parse(await readFile(path.join(fontRoot, 'manifest.json'), 'utf8'));
      const fontNames = []; manifest.fontSHA256 = {};
      await mkdir(path.join(partial, 'fonts'));
      for (const [file, expected] of Object.entries(fonts.sha256)) {
        if (!/^(JetBrainsMono-[A-Za-z]+\.ttf|OFL\.txt)$/.test(file)) throw new Error('Invalid original font name');
        const bytes = await readFile(path.join(fontRoot, file)); if (hash(bytes) !== expected) throw new Error('Original font checksum mismatch');
        manifest.fontSHA256[file] = expected; await writeFile(path.join(partial, 'fonts', file), bytes); if (file.endsWith('.ttf')) fontNames.push('fonts/' + file);
      }
      const sources = swiftSources.map(file => path.join(output, 'native', path.basename(file)));
      const flags = ['--sdk', 'iphonesimulator', 'swiftc', '-swift-version', '5', '-parse-as-library', '-sdk', sdk, '-target', manifest.target, '-F', framework];
       await runSwiftBuildStage('xcrun', [...flags, '-typecheck', ...sources], stage.cwd, { stage: 'swift-typecheck' });
      const frameworks = ['UIKit', 'UserNotifications', 'Foundation', 'Security', 'AVFoundation', 'AVKit', 'QuickLook', 'Speech', 'CoreMedia', 'CoreVideo', 'CoreGraphics', 'CoreText', 'QuartzCore', 'ImageIO', 'Photos', 'PhotosUI', 'UniformTypeIdentifiers', 'WebKit', 'SafariServices', 'Network', 'SystemConfiguration', 'AudioToolbox'];
       await runSwiftBuildStage('xcrun', [...flags, '-O', '-framework', 'NativeShell', ...frameworks.flatMap(name => ['-framework', name]), '-lc++', '-lz', '-lsqlite3', '-Xlinker', '-ObjC', ...sources, '-o', path.join(partial, 'HistoryProductionUIKit')], stage.cwd, { stage: 'swift-optimized-link', timeoutMs: 600000 });
      await writeFile(path.join(partial, 'Info.plist'), JSON.stringify({ CFBundleExecutable: 'HistoryProductionUIKit', CFBundleIdentifier: manifest.bundleID, CFBundleName: 'HistoryProductionUIKit', CFBundleDisplayName: 'History Production QA', CFBundlePackageType: 'APPL', CFBundleVersion: '1', CFBundleShortVersionString: '0.1.0', CFBundleSupportedPlatforms: ['iPhoneSimulator'], MinimumOSVersion: '15.0', LSRequiresIPhoneOS: true, UIDeviceFamily: [1, 2], UILaunchScreen: {}, UIAppFonts: fontNames, HistoryBuildID: manifest.buildID, HistoryScenario: scenario, UISupportedInterfaceOrientations: ['UIInterfaceOrientationPortrait', 'UIInterfaceOrientationLandscapeLeft', 'UIInterfaceOrientationLandscapeRight'] }));
       run('plutil', ['-insert', 'HistoryObserverSchema', '-string', manifest.observerVersion, path.join(partial, 'Info.plist')], stage.cwd);
       if (manifest.diagnosticRevision) run('plutil', ['-insert', 'HistoryDiagnosticRevision', '-string', manifest.diagnosticRevision, path.join(partial, 'Info.plist')], stage.cwd);
       if (manifest.readPhases) run('plutil', ['-insert', 'HistoryReadPhases', '-bool', 'true', path.join(partial, 'Info.plist')], stage.cwd);
       run('plutil', ['-insert', 'HistoryObserverProfile', '-string', manifest.observerProfile, path.join(partial, 'Info.plist')], stage.cwd);
       run('plutil', ['-convert', 'xml1', path.join(partial, 'Info.plist')], stage.cwd);
      run('codesign', ['--force', '--sign', '-', '--timestamp=none', partial], stage.cwd); run('codesign', ['--verify', '--deep', '--strict', partial], stage.cwd);
      await rename(partial, app); manifest.appBuilt = true; manifest.app = path.basename(app); manifest.executableSHA256 = hash(await readFile(path.join(app, 'HistoryProductionUIKit')));
      run('xcrun', ['--sdk', 'macosx', 'swiftc', '-O', '-swift-version', '5', path.join(output, 'native/SyntheticHost.swift'), path.join(output, 'tools/ClockClient.swift'), '-o', path.join(output, 'tools/clock-client')], stage.cwd);
      run('xcrun', ['--sdk', 'macosx', 'swiftc', '-O', '-swift-version', '5', path.join(output, 'tools/PixelMeasure.swift'), '-o', path.join(output, 'tools/pixel-measure')], stage.cwd);
      manifest.toolBinaries = Object.fromEntries(await Promise.all(['clock-client', 'pixel-measure'].map(async file => [file, hash(await readFile(path.join(output, 'tools', file)))])));
    }
    await verifyStage(output, manifest);
  }
  await writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ output: path.relative(repo, output), manifest: path.relative(repo, path.join(output, 'manifest.json')), buildID: manifest.buildID, bundleID: manifest.bundleID,
    sourceFiles: Object.keys(manifest.sourceGraph.sourceFiles).length, installedDependencies: Object.keys(manifest.sourceGraph.dependencies).length, scenario, experimentOn: manifest.experimentOn,
    appBuilt: manifest.appBuilt, engineStarted: false, deviceAccessed: false, production53ptVerdict: 'unresolved' }, null, 2));
}
