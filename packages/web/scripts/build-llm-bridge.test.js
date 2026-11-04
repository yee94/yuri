import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';

test('the package build command produces an isolated plugin on the current Node runtime', async () => {
  const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yuri-bridge-build-'));
  try {
    const run = promisify(execFile);
    await run('bun', ['run', 'build:llm-bridge'], {
      cwd: web,
      env: { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}` },
      timeout: 30_000,
    });
    const target = path.join(directory, 'plugin.mjs');
    await copyFile(path.join(web, 'server/lib/llm/bridge-plugin.bundle.js'), target);
    const { stdout } = await run(process.execPath, ['--input-type=module', '-e', `
      const plugin = await import(${JSON.stringify(pathToFileURL(target).href)});
      console.log(JSON.stringify([typeof plugin.default.effect, typeof plugin.generateBridgeResponse]));
    `], { cwd: directory, timeout: 10_000 });
    expect(JSON.parse(stdout)).toEqual(['function', 'function']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 45_000);
