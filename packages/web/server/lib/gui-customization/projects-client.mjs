import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { sessionSkillCommand } from './session-skill-command.mjs';

async function main() {
  let bound = false;
  try {
    const [encoded, operation] = process.argv.slice(2);
    const binding = JSON.parse(Buffer.from(encoded, 'base64url').toString());
    const operations = ['list', 'add', 'remote-hosts', 'add-remote', 'remote-projects', 'sessions', 'read-session', 'create-session', 'prompt-session'];
    if (!['describe', ...operations].includes(operation)) throw new Error();
    const origin = new URL(binding.hostOrigin);
    if (origin.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(origin.hostname) || origin.username || origin.password) throw new Error();
    const registration = JSON.parse(await readFile(binding.registrationFile, 'utf8'));
    if (new URL(registration.url).origin !== binding.upstreamOrigin || typeof registration.password !== 'string' || !registration.password) throw new Error();
    bound = true;
    let input = {};
    if (!['describe', 'list', 'remote-hosts', 'remote-projects'].includes(operation)) {
      let text = '';
      for await (const chunk of process.stdin) {
        text += chunk;
        if (Buffer.byteLength(text) > 16 * 1024) throw new Error();
      }
      input = JSON.parse(text);
    }
    const response = await fetch(new URL('/api/yuri/session-skills/projects', origin), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(['create-session', 'prompt-session'].includes(operation) ? 305_000 : 30_000),
      headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`opencode:${registration.password}`).toString('base64')}` },
      body: JSON.stringify({ sessionID: binding.sessionID, operation, input }),
    });
    const result = await response.json();
    if (!response.ok) {
      const terminal = [401, 403, 501].includes(response.status);
      console.error(JSON.stringify({ error: 'Project API operation failed', status: response.status, terminal,
        ...(['invalid_input', 'validation_error', 'project_unavailable', 'project_operation_failed', 'remote_unavailable', 'remote_target_mismatch', 'remote_response_invalid'].includes(result?.code) ? { code: result.code } : {}),
        recovery: terminal ? 'Stop this workflow; resume only with a new supported session and its bound project describe command.'
          : 'Result not confirmed. Inspect the same target before retrying; retain sessionID/messageID for interrupted writes. Never switch to local or claim success from a failed request.',
      }));
      process.exitCode = 1;
      return;
    }
    if (['add', 'add-remote'].includes(operation) && (typeof result.project?.id !== 'string' || typeof result.project?.path !== 'string' || typeof result.created !== 'boolean')) throw new Error();
    if (operation === 'remote-hosts' && (!Array.isArray(result.hosts) || !Array.isArray(result.failed) || typeof result.complete !== 'boolean')) throw new Error();
    if (operation === 'list' && !Array.isArray(result.projects)) throw new Error();
    if (operation === 'describe' && result.supported !== true) throw new Error();
    console.log(JSON.stringify(operation === 'describe' ? { ...result,
      commands: Object.fromEntries(operations.filter((op) => result.remoteSupported || ['list', 'add'].includes(op)).map((op) => [op, sessionSkillCommand(process.execPath, process.argv[1], encoded, op)])),
    } : result));
  } catch {
    console.error(JSON.stringify({ error: 'Bound project helper failed; the result is unconfirmed', terminal: !bound,
      recovery: !bound ? 'Stop this workflow; resume only with a new supported session and its bound project describe command.'
        : 'Check the input or connection. Resume with the bound describe command; retry registration with the same target and path only after recovery.' }));
    process.exitCode = 1;
  }
}

let directEntry = false;
try { directEntry = Boolean(process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url); }
catch { /* Imports and Electron flags need not name a script. */ }
if (directEntry) await main();
