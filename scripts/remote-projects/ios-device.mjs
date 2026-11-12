import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const action = process.argv[2];
const evidence = path.resolve(process.env.REMOTE_PROJECTS_IOS_EVIDENCE ?? '.scratch/remote-projects/performance/ios-baseline');
const recordPath = path.join(evidence, 'workspace.json');
const state = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'SHELL', 'USER', 'LOGNAME'].includes(key)));
env.DEVELOPER_DIR = state.developerDir;
const run = (args, { capture = false, privateArgument = false } = {}) => {
  const start = Date.now();
  const result = spawnSync('xcrun', args, { env, encoding: 'utf8', timeout: 180000, stdio: capture ? 'pipe' : 'inherit' });
  const record = { command: 'xcrun', args: privateArgument ? ['simctl', 'openurl', state.udid, '[transient test pairing link redacted]'] : args,
    startedAt: start, durationMs: Date.now() - start, exitCode: result.status, error: result.error?.message };
  fs.appendFileSync(path.join(evidence, 'device-commands.jsonl'), JSON.stringify(record) + '\n');
  if (result.status !== 0) throw new Error(`simctl ${args[1]} failed (${result.status}): ${result.stderr ?? result.error?.message ?? ''}`);
  return result.stdout?.trim();
};
const devices = JSON.parse(run(['simctl', 'list', 'devices', '--json'], { capture: true })).devices;
const owned = Object.values(devices).flat().find(d => d.udid === state.udid && d.name === state.deviceName && d.name.startsWith('Yuri Remote Projects Perf '));
if (!owned && !(action === 'cleanup' && state.cleanedUp)) throw new Error('Refusing device operation: exact task-owned UDID/name not found');
if (action === 'boot') {
  if (owned.state !== 'Booted') run(['simctl', 'boot', state.udid]);
  run(['simctl', 'bootstatus', state.udid, '-b']);
} else if (action === 'install') {
  if (state.buildStatus !== 'built' || !fs.existsSync(state.appPath)) throw new Error('No successful native App.app available');
  run(['simctl', 'install', state.udid, state.appPath]);
} else if (action === 'launch' || action === 'foreground') {
  const startedAt = Date.now();
  const stdout = run(['simctl', 'launch', ...(action === 'launch' ? ['--terminate-running-process'] : []), state.udid, state.bundleId], { capture: true });
  state.lastLaunch = { action, startedAt, launchReturnEpochMs: Date.now(), stdout,
    limitation: 'simctl return latency is process/activation acknowledgement, not first visible frame or latest session state' };
  console.log(JSON.stringify(state.lastLaunch));
} else if (action === 'screenshot') {
  const name = process.argv[3] ?? `frame-${Date.now()}`;
  if (!/^[a-zA-Z0-9-]+$/.test(name)) throw new Error('Unsafe screenshot name');
  const file = path.join(evidence, `${name}.png`);
  run(['simctl', 'io', state.udid, 'screenshot', file]);
  state.lastScreenshot = { file, capturedAt: Date.now(), sinceLastLaunchMs: state.lastLaunch ? Date.now() - state.lastLaunch.startedAt : undefined };
  console.log(JSON.stringify(state.lastScreenshot));
} else if (action === 'cleanup') {
  if (owned) {
    if (owned.state === 'Booted') run(['simctl', 'shutdown', state.udid]);
    run(['simctl', 'delete', state.udid]);
  }
  state.cleanedUp = true;
} else throw new Error('Usage: ios-device.mjs boot|install|launch|foreground|screenshot [name]|cleanup');
if (!['boot', 'install'].includes(action)) fs.writeFileSync(recordPath, JSON.stringify(state, null, 2) + '\n');
