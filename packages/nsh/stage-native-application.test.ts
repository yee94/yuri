import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
// @ts-expect-error Build-owner module is intentionally Node ESM.
import { stageNativeApplication, validateNativeApplicationBundle } from './scripts/stage-native-application.mjs';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const temporary: string[] = [];
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function sandbox() {
  const directory = await mkdtemp(path.join(process.env.OPENCODE_TMP_DIR || tmpdir(), 'native-stage-test-'));
  temporary.push(directory);
  return directory;
}
async function put(root: string, file: string, bytes: string | Buffer) {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), bytes);
}
afterEach(async () => { for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true }); });

it('rejects the 47-reference/42-outside-root regression, then accepts every original packaged byte', async () => {
  const root = await sandbox(), sourceFiles: Record<string, { bytes: number; sha256: string }> = {};
  const assets = Array.from({ length: 47 }, (_, index) => `packages/${index < 5 ? 'nsh/assets' : 'ui/src/assets/provider-logos'}/${index}.svg`);
  for (const [index, asset] of assets.entries()) {
    const bytes = Buffer.from(`<svg data-original="${index}"/>`);
    sourceFiles[asset] = { bytes: bytes.length, sha256: sha(bytes) };
    if (index < 5) await put(root, `assets/${asset}`, bytes);
  }
  const manifest = { sourceFiles, assets };
  await put(root, 'bundle.nshc', 'synthetic bytecode');
  const hostRoot = '/' + ['Users', 'build-machine', 'workspace'].join('/');
  await put(root, 'bundle.js', assets.map((asset, index) => JSON.stringify(`asset://${index < 5 ? '' : hostRoot + '/'}${asset}`)).join(';'));
  await expect(validateNativeApplicationBundle(root, manifest)).rejects.toThrow('Unpackaged native asset');
  for (const [index, asset] of assets.entries()) await put(root, `assets/${asset}`, `<svg data-original="${index}"/>`);
  await put(root, 'bundle.js', assets.map(asset => JSON.stringify(`asset://${asset}`)).join(';'));
  await expect(validateNativeApplicationBundle(root, manifest)).resolves.toEqual({ assetReferences: 47, packagedAssets: 47, originalAssets: 47 });
  await put(root, `assets/${assets[46]}`, '<svg>replacement</svg>');
  await expect(validateNativeApplicationBundle(root, manifest)).rejects.toThrow('Missing original native artwork');
});

it('rejects machine paths in metadata, traversal, and references beyond the assets directory', async () => {
  const root = await sandbox(), manifest = { sourceFiles: {}, assets: [] };
  await put(root, 'bundle.nshc', 'synthetic'); await put(root, 'bundle.js', '');
  await put(root, 'bundle.json', JSON.stringify({ source: '/' + ['home', 'builder', 'app'].join('/') }));
  await expect(validateNativeApplicationBundle(root, manifest)).rejects.toThrow('Non-neutral machine path');
  await rm(path.join(root, 'bundle.json'));
  await put(root, 'bundle.js', '"asset://../bundle.nshc"');
  await expect(validateNativeApplicationBundle(root, manifest)).rejects.toThrow('Unpackaged native asset');
});

it('does not mistake minified ternary/RegExp syntax for a Windows drive path', async () => {
  const root = await sandbox(), manifest = { sourceFiles: {}, assets: [] };
  await put(root, 'bundle.nshc', 'synthetic');
  await put(root, 'bundle.js', 'const label=t=>/^o\\d/.test(t)?t:/^v\\d/.test(t)?t.toUpperCase():t;');
  await expect(validateNativeApplicationBundle(root, manifest)).resolves.toMatchObject({ assetReferences: 0 });
  for (const source of ['const file="C:/build/output";', JSON.stringify({ source: 'C:\\build\\output' })]) {
    await put(root, 'bundle.js', source);
    await expect(validateNativeApplicationBundle(root, manifest)).rejects.toThrow('Non-neutral machine path');
  }
});

it('checks source-map file identities without treating neutral source comments as build-machine paths', async () => {
  const root = await sandbox(), manifest = { sourceFiles: {}, assets: [] };
  await put(root, 'bundle.nshc', 'synthetic'); await put(root, 'bundle.js', 'const n=1;');
  const map = { version: 3, sources: ['source.ts'], sourcesContent: ['// OS example: /' + ['private', 'tmp'].join('/')], mappings: '' };
  await put(root, 'bundle.js.map', JSON.stringify(map));
  await expect(validateNativeApplicationBundle(root, manifest)).resolves.toMatchObject({ assetReferences: 0 });
  await put(root, 'bundle.js.map', JSON.stringify({ ...map, sources: ['/' + ['home', 'builder', 'source.ts'].join('/')] }));
  await expect(validateNativeApplicationBundle(root, manifest)).rejects.toThrow('Non-neutral machine path');
});

it('preserves unused runtime imports, exact relative sources/config, and refuses existing output', async () => {
  const root = await sandbox(), repo = path.join(root, 'workspace');
  await put(repo, 'packages/nsh/App.tsx', "import { value } from '../ui/value'; console.log(value);\n");
  await put(repo, 'packages/ui/value.ts', "import Fuse from 'fuse.js'; export const value = 42;\n");
  await put(repo, 'packages/nsh/nsh.json', '{"theme":"theme.json","capabilities":{"host":["runtime.request"]}}\n');
  await put(repo, 'packages/nsh/theme.json', '{"colors":{}}\n');
  await cp(path.join(workspace, 'packages/ui/node_modules/fuse.js'), path.join(repo, 'node_modules/fuse.js'), { recursive: true, dereference: true });
  const staged = await stageNativeApplication({ root: path.join(root, 'stage'), workspaceRoot: repo });
  expect(staged.entry).toBe('App.tsx');
  expect(staged.manifest.dependencies['fuse.js'].version).toBe('7.1.0');
  for (const file of ['packages/nsh/App.tsx', 'packages/ui/value.ts']) expect(await readFile(path.join(staged.cwd, 'source', file))).toEqual(await readFile(path.join(repo, file)));
  for (const file of ['nsh.json', 'theme.json']) expect(await readFile(path.join(staged.cwd, file))).toEqual(await readFile(path.join(repo, 'packages/nsh', file)));
  await expect(stageNativeApplication({ root: staged.root, workspaceRoot: repo })).rejects.toThrow();
  expect(await readFile(path.join(staged.cwd, 'App.tsx'), 'utf8')).toContain('./source/packages/nsh/App.tsx');
});

it('stages the real production graph with every source/dependency byte and original artwork, without invoking NSH', async () => {
  const root = await sandbox(), staged = await stageNativeApplication({ root: path.join(root, 'production'), workspaceRoot: workspace });
  expect(staged.manifest.bunInputCount).toBeGreaterThan(450);
  const sources = staged.manifest.sourceFiles;
  for (const [file, record] of Object.entries(sources) as [string, { bytes: number; sha256: string }][]) {
    const bytes = await readFile(path.join(workspace, file));
    expect(record).toEqual({ bytes: bytes.length, sha256: sha(bytes) });
    const destination = /\/(?:nsh|theme)\.json$/.test(file) ? path.basename(file) : path.join('source', file);
    expect(await readFile(path.join(staged.cwd, destination))).toEqual(bytes);
  }
  for (const dependency of Object.values(staged.manifest.dependencies) as { locations: string[]; files: Record<string, { bytes: number; sha256: string }> }[]) {
    for (const location of dependency.locations) for (const [file, record] of Object.entries(dependency.files)) {
      const bytes = await readFile(path.join(staged.cwd, location, file));
      expect(record).toEqual({ bytes: bytes.length, sha256: sha(bytes) });
    }
  }
  for (const file of ['packages/nsh/application.tsx', 'packages/nsh/chat-header.tsx', 'packages/nsh/provider-logo.tsx', 'packages/nsh/Icon.tsx']) expect(sources).toHaveProperty(file);
  for (const group of ['provider-logos/', 'model-icons/', 'brand/channels/', 'brand/history-import/']) expect(staged.manifest.assets.some((file: string) => file.includes(group))).toBe(true);
  expect(staged.manifest.assets.length).toBeGreaterThanOrEqual(47);
  expect(staged.manifest.dependencies['cron-parser'].locations).toContain('source/packages/ui/node_modules/cron-parser');
  expect(staged.manifest.dependencies).toHaveProperty('fuse.js');
  const serialized = await readFile(path.join(staged.root, 'native-application.json'), 'utf8');
  expect(JSON.parse(serialized)).toEqual(staged.manifest);
  expect(serialized).not.toContain(workspace); expect(serialized).not.toContain(root);
  const graph = path.join(root, 'staged-graph');
  // Bun's independent graph check needs the native JSX namespace; NSH itself
  // owns JSX compilation and does not consume a staged TypeScript config.
  await put(staged.cwd, 'tsconfig.json', '{"compilerOptions":{"jsx":"react-jsx","jsxImportSource":"nsh"}}');
  const build = spawnSync('bun', ['build', staged.entry, '--target=browser', '--external=nsh', '--external=nsh/*', '--loader', '.svg:file', '--loader', '.png:file', '--outdir', graph], { cwd: staged.cwd, encoding: 'utf8', timeout: 60_000 });
  expect(build.status, build.stderr).toBe(0);
  console.log(JSON.stringify({ bunInputs: staged.manifest.bunInputCount, sourceFiles: Object.keys(sources).length, originalAssets: staged.manifest.assets.length, installedPackages: Object.keys(staged.manifest.dependencies).length }));
}, 120_000);
