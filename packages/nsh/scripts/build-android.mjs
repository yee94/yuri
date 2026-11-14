#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { access, cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageTerminalOfflineResources } from '../terminal-offline.mjs';
import { stageNativeApplication } from './stage-native-application.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = path.resolve(packageRoot, '../..');
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(`node packages/nsh/scripts/build-android.mjs

NSH_BIN: nsh executable (default: PATH nsh)
NSH_DIST: distribution root containing embed/android/nsh.aar
ANDROID_HOME / ANDROID_SDK_ROOT: SDK (default: ~/Library/Android/sdk or the Homebrew command-line tools)
YURI_WEBCREDENTIALS_DOMAINS: optional comma-separated RP hosts for passkey associatedDomains
Output: packages/nsh/.nsh/out/YuriNative.apk`);
  process.exit(0);
}
if (args.length) throw new Error('No arguments are supported; see --help');

function run(command, argv, options = {}) {
  const result = spawnSync(command, argv, { cwd: options.cwd ?? workspaceRoot, encoding: 'utf8', stdio: options.capture ? 'pipe' : 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} failed (${result.status})${options.capture ? `: ${(result.stderr ?? '').trim()}` : ''}`);
  return (result.stdout ?? '').trim();
}

async function executable(value) {
  const candidates = value.includes('/') ? [path.resolve(value)] : (process.env.PATH ?? '').split(path.delimiter).map(dir => path.join(dir, value));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch { /* Next PATH entry. */ }
  }
  throw new Error(`Cannot find executable ${value}; set NSH_BIN or JAVA_HOME`);
}

function newest(directory) {
  const versions = spawnSync('ls', [directory], { encoding: 'utf8' }).stdout?.split('\n').filter(Boolean) ?? [];
  versions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return versions.at(-1);
}

async function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      await access(candidate);
      return candidate;
    } catch { /* Next candidate. */ }
  }
  throw new Error(`Android SDK not found; tried ${candidates.filter(Boolean).join(', ')}`);
}

const sdk = await firstExisting([
  process.env.ANDROID_HOME,
  process.env.ANDROID_SDK_ROOT,
  path.join(os.homedir(), 'Library/Android/sdk'),
  '/opt/homebrew/share/android-commandlinetools',
  '/usr/local/share/android-commandlinetools',
  path.join(os.homedir(), 'Android/Sdk'),
]);
const androidJar = path.join(sdk, 'platforms/android-35/android.jar');
await access(androidJar);
const buildTools = newest(path.join(sdk, 'build-tools'));
if (!buildTools) throw new Error('Android build-tools are not installed');
const tool = name => path.join(sdk, 'build-tools', buildTools, name);
for (const name of ['aapt2', 'd8', 'zipalign', 'apksigner']) await access(tool(name));
const javaHome = process.env.JAVA_HOME;
const javac = javaHome ? path.join(javaHome, 'bin/javac') : await executable('javac');
const jar = javaHome ? path.join(javaHome, 'bin/jar') : await executable('jar');
const keytool = javaHome ? path.join(javaHome, 'bin/keytool') : await executable('keytool');

const nsh = await executable(process.env.NSH_BIN || 'nsh');
const dist = process.env.NSH_DIST ? path.resolve(process.env.NSH_DIST) : path.resolve(path.dirname(nsh), '..');
const aar = path.join(dist, 'embed/android/nsh.aar');
try {
  await access(aar);
} catch {
  throw new Error(`nsh.aar not found at ${aar}; set NSH_DIST to a distribution with embed/android/nsh.aar`);
}

/** Passkey RP hosts, canonical and de-duplicated; empty means no meta-data. */
function associatedDomains() {
  const raw = (process.env.YURI_WEBCREDENTIALS_DOMAINS ?? process.env.NSH_WEBCREDENTIALS_DOMAINS ?? '').trim();
  if (!raw) return [];
  const domains = [...new Set(raw.split(',').map(value => value.trim()).filter(Boolean))];
  for (const domain of domains) {
    const valid = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(domain)
      && domain.length <= 253
      && domain.split('.').every(label => label.length > 0 && label.length <= 63 && !label.startsWith('-') && !label.endsWith('-'));
    if (!valid) throw new Error(`Invalid webcredentials domain: ${domain}`);
  }
  return domains;
}

const out = path.join(packageRoot, '.nsh/out');
const work = path.join(out, `android-${randomUUID()}`);
const apk = path.join(out, 'YuriNative.apk');
await mkdir(work, { recursive: true });
await mkdir(out, { recursive: true });

try {
  // 1. Stage and build the TSX bundle exactly as iOS does.
  const sourceStage = await stageNativeApplication({ root: path.join(work, 'native-source'), workspaceRoot });
  const bundle = path.join(work, 'bundle');
  run(nsh, ['build', sourceStage.entry, '--release', '--out', bundle], { cwd: sourceStage.cwd });
  const assets = path.join(work, 'assets');
  await cp(bundle, path.join(assets, 'nsh'), { recursive: true });
  await stageTerminalOfflineResources(assets, workspaceRoot);
  run(process.execPath, [path.join(packageRoot, 'scripts/build-gui-plugin-preview.mjs'),
    '--out', path.join(assets, 'gui-plugin-preview')]);

  // 2. Runtime resources (if any) and Java sources.
  const aarDir = path.join(work, 'aar');
  await mkdir(aarDir, { recursive: true });
  run('unzip', ['-q', '-o', aar, '-d', aarDir], { cwd: work });
  const compiled = path.join(work, 'compiled');
  await mkdir(compiled, { recursive: true });
  const aarRes = path.join(aarDir, 'res');
  const aarResExists = await access(aarRes).then(() => true, () => false);
  if (aarResExists) run(tool('aapt2'), ['compile', '--dir', aarRes, '-o', path.join(compiled, 'aar-res.zip')]);
  run(tool('aapt2'), ['compile', '--dir', path.join(packageRoot, 'android/res'), '-o', path.join(compiled, 'app-res.zip')]);
  const aarAssets = path.join(aarDir, 'assets');
  if (await access(aarAssets).then(() => true, () => false)) {
    for (const entry of await readdir(aarAssets)) {
      await cp(path.join(aarAssets, entry), path.join(assets, entry), { recursive: true });
    }
  }

  // 3. Link resources, manifest and assets into the base APK.
  const generated = path.join(work, 'generated');
  await mkdir(generated, { recursive: true });
  const base = path.join(work, 'base.apk');
  const domains = associatedDomains();
  let manifest = await readFile(path.join(packageRoot, 'android/AndroidManifest.xml'), 'utf8');
  const marker = /<!-- @yuri-associated-domains:[\s\S]*?-->/;
  if (!marker.test(manifest)) throw new Error('AndroidManifest.xml lost its associated-domains marker');
  manifest = manifest.replace(marker, domains.length
    ? `<meta-data android:name="com.yee94.yuri.nsh.associatedDomains" android:value="${domains.map(host => `webcredentials:${host}`).join(',')}" />`
    : '');
  const manifestPath = path.join(work, 'AndroidManifest.xml');
  await writeFile(manifestPath, manifest);
  run(tool('aapt2'), [
    'link', '-o', base, '-I', androidJar,
    '--manifest', manifestPath,
    '-A', assets,
    '--java', generated,
    '--min-sdk-version', '28', '--target-sdk-version', '35',
    '--version-code', '1', '--version-name', '0.1.0',
    path.join(compiled, 'app-res.zip'), ...(aarResExists ? [path.join(compiled, 'aar-res.zip')] : []),
  ]);

  // 4. Compile this package's Java against android.jar and the runtime classes.
  const classes = path.join(work, 'classes');
  await mkdir(classes, { recursive: true });
  const sources = [];
  async function java(dir) {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await java(full);
      else if (entry.name.endsWith('.java')) sources.push(full);
    }
  }
  await java(path.join(packageRoot, 'android/src'));
  await java(generated);
  const runtimeClasses = path.join(aarDir, 'classes.jar');
  await access(runtimeClasses);
  run(javac, ['--release', '17', '-Xlint:-options', '-encoding', 'UTF-8',
    '-cp', `${androidJar}${path.delimiter}${runtimeClasses}`, '-d', classes, ...sources]);

  // 5. Dex our classes together with the AAR's runtime classes.
  const ourJar = path.join(work, 'app-classes.jar');
  run(jar, ['cf', ourJar, '-C', classes, '.']);
  const dex = path.join(work, 'dex');
  await mkdir(dex, { recursive: true });
  run(tool('d8'), ['--release', '--min-api', '28', '--lib', androidJar, '--output', dex, runtimeClasses, ourJar]);
  const dexFiles = (await readdir(dex)).filter(name => /^classes\d*\.dex$/.test(name)).sort();
  if (!dexFiles.length) throw new Error('d8 produced no dex files');

  // 6. Assemble: base resources + dex + stored native libraries.
  const unaligned = path.join(work, 'unaligned.apk');
  await cp(base, unaligned);
  run('zip', ['-q', '-X', '-j', unaligned, ...dexFiles], { cwd: dex });
  const jni = path.join(aarDir, 'jni');
  const abis = (await readdir(jni, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  for (const abi of abis) {
    const library = path.join(jni, abi, 'libnsh.so');
    if (!(await access(library).then(() => true, () => false))) continue;
    const staged = path.join(work, 'lib', abi, 'libnsh.so');
    await mkdir(path.dirname(staged), { recursive: true });
    await cp(library, staged);
    run('zip', ['-q', '-X', '-0', unaligned, `lib/${abi}/libnsh.so`], { cwd: work });
  }
  if (!abis.length) throw new Error('nsh.aar has no jni/<abi>/libnsh.so');

  const aligned = path.join(work, 'aligned.apk');
  run(tool('zipalign'), ['-P', '16', '-f', '4', unaligned, aligned]);

  // 7. Sign with the debug key, created on demand.
  const keystore = path.join(os.homedir(), '.android/debug.keystore');
  if (!(await access(keystore).then(() => true, () => false))) {
    await mkdir(path.dirname(keystore), { recursive: true });
    run(keytool, ['-genkeypair', '-keystore', keystore, '-storepass', 'android', '-keypass', 'android',
      '-alias', 'androiddebugkey', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000',
      '-dname', 'CN=Android Debug,O=Android,C=US']);
  }
  const signed = path.join(work, 'signed.apk');
  run(tool('apksigner'), ['sign', '--ks', keystore, '--ks-pass', 'pass:android', '--key-pass', 'pass:android',
    '--ks-key-alias', 'androiddebugkey', '--out', signed, aligned]);
  await cp(signed, apk);
  const evidence = {
    apk: path.relative(workspaceRoot, apk),
    bytes: (await readFile(apk)).length,
    sdk, buildTools, aar: path.join(path.basename(dist), 'embed/android/nsh.aar'),
    abis, dex: dexFiles, sources: sources.length, associatedDomains: domains,
  };
  await writeFile(path.join(out, 'android-evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(`Built ${path.relative(workspaceRoot, apk)} (${abis.join(', ')})`);
  console.log(`Install with: ${path.join(sdk, 'platform-tools/adb')} install -r ${path.relative(workspaceRoot, apk)}`);
} finally {
  await rm(work, { recursive: true, force: true });
}
