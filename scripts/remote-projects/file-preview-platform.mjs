import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const evidence = path.resolve(process.env.REMOTE_PROJECTS_CANDIDATE_EVIDENCE ?? '.scratch/remote-projects/performance/candidate-ui-native/independent');
const snapshot = JSON.parse(fs.readFileSync(path.join(evidence, 'source-manifest.json')));
const root = fs.mkdtempSync(path.join(snapshot.root, 'platform-files-'));
for (const dir of ['home', 'data', 'config', 'cache']) fs.mkdirSync(path.join(root, dir));
const config = path.join(root, 'config.json');
fs.writeFileSync(config, JSON.stringify({ root, evidence, manifest: path.join(evidence, 'source-manifest.json') }));
const require = createRequire(path.join(snapshot.repo, 'packages/electron/package.json'));
const env = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, HOME: path.join(root, 'home'),
  XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'), XDG_CACHE_HOME: path.join(root, 'cache'),
  YURI_DATA_DIR: path.join(root, 'data'), ELECTRON_RUN_AS_NODE: '1', REMOTE_PROJECTS_PLATFORM_CONFIG: config, NODE_ENV: 'production' };
const child = spawn(require('electron'), [fileURLToPath(new URL('./file-preview-platform-worker.mjs', import.meta.url))], { env, stdio: 'inherit' });
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.once(signal, () => child.kill(signal));
child.once('exit', code => { process.exitCode = code ?? 1; });
