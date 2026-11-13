import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const electronRoot = path.join(repoRoot, 'packages/electron');
const fixtureEntry = path.join(repoRoot, 'packages/ui/src/sync/fixtures/remote-projects-indexeddb-renderer.ts');
const temporaryBase = path.join(os.tmpdir(), 'opencode');
await fs.mkdir(temporaryBase, { recursive: true });
const root = await fs.mkdtemp(path.join(temporaryBase, 'yuri-remote-projects-indexeddb-'));
try {
  const fixtureDirectory = path.join(root, 'fixture');
  await fs.mkdir(fixtureDirectory);
  const build = spawnSync('bun', [
    'build', fixtureEntry, '--outfile', path.join(fixtureDirectory, 'renderer.js'),
    '--target', 'browser', '--format', 'iife',
  ], { cwd: repoRoot, encoding: 'utf8', timeout: 60_000 });
  if (build.status !== 0) throw new Error(build.stderr || build.stdout || 'Fixture build failed');
  const html = path.join(fixtureDirectory, 'index.html');
  await fs.writeFile(html, '<!doctype html><script src="./renderer.js"></script>');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(path.join(electronRoot, 'node_modules/.bin/electron'), [
    '--headless', '--disable-gpu', path.join(electronRoot, 'scripts/transcript-durable-indexeddb-electron.mjs'),
    '--', html, path.join(root, 'user-data'),
  ], { cwd: electronRoot, env, stdio: 'inherit' });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 60_000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => resolve(code ?? 1));
    });
    if (code !== 0) throw new Error('Remote Project Chromium IndexedDB evidence failed or timed out');
  } finally {
    clearTimeout(timeout);
  }
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
