import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const root = path.resolve(process.argv[2]);
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'yuri-portable-smoke-'));
const launcher = path.join(root, 'yuri');
const env = {
  ...process.env, HOME: home, PATH: process.env.YURI_PORTABLE_SMOKE_PATH || '/usr/bin:/bin',
  YURI_DATA_DIR: path.join(home, 'yuri'), XDG_DATA_HOME: path.join(home, 'data'),
  XDG_CONFIG_HOME: path.join(home, 'config'), XDG_CACHE_HOME: path.join(home, 'cache'),
  XDG_STATE_HOME: path.join(home, 'state'), YURI_OPENCODE_SHARED_SERVICE: '0',
  YURI_WEIXIN_ENABLED: '0', YURI_CHANNELS_ENABLED: '0',
  YURI_UI_PASSWORD: randomBytes(32).toString('hex'),
};
function command(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(launcher, args, { env, cwd: home, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Command timed out: ${args[0]}`)); }, 90000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`${args[0]} failed (${code}): ${stderr}\n${stdout}`));
      else resolve(stdout);
    });
  });
}
let startedSuccessfully = false;
try {
  const started = JSON.parse(await command(['serve', '--port', '39107', '--json']));
  startedSuccessfully = true;
  assert.equal(started.port, 39107);
  const health = await (await fetch('http://127.0.0.1:39107/health')).json();
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'portable.json'), 'utf8'));
  assert.equal(health.yuriVersion, manifest.version);
  assert.equal((await fetch('http://127.0.0.1:39107/api/info')).status, 401);
  const login = await fetch('http://127.0.0.1:39107/auth/session', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: env.YURI_UI_PASSWORD, trustDevice: true, issueClientToken: true }),
  });
  assert.equal(login.status, 200);
  const { clientToken } = await login.json();
  assert.ok(clientToken, 'Authentication did not issue a client token');
  const page = await fetch('http://127.0.0.1:39107/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<html/i);
  JSON.parse(await command(['status', '--json']));
  // Give initialization a bounded window; a healthy Yuri listener alone is not OpenCode readiness.
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    const response = await fetch('http://127.0.0.1:39107/api/info', {
      headers: { Authorization: `Bearer ${clientToken}` }, signal: AbortSignal.timeout(5000),
    });
    if (response.ok && (await response.json()).version?.startsWith('2.')) { ready = true; break; }
    await delay(1000);
  }
  assert.equal(ready, true, 'Bundled OpenCode did not become ready');
  console.log('Portable Linux smoke passed without system Node/npm/Python/compiler');
} finally {
  try {
    if (startedSuccessfully) await command(['stop', '--port', '39107', '--json']);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}
