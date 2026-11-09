import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, cp, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageHistoryProduction } from '../history-production-uikit/build.mjs';
import { validateNativeApplicationBundle } from '../../scripts/stage-native-application.mjs';
import { instrumentProjects, instrumentHome } from './instrument.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const buildID = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
const output = path.join(root, '.nsh/projects-insets-full-uikit', buildID);
await mkdir(output, { recursive: true });
let manifest = { buildID, diagnosticStage: 'freeze', errors: [], appBuilt: false };
const save = () => writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2));
function run(command, args, cwd, timeout = 240000) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout });
  if (result.error || result.status !== 0) throw new Error(`${path.basename(command)} ${args[0]} failed: ${result.error?.message ?? result.stderr}`);
  if (result.stderr) console.error(result.stderr);
  return result.stdout.trim();
}
try {
  await save();
  const staged = await stageHistoryProduction({ output, scenario: 'normal', experimentOn: false, observerVersion: 'v4', observerProfile: 'identity-only' });
  manifest = { ...staged.manifest, diagnosticStage: 'instrument', errors: [], purpose: 'Full real Home/Nav/Tab and NativeAppearanceSync, same history synthetic Host; public native/core geometry diagnosis', geometryValidated: false, installed: false, launched: false, productionSourceModified: false, instrumentation: [], fixtureNativeSourceSHA256: {} };
  manifest.bundleID = 'example.nsh.projects-insets-full.run-' + randomUUID().slice(0, 8);
  const project = staged.cwd, sourcePath = name => path.join(project, 'source/packages/nsh', name);
  const upstreamProjects = await readFile(sourcePath('projects.tsx'), 'utf8');
  manifest.consumerMarker = 'projects-home-split-source-' + hash(upstreamProjects).slice(0, 20) + '-' + randomUUID().slice(0, 8);
  const patchSource = async (name, transform) => {
    const file = sourcePath(name), original = await readFile(file, 'utf8'), changed = transform(original);
    await writeFile(file, changed); const key = 'packages/nsh/' + name;
    manifest.sourceGraph.sourceFiles[key] = { bytes: Buffer.byteLength(changed), sha256: hash(changed), upstreamSHA256: hash(original) };
    manifest.instrumentation.push({ file: key, upstreamSHA256: hash(original), instrumentedSHA256: hash(changed) });
  };
  await patchSource('projects.tsx', original => instrumentProjects(original, manifest.consumerMarker));
  await patchSource('application.tsx', instrumentHome);
  const probeName = 'tests/projects-insets-uikit/probe.tsx', probe = await readFile(path.join(root, probeName));
  await mkdir(path.dirname(sourcePath(probeName)), { recursive: true }); await writeFile(sourcePath(probeName), probe);
  manifest.sourceGraph.sourceFiles['packages/nsh/' + probeName] = { bytes: probe.length, sha256: hash(probe) };
  const entryFile = path.join(project, 'App.tsx'), entry = await readFile(entryFile, 'utf8');
  await writeFile(entryFile, "import { installCapture } from './source/packages/nsh/tests/projects-insets-uikit/probe';\ninstallCapture();\n" + entry);
  manifest.stagedEntrySHA256 = hash(await readFile(entryFile));
  const patchNative = async (name, transform) => {
    const target = path.join(output, 'native', path.basename(name)), original = await readFile(target, 'utf8'), changed = transform(original);
    await writeFile(target, changed); manifest.swiftSources[name] = hash(changed);
    manifest.instrumentation.push({ file: name, upstreamSHA256: hash(original), instrumentedSHA256: hash(changed) });
  };
  const replaceOne = (source, before, after) => { if (source.split(before).length !== 2) throw new Error('Expected exactly one frozen native seam: ' + before); return source.replace(before, after); };
  await patchNative('tests/history-production-uikit/main.swift', source => {
    source = replaceOne(source, 'private let surface = NshAppView()', 'private let surface = NshAppView()\n    private var insetsObservation: FullInsetsObservation?');
    return replaceOne(source, 'appearance = AppearanceBridge(app: surface, selectedHost: { HistoryProductionHost.hostID })', 'insetsObservation = FullInsetsObservation(surface: surface)\n            appearance = AppearanceBridge(app: surface, selectedHost: { HistoryProductionHost.hostID })');
  });
  await patchNative('ios/AppearanceBridge.swift', source => {
    source = replaceOne(source, 'return try self.apply(input)', 'FullInsetsObservation.current?.capture("appearance.apply.before")\n            let result = try self.apply(input)\n            FullInsetsObservation.current?.capture("appearance.apply.after")\n            FullInsetsObservation.current?.schedule("appearance.apply.settled")\n            return result');
    return replaceOne(source, 'try app.setThemeOverrides(json)', 'FullInsetsObservation.current?.capture("theme.override.before")\n        try app.setThemeOverrides(json)\n        FullInsetsObservation.current?.capture("theme.override.after")\n        FullInsetsObservation.current?.schedule("theme.override.settled")');
  });
  const extra = 'tests/projects-insets-uikit/FullObservation.swift', extraBytes = await readFile(path.join(root, extra));
  await writeFile(path.join(output, 'native/FullObservation.swift'), extraBytes); manifest.fixtureNativeSourceSHA256[extra] = hash(extraBytes);
  for (const name of ['build-full.mjs', 'instrument.mjs', 'read-full-report.mjs', 'probe.tsx']) {
    const bytes = await readFile(path.join(root, 'tests/projects-insets-uikit', name));
    await writeFile(path.join(output, 'tools', name), bytes); manifest.tools[name] = hash(bytes);
  }
  const configFile = path.join(project, 'nsh.json'), config = JSON.parse(await readFile(configFile, 'utf8'));
  config.id = manifest.bundleID; config.name = 'ProjectsInsetsFullUIKit'; config.capabilities.host.push('fixture.insets.report', 'fixture.insets.consumer');
  await writeFile(configFile, JSON.stringify(config)); manifest.configurationSHA256 = hash(JSON.stringify(config)); manifest.capabilities = config.capabilities;
  manifest.diagnosticStage = 'verify-freeze'; await save();
  async function verifyFreeze() {
    for (const [name, record] of Object.entries(manifest.sourceGraph.sourceFiles)) {
      if (name === 'packages/nsh/nsh.json') continue;
      const file = name === 'packages/nsh/theme.json' ? path.join(project, 'theme.json') : path.join(project, 'source', name);
      if (hash(await readFile(file)) !== record.sha256) throw new Error('Frozen source mismatch: ' + name);
    }
    for (const [name, expected] of Object.entries(manifest.swiftSources)) if (name.endsWith('.swift') && name !== 'tests/history-production-uikit/ClockClient.swift') {
      if (hash(await readFile(path.join(output, 'native', path.basename(name)))) !== expected) throw new Error('Frozen native mismatch: ' + name);
    }
    if (hash(await readFile(configFile)) !== manifest.configurationSHA256 || hash(await readFile(entryFile)) !== manifest.stagedEntrySHA256) throw new Error('Config/entry drift');
  }
  await verifyFreeze();
  const nsh = process.env.NSH_BIN; if (!nsh) throw new Error('Explicit NSH_BIN required');
  manifest.compilerVersion = run(nsh, ['--version'], project); manifest.compilerExecutableSHA256 = hash(await readFile(nsh));
  const framework = path.join(process.env.NSH_DIST || path.resolve(path.dirname(nsh), '..'), 'embed/ios/NativeShell.xcframework/ios-arm64-simulator');
  manifest.publicSwiftInterfaceSHA256 = hash(await readFile(path.join(framework, 'NativeShell.framework/Modules/NativeShell.swiftmodule/arm64-apple-ios-simulator.swiftinterface')));
  manifest.diagnosticStage = 'nsh-build'; await save(); const bundle = path.join(output, 'bundle'); run(nsh, ['build', 'App.tsx', '--release', '--out', bundle], project);
  manifest.assets = await validateNativeApplicationBundle(bundle, manifest.sourceGraph);
  const script = await readFile(path.join(bundle, 'bundle.js'), 'utf8');
  manifest.packedJSConsumerMarkerPresent = script.includes(manifest.consumerMarker);
  manifest.packedJSProbeSelectorsPresent = ['production-shell', 'home-safe-area', 'production-content', 'fixture.insets.consumer'].every(key => script.includes(key));
  if (!manifest.packedJSConsumerMarkerPresent || !manifest.packedJSProbeSelectorsPresent) throw new Error('Packed JS did not retain exact ProjectsHome consumer marker/wrapper probes');
  manifest.packedJSSHA256 = hash(script); manifest.bundleSHA256 = hash(await readFile(path.join(bundle, 'bundle.nshc')));
  const builtCapabilities = JSON.parse(await readFile(path.join(bundle, 'capabilities.json'), 'utf8'));
  if (JSON.stringify(builtCapabilities.host) !== JSON.stringify(config.capabilities.host)) throw new Error('Compiled capability ceiling drift');
  manifest.diagnosticStage = 'swift-typecheck'; await save();
  const sdk = run('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path'], project);
  const sources = (await readdir(path.join(output, 'native'))).filter(name => name.endsWith('.swift')).map(name => path.join(output, 'native', name));
  const flags = ['--sdk', 'iphonesimulator', 'swiftc', '-swift-version', '5', '-parse-as-library', '-sdk', sdk, '-target', 'arm64-apple-ios15.0-simulator', '-F', framework];
  run('xcrun', [...flags, '-typecheck', ...sources], project);
  const partial = path.join(output, 'ProjectsInsetsFullUIKit.partial.app'), app = path.join(output, 'ProjectsInsetsFullUIKit.app'); await mkdir(partial); await cp(bundle, path.join(partial, 'nsh'), { recursive: true });
  const fontRoot = path.join(root, 'assets/fonts/jetbrains-mono'), fonts = JSON.parse(await readFile(path.join(fontRoot, 'manifest.json'), 'utf8')), fontNames = []; manifest.fontSHA256 = {};
  await mkdir(path.join(partial, 'fonts'));
  for (const [file, expected] of Object.entries(fonts.sha256)) { const bytes = await readFile(path.join(fontRoot, file)); if (hash(bytes) !== expected) throw new Error('Font checksum mismatch'); await writeFile(path.join(partial, 'fonts', file), bytes); manifest.fontSHA256[file] = expected; if (file.endsWith('.ttf')) fontNames.push('fonts/' + file); }
  const frameworks = ['UIKit', 'UserNotifications', 'Foundation', 'Security', 'AVFoundation', 'AVKit', 'QuickLook', 'Speech', 'CoreMedia', 'CoreVideo', 'CoreGraphics', 'CoreText', 'QuartzCore', 'ImageIO', 'Photos', 'PhotosUI', 'UniformTypeIdentifiers', 'WebKit', 'SafariServices', 'Network', 'SystemConfiguration', 'AudioToolbox'];
  manifest.diagnosticStage = 'swift-link'; await save(); run('xcrun', [...flags, '-O', '-framework', 'NativeShell', ...frameworks.flatMap(name => ['-framework', name]), '-lc++', '-lz', '-lsqlite3', '-Xlinker', '-ObjC', ...sources, '-o', path.join(partial, 'ProjectsInsetsFullUIKit')], project, 600000);
  await writeFile(path.join(partial, 'Info.plist'), JSON.stringify({ CFBundleExecutable: 'ProjectsInsetsFullUIKit', CFBundleIdentifier: manifest.bundleID, CFBundleName: 'ProjectsInsetsFullUIKit', CFBundleDisplayName: 'Projects Full Geometry', CFBundlePackageType: 'APPL', CFBundleVersion: '1', CFBundleShortVersionString: '0.1.0', CFBundleSupportedPlatforms: ['iPhoneSimulator'], MinimumOSVersion: '15.0', LSRequiresIPhoneOS: true, UIDeviceFamily: [1, 2], UILaunchScreen: {}, UIAppFonts: fontNames, HistoryBuildID: buildID, HistoryScenario: 'normal', HistoryObserverSchema: 'v4', HistoryObserverProfile: 'identity-only', HistoryDiagnosticRevision: 'native-freeze-v1', HistoryInsetsMarker: manifest.consumerMarker, UISupportedInterfaceOrientations: ['UIInterfaceOrientationPortrait', 'UIInterfaceOrientationLandscapeLeft', 'UIInterfaceOrientationLandscapeRight'] }));
  run('plutil', ['-convert', 'xml1', path.join(partial, 'Info.plist')], project); run('codesign', ['--force', '--sign', '-', '--timestamp=none', partial], project); run('codesign', ['--verify', '--deep', '--strict', partial], project);
  await rename(partial, app); manifest.appBuilt = true; manifest.app = path.basename(app); manifest.executableSHA256 = hash(await readFile(path.join(app, 'ProjectsInsetsFullUIKit'))); await verifyFreeze(); manifest.diagnosticStage = 'complete'; await save();
  console.log(JSON.stringify({ output, bundleID: manifest.bundleID, consumerMarker: manifest.consumerMarker, bundleSHA256: manifest.bundleSHA256, executableSHA256: manifest.executableSHA256, appBuilt: true, deviceAccessed: false }, null, 2));
} catch (error) { manifest.errors.push({ stage: manifest.diagnosticStage, message: String(error) }); await save(); throw error; }
