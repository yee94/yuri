import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { directSourceFiles, freezeDirectSources, loopbackOrigin, redact, requireLoopbackOptIn } from './tests/session-direct-loopback/fixture.mjs';
import { replayCount, replayFrames } from './tests/session-direct-loopback/server.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
test('loopback test requires main opt-in and rejects non-loopback origins without starting any process or server', () => {
  expect(requireLoopbackOptIn({}, 'darwin')).toContain('explicit NSH_SESSION_DIRECT_LOOPBACK=1');
  expect(requireLoopbackOptIn({ NSH_SESSION_DIRECT_LOOPBACK: '1' }, 'linux')).toContain('macOS Foundation');
  expect(requireLoopbackOptIn({ NSH_SESSION_DIRECT_LOOPBACK: '1' }, 'darwin')).toBeNull();
  expect(loopbackOrigin('http://127.0.0.1:12345')).toBe('http://127.0.0.1:12345');
  for (const value of ['https://127.0.0.1:12345', 'http://localhost:12345', 'http://outside.invalid:12345', 'http://127.0.0.1',
    'http://user:pass@127.0.0.1:12345', 'http://127.0.0.1:12345/other', 'http://127.0.0.1:12345/?token=x']) expect(() => loopbackOrigin(value)).toThrow();
  expect(redact('Bearer synthetic-field\nsynthetic-field', 'synthetic-field')).toBe('Bearer [synthetic authorization redacted]\n[synthetic authorization redacted]');
});

test('complete production Direct, session socket and inbox files are copied byte-for-byte and hash changes fail closed; no compiler runs', async () => {
  const parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode'); await mkdir(parent, { recursive: true });
  const temporary = await mkdtemp(path.join(parent, 'session-direct-snapshot-unit-'));
  try {
    // Work on independent copies so an active source owner is never modified or frozen by this pure check.
    const independent = path.join(temporary, 'independent'), output = path.join(temporary, 'output');
    await mkdir(path.join(independent, 'ios'), { recursive: true }); await mkdir(output);
    for (const file of directSourceFiles) await writeFile(path.join(independent, 'ios', file), await readFile(path.join(root, 'ios', file)));
    const snapshot = await freezeDirectSources(independent, output);
    expect(directSourceFiles).toEqual(['RelayTunnel.swift', 'SessionMessageStream.swift', 'SessionMessageStreamDirect.swift']);
    expect(snapshot.paths.map(file => path.basename(file))).toEqual(directSourceFiles);
    for (let index = 0; index < directSourceFiles.length; index++) {
      expect(await readFile(snapshot.paths[index])).toEqual(await readFile(path.join(independent, 'ios', directSourceFiles[index])));
      expect(snapshot.manifest.sources[index].sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    await snapshot.assertUnchanged();
    await writeFile(path.join(independent, 'ios/SessionMessageStreamDirect.swift'), '// independent hash change only\n');
    await expect(snapshot.assertUnchanged()).rejects.toThrow('Production source changed during loopback verification: SessionMessageStreamDirect.swift');
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('wire fixture sends a complete replay before ready and keeps adapter/protocol declarations in production sources', async () => {
  const frames = replayFrames();
  expect(replayCount).toBe(128); expect(frames).toHaveLength(129);
  expect(frames.slice(0, -1).map(value => JSON.parse(value).payload.ordinal)).toEqual(Array.from({ length: 128 }, (_, index) => index));
  expect(JSON.parse(frames.at(-1)!)).toEqual({ type: 'ready', scope: 'global' });
  const runner = await readFile(path.join(root, 'tests/session-direct-loopback/Runner.swift'), 'utf8');
  expect(runner).toContain('SessionMessageStreamDirect(request:');
  expect(runner).toContain('SessionStreamFrame.decode');
  expect(runner).not.toMatch(/(?:class|actor|struct)\s+(?:SessionMessageStreamDirect|NativeSocketInbox|SessionStreamSocket)\b/);
  const fixture = await readFile(path.join(root, 'tests/session-direct-loopback/fixture.mjs'), 'utf8');
  expect(fixture).not.toContain('spawnSync');
  const integration = await readFile(path.join(root, 'session-message-stream-direct-loopback.test.ts'), 'utf8');
  expect(integration).toContain('test.skipIf(skipped !== null)');
  expect(integration).toContain('context.skip(report.reason)');
  expect(runner).toContain('value.code == NSURLErrorUnsupportedURL');
});
