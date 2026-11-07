import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { compileTerminalRuntime, runTerminalFixture } from './terminal-runtime-fixture.mjs';
const root = path.dirname(fileURLToPath(import.meta.url));
let temporary: string, runner: string, regression: string, authorizations: string;
beforeAll(async () => {
  temporary = await mkdtemp(path.join(process.env.OPENCODE_TMP_DIR || tmpdir(), 'terminal-runtime-'));
  runner = await compileTerminalRuntime(root, temporary, path.join(root, 'terminal-runtime-harness.swift'));
  regression = await compileTerminalRuntime(root, temporary, path.join(root, 'tests/settings-voice-recognition-transport.swift'), 'existing-owner-regression');
  authorizations = await compileTerminalRuntime(root, temporary, path.join(root, 'terminal-authorization-harness.swift'), 'authorization-retirement');
}, 90000);
afterAll(async () => { if (temporary) await rm(temporary, { recursive: true, force: true }); });
for (const mode of ['direct', 'relay']) for (const scenario of ['routes', 'optional-missing', 'optional-empty', 'optional-failure', 'port', 'bad-port', 'redirect', 'oversize', 'invalid', 'stale', 'a-b-a', 'background', 'credential-change', 'cancel-http', 'retire-http', 'late-open', 'late-open-retire', 'cancel-send', 'incoming-limit', 'outgoing-limit', ...(mode === 'relay' ? ['mint-bearer'] : [])]) {
  it(`production RuntimeBridge in-memory ${mode}: ${scenario}`, async () => { expect(await runTerminalFixture(runner, [scenario, mode], 8000)).toBe(`PASS ${scenario} ${mode === 'relay'}`); }, 12000);
}
for (const mode of ['direct', 'relay']) for (const scenario of ['routes', 'cancel-open', 'generation-http', 'resource-admission', 'host-a-b-a', 'host-background', ...(mode === 'direct' ? ['authorization-roundtrip'] : []), 'rename']) {
  it(`unchanged ASR/resource/admission owner regression ${mode}: ${scenario}`, async () => { expect(await runTerminalFixture(regression, [scenario, mode], 8000)).toBe(`PASS ${scenario} ${mode === 'relay'}`); }, 12000);
}
for (const scenario of ['non-revocations', 'failed-remove', 'reauthorize', 'failed-reauthorize', 'remove', 'callback-failure', 'legacy']) {
  it(`production successful-persist-only authorization retirement: ${scenario}`, async () => { expect(await runTerminalFixture(authorizations, [scenario], 8000)).toBe(`PASS ${scenario}`); }, 12000);
}
