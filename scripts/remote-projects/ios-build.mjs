import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const evidence = path.resolve(process.env.REMOTE_PROJECTS_IOS_EVIDENCE ?? '.scratch/remote-projects/performance/ios-baseline');
const recordPath = path.join(evidence, 'workspace.json');
const state = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
const mobile = path.join(state.repo, 'packages/mobile');
const podfile = path.join(mobile, 'ios/App/Podfile');
const lockfile = path.join(mobile, 'ios/App/Podfile.lock');
const originalPodfile = fs.readFileSync(podfile);
const originalLock = fs.existsSync(lockfile) ? fs.readFileSync(lockfile) : undefined;
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'SHELL', 'USER', 'LOGNAME'].includes(key)));
env.DEVELOPER_DIR = state.developerDir;
env.PATH = path.join(mobile, 'node_modules/.bin') + path.delimiter + env.PATH;
const run = (command, args, cwd = mobile) => {
  const startedAt = Date.now();
  console.log(JSON.stringify({ stage: 'command', command, args, cwd, startedAt }));
  const result = spawnSync(command, args, { env, cwd, stdio: 'inherit', timeout: 900_000 });
  state.stages.push({ command, args, cwd, startedAt, durationMs: Date.now() - startedAt, exitCode: result.status, error: result.error?.message });
  fs.writeFileSync(recordPath, JSON.stringify(state, null, 2) + '\n');
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.signal}): ${result.error?.message ?? ''}`);
};
try {
  // Same owning simulator script sequence, but with an isolated native workspace
  // and explicit DerivedData; never write the saved Electron Web bundle.
  run('bun', ['run', 'build']);
  run('cap', ['copy', 'ios']);
  fs.writeFileSync(podfile, originalPodfile.toString().split('\n').filter(line => !line.includes('CapacitorMlkitBarcodeScanning')).join('\n'));
  run('pod', ['install'], path.join(mobile, 'ios/App'));
  state.simulatorPodLock = fs.readFileSync(lockfile, 'utf8');
  run('xcodebuild', ['-workspace', 'ios/App/App.xcworkspace', '-scheme', 'App', '-configuration', 'Debug',
    '-sdk', 'iphonesimulator', '-destination', `platform=iOS Simulator,id=${state.udid}`,
    '-derivedDataPath', state.derivedData, '-resultBundlePath', path.join(state.root, 'build.xcresult'),
    'CODE_SIGNING_ALLOWED=NO', 'CODE_SIGNING_REQUIRED=NO', 'build']);
  state.appPath = path.join(state.derivedData, 'Build/Products/Debug-iphonesimulator/App.app');
  if (!fs.existsSync(state.appPath)) throw new Error('xcodebuild returned success without the expected real App.app');
  state.buildStatus = 'built';
} catch (error) { state.buildStatus = 'blocked'; state.buildError = error.message; process.exitCode = 2; }
finally {
  fs.writeFileSync(podfile, originalPodfile);
  if (originalLock) fs.writeFileSync(lockfile, originalLock);
  state.podfileRestored = createHash('sha256').update(fs.readFileSync(podfile)).digest('hex') === state.podfileSha256;
  state.podLockRestored = !originalLock || fs.readFileSync(lockfile).equals(originalLock);
  fs.writeFileSync(recordPath, JSON.stringify(state, null, 2) + '\n');
  fs.writeFileSync(path.join(evidence, 'build-result.json'), JSON.stringify({ buildStatus: state.buildStatus, appPath: state.appPath, error: state.buildError, podfileRestored: state.podfileRestored, podLockRestored: state.podLockRestored }, null, 2) + '\n');
  console.log(JSON.stringify({ buildStatus: state.buildStatus, appPath: state.appPath, error: state.buildError, podfileRestored: state.podfileRestored, podLockRestored: state.podLockRestored }));
}
