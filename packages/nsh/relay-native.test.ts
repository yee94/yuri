import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';

const directory = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(directory, '../..');
const fixtures = path.join(directory, 'tests/relay');
const outputLimit = 64 * 1024;

function unavailableReason(): string | undefined {
  if (process.platform !== 'darwin') return 'requires macOS Foundation + CryptoKit';
  const swift = spawnSync('xcrun', ['--find', 'swiftc'], { encoding: 'utf8', timeout: 5_000 });
  if (swift.error || swift.status !== 0) return 'requires the macOS Swift toolchain (xcrun swiftc)';
  const bun = spawnSync('bun', ['--version'], { encoding: 'utf8', timeout: 5_000 });
  if (bun.error || bun.status !== 0) return 'requires Bun for the local WebSocket fixture';
  return undefined;
}

function launch(command: string, args: string[]) {
  const child = spawn(command, args, { cwd: repository, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const output = { stdout: '', stderr: '' };
  child.stdout!.on('data', (chunk: Buffer) => { output.stdout = (output.stdout + chunk.toString('utf8')).slice(-outputLimit); });
  child.stderr!.on('data', (chunk: Buffer) => { output.stderr = (output.stderr + chunk.toString('utf8')).slice(-outputLimit); });
  const done = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(command)} exited ${code ?? signal}\n${output.stdout}\n${output.stderr}`));
    });
  });
  // Long-lived fixture failures are observed by startup and per-test checks too.
  void done.catch(() => {});
  return { child, output, done };
}

function signal(child: ChildProcess, value: NodeJS.Signals): void {
  if (child.pid) {
    try { process.kill(-child.pid, value); return; }
    catch { /* The process may already have exited; fall back to the child handle. */ }
  }
  child.kill(value);
}

async function run(command: string, args: string[], timeout: number): Promise<string> {
  const process = launch(command, args);
  // Kill the process group too: swiftc may have spawned a compiler frontend.
  const timer = setTimeout(() => signal(process.child, 'SIGKILL'), timeout);
  try {
    await process.done;
    return process.output.stdout;
  } finally {
    clearTimeout(timer);
  }
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  signal(child, 'SIGTERM');
  const timer = setTimeout(() => signal(child, 'SIGKILL'), 1_000);
  try { await closed; } finally { clearTimeout(timer); }
}

const unavailable = unavailableReason();
describe.skipIf(Boolean(unavailable))(`native Relay ↔ repository JS Host${unavailable ? ` (skip: ${unavailable})` : ''}`, () => {
  let temporary: string | undefined;
  let binary: string;
  let server: ReturnType<typeof launch> | undefined;
  let configURL: string;

  beforeAll(async () => {
    temporary = await mkdtemp(path.join(os.tmpdir(), 'yuri-nsh-relay-'));
    binary = path.join(temporary, 'relay-runner');
    await run('xcrun', ['swiftc', '-parse-as-library', '-swift-version', '5', '-warnings-as-errors',
      path.join(directory, 'ios/RelayTunnel.swift'), path.join(directory, 'ios/SessionMessageStream.swift'), path.join(fixtures, 'Runner.swift'), '-o', binary], 45_000);
    server = launch('bun', [path.join(fixtures, 'fixture.mjs')]);
    const running = server;
    configURL = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`fixture startup timed out\n${running.output.stderr}`)), 5_000);
      let text = '';
      const onData = (chunk: Buffer) => {
        text += chunk.toString('utf8');
        const newline = text.indexOf('\n');
        if (newline === -1) return;
        clearTimeout(timer);
        running.child.stdout!.off('data', onData);
        try {
          const startup = JSON.parse(text.slice(0, newline)) as { configURL: string };
          expect(startup.configURL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/config$/);
          resolve(startup.configURL);
        } catch (error) { reject(error); }
      };
      running.child.stdout!.on('data', onData);
      void running.done.then(() => {
        clearTimeout(timer);
        reject(new Error('fixture exited before reporting readiness'));
      }, error => { clearTimeout(timer); reject(error); });
    });
  }, 55_000);

  afterEach(() => {
    if (server) {
      expect(server.output.stderr, 'JS Host fixture assertion failed').toBe('');
      expect(server.child.exitCode, 'JS Host fixture exited unexpectedly').toBeNull();
    }
  });

  afterAll(async () => {
    try { if (server) await stop(server.child); }
    finally { if (temporary) await rm(temporary, { recursive: true, force: true }); }
  });

  const scenarios = [
    ['multiplex', 'interleaves eight 300 KB request/response bodies on one authenticated channel'],
    ['sse', 'preserves SSE byte order across UTF-8 boundaries and delivers response head first'],
    ['cancel', 'sends StreamAbort on SSE cancellation without resetting another request'],
    ['replay', 'rejects a replayed encrypted frame and establishes a fresh session afterward'],
    ['tamper', 'rejects a fresh-counter frame with a corrupted GCM tag'],
    ['authentication', 'keeps bearer inside E2EE headers and rejects requests without it'],
  ] as const;
  for (const [scenario, description] of scenarios) {
    test(description, async () => {
      const output = await run(binary, [configURL, scenario], 10_000);
      expect(output.trim()).toBe(`PASS ${scenario}`);
    }, 12_000);
  }
});
