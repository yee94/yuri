import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const directSourceFiles = ['RelayTunnel.swift', 'SessionMessageStream.swift', 'SessionMessageStreamDirect.swift'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export function requireLoopbackOptIn(env = process.env, platform = process.platform) {
  if (env.NSH_SESSION_DIRECT_LOOPBACK !== '1') return 'requires explicit NSH_SESSION_DIRECT_LOOPBACK=1 after source owners freeze';
  if (platform !== 'darwin') return 'requires the macOS Foundation URLSession WebSocket implementation';
  return null;
}
export function loopbackOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw Error('Expected an explicit IPv4 loopback HTTP origin');
  return url.origin;
}
export function redact(output, authorization) { return String(output).split(authorization).join('[synthetic authorization redacted]'); }

/** Copies complete production files unchanged, never constructs an adapter/inbox stub. */
export async function freezeDirectSources(root, temporary) {
  const directory = path.join(temporary, 'production'); await mkdir(directory);
  const entries = [];
  for (const file of directSourceFiles) {
    const bytes = await readFile(path.join(root, 'ios', file));
    const frozen = path.join(directory, file); await writeFile(frozen, bytes);
    entries.push({ file, sha256: digest(bytes), frozen });
  }
  const manifest = { sources: entries.map(({ file, sha256 }) => ({ file, sha256 })) };
  await writeFile(path.join(temporary, 'source-manifest.json'), JSON.stringify(manifest, null, 2));
  async function assertUnchanged() {
    for (const entry of entries) {
      if (digest(await readFile(path.join(root, 'ios', entry.file))) !== entry.sha256 || digest(await readFile(entry.frozen)) !== entry.sha256) throw Error('Production source changed during loopback verification: ' + entry.file);
    }
  }
  await assertUnchanged();
  return { paths: entries.map(entry => entry.frozen), manifest, assertUnchanged };
}

/** Async process I/O: the Bun server never shares the Vitest event loop.
 * @returns {Promise<{code: number | null, stdout: string, stderr: string, timedOut: boolean}>}
 */
export function runProcess(command, args, { timeout = 60000, input, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeout);
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
    child.stdin.on('error', () => {}); child.stdin.end(input);
  });
}

export function startLoopbackServer(serverFile, authorization, { env = process.env, timeout = 5000 } = {}) {
  const reason = requireLoopbackOptIn(env); if (reason) throw Error(reason);
  const child = spawn('bun', [serverFile], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', stderr = '', done = false, exitCode;
  const exited = new Promise(resolve => {
    child.once('exit', code => { exitCode = code; done = true; resolve(); });
    child.once('error', () => { done = true; resolve(); });
  });
  child.stderr.on('data', data => { stderr += redact(data, authorization); });
  /** @type {Promise<{origin: string, targetOrigin: string}>} */
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(Error('Loopback server startup deadline')); }, timeout);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(Error('Loopback server exited before readiness: ' + stderr)); });
    child.stdout.on('data', data => {
      output += String(data); const newline = output.indexOf('\n'); if (newline < 0) return;
      try {
        const value = JSON.parse(output.slice(0, newline));
        if (value.kind !== 'ready') throw Error('Invalid loopback readiness record');
        clearTimeout(timer); resolve({ origin: loopbackOrigin(value.origin), targetOrigin: loopbackOrigin(value.targetOrigin) });
      } catch (error) { clearTimeout(timer); child.kill('SIGKILL'); reject(error); }
    });
  });
  child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify({ authorization }) + '\n');
  return {
    ready,
    async stop() {
      if (!done) child.kill('SIGTERM');
      const timer = setTimeout(() => { if (!done) child.kill('SIGKILL'); }, 1500);
      try { await exited; } finally { clearTimeout(timer); }
      if (exitCode !== 0 && exitCode !== null) throw Error('Loopback server shutdown failed: ' + stderr);
    },
  };
}
