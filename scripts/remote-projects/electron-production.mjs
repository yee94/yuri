import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { startSeededOpenCode } from './seeded-opencode.mjs';
import { createHash } from 'node:crypto';

const option = name => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const repo = path.resolve(option('repo') ?? '.');
const phase = option('phase');
const build = option('build');
const classification = option('classification') ?? 'diagnostic';
if (!['diagnostic', 'budget'].includes(classification)) throw new Error('classification must be diagnostic|budget');
if (classification === 'budget' && !process.argv.includes('--confirm-quiescent')) throw new Error('Formal budget sampling requires externally scheduled quiescence and --confirm-quiescent');
if (!['baseline', 'candidate'].includes(phase) || !build) throw new Error('--phase=baseline|candidate and --build=... required');
const count = Number(option('cold-starts') ?? 20);
if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error('cold-starts must be 1..100');
const out = path.resolve(option('out') ?? `.scratch/remote-projects/performance/electron-${phase}`);
if (option('remote-config') && option('remote-configs')) throw new Error('Choose one isolated remote descriptor input');
const configuredHosts = option('remote-configs')
  ? JSON.parse(fs.readFileSync(option('remote-configs'), 'utf8')).hosts
  : option('remote-config') ? [JSON.parse(fs.readFileSync(option('remote-config'), 'utf8')).host] : undefined;
if (configuredHosts && (!Array.isArray(configuredHosts) || configuredHosts.some(host => !host?.id))) throw new Error('Invalid isolated remote descriptors');
fs.mkdirSync(out, { recursive: true });
const temporaryBase = option('temp-root') ?? path.join(process.env.TMPDIR ?? os.tmpdir(), 'opencode');
fs.mkdirSync(temporaryBase, { recursive: true });
const root = fs.mkdtempSync(path.join(temporaryBase, 'remote-projects-electron-'));
const require = createRequire(path.join(repo, 'packages/electron/package.json'));
const binary = require('electron');
const entry = fileURLToPath(new URL('./electron-production-entry.mjs', import.meta.url));
const entrySource = fs.readFileSync(entry);
const probeSource = fs.readFileSync(new URL('./browser-probe.js', import.meta.url));
const runs = [];
let activeService;
let activeElectron;
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, async () => {
  if (stopping) return;
  stopping = true;
  if (activeElectron && activeElectron.exitCode === null && activeElectron.signalCode === null) {
    try { process.kill(-activeElectron.pid, 'SIGTERM'); } catch {}
  }
  await activeService?.close();
  process.exit(130);
});

for (let index = 0; index < count; index++) {
  const runRoot = path.join(root, `cold-${index}`);
  for (const dir of ['home', 'app-data', 'user-data', 'logs', 'xdg-config', 'xdg-data', 'xdg-cache', 'yuri-data', 'project']) fs.mkdirSync(path.join(runRoot, dir), { recursive: true });
  // Never inherit runtime/provider/authentication/config variables from the agent.
  const allowedEnv = new Set(['PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ', 'DISPLAY', 'WAYLAND_DISPLAY', '__CF_USER_TEXT_ENCODING']);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowedEnv.has(key)));
  Object.assign(env, { HOME: path.join(runRoot, 'home'), XDG_CONFIG_HOME: path.join(runRoot, 'xdg-config'),
    XDG_DATA_HOME: path.join(runRoot, 'xdg-data'), XDG_CACHE_HOME: path.join(runRoot, 'xdg-cache'),
    YURI_DATA_DIR: path.join(runRoot, 'yuri-data'), YURI_MANAGED_PROCESS_REGISTRY: path.join(runRoot, 'managed-processes'),
    NODE_ENV: 'production', YURI_ELECTRON_DEV: '1', YURI_ELECTRON_USE_BUNDLED_UI: '1', YURI_HOST: '127.0.0.1',
  });
  if (option('opencode-binary')) env.OPENCODE_BINARY = path.resolve(option('opencode-binary'));
  // Explicitly reserve a fresh configured desktop port; never use a user listener.
  const port = await new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
  const opencodePort = await new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
  env.OPENCODE_PORT = String(opencodePort);
  let service;
  if (option('opencode-binary')) {
    service = await startSeededOpenCode({ binary: env.OPENCODE_BINARY, env, root: runRoot, port: opencodePort, directory: option('project-directory'), logFile: path.join(out, `cold-${index}-opencode.log`), onStart: controller => { activeService = controller; } });
    activeService = service;
    Object.assign(env, service.env);
  }
  fs.writeFileSync(path.join(runRoot, 'yuri-data/settings.json'), JSON.stringify({ desktopLocalPort: port, desktopLanAccess: false,
    ...(configuredHosts ? { desktopHosts: configuredHosts } : {}),
    desktopDefaultHostId: 'local', desktopInitialHostChoiceCompleted: true,
    ...(service ? { projects: [{ id: 'performance-project', path: service.directory, label: 'Performance project', addedAt: 1790000000000, lastOpenedAt: 1790000000000 }], activeProjectId: 'performance-project',
      lastDirectory: service.directory, homeDirectory: path.join(runRoot, 'home'),
      desktopWindowStates: [{ hostId: 'local', route: `/session/${service.sessionId}`, x: 0, y: 0, width: 1280, height: 900 }] } : {}) }));
  const config = { root: runRoot, repo, phase, build, timeoutMs: Number(option('timeout-ms') ?? 60_000),
    bootstrapLocalCredential: process.argv.includes('--bootstrap-local-credential'),
    interactive: process.argv.includes('--interactive'),
    classification, loadAverageAtLaunch: os.loadavg(),
    input: process.argv.includes('--input') && index === 0, headless: process.argv.includes('--headless'), fixture: service?.fixture,
    stageFile: path.join(out, `cold-${index}-stages.jsonl`), resultFile: path.join(out, `cold-${index}-result.json`), launchEpochMs: Date.now() };
  const configFile = path.join(runRoot, 'probe-config.json'); fs.writeFileSync(configFile, JSON.stringify(config));
  env.REMOTE_PROJECTS_PROBE_CONFIG = configFile;
  if (config.interactive) fs.writeFileSync(path.join(out, 'interactive.json'), JSON.stringify({ root: runRoot, controlFile: path.join(runRoot, 'control.json'), repliesFile: path.join(runRoot, 'control-replies.jsonl'), out, repo, sourceHash: build }, null, 2));
  const localEntry = path.join(runRoot, 'electron-production-entry.mjs');
  fs.writeFileSync(localEntry, entrySource);
  fs.copyFileSync(new URL('./terminal-frame-observer.mjs', import.meta.url), path.join(runRoot, 'terminal-frame-observer.mjs'));
  fs.writeFileSync(path.join(runRoot, 'browser-probe.js'), probeSource);
  const command = [binary, ...(config.headless ? ['--headless', '--disable-gpu'] : []), localEntry];
  fs.writeFileSync(path.join(out, `cold-${index}-command.json`), JSON.stringify({ command, cwd: path.join(runRoot, 'project'), isolatedRoot: runRoot, envKeys: Object.keys(env), phase, build,
    entrySha256: createHash('sha256').update(entrySource).digest('hex'), probeSha256: createHash('sha256').update(probeSource).digest('hex') }, null, 2));
  const log = fs.openSync(path.join(out, `cold-${index}.log`), 'w');
  console.log(JSON.stringify({ index, stage: 'spawn', root: runRoot, binary, headless: config.headless }));
  const result = await new Promise(resolve => {
    const child = spawn(binary, command.slice(1), { cwd: path.join(runRoot, 'project'), env, detached: true, stdio: ['ignore', log, log] });
    activeElectron = child;
    const kill = signal => { try { process.kill(-child.pid, signal); } catch {} };
    const timer = setTimeout(() => kill('SIGTERM'), config.timeoutMs + 10_000);
    const hard = setTimeout(() => kill('SIGKILL'), config.timeoutMs + 15_000);
    child.once('error', error => { clearTimeout(timer); clearTimeout(hard); resolve({ error: error.message }); });
    child.once('exit', (code, signal) => { clearTimeout(timer); clearTimeout(hard); kill('SIGTERM'); resolve({ code, signal }); });
  });
  fs.closeSync(log);
  await service?.close();
  activeService = undefined;
  activeElectron = undefined;
  const raw = fs.existsSync(config.resultFile) ? JSON.parse(fs.readFileSync(config.resultFile, 'utf8')) : { status: 'blocked', reason: 'Electron exited without result; see command and process log' };
  runs.push({ index, ...result, raw });
  fs.writeFileSync(path.join(out, 'runs.json'), JSON.stringify({ schemaVersion: 1, classification, phase, build, requestedColdStarts: count, isolatedRoot: root, runs }, null, 2));
  console.log(JSON.stringify({ index, ...result, status: raw.status }));
  // Repeating an environment boot failure 20 times produces no useful timing.
  if (raw.status !== 'measured') { process.exitCode = 2; break; }
}
