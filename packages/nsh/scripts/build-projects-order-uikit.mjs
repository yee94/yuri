#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, cp, mkdir, readFile, realpath, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), repository = path.resolve(root, '../..');
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('node packages/nsh/scripts/build-projects-order-uikit.mjs [--stage-only | --bundle-only]\nIndependent Projects UIKit fixture. --stage-only typechecks and stages exact source bytes/SHA without invoking NSH, Swift, signing, engine or device. Default compiles and ad-hoc signs a unique Simulator App; never installs or launches. NSH_BIN/NSH_DIST select the installed compiler/framework.');
  process.exit(0);
}
if (args.some(arg => !['--stage-only', '--bundle-only'].includes(arg)) || args.length > 1) throw new Error('Use at most one of --stage-only or --bundle-only');
const suffix = randomUUID().slice(0, 8), buildID = `${new Date().toISOString().replace(/[:.]/g, '-')}-${suffix}`;
const name = 'ProjectsOrderUIKitFixture', bundleID = `example.nsh.projects-order-uikit.run-${suffix}`;
const output = path.join(root, '.nsh/projects-order-uikit', buildID), project = path.join(output, 'project'), bundle = path.join(output, 'bundle');
const entry = 'packages/nsh/tests/projects-order-uikit/fixture.tsx';
const nativeSources = ['tests/projects-order-uikit/SyntheticHost.swift', 'tests/projects-order-uikit/uikit-main.swift', 'ios/SheetPresentation.swift'];
const capabilities = ['connection.list', 'runtime.request', 'fixture.projectsOrder.audit'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceSHA256 = {}, dependencyVersions = {}, staged = new Set(), runtimePackages = new Set();
const config = ts.getParsedCommandLineOfConfigFile(path.join(root, 'tsconfig.json'), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: error => { throw new Error(ts.flattenDiagnosticMessageText(error.messageText, '\n')); } });
if (!config) throw new Error('Missing Projects TypeScript config');
const types = ['globals.d.ts', 'assets.d.ts', 'tokens.d.ts'].map(file => path.join(root, '.nsh/types/nsh', file));
const diagnostics = ts.getPreEmitDiagnostics(ts.createProgram([path.join(repository, entry), ...types], config.options));
if (diagnostics.length) throw new Error(ts.formatDiagnostics(diagnostics, { getCanonicalFileName: file => file, getCurrentDirectory: ts.sys.getCurrentDirectory, getNewLine: () => '\n' }));
await mkdir(project, { recursive: true });
function run(command, argv, cwd = project, capture = false) {
  const result = spawnSync(command, argv, { cwd, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit', timeout: 240_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} failed (${result.status})${capture ? ': ' + result.stderr : ''}`);
  return result.stdout?.trim();
}
async function files(directory, prefix = '') {
  const result = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const relative = path.join(prefix, item.name);
    if (item.isDirectory()) result.push(...await files(path.join(directory, item.name), relative)); else result.push(relative);
  }
  return result;
}
async function stage(absolute) {
  const relative = path.relative(repository, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Source escaped repository');
  if (!relative.startsWith('packages/')) throw new Error(`Unexpected source: ${relative}`);
  if (staged.has(relative)) return;
  staged.add(relative);
  const bytes = await readFile(absolute), destination = path.join(project, 'source', relative);
  await mkdir(path.dirname(destination), { recursive: true }); await writeFile(destination, bytes);
  if (!bytes.equals(await readFile(destination))) throw new Error(`Stage byte mismatch: ${relative}`);
  sourceSHA256[relative] = hash(bytes);
  if (!/\.tsx?$/.test(relative)) return;
  // NSH may retain imports that Bun tree-shakes; walk all value imports too.
  const ast = ts.createSourceFile(relative, bytes.toString('utf8'), ts.ScriptTarget.Latest, true);
  for (const statement of ast.statements) {
    if (!(ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) || !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier) || statement.isTypeOnly || ('importClause' in statement && statement.importClause?.isTypeOnly)) continue;
    const binding = 'importClause' in statement ? statement.importClause?.namedBindings : undefined;
    if ('importClause' in statement && !statement.importClause?.name && binding && ts.isNamedImports(binding) && binding.elements.every(item => item.isTypeOnly)) continue;
    const specifier = statement.moduleSpecifier.text;
    if (/^nsh(?:\/|$)/.test(specifier)) continue;
    if (!specifier.startsWith('.') && !specifier.startsWith('@/')) { runtimePackages.add(specifier); continue; }
    const direct = specifier.startsWith('@/') ? path.join(repository, 'packages/ui/src', specifier.slice(2)) : path.resolve(path.dirname(absolute), specifier);
    let resolved;
    for (const candidate of [direct, ...['.ts', '.tsx', '.js', '.json', '/index.ts', '/index.tsx'].map(suffix => direct + suffix)]) {
      try { const value = await readFile(candidate); if (value) { resolved = candidate; break; } } catch (error) { if (!['ENOENT', 'EISDIR'].includes(error.code)) throw error; }
    }
    if (!resolved) throw new Error(`Unresolved staged import ${specifier} in ${relative}`);
    await stage(resolved);
  }
}
const graphDirectory = path.join(output, 'graph'); await mkdir(graphDirectory);
const metafile = path.join(graphDirectory, 'inputs.json');
run('bun', ['build', entry, '--target=browser', '--external=nsh', '--external=nsh/*', '--loader', '.svg:file', '--loader', '.png:file', '--outdir', graphDirectory, `--metafile=${metafile}`], repository, true);
const graph = JSON.parse(await readFile(metafile, 'utf8')).inputs;
for (const [source, module] of Object.entries(graph)) {
  const absolute = path.resolve(repository, source), relative = path.relative(repository, absolute);
  if (relative.startsWith('node_modules/')) {
    const dependency = relative.match(/\/node_modules\/(fuzzysort|fuse\.js|@dicebear\/(?:core|styles))\//)?.[1];
    if (!dependency) throw new Error(`Unexpected installed dependency: ${relative}`);
    runtimePackages.add(dependency); continue;
  }
  for (const imported of module.imports) if (imported.external && !/^nsh(?:\/|$)/.test(imported.original ?? imported.path)) throw new Error('Unexpected runtime external');
  await stage(absolute);
}
const require = createRequire(path.join(repository, 'packages/ui/package.json'));
for (const specifier of runtimePackages) {
  const packageName = specifier === '@dicebear/styles/bottts-neutral.json' ? '@dicebear/styles' : specifier;
  if (!['fuzzysort', 'fuse.js', '@dicebear/core', '@dicebear/styles'].includes(packageName)) throw new Error(`Unexpected runtime package: ${specifier}`);
  if (dependencyVersions[packageName]) continue;
  let directory = path.dirname(require.resolve(specifier)), metadata;
  while (directory !== path.dirname(directory)) {
    try { const candidate = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8')); if (candidate.name === packageName) { metadata = candidate; break; } } catch { /* Ascend to the owning installed package. */ }
    directory = path.dirname(directory);
  }
  if (!metadata) throw new Error(`Missing installed dependency metadata: ${specifier}`);
  const destination = path.join(project, 'node_modules', packageName); await cp(directory, destination, { recursive: true }); dependencyVersions[packageName] = metadata.version;
  for (const file of await files(destination)) {
    const original = await readFile(path.join(directory, file)), copied = await readFile(path.join(destination, file));
    if (!original.equals(copied)) throw new Error('Dependency stage byte mismatch'); sourceSHA256[`dependencies/${packageName}/${file}`] = hash(copied);
  }
}
await rm(graphDirectory, { recursive: true });
for (const source of nativeSources) await stage(path.join(root, source));
await stage(path.join(root, 'tests/projects-order-uikit/seed.json')); await stage(path.join(root, 'tests/projects-order-uikit/README.md'));
const theme = await readFile(path.join(root, 'theme.json')); await writeFile(path.join(project, 'theme.json'), theme); sourceSHA256['packages/nsh/theme.json'] = hash(theme);
await stage(fileURLToPath(import.meta.url));
await writeFile(path.join(project, 'nsh.json'), JSON.stringify({ name, id: bundleID, version: '0.1.0', build: 1, appearance: 'system', theme: 'theme.json', capabilities: { host: capabilities } }));
await writeFile(path.join(project, 'App.tsx'), `import './source/${entry}';\n`);
const manifest = { buildID, bundleID, entry, sourceSHA256, dependencyVersions, capabilities, sourceTypechecked: true, exactByteStageVerified: true,
  transport: 'Foundation-only in-memory synthetic request mapping', syntheticOnly: true, network: false, keychain: false, sessionWrites: false, modelInvocations: false,
  fixtureAdmission: 'connection.list → production loadConnections; exact expectedHost on every runtime request',
  productionUI: ['ProjectsHome', 'ProjectDetail'], uiKitGestureValidated: false, engineStarted: false, installed: false, launched: false, bundleBuilt: false, swiftTypechecked: false, appBuilt: false };
if (!args.includes('--stage-only')) {
  const executable = process.env.NSH_BIN || 'nsh';
  let nsh;
  for (const candidate of executable.includes('/') ? [path.resolve(executable)] : (process.env.PATH ?? '').split(path.delimiter).map(directory => path.join(directory, executable))) {
    try { await access(candidate, constants.X_OK); nsh = await realpath(candidate); break; } catch { /* Try the next executable. */ }
  }
  if (!nsh) throw new Error('Cannot find NSH compiler; set NSH_BIN');
  run(nsh, ['build', 'App.tsx', '--release', '--out', bundle]);
  manifest.bundleBuilt = true; manifest.bundle = path.relative(root, bundle); manifest.bundleSHA256 = hash(await readFile(path.join(bundle, 'bundle.nshc')));
  const script = await readFile(path.join(bundle, 'bundle.js'), 'utf8');
  if (script.includes(repository) || /asset:\/\/(?:Users|private)\//.test(script)) throw new Error('Non-neutral absolute fixture asset URL');
  const assetRoot = path.join(bundle, 'assets');
  const assets = await files(assetRoot).catch(error => {
    if (error.code === 'ENOENT' && error.path === assetRoot) return [];
    throw error;
  });
  for (const match of script.matchAll(/asset:\/\/([^`"']+)/g)) if (!assets.includes(match[1])) throw new Error('Missing packaged asset');
  manifest.assets = assets; manifest.compilerVersion = run(nsh, ['--version'], project, true);
  if (!args.includes('--bundle-only')) {
    const dist = process.env.NSH_DIST ? path.resolve(process.env.NSH_DIST) : path.resolve(path.dirname(nsh), '..');
    const framework = path.join(dist, 'embed/ios/NativeShell.xcframework/ios-arm64-simulator'); await access(path.join(framework, 'NativeShell.framework/NativeShell'));
    const publicInterface = await readFile(path.join(framework, 'NativeShell.framework/Modules/NativeShell.swiftmodule/arm64-apple-ios-simulator.swiftinterface'));
    manifest.publicSwiftInterfaceSHA256 = hash(publicInterface);
    manifest.publicSwiftWebHostLoader = /func\s+(?:loadWebHost|setWebHost)\b|var\s+webHost\b/.test(publicInterface.toString('utf8'));
    const sdk = run('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path'], project, true), sdkVersion = run('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-version'], project, true);
    if (Number(sdkVersion.split('.')[0]) < 26) throw new Error('iOS 26+ SDK required');
    manifest.sdkVersion = sdkVersion; manifest.target = 'arm64-apple-ios15.0-simulator';
    const stagedSwift = nativeSources.map(source => path.join(project, 'source/packages/nsh', source));
    const swift = ['--sdk', 'iphonesimulator', 'swiftc', '-swift-version', '5', '-parse-as-library', '-sdk', sdk, '-target', manifest.target, '-F', framework];
    run('xcrun', [...swift, '-typecheck', ...stagedSwift]); manifest.swiftTypechecked = true;
    const staging = path.join(output, `${name}.staging.app`), app = path.join(output, `${name}.app`); await mkdir(staging);
    await cp(bundle, path.join(staging, 'nsh'), { recursive: true }); await mkdir(path.join(staging, 'fixture'));
    await cp(path.join(project, 'source/packages/nsh/tests/projects-order-uikit/seed.json'), path.join(staging, 'fixture/seed.json'));
    const frameworks = ['UIKit', 'Foundation', 'Security', 'AVFoundation', 'AVKit', 'QuickLook', 'Speech', 'CoreMedia', 'CoreVideo', 'CoreGraphics', 'CoreText', 'QuartzCore', 'ImageIO', 'Photos', 'PhotosUI', 'UniformTypeIdentifiers', 'WebKit', 'SafariServices', 'Network', 'SystemConfiguration', 'AudioToolbox'];
    run('xcrun', [...swift, '-O', '-framework', 'NativeShell', ...frameworks.flatMap(value => ['-framework', value]), '-lc++', '-lz', '-lsqlite3', '-Xlinker', '-ObjC', ...stagedSwift, '-o', path.join(staging, name)]);
    await writeFile(path.join(staging, 'Info.plist'), JSON.stringify({ CFBundleDevelopmentRegion: 'en', CFBundleDisplayName: 'Projects Order UIKit QA', CFBundleExecutable: name, CFBundleIdentifier: bundleID, CFBundleInfoDictionaryVersion: '6.0', CFBundleName: name, CFBundlePackageType: 'APPL', CFBundleShortVersionString: '0.1.0', CFBundleVersion: '1', CFBundleSupportedPlatforms: ['iPhoneSimulator'], MinimumOSVersion: '15.0', LSRequiresIPhoneOS: true, UIDeviceFamily: [1, 2], UILaunchScreen: {}, FixtureBuildID: buildID, UISupportedInterfaceOrientations: ['UIInterfaceOrientationPortrait', 'UIInterfaceOrientationLandscapeLeft', 'UIInterfaceOrientationLandscapeRight'] }));
    run('plutil', ['-convert', 'xml1', path.join(staging, 'Info.plist')]); run('codesign', ['--force', '--sign', '-', '--timestamp=none', staging]); run('codesign', ['--verify', '--strict', staging]);
    await rename(staging, app); manifest.appBuilt = true; manifest.signatureVerified = true; manifest.app = path.relative(root, app); manifest.executableSHA256 = hash(await readFile(path.join(app, name)));
  }
}
await writeFile(path.join(output, 'fixture-build.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ ...manifest, sourceSHA256: `${Object.keys(sourceSHA256).length} exact staged entries; see fixture-build.json`, manifest: path.relative(root, path.join(output, 'fixture-build.json')) }, null, 2));
