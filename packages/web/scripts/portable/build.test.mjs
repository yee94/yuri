import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import YAML from 'yaml';
import { assertContainedSymlinks, copyProductionDependencies } from './build.mjs';

const temporary = [];
it('keeps Linux artifact uploads flat so both CLI archives reach the release inventory', async () => {
  const workflow = YAML.parse(await fs.readFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../.github/workflows/release.yml'), 'utf8'));
  const build = workflow.jobs['build-desktop-electron-linux'];
  const paths = build.steps.find((step) => step.name === 'Upload validated Linux release files').with.path.trim().split('\n');
  expect(paths.every((file) => file.startsWith('packages/electron/dist/'))).toBe(true);
  expect(paths).toContain('packages/electron/dist/yuri-*.tar.gz');
  const publish = workflow.jobs['publish-electron-linux'].steps.find((step) => step.uses?.startsWith('softprops/action-gh-release@'));
  expect(publish.with.files).toContain('artifacts/x64/yuri-');
  expect(publish.with.files).toContain('artifacts/arm64/yuri-');
});
afterEach(async () => {
  for (const directory of temporary.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});
async function directory() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuri portable graph '));
  temporary.push(root);
  return root;
}
async function pkg(root, name, version, dependencies = {}, extra = {}) {
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name, version, dependencies, ...extra }));
  await fs.writeFile(path.join(root, 'index.js'), `exports.version = ${JSON.stringify(version)};`);
}

it('copies transitive versions, peers, optional assets and cyclic edges without external symlinks', async () => {
  const root = await directory();
  const source = path.join(root, 'source'), destination = path.join(root, 'packed');
  await pkg(source, 'host', '1', { a: '1', b: '1' }, { optionalDependencies: { missing: '1' } });
  await pkg(path.join(source, 'node_modules/a'), 'a', '1', { b: '1' });
  await pkg(path.join(source, 'node_modules/b'), 'b', '1', { a: '2' }, { peerDependencies: { peer: '1' } });
  await pkg(path.join(source, 'node_modules/b/node_modules/a'), 'a', '2', { b: '1' });
  await pkg(path.join(source, 'node_modules/peer'), 'peer', '1');
  await fs.writeFile(path.join(source, 'node_modules/b/worker.cjs'), 'module.exports = 42');
  await fs.mkdir(destination);
  await copyProductionDependencies(source, destination);
  await assertContainedSymlinks(destination);
  const result = spawnSync(process.execPath, ['-e', `
    const b = require.resolve("b");
    const { createRequire } = require("module");
    const fromB = createRequire(b);
    console.log(JSON.stringify([require("a").version, fromB("a").version, fromB("peer").version, fromB("./worker.cjs")]));
  `], { cwd: destination, encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual(['1', '2', '1', 42]);
});

it('fails instead of shipping a missing required runtime dependency', async () => {
  const root = await directory();
  await pkg(root, 'host', '1', { 'missing-yuri-test-package': '1' });
  await expect(copyProductionDependencies(root, path.join(root, 'out'))).rejects.toThrow('Missing production dependency');
});

it('rejects absolute or escaping links inside copied runtime assets', async () => {
  const root = await directory();
  const packed = path.join(root, 'packed');
  await fs.mkdir(packed);
  await fs.writeFile(path.join(root, 'outside'), 'not portable');
  await fs.symlink('../outside', path.join(packed, 'asset'));
  await expect(assertContainedSymlinks(packed)).rejects.toThrow('Non-portable symlink');
});

it('launches through relative symlinks and spaced paths without exposing private Node on PATH', async () => {
  const root = await directory();
  let packed = path.join(root, 'portable');
  await fs.mkdir(path.join(packed, 'runtime'), { recursive: true });
  packed = await fs.realpath(packed);
  const launcher = path.join(packed, 'yuri');
  await fs.copyFile(path.join(path.dirname(fileURLToPath(import.meta.url)), 'launcher.sh'), launcher);
  await fs.chmod(launcher, 0o755);
  const node = path.join(packed, 'runtime/node');
  await fs.writeFile(node, '#!/bin/sh\nprintf "%s\\n" "$PATH" "$LD_LIBRARY_PATH" "$@"\n', { mode: 0o755 });
  await fs.symlink('portable/yuri', path.join(root, 'first'));
  await fs.symlink('first', path.join(root, 'yuri'));
  const result = spawnSync(path.join(root, 'yuri'), ['serve', '--name', 'with spaces'], {
    encoding: 'utf8', env: { PATH: '/usr/bin:/bin' },
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim().split('\n')).toEqual([
    `${packed}/bin:/usr/bin:/bin`, `${packed}/runtime/lib`,
    '--title=yuri', `${packed}/lib/bin/cli.js`, 'serve', '--name', 'with spaces',
  ]);
});
