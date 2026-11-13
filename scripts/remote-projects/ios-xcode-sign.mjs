import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const evidence = path.resolve(process.env.REMOTE_PROJECTS_IOS_EVIDENCE ?? '.scratch/remote-projects/performance/ios-baseline');
const workspaceFile = path.join(evidence, 'workspace.json');
const state = JSON.parse(fs.readFileSync(workspaceFile, 'utf8'));
const mobile = path.join(state.repo, 'packages/mobile');
const native = path.join(mobile, 'ios/App');
const podfile = path.join(native, 'Podfile');
const lockfile = path.join(native, 'Podfile.lock');
const originalPodfile = fs.readFileSync(podfile);
const originalLock = fs.readFileSync(lockfile);
const root = fs.mkdtempSync(path.join(state.root, 'xcode-adhoc-'));
const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, DEVELOPER_DIR: state.developerDir };
const sdkResult = spawnSync('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path'], { env, encoding: 'utf8' });
if (sdkResult.status !== 0) throw new Error('Cannot locate the selected Xcode Simulator SDK');
const sdk = sdkResult.stdout.trim();
const entitlements = path.join(root, 'Simulator.entitlements');
// Use the installed SDK's real simulator template, not a fabricated Team ID.
fs.copyFileSync(path.join(sdk, 'Entitlements.plist'), entitlements);
const args = ['-workspace', 'ios/App/App.xcworkspace', '-scheme', 'App', '-configuration', 'Debug', '-sdk', 'iphonesimulator',
  '-destination', `platform=iOS Simulator,id=${state.udid}`, '-derivedDataPath', path.join(root, 'DerivedData'),
  'CODE_SIGNING_ALLOWED=YES', 'CODE_SIGNING_REQUIRED=YES', 'CODE_SIGN_IDENTITY=-', 'DEVELOPMENT_TEAM=',
  `CODE_SIGN_ENTITLEMENTS=${entitlements}`, 'CODE_SIGN_INJECT_BASE_ENTITLEMENTS=YES', 'build'];
const record = { classification: 'simulator-only diagnostic', command: 'xcodebuild', args, cwd: mobile, sdkEntitlementTemplate: path.join(sdk, 'Entitlements.plist'), startedAt: Date.now() };
try {
  fs.writeFileSync(podfile, originalPodfile.toString().split('\n').filter(line => !line.includes('CapacitorMlkitBarcodeScanning')).join('\n'));
  // Reuse only the locked simulator Pods already built in this isolated copy.
  fs.copyFileSync(path.join(native, 'Pods/Manifest.lock'), lockfile);
  const build = spawnSync('xcodebuild', args, { env, cwd: mobile, stdio: 'inherit', timeout: 900000 });
  record.exitCode = build.status;
  if (build.status !== 0) throw new Error(`xcodebuild failed (${build.status}): ${build.error?.message ?? ''}`);
  const app = path.join(root, 'DerivedData/Build/Products/Debug-iphonesimulator/App.app');
  record.appPath = app;
  const commands = [];
  for (const commandArgs of [['--display', '--verbose=4', app], ['--display', '--entitlements', '-', '--xml', app], ['--verify', '--deep', '--strict', '--verbose=4', app]]) {
    const r = spawnSync('codesign', commandArgs, { env, encoding: 'utf8' });
    commands.push({ command: 'codesign', args: commandArgs, exitCode: r.status, stdout: r.stdout, stderr: r.stderr });
    if (r.status !== 0) throw new Error('Xcode signed product failed codesign inspection/verification');
  }
  record.signatureCommands = commands;
  state.appPath = app;
  state.signingMode = 'Xcode Simulator ad-hoc using installed SDK Entitlements.plist; no Development Team';
  fs.writeFileSync(workspaceFile, JSON.stringify(state, null, 2) + '\n');
  record.status = 'built-signed-verified';
} catch (error) { record.status = 'blocked'; record.error = error.message; process.exitCode = 2; }
finally {
  fs.writeFileSync(podfile, originalPodfile);
  fs.writeFileSync(lockfile, originalLock);
  record.podfileRestored = fs.readFileSync(podfile).equals(originalPodfile);
  record.podLockRestored = fs.readFileSync(lockfile).equals(originalLock);
  record.completedAt = Date.now();
  fs.writeFileSync(path.join(evidence, 'xcode-adhoc-signing.json'), JSON.stringify(record, null, 2) + '\n');
  console.log(JSON.stringify({ status: record.status, error: record.error, appPath: record.appPath }));
}
