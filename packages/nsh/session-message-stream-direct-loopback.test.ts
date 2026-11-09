import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { freezeDirectSources, redact, requireLoopbackOptIn, runProcess, startLoopbackServer } from './tests/session-direct-loopback/fixture.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const skipped = requireLoopbackOptIn();
test.skipIf(skipped !== null)(`production SessionMessageStreamDirect actual loopback adapter integration${skipped ? ' — ' + skipped : ''}`, async context => {
  const parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode');
  await mkdir(parent, { recursive: true });
  const temporary = await mkdtemp(path.join(parent, 'nsh-session-direct-loopback-'));
  const authorization = randomBytes(32).toString('hex');
  let server: ReturnType<typeof startLoopbackServer> | undefined;
  try {
    const frozen = await freezeDirectSources(root, temporary), runner = path.join(temporary, 'runner');
    const compile = await runProcess('xcrun', ['swiftc', '-parse-as-library', '-swift-version', '5', '-warnings-as-errors',
      ...frozen.paths, path.join(root, 'tests/session-direct-loopback/Runner.swift'), '-o', runner], { timeout: 60000 });
    if (compile.timedOut || compile.code !== 0) throw Error('Frozen production Direct compilation failed:\n' + redact(compile.stdout + compile.stderr, authorization));
    await frozen.assertUnchanged();
    server = startLoopbackServer(path.join(root, 'tests/session-direct-loopback/server.mjs'), authorization);
    const { origin } = await server.ready;
    const configuration = path.join(temporary, 'configuration.json');
    await writeFile(configuration, JSON.stringify({ origin, authorization }), { mode: 0o600 });
    const result = await runProcess(runner, [configuration], { timeout: 40000 });
    await frozen.assertUnchanged();
    const output = redact(result.stdout + result.stderr, authorization);
    if (result.timedOut) throw Error('Direct loopback runner exceeded its deadline:\n' + output);
    const lines = result.stdout.trim().split('\n');
    const report = JSON.parse(lines.at(-1) || '{}') as { kind?: string; reason?: string; replayFrames?: number; readyAfterReplay?: boolean; redirectTargetRequests?: number };
    if (result.code === 77) {
      expect(report.kind).toBe('unsupported');
      expect(report.reason).toBe('macOS Foundation rejects the loopback ws scheme in a raw URLSession capability probe (NSURLErrorUnsupportedURL)');
      context.skip(report.reason);
    }
    if (result.code !== 0) throw Error('Production Direct adapter loopback failed:\n' + output);
    expect(report).toMatchObject({ kind: 'passed', replayFrames: 128, readyAfterReplay: true, redirectTargetRequests: 0 });
    const response = await fetch(origin + '/audit', { headers: { authorization: 'Bearer ' + authorization }, signal: AbortSignal.timeout(3000) });
    expect(response.status).toBe(200);
    const audit = await response.json() as { records: Record<string, { requests: number; authorizationExact: boolean; originExact: boolean; frames: number }>; targetRequests: number; targetAuthorization: number };
    if (JSON.stringify(audit).includes(authorization)) throw Error('Loopback audit exposed authorization instead of boolean comparisons');
    expect(audit.targetRequests).toBe(0); expect(audit.targetAuthorization).toBe(0);
    for (const name of ['probe', 'replay', 'local-close', 'receive-cancel', 'server-close', 'open-close', 'open-cancel', 'unauthorized', 'redirect-same', 'redirect-cross']) {
      expect(audit.records[name], name).toMatchObject({ requests: 1, authorizationExact: true, originExact: true });
    }
    expect(audit.records.replay.frames).toBe(129);
    expect(JSON.parse(await readFile(path.join(temporary, 'source-manifest.json'), 'utf8'))).toEqual(frozen.manifest);
  } finally {
    try { await server?.stop(); } finally { await rm(temporary, { recursive: true, force: true }); }
  }
}, 120000);
