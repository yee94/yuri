import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const evidence = path.resolve(process.env.REMOTE_PROJECTS_IOS_EVIDENCE ?? '.scratch/remote-projects/performance/ios-baseline');
const state = JSON.parse(fs.readFileSync(path.join(evidence, 'workspace.json'), 'utf8'));
const baseline = JSON.parse(fs.readFileSync('.scratch/remote-projects/performance/baseline-environment.json', 'utf8'));
const runtimeRepo = state.hubRepo ?? baseline.directory;
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const probe = spawnSync('xcrun', ['simctl', 'list', 'devices', '--json'], { env: { ...process.env, DEVELOPER_DIR: state.developerDir }, encoding: 'utf8' });
if (probe.status !== 0) throw new Error('Cannot verify Simulator deletion');
const devices = JSON.parse(probe.stdout).devices;
const hub = JSON.parse(fs.readFileSync(path.join(evidence, 'test-hub.json'), 'utf8'));
const helper = JSON.parse(fs.readFileSync(path.join(evidence, 'serve.json'), 'utf8'));
const config = JSON.parse(fs.readFileSync(path.join(hub.root, 'config.json'), 'utf8'));
const reachable = async url => {
  try { await fetch(url, { signal: AbortSignal.timeout(1500) }); return true; } catch { return false; }
};
let hubProcessAlive = true;
try { process.kill(hub.pid, 0); } catch { hubProcessAlive = false; }
const record = {
  classification: 'diagnostic', checkedAt: new Date().toISOString(),
  electronWebSha256: sha(path.join(runtimeRepo, 'packages/web/dist/index.html')),
  electronWebUnchanged: sha(path.join(runtimeRepo, 'packages/web/dist/index.html')) === state.originalWebIndexSha256,
  podfileRestored: sha(path.join(state.repo, 'packages/mobile/ios/App/Podfile')) === state.podfileSha256,
  podLockRestored: fs.readFileSync(path.join(state.repo, 'packages/mobile/ios/App/Podfile.lock')).equals(fs.readFileSync(path.join(runtimeRepo, 'packages/mobile/ios/App/Podfile.lock'))),
  taskDeviceDeleted: !Object.values(devices).flat().some(device => device.udid === state.udid),
  taskHubProcessStopped: !hubProcessAlive,
  taskHubEndpointClosed: !await reachable(hub.origin + '/health'),
  taskOpenCodeEndpointClosed: !await reachable(`http://127.0.0.1:${config.opencodePort}/api/info`),
  taskHelperEndpointClosed: !await reachable(helper.url),
  taskHelperStateRemoved: !fs.existsSync(path.join(state.root, 'helper-tmp', 'serve-sim', `server-${state.udid}.json`)),
};
fs.writeFileSync(path.join(evidence, 'integrity-cleanup.json'), JSON.stringify(record, null, 2) + '\n');
console.log(JSON.stringify(record, null, 2));
if (Object.values(record).some(value => value === false)) process.exitCode = 2;
