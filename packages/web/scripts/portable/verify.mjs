import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'portable.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'lib/package.json'), 'utf8'));
if (manifest.format !== 1 || manifest.version !== pkg.version
  || manifest.platform !== process.platform || manifest.arch !== process.arch
  || manifest.nodeVersion !== process.versions.node || manifest.nodeAbi !== process.versions.modules
  || (process.argv[2] && manifest.version !== process.argv[2])) {
  throw new Error('Portable package version, platform or Node ABI mismatch');
}
if (process.platform === 'linux') {
  const [major, minor] = String(process.report.getReport().header.glibcVersionRuntime || '').split('.').map(Number);
  if (!(major > 2 || (major === 2 && minor >= 36))) throw new Error('This portable package requires glibc 2.36+; musl/Alpine is not supported');
}
const require = createRequire(path.join(root, 'lib/package.json'));
const db = new (require('better-sqlite3'))(':memory:');
if (db.prepare('SELECT 1 AS ok').get().ok !== 1) throw new Error('SQLite probe failed');
db.close();
const pty = require('node-pty').spawn('/bin/sh', ['-c', 'printf yuri-portable-pty'], {
  name: 'xterm', cols: 80, rows: 24, cwd: os.tmpdir(), env: process.env,
});
await new Promise((resolve, reject) => {
  let text = '';
  const timer = setTimeout(() => { pty.kill(); reject(new Error('PTY probe timed out')); }, 10000);
  pty.onData((data) => { text += data; });
  pty.onExit(({ exitCode }) => {
    clearTimeout(timer);
    if (exitCode !== 0 || !text.includes('yuri-portable-pty')) reject(new Error('PTY probe failed'));
    else resolve();
  });
});
const { applySherpaLoaderEnv } = await import('./lib/server/lib/dictation/local/sherpa-loader.js');
const speechEnv = { ...process.env };
applySherpaLoaderEnv(speechEnv);
const speech = spawnSync(process.execPath, ['--input-type=module', '-e',
  `import { loadSherpaOnnxNode } from ${JSON.stringify(pathToFileURL(path.join(root, 'lib/server/lib/dictation/local/sherpa-loader.js')).href)}; loadSherpaOnnxNode();`,
], { env: speechEnv, encoding: 'utf8', timeout: 15000 });
if (speech.status !== 0) throw new Error(`Speech addon probe failed: ${speech.stderr}`);
const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'yuri-portable-preflight-'));
try {
  const env = { ...process.env, HOME: isolated, YURI_DATA_DIR: path.join(isolated, 'yuri') };
  const cli = spawnSync(path.join(root, 'yuri'), ['--version'], { env, encoding: 'utf8', timeout: 15000 });
  if (cli.status !== 0 || !cli.stdout.includes(manifest.version)) throw new Error(`CLI probe failed: ${cli.stderr}`);
  const opencode = spawnSync(path.join(root, 'bin/opencode'), ['--version'], { env, encoding: 'utf8', timeout: 15000 });
  if (opencode.status !== 0 || !opencode.stdout.includes(manifest.opencodeVersion)) throw new Error('OpenCode probe failed');
} finally {
  fs.rmSync(isolated, { recursive: true, force: true });
}
for (const file of ['lib/dist/index.html', 'lib/server/lib/llm/bridge-plugin.bundle.js']) {
  if (!fs.existsSync(path.join(root, file))) throw new Error(`Missing portable asset: ${file}`);
}
console.log(`Verified Yuri ${manifest.version}, Node ${manifest.nodeVersion}, ${manifest.platform}-${manifest.arch}`);
