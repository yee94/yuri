import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
const binary = process.argv[2];
const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'opencode/remote-projects-cli-'));
const env = { PATH: process.env.PATH, HOME: root, XDG_DATA_HOME: path.join(root, 'data'), XDG_CONFIG_HOME: path.join(root, 'config'), XDG_CACHE_HOME: path.join(root, 'cache') };
const password = randomBytes(24).toString('hex');
env.OPENCODE_PASSWORD = password;
env.OPENCODE_SERVER_PASSWORD = password;
const headers = { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` };
const port = await new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); });
const log = fs.openSync('.scratch/remote-projects/performance/isolated-cli.log', 'w');
const child = spawn(binary, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], { env, cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
for (const stream of [child.stdout, child.stderr]) createInterface({ input: stream }).on('line', line => fs.writeSync(log, /password|authorization|bearer|token/i.test(line) ? '[credential-bearing diagnostic line redacted]\n' : line.split(password).join('[REDACTED]') + '\n'));
try {
  const deadline = Date.now() + 30000;
  while (true) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/openapi.json`, { headers, signal: AbortSignal.timeout(1000) });
      if (response.ok) {
        const schema = await response.json();
        fs.writeFileSync('.scratch/remote-projects/performance/isolated-openapi.json', JSON.stringify(schema, null, 2));
        const json = async (route, method, body) => {
          const r = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { ...headers, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
          const text = await r.text();
          return { status: r.status, body: text ? JSON.parse(text) : null };
        };
        const created = await json('/api/session', 'POST', { title: 'Isolated performance seed', location: { directory: root } });
        const info = created.body?.data;
        const fixtureResults = { created };
        if (info?.id) {
          fixtureResults.deleted = await json(`/api/session/${info.id}`, 'DELETE');
          fixtureResults.imported = await json('/api/experimental/session/import', 'POST', {
            info, location: { directory: root }, messages: [{ id: 'msg_performance_fixture', type: 'user', time: { created: Date.now() }, text: 'Isolated performance fixture message' }],
          });
          fixtureResults.messages = await json(`/api/session/${info.id}/message`, 'GET');
        }
        fs.writeFileSync('.scratch/remote-projects/performance/isolated-cli-seed.json', JSON.stringify(fixtureResults, null, 2));
        console.log(JSON.stringify({ root, port, paths: Object.keys(schema.paths).filter(p => /session|message|import/.test(p)) }, null, 2));
        break;
      }
    } catch {}
    if (Date.now() > deadline) throw new Error('Isolated CLI never exposed OpenAPI');
    await delay(100);
  }
} finally { child.kill('SIGTERM'); fs.closeSync(log); }
