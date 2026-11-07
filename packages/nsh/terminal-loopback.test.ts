import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, afterAll, it, expect } from 'vitest';
import { compileTerminalRuntime, runTerminalFixture } from './terminal-runtime-fixture.mjs';
const root = path.dirname(fileURLToPath(import.meta.url));
let temporary: string, runner: string, url: string, server: ReturnType<typeof spawn>, errors = '';
beforeAll(async () => {
  temporary = await mkdtemp(path.join(process.env.OPENCODE_TMP_DIR || tmpdir(), 'terminal-loopback-'));
  runner = await compileTerminalRuntime(root, temporary, path.join(root, 'terminal-loopback-harness.swift'));
  server = spawn('bun', [path.join(root, 'terminal-loopback-fixture.mjs')], { stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr!.on('data', value => { errors += value; });
  url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Loopback startup timeout: ' + errors)), 5000);
    server.stdout!.once('data', data => { clearTimeout(timer); resolve(JSON.parse(String(data)).configURL); }); server.once('error', reject);
  });
}, 90000);
afterAll(async () => { if (server?.exitCode === null) { const closed = new Promise(resolve => server.once('close', resolve)); server.kill('SIGTERM'); await closed; } if (temporary) await rm(temporary, { recursive: true, force: true }); });
for (const mode of ['direct', 'relay']) it(`production terminal ${mode}: authenticated synthetic loopback HTTP/SSE + real Host E2EE mux, no PTY`, async () => {
  expect(await runTerminalFixture(runner, [url, mode], 20000)).toBe(`PASS ${mode}`); expect(errors).toBe('');
}, 25000);
for (const mode of ['direct', 'relay']) for (const scenario of ['auth-denied', 'ws-redirect', ...(mode === 'relay' ? ['mint-denied'] : [])]) it(`production ${mode} WS auth/redirect gate: ${scenario}, no fallback to direct`, async () => {
  expect(await runTerminalFixture(runner, [url, mode, scenario], 20000)).toBe(`PASS ${mode} ${scenario}`); expect(errors).toBe('');
}, 25000);
for (const mode of ['direct', 'relay']) for (const scenario of ['fallback', 'explicit-sse']) it(`actual TerminalBridge → RuntimeBridge → ${mode} loopback mux: ${scenario} with HTTP text input`, async () => {
  expect(await runTerminalFixture(runner, [url, mode, scenario, temporary], 20000)).toBe(`PASS ${mode} ${scenario}`); expect(errors).toBe('');
}, 25000);
for (const mode of ['direct', 'relay']) it(`strict native runtime stream/stop ${mode}: missing scope, A→B→A stale stream, stale same-key stop, background`, async () => {
  expect(await runTerminalFixture(runner, [url, mode, 'runtime-stream'], 20000)).toBe(`PASS ${mode} runtime-stream`); expect(errors).toBe('');
}, 25000);
for (const mode of ['direct', 'relay']) it(`production unchanged ASR/desktop ${mode} text socket roundtrip via loopback/mux`, async () => {
  expect(await runTerminalFixture(runner, [url, mode, 'legacy-regression'], 20000)).toBe(`PASS ${mode} legacy-regression`); expect(errors).toBe('');
}, 25000);
