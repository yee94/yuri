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
  console.log('node packages/nsh/scripts/build-resource-global-clear-uikit.mjs [--stage-only | --bundle-only]\nIndependent synthetic global-clear UIKit fixture. Default freezes, typechecks, builds and ad-hoc signs only. Never installs, launches, runs an engine, accesses a Host/credentials, or mutates an existing fixture. Controls start disabled.');
  process.exit(0);
}
if (args.length > 1 || args.some(arg => !['--stage-only', '--bundle-only'].includes(arg))) throw Error('Unsupported option');
const buildID = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
const output = path.join(root, '.nsh/resource-global-clear-uikit', buildID), fixture = 'packages/nsh/tests/resource-global-clear-uikit';
await mkdir(output, { recursive: true });
const entry = fixture + '/fixture.tsx';
const stage = await stageNativeApplication({ root: path.join(output, 'frozen'), workspaceRoot: repository, entry });
const hash = value => createHash('sha256').update(value).digest('hex');
const sources = { ...stage.manifest.sourceFiles }, frozenTypes = new Map(), transforms = [];
async function freeze(relative) {
  const bytes = await readFile(path.join(repository, relative)), target = path.join(stage.cwd, 'source', relative);
  await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, bytes);
  sources[relative] = { bytes: bytes.length, sha256: hash(bytes) }; return bytes.toString('utf8');
}
async function generated(relative, text, reason) {
  const raw = await readFile(path.join(repository, relative));
  const original = path.join(output, 'originals', relative); await mkdir(path.dirname(original), { recursive: true }); await writeFile(original, raw);
  await writeFile(path.join(stage.cwd, 'source', relative), text);
  frozenTypes.set(path.join(repository, relative), text);
  transforms.push({ path: relative, originalSHA256: hash(raw), generatedSHA256: hash(text), reason });
}
function run(command, argv, cwd = stage.cwd, capture = false) {
  const result = spawnSync(command, argv, { cwd, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit', timeout: 240_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw Error(`${path.basename(command)} failed (${result.status})${capture ? ': ' + result.stderr : ''}`);
  return result.stdout?.trim();
}
// Preserve original config bytes separately from the fixture's root config.
await freeze('packages/nsh/nsh.json'); await freeze('packages/nsh/theme.json');
const options = ts.getParsedCommandLineOfConfigFile(path.join(root, 'tsconfig.json'), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: value => { throw Error(ts.flattenDiagnosticMessageText(value.messageText, '\n')); } }).options;
const roots = [path.join(repository, entry), ...['globals.d.ts', 'assets.d.ts', 'tokens.d.ts'].map(file => path.join(root, '.nsh/types/nsh', file)), path.join(repository, 'packages/ui/src/types/desktop.d.ts')];
for (const source of ts.createProgram(roots, options).getSourceFiles()) {
  const relative = path.relative(repository, source.fileName);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw Error('Type input outside repository');
  if (relative.startsWith('packages/')) frozenTypes.set(source.fileName, await freeze(relative));
  else {
    const bytes = await readFile(source.fileName), target = path.join(output, 'typecheck-inputs', relative);
    await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, bytes);
    sources[relative] = { bytes: bytes.length, sha256: hash(bytes) }; frozenTypes.set(source.fileName, bytes.toString('utf8'));
  }
}
const application = await freeze('packages/nsh/application.tsx');
const parsed = ts.createSourceFile('application.tsx', application, ts.ScriptTarget.ES2023, true, ts.ScriptKind.TSX);
const effects = [];
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(parsed) === 'effect' && node.getText(parsed).includes('previous = selected')) effects.push(node.getText(parsed));
  ts.forEachChild(node, visit);
}
visit(parsed);
if (effects.length !== 1 || !effects[0].includes('untracked(() => resourceConnectionClear.clear())')) throw Error('Production connection effect changed; review extraction');
await generated(fixture + '/connection-effect.ts', `import { effect, untracked } from 'nsh';\nimport { app } from '../../state';\nimport type { createResourceConnectionClear } from '../../resource-retirement';\nexport function installProductionConnectionEffect<R>(resourceConnectionClear: ReturnType<typeof createResourceConnectionClear<R>>) {\nlet previous: string | undefined;\n${effects[0]};\n}\n`, 'Exact application.tsx connection-ID effect; production clear implementation unchanged');
const nativePath = 'packages/nsh/resource-html-native.tsx';
const rawNative = await freeze(nativePath);
if (!rawNative.includes('export const ResourceHTMLPresentationAnchor = nativeComponent')) throw Error('Native adapter changed; review observer wrapper');
const observedNative = rawNative.replace("import { nativeComponent }", "import { host, nativeComponent }").replace('export const ResourceHTMLPresentationAnchor =', 'const RawResourceHTMLPresentationAnchor =') + `
// Fixture-only observers forward actual SDK events; they never synthesize lifecycle.
export function ResourceHTMLPresentationAnchor(props: Parameters<typeof RawResourceHTMLPresentationAnchor>[0]) {
  const note = (event: string, owner: string, attempt?: number) => host.post('fixture.globalClear.event', { event, owner, ...(attempt === undefined ? {} : { attempt }) });
  return <RawResourceHTMLPresentationAnchor {...props}
    onReady={event => { note('actionRegistrationReady', event.owner); props.onReady?.(event); }}
    onFailed={event => { note('actionRegistrationFailure', event.owner); props.onFailed?.(event); }}
    onOpened={event => { note('controllerOpened', event.owner); props.onOpened?.(event); }}
    onClosed={event => { note('dismissCompleted', event.owner); props.onClosed?.(event); }}
    onCloseFailed={event => { note('closeFailed', event.owner, event.attempt); props.onCloseFailed?.(event); }} />;
}
`;
await generated(nativePath, observedNative, 'Public native component event observer only; forwards actual events to original production props');
const compilerHost = ts.createCompilerHost(options), readOriginal = compilerHost.readFile;
compilerHost.readFile = file => frozenTypes.get(file) ?? readOriginal(file);
const diagnostics = ts.getPreEmitDiagnostics(ts.createProgram(roots, options, compilerHost));
if (diagnostics.length) throw Error(ts.formatDiagnostics(diagnostics, { getCanonicalFileName: file => file, getCurrentDirectory: () => repository, getNewLine: () => '\n' }));
const swiftSources = [], combined = [];
for (const file of (await readdir(path.join(root, 'ios'))).filter(file => file.endsWith('.swift') && file !== 'main.swift').sort()) {
  const relative = 'packages/nsh/ios/' + file, original = await freeze(relative);
  const appendix = file === 'ResourceHTMLComponents.swift' ? 'anchor-gate.swift' : file === 'ResourceBridge.swift' ? 'lease-audit.swift' : undefined;
  if (!appendix) { swiftSources.push(path.join(stage.cwd, 'source', relative)); continue; }
  const extra = await freeze(fixture + '/' + appendix), target = path.join(output, 'generated', file);
  await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, original + '\n' + extra);
  combined.push({ production: relative, originalSHA256: hash(original), appendix: fixture + '/' + appendix, combinedSHA256: hash(original + '\n' + extra) });
  swiftSources.push(target);
}
for (const relative of ['packages/mobile/ios/App/App/YuriViewExportRenderer.swift', fixture + '/SyntheticHost.swift', fixture + '/uikit-main.swift']) {
  await freeze(relative); swiftSources.push(path.join(stage.cwd, 'source', relative));
}
for (const relative of [fixture + '/README.md', fixture + '/check-build.mjs', 'packages/nsh/resource-global-clear-fixture.test.ts', 'packages/nsh/scripts/build-resource-global-clear-uikit.mjs', 'packages/nsh/scripts/stage-native-application.mjs']) await freeze(relative);
const methods = ['connection.list', 'runtime.request', 'resources.read', 'resources.present', 'resources.release', 'resources.cancel', 'resources.close', 'resources.web.present', 'resources.web.close', 'fixture.globalClear.control', 'fixture.globalClear.applied', 'fixture.globalClear.event', 'fixture.globalClear.audit'];
const name = 'ResourceGlobalClearUIKitFixture', bundleID = 'example.nsh.resource-global-clear.run-' + buildID.slice(-8);
await writeFile(path.join(stage.cwd, 'nsh.json'), JSON.stringify({ name, id: bundleID, version: '0.1.0', build: 1, appearance: 'system', theme: 'theme.json', capabilities: { host: methods } }));
const manifest = { buildID, bundleID, syntheticOnly: true, controlsDefaultOff: true, realHost: false, networkGranted: false, credentials: false,
  productionClear: true, productionConnectionEffectSHA256: hash(effects[0]), fullAppRoutesProved: false,
  productionRouteFactory: 'ResourcePreviewPage', guiBypassedByExistingProp: true, eventCapacity: 64,
  sources, transforms, combined, sourceTypechecked: true, installed: false, launched: false, engineStarted: false, appBuilt: false };
if (!args.includes('--stage-only')) {
  let nsh; const executable = process.env.NSH_BIN || 'nsh';
  for (const candidate of executable.includes('/') ? [path.resolve(executable)] : (process.env.PATH ?? '').split(path.delimiter).map(directory => path.join(directory, executable))) {
    try { await access(candidate, constants.X_OK); nsh = await realpath(candidate); break; } catch { /* Try the next installed compiler. */ }
  }
  if (!nsh) throw Error('Set NSH_BIN to the installed distribution');
  const bundle = path.join(output, 'bundle'); run(nsh, ['build', stage.entry, '--release', '--out', bundle]);
  manifest.bundleSHA256 = hash(await readFile(path.join(bundle, 'bundle.nshc'))); manifest.assetEvidence = await validateNativeApplicationBundle(bundle, stage.manifest);
  if (!args.includes('--bundle-only')) {
    const dist = process.env.NSH_DIST ? path.resolve(process.env.NSH_DIST) : path.resolve(path.dirname(nsh), '..'), framework = path.join(output, 'frameworks');
    await mkdir(framework); await cp(path.join(dist, 'embed/ios/NativeShell.xcframework/ios-arm64-simulator/NativeShell.framework'), path.join(framework, 'NativeShell.framework'), { recursive: true });
    manifest.nativeShellSHA256 = hash(await readFile(path.join(framework, 'NativeShell.framework/NativeShell')));
    manifest.publicInterfaceSHA256 = hash(await readFile(path.join(framework, 'NativeShell.framework/Modules/NativeShell.swiftmodule/arm64-apple-ios-simulator.swiftinterface')));
    const sdk = run('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path'], stage.cwd, true);
    const flags = ['--sdk', 'iphonesimulator', 'swiftc', '-swift-version', '5', '-parse-as-library', '-sdk', sdk, '-target', 'arm64-apple-ios15.0-simulator', '-F', framework];
    run('xcrun', [...flags, '-typecheck', ...swiftSources]); manifest.swiftTypechecked = true;
    const staging = path.join(output, name + '.staging.app'), app = path.join(output, name + '.app'); await mkdir(staging);
    await cp(bundle, path.join(staging, 'nsh'), { recursive: true });
    const frameworks = ['UIKit', 'UserNotifications', 'Foundation', 'Security', 'AVFoundation', 'AVKit', 'QuickLook', 'Speech', 'CoreMedia', 'CoreVideo', 'CoreGraphics', 'CoreText', 'QuartzCore', 'ImageIO', 'Photos', 'PhotosUI', 'UniformTypeIdentifiers', 'WebKit', 'SafariServices', 'Network', 'SystemConfiguration', 'AudioToolbox'];
    run('xcrun', [...flags, '-O', '-framework', 'NativeShell', ...frameworks.flatMap(value => ['-framework', value]), '-lc++', '-lz', '-lsqlite3', '-Xlinker', '-ObjC', ...swiftSources, '-o', path.join(staging, name)]);
    await writeFile(path.join(staging, 'Info.plist'), JSON.stringify({ CFBundleDevelopmentRegion: 'en', CFBundleDisplayName: 'Synthetic Global Clear QA', CFBundleExecutable: name, CFBundleIdentifier: bundleID, CFBundleInfoDictionaryVersion: '6.0', CFBundleName: name, CFBundlePackageType: 'APPL', CFBundleShortVersionString: '0.1.0', CFBundleVersion: '1', CFBundleSupportedPlatforms: ['iPhoneSimulator'], MinimumOSVersion: '15.0', LSRequiresIPhoneOS: true, UIDeviceFamily: [1, 2], UILaunchScreen: {}, FixtureBuildID: buildID, UISupportedInterfaceOrientations: ['UIInterfaceOrientationPortrait'] }));
    run('plutil', ['-convert', 'xml1', path.join(staging, 'Info.plist')]); run('codesign', ['--force', '--sign', '-', '--timestamp=none', staging]); run('codesign', ['--verify', '--strict', staging]);
    await rename(staging, app); manifest.appBuilt = true; manifest.app = app; manifest.executableSHA256 = hash(await readFile(path.join(app, name)));
  }
}
manifest.changedAfterSnapshot = [];
for (const [relative, record] of Object.entries(sources)) if (hash(await readFile(path.join(repository, relative))) !== record.sha256) manifest.changedAfterSnapshot.push(relative);
await writeFile(path.join(output, 'fixture-build.json'), JSON.stringify(manifest, null, 2) + '\n');
if (manifest.changedAfterSnapshot.length) throw Error('Source changed after snapshot; inspect fixture-build.json');
console.log(JSON.stringify({ buildID, bundleID, app: manifest.app ?? null, sourceTypechecked: true, swiftTypechecked: manifest.swiftTypechecked ?? false, installed: false, launched: false, engineStarted: false, manifest: path.join(output, 'fixture-build.json') }, null, 2));
