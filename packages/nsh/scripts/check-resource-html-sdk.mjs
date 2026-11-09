import { spawnSync } from 'node:child_process';
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspace = path.resolve(root, '../..');
const compile = process.argv.includes('--compile');
if (process.argv.slice(2).some(value => value !== '--compile')) throw Error('Only --compile is supported');
function run(args, cwd = root) {
  const result = spawnSync('xcrun', args, { cwd, encoding: 'utf8', timeout: 180_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw Error(result.stdout + result.stderr);
  return result.stdout.trim();
}
async function frameworkDirectory() {
  if (process.env.NSH_FRAMEWORK_DIR) return path.resolve(process.env.NSH_FRAMEWORK_DIR);
  if (process.env.NSH_DIST) return path.resolve(process.env.NSH_DIST, 'embed/ios/NativeShell.xcframework/ios-arm64-simulator');
  const executable = process.env.NSH_BIN || 'nsh';
  const candidates = executable.includes('/') ? [executable] : (process.env.PATH || '').split(path.delimiter).map(value => path.join(value, executable));
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); return path.resolve(path.dirname(await realpath(candidate)), '../embed/ios/NativeShell.xcframework/ios-arm64-simulator'); }
    catch { /* Inspect the next executable path; never run the engine. */ }
  }
  // Existing GUI boundary builders freeze the real distribution, including its
  // public Swift interface and static binary. Reuse that offline SDK snapshot.
  const parent = path.join(root, '.nsh/gui-wk-boundary');
  for (const entry of (await readdir(parent).catch(() => [])).sort().reverse()) {
    const candidate = path.join(parent, entry, 'frozen/frameworks');
    try { await access(path.join(candidate, 'NativeShell.framework/NativeShell')); return candidate; } catch { /* Not a completed SDK snapshot. */ }
  }
  throw Error('Set NSH_DIST or NSH_FRAMEWORK_DIR to the real NativeShell framework; no declaration stub is accepted');
}
const framework = await frameworkDirectory();
const binary = await readFile(path.join(framework, 'NativeShell.framework/NativeShell'));
const api = await readFile(path.join(framework, 'NativeShell.framework/Modules/NativeShell.swiftmodule/arm64-apple-ios-simulator.swiftinterface'));
if (binary.length < 100_000 || !api.toString().includes('public protocol NshComponent')) throw Error('A real NativeShell binary and public SDK interface are required');
const hash = data => createHash('sha256').update(data).digest('hex');
const output = await mkdtemp(path.join(process.env.OPENCODE_TMP_DIR || tmpdir(), 'resource-html-sdk-'));
const sources = (await readdir(path.join(root, 'ios'))).filter(value => value.endsWith('.swift')).sort().map(value => 'packages/nsh/ios/' + value);
sources.push('packages/mobile/ios/App/App/YuriViewExportRenderer.swift');
const manifest = [];
for (const source of sources) {
  const bytes = await readFile(path.join(workspace, source)), target = path.join(output, source);
  await mkdir(path.dirname(target), { recursive: true }); await copyFile(path.join(workspace, source), target);
  if (hash(await readFile(target)) !== hash(bytes)) throw Error('Source changed while freezing: ' + source);
  manifest.push({ path: source, sha256: hash(bytes) });
}
const sdk = run(['--sdk', 'iphonesimulator', '--show-sdk-path']);
const flags = ['-swift-version', '5', '-sdk', sdk, '-target', 'arm64-apple-ios15.0-simulator', '-F', framework];
run(['swiftc', ...flags, '-typecheck', ...sources], output);
if (compile) {
  const map = Object.fromEntries(sources.map((source, index) => [source, { object: path.join(output, `source-${index}.o`) }]));
  await writeFile(path.join(output, 'outputs.json'), JSON.stringify(map));
  run(['swiftc', ...flags, '-c', '-output-file-map', path.join(output, 'outputs.json'), ...sources], output);
}
if (hash(await readFile(path.join(framework, 'NativeShell.framework/NativeShell'))) !== hash(binary)) throw Error('SDK binary changed during compilation');
const changedAfterSnapshot = [];
for (const source of manifest) if (hash(await readFile(path.join(workspace, source.path))) !== source.sha256) changedAfterSnapshot.push(source.path);
const evidence = { typechecked: true, compiled: compile, sdk: run(['--sdk', 'iphonesimulator', '--show-sdk-version']), nativeShellSHA256: hash(binary), sources: manifest, changedAfterSnapshot };
await writeFile(path.join(output, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify({ typechecked: true, compiled: compile, sources: sources.length, changedAfterSnapshot, evidence: path.join(output, 'evidence.json') }));
if (changedAfterSnapshot.length) process.exitCode = 1;
