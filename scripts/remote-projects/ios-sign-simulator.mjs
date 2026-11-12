import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const evidence = path.resolve('.scratch/remote-projects/performance/ios-baseline');
const workspaceFile = path.join(evidence, 'workspace.json');
const state = JSON.parse(fs.readFileSync(workspaceFile, 'utf8'));
if (!state.cleanedUp) throw new Error('Finish the previous device/helper/Hub cleanup before starting the signed round');
const sourceApp = state.unsignedAppPath ?? state.appPath;
if (!fs.realpathSync(sourceApp).startsWith(fs.realpathSync(state.root) + path.sep)) throw new Error('App must belong to this isolated workspace');
const archive = path.resolve('.scratch/remote-projects/performance/ios-unsigned-baseline');
if (!fs.existsSync(archive)) fs.cpSync(evidence, archive, { recursive: true });
const env = { PATH: process.env.PATH, HOME: process.env.HOME, DEVELOPER_DIR: state.developerDir };
const commands = [];
const resultFile = path.join(evidence, 'adhoc-signing.json');
const record = { classification: 'simulator-only diagnostic', sourceApp, commands,
  identity: 'Ad-hoc (-); no certificate, TeamIdentifier, provisioning profile or invented team prefix',
  entitlementPolicy: 'Main App only, its existing CFBundleIdentifier as its private default Keychain group; no shared group or authentication bypass' };
const run = (command, args) => {
  const result = spawnSync(command, args, { env, encoding: 'utf8', timeout: 120000 });
  commands.push({ command, args, exitCode: result.status, stdout: result.stdout, stderr: result.stderr });
  fs.writeFileSync(resultFile, JSON.stringify(record, null, 2) + '\n');
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}): ${result.stderr}`);
  return result.stdout;
};
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
try {
  record.unsignedExecutableSha256 = sha(path.join(sourceApp, 'App'));
  run('codesign', ['--display', '--verbose=4', sourceApp]);
  run('codesign', ['--display', '--entitlements', '-', '--xml', sourceApp]);
  const platform = run('xcrun', ['vtool', '-show-build', path.join(sourceApp, 'App')]);
  if (!platform.includes('IOSSIMULATOR')) throw new Error('Refusing to sign a non-Simulator App');
  const bundleId = run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', path.join(sourceApp, 'Info.plist')]).trim();
  if (bundleId !== state.bundleId || !/^[a-zA-Z0-9.-]+$/.test(bundleId)) throw new Error('Unexpected isolated App identifier');
  const destination = fs.mkdtempSync(path.join(state.root, 'adhoc-simulator-'));
  const app = path.join(destination, 'App.app');
  fs.cpSync(sourceApp, app, { recursive: true });
  const entitlements = path.join(destination, 'simulator-keychain.entitlements');
  fs.writeFileSync(entitlements, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>application-identifier</key><string>${bundleId}</string>
<key>keychain-access-groups</key><array><string>${bundleId}</string></array>
</dict></plist>\n`);
  record.signedApp = app;
  record.entitlements = { 'application-identifier': bundleId, 'keychain-access-groups': [bundleId] };
  run('plutil', ['-lint', entitlements]);
  // Sign inside-out, rather than deprecated --deep signing. Nested code keeps
  // its existing entitlements, if any; only the main App gains its private group.
  const nested = [];
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(file);
        if (/\.(framework|appex)$/.test(entry.name)) nested.push(file);
      } else if (entry.isFile() && entry.name.endsWith('.dylib')) nested.push(file);
    }
  };
  visit(app);
  for (const file of nested) run('codesign', ['--force', '--sign', '-', '--timestamp=none', '--preserve-metadata=entitlements', file]);
  run('codesign', ['--force', '--sign', '-', '--timestamp=none', '--generate-entitlement-der', '--entitlements', entitlements, app]);
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=4', app]);
  run('codesign', ['--display', '--verbose=4', app]);
  run('codesign', ['--display', '--entitlements', '-', '--xml', app]);
  record.originalExecutableUnchanged = sha(path.join(sourceApp, 'App')) === record.unsignedExecutableSha256;
  if (!record.originalExecutableUnchanged) throw new Error('Original build artifact changed');
  const deviceName = `Yuri Remote Projects Perf AdHoc ${Date.now()}`;
  const udid = run('xcrun', ['simctl', 'create', deviceName, 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro', state.runtime]).trim();
  state.previousUdid = state.udid;
  state.udid = udid;
  state.deviceName = deviceName;
  state.unsignedAppPath = sourceApp;
  state.appPath = app;
  state.cleanedUp = false;
  state.signingMode = 'simulator-only local ad-hoc; private Keychain entitlement';
  delete state.lastLaunch;
  delete state.lastScreenshot;
  record.status = 'signed-verified-new-device-created';
  fs.writeFileSync(workspaceFile, JSON.stringify(state, null, 2) + '\n');
} catch (error) { record.status = 'blocked'; record.error = error.message; process.exitCode = 2; }
fs.writeFileSync(resultFile, JSON.stringify(record, null, 2) + '\n');
console.log(JSON.stringify({ status: record.status, error: record.error, signedApp: record.signedApp, udid: state.udid }));
