import { spawnSync } from 'node:child_process';
import { mkdir, writeFile, readFile, copyFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageNativeApplication } from '../../scripts/stage-native-application.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const work = path.join(root, '.nsh/composer-inline-chips-uikit', String(Date.now()));
const app = path.join(work, 'InlineChipsQA.app'), identifier = 'example.yuri.inlinechips.qa';
const dist = process.env.NSH_DIST;
if (!dist) throw Error('Set NSH_DIST to the existing NSH distribution');
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { encoding: 'utf8', cwd, timeout: 90_000, env: { ...process.env, SIMCTL_CHILD_CHIP_SCHEME: process.env.NSH_CHIP_SCHEME ?? 'light' } });
  if (result.status !== 0) throw Error(result.stdout + result.stderr);
  return result.stdout.trim();
}
await mkdir(app, { recursive: true });
const stage = await stageNativeApplication({ root: path.join(work, 'source'), entry: 'packages/nsh/tests/composer-inline-chips-uikit/fixture.tsx' });
run(process.env.NSH_BIN || 'nsh', ['build', stage.entry, '--release', '--out', path.join(app, 'nsh')], stage.cwd);
const sdk = run('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path']);
run('xcrun', ['swiftc', '-parse-as-library', '-swift-version', '5', '-O', '-sdk', sdk, '-target', 'arm64-apple-ios15.0-simulator', '-F', path.join(dist, 'embed/ios/NativeShell.xcframework/ios-arm64-simulator'), '-framework', 'NativeShell', '-framework', 'UIKit', '-framework', 'Foundation', '-lc++', '-lz', '-lsqlite3',
  ...['tests/composer-inline-chips-uikit/main.swift', 'ios/ComposerInlineChipPlan.swift', 'ios/ComposerInlineChipIcons.swift', 'ios/ComposerInlineChips.swift'].map(file => path.join(root, file)), '-o', path.join(app, 'InlineChipsQA')]);
await writeFile(path.join(app, 'Info.plist'), JSON.stringify({ CFBundleIdentifier: identifier, CFBundleExecutable: 'InlineChipsQA', CFBundleName: 'InlineChipsQA', CFBundleDisplayName: 'Inline Chips QA', CFBundlePackageType: 'APPL', CFBundleShortVersionString: '1.0', CFBundleVersion: '1', MinimumOSVersion: '15.0', UIDeviceFamily: [1, 2], UILaunchScreen: {} }));
run('plutil', ['-convert', 'xml1', path.join(app, 'Info.plist')]); run('codesign', ['--force', '--sign', '-', app]);
const devices = JSON.parse(run('xcrun', ['simctl', 'list', 'devices', 'booted', '-j']));
const device = Object.values(devices.devices).flat().find(device => device.state === 'Booted');
if (!device) throw Error('Boot an iOS simulator first');
run('xcrun', ['simctl', 'install', device.udid, app]);
const container = run('xcrun', ['simctl', 'get_app_container', device.udid, identifier, 'data']);
const docs = path.join(container, 'Documents'); await mkdir(docs, { recursive: true });
const completion = new Promise((resolve, reject) => {
  const watcher = watch(docs, (_event, file) => { if (file === 'chip-audit.json') { watcher.close(); clearTimeout(deadline); resolve(); } });
  const deadline = setTimeout(() => { watcher.close(); reject(Error('Native chip audit did not complete')); }, 20_000);
});
run('xcrun', ['simctl', 'launch', device.udid, identifier]); await completion;
const rows = JSON.parse(await readFile(path.join(docs, 'chip-audit.json'), 'utf8'));
const counts = rows.map(row => row.attachments);
if (JSON.stringify(counts) !== JSON.stringify([0, 1, 2, 1, 0, 1, 0])) throw Error('Native attachment counts differ: ' + JSON.stringify(rows));
if (rows.some(row => String(row.text ?? '').includes('\ufffc'))) throw Error('A visual placeholder changed logical Input text');
await writeFile(path.join(work, 'chip-audit.json'), JSON.stringify(rows, null, 2));
await copyFile(path.join(docs, 'chip-geometry.json'), path.join(work, 'chip-geometry.json'));
for (const name of ['chips-phase2.png', 'chips-phase5.png']) await copyFile(path.join(docs, name), path.join(work, name));
console.log(run('swift', [path.join(root, 'tests/composer-inline-chips-uikit/VisualChecks.swift'), work]));
console.log(JSON.stringify({ work, counts, screenshots: ['chips-phase2.png', 'chips-phase5.png'] }));
