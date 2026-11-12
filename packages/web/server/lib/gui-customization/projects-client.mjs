import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { sessionSkillCommand } from './session-skill-command.mjs';

async function main() {
  let bound = false;
  try {
    const [encoded, operation] = process.argv.slice(2);
    const binding = JSON.parse(Buffer.from(encoded, 'base64url').toString());
    if (!['describe', 'list', 'add'].includes(operation)) throw new Error();
    const origin = new URL(binding.hostOrigin);
    if (origin.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(origin.hostname) || origin.username || origin.password) throw new Error();
    const registration = JSON.parse(await readFile(binding.registrationFile, 'utf8'));
    if (new URL(registration.url).origin !== binding.upstreamOrigin || typeof registration.password !== 'string' || !registration.password) throw new Error();
    bound = true;
    let input = {};
    if (operation === 'add') {
      let text = '';
      for await (const chunk of process.stdin) {
        text += chunk;
        if (Buffer.byteLength(text) > 16 * 1024) throw new Error();
      }
      input = JSON.parse(text);
    }
    const response = await fetch(new URL('/api/yuri/session-skills/projects', origin), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`opencode:${registration.password}`).toString('base64')}` },
      body: JSON.stringify({ sessionID: binding.sessionID, operation, input }),
    });
    const result = await response.json();
    if (!response.ok) {
      const terminal = [401, 403, 501].includes(response.status);
      console.error(JSON.stringify({ error: 'Project API operation failed', status: response.status, terminal,
        ...(['invalid_input', 'validation_error', 'project_unavailable', 'project_operation_failed'].includes(result?.code) ? { code: result.code } : {}),
        recovery: terminal ? 'Stop this workflow; resume only with a new supported session and its bound project describe command.'
          : 'Result not confirmed. Check the path; use list or retry add with the same path after recovery. Never claim success from a failed request.',
      }));
      process.exitCode = 1;
      return;
    }
    if (operation === 'add' && (typeof result.project?.id !== 'string' || typeof result.project?.path !== 'string' || typeof result.created !== 'boolean')) throw new Error();
    if (operation === 'list' && !Array.isArray(result.projects)) throw new Error();
    if (operation === 'describe' && result.supported !== true) throw new Error();
    console.log(JSON.stringify(operation === 'describe' ? { ...result,
      commands: Object.fromEntries(['list', 'add'].map((op) => [op, sessionSkillCommand(process.execPath, process.argv[1], encoded, op)])),
    } : result));
  } catch {
    console.error(JSON.stringify({ error: 'Bound project helper failed; the result is unconfirmed', terminal: !bound,
      recovery: !bound ? 'Stop this workflow; resume only with a new supported session and its bound project describe command.'
        : 'Check the input or connection. Resume with the bound describe command; retry add with the same path only after recovery.' }));
    process.exitCode = 1;
  }
}

let directEntry = false;
try { directEntry = Boolean(process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url); }
catch { /* Imports and Electron flags need not name a script. */ }
if (directEntry) await main();
