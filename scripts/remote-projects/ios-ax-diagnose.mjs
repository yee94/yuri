import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const evidence = path.resolve(process.env.REMOTE_PROJECTS_IOS_EVIDENCE ?? '.scratch/remote-projects/performance/ios-baseline');
const label = process.argv[2];
if (!/^[a-zA-Z0-9-]+$/.test(label ?? '')) throw new Error('Unique safe label required');
const file = path.join(evidence, `ax-diagnostic-${label}.json`);
if (fs.existsSync(file)) throw new Error('Refusing diagnostic overwrite');
const state = JSON.parse(fs.readFileSync(path.join(evidence, 'workspace.json')));
const helper = JSON.parse(fs.readFileSync(path.join(state.root, 'helper-tmp/serve-sim', `server-${state.udid}.json`)));
if (helper.device !== state.udid || !Number.isInteger(helper.pid)) throw new Error('Task helper identity mismatch');
const appPid = Number(state.lastLaunch.stdout.split(': ').at(-1));
const ps = spawnSync('ps', ['-p', String(appPid), '-o', 'command='], { encoding: 'utf8' });
if (!ps.stdout.includes(state.udid) || !ps.stdout.includes('/App.app/App')) throw new Error('Task App PID mismatch');
const env = { ...process.env, DEVELOPER_DIR: state.developerDir, REMOTE_PROJECTS_IOS_EVIDENCE: evidence };
const report = { label, udid: state.udid, appPid, helperPid: helper.pid, sourceHash: state.sourceHash, startedAt: Date.now(), calls: [], samples: [], limitation: 'Sampling and framebuffer success alone do not prove App responsiveness; correlate WK/UI observations. No product-state fetch, App restart, value or draft writes.' };
const save = () => fs.writeFileSync(file, JSON.stringify(report, null, 2));
const request = async route => {
  const start = Date.now();
  try {
    const r = await fetch(`http://127.0.0.1:${helper.port}${route}`, { signal: AbortSignal.timeout(15000) });
    const bytes = await r.text();
    const row = { route, startedAt: start, durationMs: Date.now() - start, status: r.status, bytes: Buffer.byteLength(bytes) };
    if (route === '/ax' && !r.ok) row.errorBody = bytes.slice(0, 2000);
    if (route === '/ax' && r.ok) {
      JSON.parse(bytes);
      fs.writeFileSync(path.join(evidence, `ax-diagnostic-${label}-tree.json`), bytes, { flag: 'wx' });
    }
    report.calls.push(row); save(); return row;
  } catch (error) { const row = { route, startedAt: start, durationMs: Date.now() - start, error: error.name }; report.calls.push(row); save(); return row; }
};
const sample = async (pid, name) => {
  const output = path.join(evidence, `ax-diagnostic-${label}-${name}.sample.txt`);
  const child = spawn('sample', [String(pid), '3', '10', '-file', output], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', b => { stderr += b; }); child.stdout.resume();
  const status = await new Promise(resolve => child.once('exit', resolve));
  report.samples.push({ name, pid, status, file: path.basename(output), stderr: status === 0 ? undefined : stderr }); save();
};
await request('/');
const pending = request('/ax');
await delay(1500);
const launchctl = spawnSync('xcrun', ['simctl', 'spawn', state.udid, 'launchctl', 'list'], { env, encoding: 'utf8', timeout: 15000 });
report.taskAccessibilityServices = launchctl.stdout.split('\n').filter(line => /accessibility|AXHelper/i.test(line)).map(line => {
  const [pid, status, service] = line.trim().split(/\s+/); return { pid: /^\d+$/.test(pid) ? Number(pid) : null, status, service };
});
const accessibilityPids = new Set(report.taskAccessibilityServices.map(service => service.pid).filter(Boolean));
const processes = spawnSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' }).stdout.split('\n');
report.axHelperCandidates = processes.filter(line => /AXHelper|AXUIService|AccessibilityUIServer/.test(line)).map(line => {
  const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
  return match && { pid: Number(match[1]), ppid: Number(match[2]), executable: path.basename(match[3].split(' -')[0]), taskDeviceMentioned: line.includes(state.udid), taskHelperChild: Number(match[2]) === helper.pid, taskAccessibilityService: accessibilityPids.has(Number(match[1])) };
}).filter(Boolean); save();
const work = [sample(helper.pid, 'helper'), sample(appPid, 'app'), request('/')];
for (const proc of report.axHelperCandidates.filter(r => r.taskDeviceMentioned || r.taskHelperChild || r.taskAccessibilityService)) work.push(sample(proc.pid, 'axhelper-' + proc.pid));
await Promise.allSettled(work);
const probe = spawnSync(process.execPath, ['scripts/remote-projects/ios-input-probe.mjs', `ax-${label}`], { env, encoding: 'utf8', timeout: 60000 });
report.appObservation = { status: probe.status, stdout: probe.stdout, stderr: probe.stderr };
await pending;
report.completedAt = Date.now(); save();
console.log(JSON.stringify({ label, calls: report.calls, sampleResults: report.samples.map(s => ({ name: s.name, status: s.status })), appObservationExit: probe.status, axHelperCandidates: report.axHelperCandidates }));
if (!report.calls.some(r => r.route === '/ax' && r.status === 200)) process.exitCode = 2;
