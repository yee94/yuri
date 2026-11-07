#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { createRequire } from 'node:module';
import { access, cp, mkdir, readFile, realpath, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), repository = path.resolve(root, '../..');
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('node packages/nsh/scripts/build-new-session-uikit.mjs [--bundle-only]\nNSH_BIN and optional NSH_DIST select the installed compiler/framework. Unique arm64 Simulator App, unchanged production UI, Foundation-only memory Host. Compiles only; never installs, launches, starts an engine, connects or accesses Keychain.');
  process.exit(0);
}
if (args.some(arg => arg !== '--bundle-only')) throw new Error('Only --bundle-only is supported');
const suffix = randomUUID().slice(0, 8), buildID = `${new Date().toISOString().replace(/[:.]/g, '-')}-${suffix}`;
const bundleID = `example.nsh.new-session-uikit.run-${suffix}`, name = 'NewSessionUIKitFixture';
const output = path.join(root, '.nsh/new-session-uikit', buildID), project = path.join(output, 'project'), bundle = path.join(output, 'bundle');
const entry = 'packages/nsh/tests/new-session-uikit/fixture.tsx';
const swiftSources = ['tests/new-session-uikit/SyntheticHost.swift', 'tests/new-session-uikit/uikit-main.swift', 'ios/NewSessionPickerOwners.swift', 'ios/SheetPresentation.swift'];
const capabilities = ['connection.list', 'runtime.request', 'fixture.newSession.capture', 'fixture.newSession.audit'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const config = ts.getParsedCommandLineOfConfigFile(path.join(root, 'tsconfig.json'), {}, {
  ...ts.sys, onUnRecoverableConfigFileDiagnostic: diagnostic => { throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')); },
});
if (!config) throw new Error('Missing fixture TypeScript config');
const types = ['globals.d.ts', 'assets.d.ts', 'tokens.d.ts'].map(file => path.join(root, '.nsh/types/nsh', file));
const diagnostics = ts.getPreEmitDiagnostics(ts.createProgram([path.join(repository, entry), ...types], config.options));
if (diagnostics.length) throw new Error(ts.formatDiagnostics(diagnostics, {
  getCanonicalFileName: file => file, getCurrentDirectory: ts.sys.getCurrentDirectory, getNewLine: () => '\n',
}));
await mkdir(project, { recursive: true });
function run(command, argv, cwd = project, capture = false) {
  const result = spawnSync(command, argv, { cwd, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit', timeout: 240_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} failed (${result.status})${capture ? ': ' + result.stderr : ''}`);
  return result.stdout?.trim();
}
async function executable(value) {
  const candidates = value.includes('/') ? [path.resolve(value)] : (process.env.PATH ?? '').split(path.delimiter).map(dir => path.join(dir, value));
  for (const candidate of candidates) { try { await access(candidate, constants.X_OK); return await realpath(candidate); } catch { /* Continue executable discovery. */ } }
  throw new Error('Cannot find NSH compiler; set NSH_BIN');
}
const nsh = await executable(process.env.NSH_BIN || 'nsh');
const graphDirectory = path.join(output, 'graph'); await mkdir(graphDirectory);
const metafile = path.join(graphDirectory, 'inputs.json');
run('bun', ['build', entry, '--target=browser', '--external=nsh', '--external=nsh/*', '--loader', '.svg:file', '--loader', '.png:file', '--outdir', graphDirectory, `--metafile=${metafile}`], repository, true);
const graph = JSON.parse(await readFile(metafile, 'utf8')).inputs;
// Stage the exact dependency closure, byte-for-byte, under a neutral project
// root. NSH 0.4 otherwise emits absolute asset URLs and omits outside-root images.
// This is build staging, not a second implementation of any UI component.
const sourceSHA256 = {}, dependencyVersions = {}, runtimePackages = new Set();
for (const [source, module] of Object.entries(graph)) {
  const absolute = path.resolve(repository, source), relative = path.relative(repository, absolute);
  if (relative.startsWith('..')) throw new Error('Source escaped workspace');
  // Existing production search/avatar dependencies, not new dependencies. Keep
  // their exact installed packages in this sandbox; never replace their code.
  if (relative.startsWith('node_modules/')) {
    const dependency = relative.match(/\/node_modules\/(fuzzysort|fuse\.js|@dicebear\/(?:core|styles))\//)?.[1];
    if (!dependency) throw new Error(`Unexpected installed dependency: ${relative}`);
    runtimePackages.add(dependency);
    continue;
  }
  if (!relative.startsWith('packages/')) throw new Error(`Unexpected source outside workspace packages: ${relative}`);
  for (const dependency of module.imports) if (dependency.external && !/^nsh(?:\/|$)/.test(dependency.original ?? dependency.path)) throw new Error('Unexpected runtime dependency');
  const destination = path.join(project, 'source', relative);
  const bytes = await readFile(absolute);
  await mkdir(path.dirname(destination), { recursive: true }); await writeFile(destination, bytes);
  sourceSHA256[relative] = hash(bytes);
  if (/\.tsx?$/.test(relative)) {
    const ast = ts.createSourceFile(relative, bytes.toString('utf8'), ts.ScriptTarget.Latest, true);
    for (const statement of ast.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.importClause?.isTypeOnly) continue;
      const bindings = statement.importClause?.namedBindings;
      if (!statement.importClause?.name && bindings && ts.isNamedImports(bindings) && bindings.elements.every(item => item.isTypeOnly)) continue;
      const specifier = statement.moduleSpecifier.text;
      if (!specifier.startsWith('.') && !/^nsh(?:\/|$)/.test(specifier)) runtimePackages.add(specifier);
    }
  }
}
// NSH retains imports of some unused exports that Bun tree-shakes (fuzzySearch
// still imports Fuse). Preserve those existing packages too, without installing.
const require = createRequire(path.join(repository, 'packages/ui/package.json'));
for (const specifier of runtimePackages) {
  const packageName = specifier === '@dicebear/styles/bottts-neutral.json' ? '@dicebear/styles' : specifier;
  if (!['fuzzysort', 'fuse.js', '@dicebear/core', '@dicebear/styles'].includes(packageName)) throw new Error(`Unexpected runtime package: ${specifier}`);
  if (dependencyVersions[packageName]) continue;
  let directory = path.dirname(require.resolve(specifier)), metadata;
  while (directory !== path.dirname(directory)) {
    try { const candidate = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8')); if (candidate.name === packageName) { metadata = candidate; break; } } catch { /* Ascend to the owning package metadata. */ }
    directory = path.dirname(directory);
  }
  if (!metadata) throw new Error(`Missing installed package metadata: ${specifier}`);
  const avatarVersions = { '@dicebear/core': '10.7.0', '@dicebear/styles': '10.6.0' };
  if (packageName in avatarVersions && metadata.version !== avatarVersions[packageName]) throw new Error('Unexpected production DiceBear version; review its native dependency closure');
  await cp(directory, path.join(project, 'node_modules', packageName), { recursive: true });
  dependencyVersions[packageName] = metadata.version;
  for (const file of await files(path.join(project, 'node_modules', packageName))) sourceSHA256[`dependencies/${packageName}/${file}`] = hash(await readFile(path.join(project, 'node_modules', packageName, file)));
}
await rm(graphDirectory, { recursive: true });
await cp(path.join(root, 'theme.json'), path.join(project, 'theme.json'));
sourceSHA256['packages/nsh/theme.json'] = hash(await readFile(path.join(root, 'theme.json')));
await writeFile(path.join(project, 'nsh.json'), JSON.stringify({ name, id: bundleID, version: '0.1.0', build: 1, appearance: 'system', theme: 'theme.json', capabilities: { host: capabilities } }));
await writeFile(path.join(project, 'App.tsx'), `import './source/${entry}';\n`);
run(nsh, ['build', 'App.tsx', '--release', '--out', bundle]);
await access(path.join(bundle, 'bundle.nshc'));
const script = await readFile(path.join(bundle, 'bundle.js'), 'utf8');
if (script.includes(repository) || /asset:\/\/(?:Users|private)\//.test(script)) throw new Error('Non-neutral absolute asset URL in fixture bundle');
async function files(directory, prefix = '') {
  const result = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const relative = path.join(prefix, item.name);
    if (item.isDirectory()) result.push(...await files(path.join(directory, item.name), relative)); else result.push(relative);
  }
  return result;
}
const assets = await files(path.join(bundle, 'assets'));
for (const artwork of ['gpt.svg', 'claude.svg']) if (!assets.some(file => path.basename(file) === artwork)) throw new Error(`Missing original model artwork: ${artwork}`);
for (const match of script.matchAll(/asset:\/\/([^`"']+)/g)) if (!assets.includes(match[1])) throw new Error('An asset URL has no packaged file');
for (const file of await files(bundle)) if (/\.(js|map|json)$/.test(file)) {
  const text = await readFile(path.join(bundle, file), 'utf8');
  if (text.includes(repository) || /asset:\/\/(?:Users|private)\//.test(text)) throw new Error('Non-neutral machine path in bundle metadata');
}
const steps = path.join(root, 'tests/new-session-uikit/README.md');
await cp(steps, path.join(output, 'AX-STEPS.md'));
sourceSHA256['packages/nsh/tests/new-session-uikit/README.md'] = hash(await readFile(steps));
const axContract = path.join(root, 'tests/new-session-uikit/AX-ISOLATION.md');
await cp(axContract, path.join(output, 'AX-ISOLATION.md'));
sourceSHA256['packages/nsh/tests/new-session-uikit/AX-ISOLATION.md'] = hash(await readFile(axContract));
const pickerOwners = path.join(root, 'tests/new-session-uikit/PICKER-NATIVE-OWNERS.md');
await cp(pickerOwners, path.join(output, 'PICKER-NATIVE-OWNERS.md'));
sourceSHA256['packages/nsh/tests/new-session-uikit/PICKER-NATIVE-OWNERS.md'] = hash(await readFile(pickerOwners));
sourceSHA256['packages/nsh/scripts/build-new-session-uikit.mjs'] = hash(await readFile(fileURLToPath(import.meta.url)));
const manifest = { buildID, bundleID, entry: path.relative(root, path.join(repository, entry)), bundle: path.relative(root, bundle), sourceSHA256, dependencyVersions,
  capabilities, assets, acceptanceSteps: path.relative(root, path.join(output, 'AX-STEPS.md')), bundleSHA256: hash(await readFile(path.join(bundle, 'bundle.nshc'))),
  compilerVersion: run(nsh, ['--version'], project, true), transport: 'Swift Foundation-only in-memory synthetic request mapping',
  syntheticOnly: true, network: false, keychain: false, sessionWrites: false, modelInvocations: false,
  presentation: 'production NativeSheet system pageSheet; registered UIKit sheet presentation completion',
  fixtureAdmission: 'synthetic connection.list → production loadConnections adoption; strict fixed expectedHost',
  nativePickerOwners: ['yuri.newSession.inputAX', 'yuri.newSession.presentation', 'yuri.sheet.presentation'],
  sourceTypechecked: true, uiKitAXValidated: false, uiKitVisualValidated: false, uiKitKeyboardValidated: false,
  engineStarted: false, installed: false, launched: false, bundleBuilt: true, swiftTypechecked: false, appBuilt: false };
const seed = path.join(root, 'tests/new-session-uikit/seed.json');
manifest.seedSHA256 = hash(await readFile(seed));
if (!args.includes('--bundle-only')) {
  const dist = process.env.NSH_DIST ? path.resolve(process.env.NSH_DIST) : path.resolve(path.dirname(nsh), '..');
  const framework = path.join(dist, 'embed/ios/NativeShell.xcframework/ios-arm64-simulator');
  await access(path.join(framework, 'NativeShell.framework/NativeShell'));
  const publicInterface = path.join(framework, 'NativeShell.framework/Modules/NativeShell.swiftmodule/arm64-apple-ios-simulator.swiftinterface');
  const interfaceSource = await readFile(publicInterface, 'utf8');
  manifest.publicSwiftInterfaceSHA256 = hash(interfaceSource);
  manifest.publicSwiftWebHostLoader = /func\s+(?:loadWebHost|setWebHost)\b|var\s+webHost\b/.test(interfaceSource);
  const sdk = run('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path'], project, true);
  const sdkVersion = run('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-version'], project, true);
  if (Number(sdkVersion.split('.')[0]) < 26) throw new Error('iOS 26+ SDK required');
  manifest.sdkVersion = sdkVersion; manifest.target = 'arm64-apple-ios15.0-simulator';
  const staging = path.join(output, `${name}.staging.app`), app = path.join(output, `${name}.app`);
  await mkdir(staging); await cp(bundle, path.join(staging, 'nsh'), { recursive: true });
  await mkdir(path.join(staging, 'fixture')); await cp(seed, path.join(staging, 'fixture/seed.json'));
  for (const source of swiftSources) sourceSHA256[`packages/nsh/${source}`] = hash(await readFile(path.join(root, source)));
  sourceSHA256['packages/nsh/tests/new-session-uikit/seed.json'] = manifest.seedSHA256;
  const swift = ['--sdk', 'iphonesimulator', 'swiftc', '-swift-version', '5', '-parse-as-library', '-sdk', sdk, '-target', manifest.target, '-F', framework];
  run('xcrun', [...swift, '-typecheck', ...swiftSources.map(source => path.join(root, source))]); manifest.swiftTypechecked = true;
  const frameworks = ['UIKit', 'Foundation', 'Security', 'AVFoundation', 'AVKit', 'QuickLook', 'Speech', 'CoreMedia', 'CoreVideo', 'CoreGraphics', 'CoreText', 'QuartzCore', 'ImageIO', 'Photos', 'PhotosUI', 'UniformTypeIdentifiers', 'WebKit', 'SafariServices', 'Network', 'SystemConfiguration', 'AudioToolbox'];
  run('xcrun', [...swift, '-O', '-framework', 'NativeShell', ...frameworks.flatMap(value => ['-framework', value]), '-lc++', '-lz', '-lsqlite3', '-Xlinker', '-ObjC',
    ...swiftSources.map(source => path.join(root, source)), '-o', path.join(staging, name)]);
  await writeFile(path.join(staging, 'Info.plist'), JSON.stringify({
    CFBundleDevelopmentRegion: 'en', CFBundleDisplayName: 'New Session UIKit QA', CFBundleExecutable: name, CFBundleIdentifier: bundleID,
    CFBundleInfoDictionaryVersion: '6.0', CFBundleName: name, CFBundlePackageType: 'APPL', CFBundleShortVersionString: '0.1.0', CFBundleVersion: '1',
    CFBundleSupportedPlatforms: ['iPhoneSimulator'], MinimumOSVersion: '15.0', LSRequiresIPhoneOS: true, UIDeviceFamily: [1, 2], UILaunchScreen: {},
    FixtureBuildID: buildID, UISupportedInterfaceOrientations: ['UIInterfaceOrientationPortrait', 'UIInterfaceOrientationLandscapeLeft', 'UIInterfaceOrientationLandscapeRight'],
  }));
  run('plutil', ['-convert', 'xml1', path.join(staging, 'Info.plist')]);
  run('codesign', ['--force', '--sign', '-', '--timestamp=none', staging]);
  run('codesign', ['--verify', '--strict', staging]);
  await rename(staging, app);
  manifest.appBuilt = true; manifest.signatureVerified = true; manifest.app = path.relative(root, app); manifest.executableSHA256 = hash(await readFile(path.join(app, name)));
}
await writeFile(path.join(output, 'fixture-build.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest, null, 2));
