import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

/** Credentials stay in this closure; callers receive neither headers nor config. */
export async function liveHost() {
  const origin = new URL(process.env.NSH_LIVE_ORIGIN || 'http://127.0.0.1:57123').origin;
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname)) throw new Error('Live acceptance requires a loopback Host');
  const settingsFile = process.env.NSH_LIVE_SETTINGS || path.join(process.env.YURI_DATA_DIR || path.join(homedir(), '.config', 'yuri'), 'settings.json');
  const settings = JSON.parse(await readFile(settingsFile, 'utf8'));
  const token = settings.desktopLocalClientToken;
  if (typeof token !== 'string' || !token) throw new Error('Local desktop credential unavailable');
  const headers = { authorization: `Bearer ${token}` };
  const fetchHost = (resource, init = {}) => fetch(origin + resource, { ...init, redirect: 'error', headers: { ...headers, ...init.headers } });
  return {
    origin,
    async request(resource, method = 'GET', body) {
      const response = await fetchHost(resource, { method, signal: AbortSignal.timeout(30_000), ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) });
      const raw = await response.text();
      let value = null;
      if (raw) { try { value = JSON.parse(raw); } catch { throw new Error(`Non-JSON live response (${response.status})`); } }
      // Do not echo bodies: even errors may contain credentials or config.
      if (!response.ok) {
        const error = new Error(`Live HTTP ${response.status} at ${resource.split('?')[0]}`);
        error.status = response.status;
        // Only this known benign command failure is classified; no server text escapes.
        if (value?._tag === 'CommandExecutionError' && value?.message === 'No goal is set.') error.reason = 'no-goal';
        throw error;
      }
      return value;
    },
    async stream(resource, onFrame, signal) {
      const response = await fetchHost(resource, { signal, headers: { accept: 'text/event-stream' } });
      if (!response.ok || !response.body) throw new Error(`Live SSE HTTP ${response.status}`);
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let buffer = '';
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, '\n');
          let boundary;
          while ((boundary = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
            const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
            if (data) await onFrame(JSON.parse(data));
          }
        }
      } finally { await reader.cancel().catch(() => {}); }
    },
  };
}
