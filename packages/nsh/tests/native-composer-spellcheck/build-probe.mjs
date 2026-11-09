import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, '../..');
const repo = path.resolve(packageRoot, '../..');
export const swiftInputs = [
  'ios/NativeInputMetadataBinding.swift', 'ios/NativeInputMetadataOwner.swift',
  'ios/NativeComposerSpellcheckLease.swift', 'ios/NativeComposerSpellcheck.swift',
  'tests/native-composer-spellcheck/ProbeLedger.swift', 'tests/native-composer-spellcheck/ProbeDiagnostics.swift',
  'tests/native-composer-spellcheck/probe-main.swift',
];
const tsInputs = ['tests/native-composer-spellcheck/fixture.tsx', 'native-input-metadata.tsx', 'native-composer-spellcheck.tsx', 'composer-surface.ts'];

export function options(args) {
  const allowed = new Set(['--sdk-only', '--diagnostics', '--device', '--json', '--quiet']);
  for (const arg of args) if (!allowed.has(arg)) throw new Error(`Unknown option: ${arg}`);
  return { sdkOnly: args.includes('--sdk-only'), diagnostics: args.includes('--diagnostics'), device: args.includes('--device') };
}
export function identity(runID, override) {
  const identifier = override || `example.nsh.composer-probe.${runID}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]+$/.test(identifier) || !identifier.includes('.') || ['com.yee94.yuri', 'com.yee94.yuri.nsh'].includes(identifier)) throw new Error('Use a new, valid fixture bundle ID');
  return { identifier, scheme: `nsh-composer-probe-${runID}` };
}

function run(command, args, cwd = repo) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

export const probeGrants = { host: ['fixture.composer.hostAdopted'] };
export const compiledProbeGrants = { network: { hosts: [], http: [] }, process: { execute: [], exit: false, env: [] }, fs: { read: [], write: [] }, statusBar: false, clipboard: false, picker: false, host: probeGrants.host, openUrl: false };
export function verifyCompiledProbe(metadata, capabilities, identifier) {
  if (metadata.id !== identifier || !isDeepStrictEqual(capabilities, compiledProbeGrants)) throw new Error('Compiled fixture identity/Host grants mismatch');
}
export async function prepareProbeSources(output, identifier = 'example.nsh.composer-probe.headless') {
  const source = path.join(output, 'source');
  const inputs = [];
  for (const file of [...swiftInputs, ...tsInputs]) {
    const original = path.join(packageRoot, file), destination = path.join(source, file);
    await mkdir(path.dirname(destination), { recursive: true });
    const bytes = await readFile(original); await writeFile(destination, bytes);
    inputs.push({ path: file, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  await writeFile(path.join(source, 'nsh.json'), JSON.stringify({ name: 'Composer probe', id: identifier, version: '1.0', build: 1, capabilities: probeGrants }));
  const entry = path.join(source, 'App.tsx');
  await writeFile(entry, 'import "./tests/native-composer-spellcheck/fixture";\n');
  return { source, inputs, cwd: source, entry };
}

export async function buildProbe(args) {
  const selected = options(args), runID = randomUUID().replaceAll('-', '').slice(0, 16);
  const { identifier, scheme } = identity(runID, process.env.COMPOSER_PROBE_BUNDLE_ID);
  if (!process.env.NSH_DIST) throw new Error('NSH_DIST must identify the existing distribution; this script never installs dependencies');
  const sdkName = selected.device ? 'iphoneos' : 'iphonesimulator';
  const sdk = run('xcrun', ['--sdk', sdkName, '--show-sdk-path']);
  const framework = path.join(path.resolve(process.env.NSH_DIST), 'embed/ios/NativeShell.xcframework', selected.device ? 'ios-arm64' : 'ios-arm64-simulator');
  await access(path.join(framework, 'NativeShell.framework/NativeShell'));
  const output = path.join(packageRoot, '.nsh/composer-spellcheck-probe', runID);
  await mkdir(output, { recursive: true });
  const { source, inputs, cwd, entry } = await prepareProbeSources(output, identifier);
  const flags = ['-swift-version', '5', '-parse-as-library', '-sdk', sdk, '-target', `arm64-apple-ios15.0${selected.device ? '' : '-simulator'}`, '-F', framework];
  const sources = swiftInputs.map(file => path.join(source, file));
  let artifact;
  if (selected.sdkOnly) {
    artifact = 'ComposerProbe.o';
    run('xcrun', ['--sdk', sdkName, 'swiftc', ...flags, '-whole-module-optimization', '-emit-object', ...sources, '-o', path.join(output, artifact)]);
  } else {
    const app = path.join(output, 'ComposerProbe.app'); await mkdir(app);
    // This is compile/package only. The script contains no install, launch, boot or Simulator settings operations.
    run(process.env.NSH_BIN || path.join(process.env.NSH_DIST, 'bin/nsh'), ['build', entry, '--release', '--out', path.join(app, 'nsh')], cwd);
    const compiled = JSON.parse(await readFile(path.join(app, 'nsh/app.json'), 'utf8'));
    const capabilities = JSON.parse(await readFile(path.join(app, 'nsh/capabilities.json'), 'utf8'));
    verifyCompiledProbe(compiled, capabilities, identifier);
    const frameworks = ['UIKit', 'UserNotifications', 'Foundation', 'Security', 'AVFoundation', 'AVKit', 'QuickLook', 'Speech', 'CoreMedia', 'CoreVideo', 'CoreGraphics', 'CoreText', 'QuartzCore', 'ImageIO', 'Photos', 'PhotosUI', 'UniformTypeIdentifiers', 'WebKit', 'SafariServices', 'Network', 'SystemConfiguration', 'AudioToolbox'];
    run('xcrun', ['--sdk', sdkName, 'swiftc', ...flags, '-O', '-framework', 'NativeShell', ...frameworks.flatMap(name => ['-framework', name]), '-lc++', '-lz', '-lsqlite3', '-Xlinker', '-ObjC', '-Xlinker', '-rpath', '-Xlinker', '@executable_path/Frameworks', ...sources, '-o', path.join(app, 'ComposerProbe')]);
    const plist = {
      CFBundleIdentifier: identifier, CFBundleExecutable: 'ComposerProbe', CFBundleName: 'ComposerProbe', CFBundleDisplayName: 'Composer Trait Probe',
      CFBundlePackageType: 'APPL', CFBundleShortVersionString: '1.0', CFBundleVersion: '1', MinimumOSVersion: '15.0',
      CFBundleSupportedPlatforms: [selected.device ? 'iPhoneOS' : 'iPhoneSimulator'], LSRequiresIPhoneOS: true, UIDeviceFamily: [1, 2],
      UILaunchScreen: {}, UISupportedInterfaceOrientations: ['UIInterfaceOrientationPortrait'],
      ComposerReadbackEnabled: selected.diagnostics, ComposerProbeScheme: scheme, ComposerProbeBuildID: runID,
      CFBundleURLTypes: [{ CFBundleURLName: identifier, CFBundleURLSchemes: [scheme] }],
    };
    await writeFile(path.join(app, 'Info.plist'), JSON.stringify(plist));
    run('plutil', ['-convert', 'xml1', path.join(app, 'Info.plist')]);
    const frameworkBinary = path.join(framework, 'NativeShell.framework/NativeShell');
    if (!run('file', [frameworkBinary]).includes('current ar archive')) {
      const embedded = path.join(app, 'Frameworks'); await mkdir(embedded);
      await cp(path.join(framework, 'NativeShell.framework'), path.join(embedded, 'NativeShell.framework'), { recursive: true });
    }
    if (!selected.device) {
      const embedded = path.join(app, 'Frameworks/NativeShell.framework');
      try { await access(embedded); run('codesign', ['--force', '--sign', '-', embedded]); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      run('codesign', ['--force', '--sign', '-', app]);
    }
    artifact = 'ComposerProbe.app';
  }
  for (const input of inputs) {
    const current = createHash('sha256').update(await readFile(path.join(packageRoot, input.path))).digest('hex');
    if (current !== input.sha256) throw new Error(`Source changed during build: ${input.path}`);
  }
  const manifest = { schema: 1, runID, identifier, scheme, diagnosticsEnabled: selected.diagnostics, sdkOnly: selected.sdkOnly, device: selected.device,
    target: flags[flags.indexOf('-target') + 1], sdkVersion: run('xcrun', ['--sdk', sdkName, '--show-sdk-version']),
    artifact, capabilities: probeGrants, deviceSigning: selected.device ? 'unsigned; main must development-sign for this fresh fixture identifier' : null, inputs };
  await writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return { output, manifest: path.join(output, 'manifest.json'), artifact: path.join(output, artifact), identifier, scheme, diagnosticsEnabled: selected.diagnostics };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await buildProbe(process.argv.slice(2)))); }
  catch (error) { console.error(JSON.stringify({ error: error.message })); process.exitCode = 1; }
}
