import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const evidence = path.resolve(process.env.REMOTE_PROJECTS_CANDIDATE_EVIDENCE ?? '.scratch/remote-projects/performance/candidate');
const snapshot = JSON.parse(fs.readFileSync(path.join(evidence, 'source-manifest.json'), 'utf8'));
const root = fs.mkdtempSync(path.join(snapshot.root, 'remote-host-'));
for (const dir of ['home', 'config', 'data', 'cache', 'project']) fs.mkdirSync(path.join(root, dir));
const config = { root, repo: snapshot.repo, evidence, binary: process.argv[2] };
if (!config.binary) throw new Error('Pass installed real OpenCode binary');
const file = path.join(root, 'config.json'); fs.writeFileSync(file, JSON.stringify(config));
const require = createRequire(path.join(snapshot.repo, 'packages/electron/package.json'));
const electron = require('electron');
const env = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, HOME: path.join(root, 'home'),
  XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'), XDG_CACHE_HOME: path.join(root, 'cache'),
  ELECTRON_RUN_AS_NODE: '1', REMOTE_PROJECTS_REMOTE_CONFIG: file, NODE_ENV: 'production' };
const child = spawn(electron, [fileURLToPath(new URL('./candidate-remote-worker.mjs', import.meta.url))], { env, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, () => child.kill(signal));
child.once('exit', code => { process.exitCode = code ?? 1; });
