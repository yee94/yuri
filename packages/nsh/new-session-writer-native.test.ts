import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { expect, test } from 'vitest';

test('new-session real NSH Page and writer client/Chat, named synthetic producer, macOS/Windows/iOS', () => {
  const root = path.dirname(fileURLToPath(import.meta.url)), parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true }); const directory = mkdtempSync(path.join(parent, 'new-session-writer-'));
  try {
    writeFileSync(path.join(directory, 'nsh.json'), JSON.stringify({ name: 'New session writer fixture', id: 'example.yuri.new-session-writer', version: '0.1.0', build: 1, theme: path.join(root, 'theme.json'), capabilities: { host: ['connection.list', 'runtime.request', 'runtime.stream', 'runtime.stop', 'desktop.writer.capabilities', 'desktop.writer.acquire', 'desktop.writer.release', 'desktop.writer.renew', 'fixture.newSessionWriter.control'] } }));
    writeFileSync(path.join(directory, 'App.tsx'), `import ${JSON.stringify(path.join(root, 'new-session-writer-native-fixture.tsx'))};\n`);
    writeFileSync(path.join(directory, 'Writer.test.tsx'), `import ${JSON.stringify(path.join(root, 'new-session-writer-headless.tsx'))};\n`);
    const host = path.join(directory, 'host.mjs');
    const build = spawnSync('bun', ['build', path.join(root, 'new-session-writer-native-host.mjs'), '--target=browser', '--outfile', host], { encoding: 'utf8', timeout: 30_000 });
    expect(build.status, build.stdout + build.stderr).toBe(0);
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'Writer.test.tsx', '--web-host', host], { cwd: directory, encoding: 'utf8', timeout: 220_000 });
    expect(result.error, result.stdout + result.stderr).toBeUndefined(); expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 260_000);
