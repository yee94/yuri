import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, cp, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageNativeApplication, validateNativeApplicationBundle } from '../../scripts/stage-native-application.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const buildID = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
const output = path.join(root, '.nsh/projects-insets-uikit', buildID), bundleID = 'example.nsh.projects-insets.run-' + randomUUID().slice(0, 8);
await mkdir(output, { recursive: true });
const manifest = { buildID, bundleID, purpose: 'UIKit public container geometry and original NSH ref/layout metadata', productionSourceModified: false, frozenProjectsInstrumented: true, appBuilt: false, installed: false, launched: false, deviceAccessed: false, network: false, sourceSHA256: {}, errors: [] };
const manifestPath = path.join(output, 'manifest.json');
const save = () => writeFile(manifestPath, JSON.stringify(manifest, null, 2));
function run(command, args, cwd, timeout = 240000) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout });
  if (result.error || result.status !== 0) throw new Error(`${path.basename(command)} ${args[0]} failed: ${result.error?.message ?? result.stderr}`);
  if (result.stderr) console.error(result.stderr);
  return result.stdout.trim();
}
try {
  manifest.stage = 'freeze'; await save();
  const staged = await stageNativeApplication({ root: path.join(output, 'stage'), entry: 'packages/nsh/tests/projects-insets-uikit/fixture.tsx' });
  manifest.sourceGraph = staged.manifest;
  const project = staged.cwd, file = path.join(project, 'source/packages/nsh/projects.tsx');
  const original = await readFile(file, 'utf8'); manifest.productionProjectsSHA256 = sha(original);
  const start = original.indexOf('export function ProjectsHome('), end = original.indexOf('export function ProjectDetail(', start);
  if (start < 0 || end < 0) throw new Error('ProjectsHome boundary missing');
  let home = original.slice(start, end);
  const replace = (before, after) => { if (home.split(before).length !== 2) throw new Error('Instrument exactly one ProjectsHome seam: ' + before); home = home.replace(before, after); };
  replace('return <View class="flex-1 bg-background">', 'return <View testID="production-root" ref={layoutRef("production-root")} onLayout={event => layoutEvent("production-root", event)} class="flex-1 bg-background"><LayoutProbe name="production-root" />');
  replace('ref={scroll.ref}', 'ref={node => { scroll.ref(node); layoutRef("production-scroll")(node); }} onLayout={event => layoutEvent("production-scroll", event)}');
  replace('<View style={{ maxWidth: 452, width: \'100%\', alignSelf: \'center\' }}>', '<View testID="production-shell" ref={layoutRef("production-shell")} onLayout={event => layoutEvent("production-shell", event)} style={{ maxWidth: 452, width: \'100%\', alignSelf: \'center\' }}><LayoutProbe name="production-shell" />');
  replace('<View ref={scroll.contentRef} onLayout={scroll.onContentLayout}', '<View testID="production-content" ref={node => { scroll.contentRef(node); layoutRef("production-content")(node); }} onLayout={event => { scroll.onContentLayout(); layoutEvent("production-content", event); }}');
  replace('<View testID={`projects-card-${project().id}`} style={projectHomeSurface}>', '<View testID={`projects-card-${project().id}`} ref={layoutRef(`production-card-${project().id}`)} onLayout={event => layoutEvent(`production-card-${project().id}`, event)} style={projectHomeSurface}><LayoutProbe name={`production-card-${project().id}`} />');
  replace('gap: homeGeometry().pageGap }}>','gap: homeGeometry().pageGap }}><LayoutProbe name="production-content" />');
  const instrumented = "import { LayoutProbe, layoutRef, layoutEvent } from './tests/projects-insets-uikit/probe';\n" + original.slice(0, start) + home + original.slice(end);
  await writeFile(file, instrumented); manifest.instrumentedProjectsSHA256 = sha(instrumented);
  manifest.instrumentation = 'frozen copy only: zero-size native component anchors; ref forwarding preserves original Scroll/content refs; original content onLayout called; no styles changed';
  manifest.sourceGraph.sourceFiles['packages/nsh/projects.tsx'] = { bytes: Buffer.byteLength(instrumented), sha256: sha(instrumented), upstreamSHA256: sha(original) };
  const methods = ['connection.list', 'runtime.request', 'fixture.insets.report'];
  await writeFile(path.join(project, 'nsh.json'), JSON.stringify({ name: 'ProjectsInsetsUIKit', id: bundleID, version: '0.1.0', build: 1, theme: 'theme.json', capabilities: { host: methods } }));
  const nativeSources = ['tests/projects-insets-uikit/main.swift', 'tests/projects-order-uikit/SyntheticHost.swift'];
  const native = path.join(output, 'native'); await mkdir(native);
  for (const name of nativeSources) { const bytes = await readFile(path.join(root, name)); await writeFile(path.join(native, path.basename(name)), bytes); manifest.sourceSHA256[name] = sha(bytes); }
  const builder = await readFile(fileURLToPath(import.meta.url)); manifest.sourceSHA256['tests/projects-insets-uikit/build.mjs'] = sha(builder); await writeFile(path.join(output, 'build-snapshot.mjs'), builder);
  const nsh = process.env.NSH_BIN; if (!nsh) throw new Error('Explicit installed NSH_BIN required');
  const dist = process.env.NSH_DIST || path.resolve(path.dirname(nsh), '..'), framework = path.join(dist, 'embed/ios/NativeShell.xcframework/ios-arm64-simulator');
  manifest.publicSwiftInterfaceSHA256 = sha(await readFile(path.join(framework, 'NativeShell.framework/Modules/NativeShell.swiftmodule/arm64-apple-ios-simulator.swiftinterface')));
  manifest.stage = 'nsh-build'; await save();
  const bundle = path.join(output, 'bundle'); run(nsh, ['build', 'App.tsx', '--release', '--out', bundle], project);
  manifest.assets = await validateNativeApplicationBundle(bundle, staged.manifest); manifest.bundleSHA256 = sha(await readFile(path.join(bundle, 'bundle.nshc')));
  const sdk = run('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path'], project);
  const flags = ['--sdk', 'iphonesimulator', 'swiftc', '-swift-version', '5', '-parse-as-library', '-sdk', sdk, '-target', 'arm64-apple-ios15.0-simulator', '-F', framework];
  const sources = nativeSources.map(name => path.join(native, path.basename(name)));
  manifest.stage = 'swift-typecheck'; await save(); run('xcrun', [...flags, '-typecheck', ...sources], project);
  const partial = path.join(output, 'ProjectsInsetsUIKit.partial.app'), app = path.join(output, 'ProjectsInsetsUIKit.app'); await mkdir(partial); await cp(bundle, path.join(partial, 'nsh'), { recursive: true }); await mkdir(path.join(partial, 'fixture'));
  const seed = await readFile(path.join(root, 'tests/projects-order-uikit/seed.json')); await writeFile(path.join(partial, 'fixture/seed.json'), seed); manifest.seedSHA256 = sha(seed);
  manifest.stage = 'swift-link'; await save();
  const frameworks = ['UIKit', 'Foundation', 'Security', 'AVFoundation', 'AVKit', 'QuickLook', 'Speech', 'CoreMedia', 'CoreVideo', 'CoreGraphics', 'CoreText', 'QuartzCore', 'ImageIO', 'Photos', 'PhotosUI', 'UniformTypeIdentifiers', 'WebKit', 'SafariServices', 'Network', 'SystemConfiguration', 'AudioToolbox'];
  run('xcrun', [...flags, '-O', '-framework', 'NativeShell', ...frameworks.flatMap(name => ['-framework', name]), '-lc++', '-lz', '-lsqlite3', '-Xlinker', '-ObjC', ...sources, '-o', path.join(partial, 'ProjectsInsetsUIKit')], project, 600000);
  await writeFile(path.join(partial, 'Info.plist'), JSON.stringify({ CFBundleExecutable: 'ProjectsInsetsUIKit', CFBundleIdentifier: bundleID, CFBundleName: 'ProjectsInsetsUIKit', CFBundleDisplayName: 'Projects Insets Geometry', CFBundlePackageType: 'APPL', CFBundleVersion: '1', CFBundleShortVersionString: '0.1.0', CFBundleSupportedPlatforms: ['iPhoneSimulator'], MinimumOSVersion: '15.0', LSRequiresIPhoneOS: true, UIDeviceFamily: [1, 2], UILaunchScreen: {}, FixtureBuildID: buildID, UISupportedInterfaceOrientations: ['UIInterfaceOrientationPortrait', 'UIInterfaceOrientationLandscapeLeft', 'UIInterfaceOrientationLandscapeRight'] }));
  run('plutil', ['-convert', 'xml1', path.join(partial, 'Info.plist')], project); run('codesign', ['--force', '--sign', '-', '--timestamp=none', partial], project); run('codesign', ['--verify', '--strict', partial], project);
  await rename(partial, app); manifest.appBuilt = true; manifest.app = path.relative(root, app); manifest.executableSHA256 = sha(await readFile(path.join(app, 'ProjectsInsetsUIKit'))); manifest.stage = 'complete'; await save();
  console.log(JSON.stringify({ buildID, bundleID, app, manifest: manifestPath, bundleSHA256: manifest.bundleSHA256, executableSHA256: manifest.executableSHA256 }, null, 2));
} catch (error) { manifest.errors.push({ stage: manifest.stage, message: String(error) }); await save(); throw error; }
