import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const remoteConnectionsCommand = (executable, script, encoded, operation) => {
  const args = [executable, script, encoded, operation];
  const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
  if (process.platform !== 'win32') return `ELECTRON_RUN_AS_NODE=1 ${args.map(quote).join(' ')}`;
  const psQuote = (value) => `'${String(value).replaceAll("'", "''")}'`;
  const ps = `$env:ELECTRON_RUN_AS_NODE='1'; & ${args.map(psQuote).join(' ')}`;
  return `powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${Buffer.from(ps, 'utf16le').toString('base64')}`;
};

async function main() {
  try {
    const [encoded, operation] = process.argv.slice(2);
    const binding = JSON.parse(Buffer.from(encoded, 'base64url').toString());
    if (!['describe', 'list', 'setup', 'pair'].includes(operation)) throw new Error();
    const origin = new URL(binding.hostOrigin);
    if (origin.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(origin.hostname) || origin.username || origin.password) throw new Error();
    const registration = JSON.parse(await readFile(binding.registrationFile, 'utf8'));
    if (new URL(registration.url).origin !== binding.upstreamOrigin || typeof registration.password !== 'string' || !registration.password) throw new Error();
    let input = {};
    if (operation === 'setup' || operation === 'pair') {
      let text = '';
      for await (const chunk of process.stdin) {
        text += chunk;
        if (Buffer.byteLength(text) > 16 * 1024) throw new Error();
      }
      input = text.trim() ? JSON.parse(text) : {};
    }
    const response = await fetch(new URL('/api/yuri/session-skills/remote-connections', origin), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(operation === 'pair' ? 250_000 : 30_000),
      headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`opencode:${registration.password}`).toString('base64')}` },
      body: JSON.stringify({ sessionID: binding.sessionID, operation, input }),
    });
    const result = await response.json();
    if (!response.ok) {
      const terminal = [401, 403, 501].includes(response.status);
      console.error(JSON.stringify({ error: 'Remote connection operation failed', status: response.status,
        ...(['invalid_input', 'instance_not_found', 'external_instance', 'instance_not_ready', 'remote_connection_failed', 'remote_connections_unsupported'].includes(result?.code) ? { code: result.code } : {}),
        terminal,
        recovery: terminal
          ? 'Stop this workflow. All operations share this admission gate. Resume only after a supported local desktop session is available and its bound describe command succeeds.'
          : operation === 'setup' ? 'Use the bound list command to check saved instances before retrying setup.'
            : operation === 'pair' ? 'Pairing was not confirmed. Retrying creates a new one-time link.'
              : 'Report the failed check; no authoritative connection list was returned.',
      }));
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify(operation === 'describe' ? { ...result,
      commands: Object.fromEntries(['list', 'setup', 'pair'].map((op) => [op, remoteConnectionsCommand(process.execPath, process.argv[1], encoded, op)])),
    } : result));
  } catch {
    console.error(JSON.stringify({ error: 'Bound remote connection helper unavailable; reload a local Yuri session', terminal: true,
      recovery: 'Stop this workflow. Resume with the new session\'s bound describe command; the previous result is unconfirmed.' }));
    process.exitCode = 1;
  }
}

let directEntry = false;
try { directEntry = Boolean(process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url); }
catch { /* Imports and Electron flags need not name a script. */ }
if (directEntry) await main();
