import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { randomUUID } from 'node:crypto';

const evidence = path.resolve(process.env.REMOTE_PROJECTS_IOS_EVIDENCE ?? '.scratch/remote-projects/performance/ios-baseline');
const state = JSON.parse(fs.readFileSync(path.join(evidence, 'workspace.json'), 'utf8'));
const action = process.argv[2];
if (['pair', 'inspect', 'stop'].includes(action)) {
  const hub = JSON.parse(fs.readFileSync(path.join(evidence, 'test-hub.json'), 'utf8'));
  if (!hub.root.startsWith(state.root + path.sep)) throw new Error('Not this task Hub');
  fs.writeFileSync(path.join(hub.root, 'control.json'), JSON.stringify({ id: randomUUID(), action }));
} else if (action === 'start') {
  const existingFile = path.join(evidence, 'test-hub.json');
  if (fs.existsSync(existingFile)) {
    const existing = JSON.parse(fs.readFileSync(existingFile, 'utf8'));
    if (!existing.root.startsWith(state.root + path.sep)) throw new Error('Existing Hub evidence belongs to another workspace');
    let alive = false;
    try { process.kill(existing.pid, 0); alive = true; } catch {}
    if (alive) { console.log('[ios-test-hub] reusing existing task Hub'); process.exit(0); }
  }
  const baseline = JSON.parse(fs.readFileSync('.scratch/remote-projects/performance/baseline-environment.json', 'utf8'));
  const runtimeRepo = state.hubRepo ?? baseline.directory;
  const require = createRequire(path.join(runtimeRepo, 'packages/electron/package.json'));
  const binary = require('electron');
  const root = fs.mkdtempSync(path.join(state.root, 'hub-'));
  for (const dir of ['home', 'project', 'app-data', 'user-data', 'logs', 'data', 'config', 'cache']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  const freePort = () => new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
  const config = { root, repo: runtimeRepo, evidence, udid: state.udid, port: await freePort(), opencodePort: await freePort(), binary: process.argv[3], remoteDescriptorFile: process.env.REMOTE_PROJECTS_REMOTE_DESCRIPTOR, projectDirectory: process.env.REMOTE_PROJECTS_COLLISION_DIRECTORY, projectLabel: state.phase === 'candidate' ? 'project' : 'iOS performance project' };
  if (!config.binary) throw new Error('Pass the already-installed OpenCode binary path');
  const file = path.join(root, 'config.json'); fs.writeFileSync(file, JSON.stringify(config));
  const env = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, HOME: path.join(root, 'home'), DEVELOPER_DIR: state.developerDir,
    XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'), XDG_CACHE_HOME: path.join(root, 'cache'),
    YURI_DATA_DIR: path.join(root, 'yuri-data'), REMOTE_PROJECTS_IOS_HUB_CONFIG: file, NODE_ENV: 'production' };
  const child = spawn(binary, [fileURLToPath(new URL('./ios-hub-entry.mjs', import.meta.url))], { env, cwd: path.join(root, 'project'), stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, () => { child.kill(signal); });
  child.once('exit', code => { process.exitCode = code ?? 1; });
} else throw new Error('Usage: ios-test-hub.mjs start /path/to/existing/opencode | pair | inspect | stop');
