import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

// Real CLI + real import API; no model request, provider credential or fake DOM.
export async function startSeededOpenCode({ binary, env, root, port, logFile, onStart, reuseSessionId, directory = path.join(root, 'project') }) {
  directory = fs.realpathSync(directory);
  const password = randomBytes(24).toString('hex');
  const serviceEnv = { ...env, OPENCODE_PASSWORD: password, OPENCODE_SERVER_PASSWORD: password };
  const log = fs.openSync(logFile, 'w');
  const child = spawn(binary, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
    env: serviceEnv, cwd: directory, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let childError;
  child.once('error', error => { childError = error; });
  for (const stream of [child.stdout, child.stderr]) {
    createInterface({ input: stream }).on('line', line => {
      fs.writeSync(log, /password|authorization|bearer|token/i.test(line) ? '[credential-bearing diagnostic line redacted]\n' : line.split(password).join('[REDACTED]') + '\n');
    });
  }
  const close = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(2500)]);
      if (child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
    }
  };
  onStart?.({ close });
  const headers = { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`, 'content-type': 'application/json' };
  const origin = `http://127.0.0.1:${port}`;
  const request = async (route, method = 'GET', body) => {
    const response = await fetch(origin + route, { method, headers, signal: AbortSignal.timeout(10_000), ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await response.text();
    if (!response.ok) throw new Error(`Isolated fixture ${method} ${route} failed HTTP ${response.status}: ${text.slice(0, 1000)}`);
    return text ? JSON.parse(text) : null;
  };
  try {
    const deadline = Date.now() + 30000;
    while (true) {
      if (childError) throw childError;
      try { await request('/api/info'); break; } catch (error) {
        if (child.exitCode !== null || Date.now() > deadline) throw error;
        await delay(100);
      }
    }
    const location = { directory };
    if (reuseSessionId) {
      const readBack = await request(`/api/session/${reuseSessionId}/message`);
      if (!readBack.data?.length) throw new Error('Existing isolated fixture transcript missing; refusing to reseed over it');
      return { close, sessionId: reuseSessionId, directory, fixture: { projects: 1, summaries: 1, messages: readBack.data.length, liveStreams: 0, remoteProjects: 0, source: 'reused real isolated OpenCode session; no import or draft writes' },
        env: { OPENCODE_HOST: origin, OPENCODE_PORT: String(port), OPENCODE_SKIP_START: 'true', OPENCODE_PASSWORD: password, OPENCODE_SERVER_PASSWORD: password } };
    }
    const { data: info } = await request('/api/session', 'POST', { title: 'Performance baseline session', location });
    await request(`/api/session/${info.id}`, 'DELETE');
    const messages = Array.from({ length: 20 }, (_, i) => ({ id: `msg_performance_fixture_${i}`,
      type: 'user', time: { created: info.time.created + i }, text: `Isolated baseline message ${i}. Production full application transcript.` }));
    await request('/api/experimental/session/import', 'POST', { info, location, messages });
    const readBack = await request(`/api/session/${info.id}/message`);
    if (!readBack.data?.length) throw new Error('Real imported transcript missing');
    return { close, sessionId: info.id, directory: location.directory, fixture: { projects: 1, summaries: 1, messages: 20, liveStreams: 0, remoteProjects: 0, source: 'real OpenCode session/import APIs' },
      env: { OPENCODE_HOST: origin, OPENCODE_PORT: String(port), OPENCODE_SKIP_START: 'true', OPENCODE_PASSWORD: password, OPENCODE_SERVER_PASSWORD: password } };
  } catch (error) { await close(); throw error; }
}
