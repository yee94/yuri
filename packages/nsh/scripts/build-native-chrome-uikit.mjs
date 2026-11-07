import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nsh = process.env.NSH_BIN || 'nsh';
const dist = process.env.NSH_DIST || path.resolve(path.dirname(nsh), '..');
const identifier = `example.nsh.chrome.qa-${Date.now()}`;
const app = path.join(root, '.nsh/native-chrome-uikit', identifier, 'NativeChromeQA.app');
await mkdir(app, { recursive: true });
function run(command, args) {
  const result = spawnSync(command, args, { cwd: path.resolve(root, '../..'), encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stdout + result.stderr);
  return result.stdout.trim();
}
run(nsh, ['build', 'packages/nsh/native-chrome-fixture.tsx', '--release', '--out', path.join(app, 'nsh')]);
const sdk = run('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path']);
run('xcrun', ['swiftc', '-swift-version', '5', '-O', '-sdk', sdk, '-target', 'arm64-apple-ios15.0-simulator', '-F', path.join(dist, 'embed/ios/NativeShell.xcframework/ios-arm64-simulator'), '-framework', 'NativeShell', '-framework', 'UIKit', '-framework', 'Foundation', '-lc++', '-lz', '-lsqlite3', ...['tests/native-chrome-uikit.swift', 'ios/SheetPresentation.swift', 'ios/ChatHeaderCollapse.swift', 'ios/DatePicker.swift'].map(file => path.join(root, file)), '-o', path.join(app, 'NativeChromeQA')]);
await writeFile(path.join(app, 'Info.plist'), JSON.stringify({ CFBundleIdentifier: identifier, CFBundleExecutable: 'NativeChromeQA', CFBundleName: 'NativeChromeQA', CFBundleDisplayName: 'Native Chrome QA', CFBundlePackageType: 'APPL', CFBundleShortVersionString: '1.0', CFBundleVersion: '1', MinimumOSVersion: '15.0', UIDeviceFamily: [1, 2], UILaunchScreen: {} }));
run('plutil', ['-convert', 'xml1', path.join(app, 'Info.plist')]);
run('codesign', ['--force', '--sign', '-', app]);
await writeFile(path.join(root, '.nsh/native-chrome-uikit/latest.json'), JSON.stringify({ app, identifier }));
console.log(JSON.stringify({ app, identifier }));
