import { test, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DesktopOta } from './desktop-ota.mjs';

test('native startup establishes and saves its local credential before returning the backend URL', async () => {
  const source = readFileSync(new URL('./main.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('  const port = handle.getPort();', source.indexOf('const spawnLocalServer ='));
  const end = source.indexOf('\n  return url;\n};', start) + '\n  return url;'.length;
  const root = { desktopLocalClientToken: 'stale-token', unrelated: true };
  let release;
  const ensured = new Promise((resolve) => { release = resolve; });
  const handle = { getPort: () => 4321, ensureDesktopLocalClientToken: vi.fn(() => ensured) };
  const persist = vi.fn(async (mutate) => mutate(root));
  const context = vm.createContext({ handle, state: {}, buildLocalUrl: (port) => `http://127.0.0.1:${port}`,
    readDesktopLocalClientToken: () => root.desktopLocalClientToken, mutateSettingsRoot: persist });
  const pending = vm.runInContext(`(async () => { ${source.slice(start, end)} })()`, context);
  expect(handle.ensureDesktopLocalClientToken).toHaveBeenCalledWith('stale-token');
  expect(persist).not.toHaveBeenCalled();
  release('valid-local-token');
  expect(await pending).toBe('http://127.0.0.1:4321');
  expect(root).toEqual({ desktopLocalClientToken: 'valid-local-token', desktopLocalPort: 4321, unrelated: true });
  const saved = { ...root };
  handle.ensureDesktopLocalClientToken.mockRejectedValueOnce(new Error('credential store unavailable'));
  await expect(vm.runInContext(`(async () => { ${source.slice(start, end)} })()`, context)).rejects.toThrow('credential store unavailable');
  expect(persist).toHaveBeenCalledTimes(1);
  expect(root).toEqual(saved);
  persist.mockRejectedValueOnce(new Error('settings write failed'));
  await expect(vm.runInContext(`(async () => { ${source.slice(start, end)} })()`, context)).rejects.toThrow('settings write failed');
  expect(root).toEqual(saved);
});

test('installed backend loads its real server entry under Node without mocked imports', async () => {
  const loader = new URL('./desktop-backend.mjs', import.meta.url).href;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
    import { loadDesktopBackend } from ${JSON.stringify(loader)};
    const backend = await loadDesktopBackend();
    if (typeof backend.startWebUiServer !== 'function' || typeof backend.mintOutsideFileGrant !== 'function') {
      throw new Error('Desktop backend entry is incomplete');
    }
    console.log('backend import OK');
    process.exit(0);
  `], { timeout: 15000 });
  expect(stdout).toContain('backend import OK');
});

test('OTA backend resolves ESM and createRequire dependencies from the installed package', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'desktop-backend-'));
  try {
    const builtin = path.join(root, 'installed/server/index.js');
    const backend = path.join(root, 'downloaded');
    await mkdir(path.dirname(builtin), { recursive: true });
    await mkdir(backend);
    const dependency = path.join(root, 'installed/node_modules/fixture-dependency');
    await mkdir(dependency, { recursive: true });
    await writeFile(path.join(dependency, 'package.json'), JSON.stringify({ main: 'index.cjs' }));
    await writeFile(path.join(dependency, 'index.cjs'), 'module.exports = { nativeAbi: "installed" };');
    await writeFile(path.join(backend, 'entry.mjs'), `
      import dep from 'fixture-dependency';
      import { createRequire } from 'node:module';
      export default [dep.nativeAbi, createRequire(import.meta.url)('fixture-dependency').nativeAbi];
    `);
    const loader = new URL('./desktop-backend.mjs', import.meta.url).href;
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
      import { registerDesktopBackend } from ${JSON.stringify(loader)};
      const hook = registerDesktopBackend(${JSON.stringify({ directory: backend, builtinEntry: pathToFileURL(builtin).href })});
      const result = await import(${JSON.stringify(pathToFileURL(path.join(backend, 'entry.mjs')).href)});
      console.log(JSON.stringify(result.default));
      hook.deregister();
    `]);
    expect(JSON.parse(stdout)).toEqual(['installed', 'installed']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('backend-bearing OTA activates persistently without startup rollback and rejects mixed versions', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'desktop-backend-state-'));
  try {
    const bundle = { bundleId: 'a'.repeat(16), releaseVersion: '2.1.1' };
    const dir = path.join(root, bundle.bundleId);
    await mkdir(path.join(dir, 'desktop-backend/server'), { recursive: true });
    await writeFile(path.join(dir, 'index.html'), 'new UI');
    await writeFile(path.join(dir, 'desktop-ota.json'), JSON.stringify({ applicationId: 'dev.yuri.desktop', shellApiVersion: 2, releaseVersion: '2.1.1', backendVersion: '2.1.1' }));
    await writeFile(path.join(dir, 'desktop-backend/package.json'), JSON.stringify({ version: '2.1.0' }));
    await writeFile(path.join(dir, 'desktop-backend/server/index.js'), 'export const version = "2.1.1";');
    const options = { directory: root, builtinDirectory: root, nativeVersion: '2.1.0', requireBackend: true };
    const ota = new DesktopOta(options);
    expect(await ota.usable(bundle)).toBe(false);
    await writeFile(path.join(dir, 'desktop-backend/package.json'), JSON.stringify({ version: '2.1.1' }));
    ota.state.queued = bundle;
    await ota.persist();
    await ota.initialize();
    expect(ota.backendDirectory).toBe(path.join(dir, 'desktop-backend'));
    expect(ota.state.trial).toBe(false);
    const restarted = new DesktopOta(options);
    await restarted.initialize();
    expect(restarted.version).toBe('2.1.1');
    await rm(path.join(dir, 'desktop-backend/server/index.js'));
    await expect(new DesktopOta(options).initialize()).rejects.toThrow('clear the OTA cache');
  } finally { await rm(root, { recursive: true, force: true }); }
});
