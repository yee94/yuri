import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultManifest = path.join(packageRoot, 'patches/nsh-0.4.0/manifest.json');
const excludedParts = new Set(['.git', 'target', 'node_modules', '.nsh', '.cache', 'dist']);
const cacheRoots = ['cache', '.cargo/cache', '.cargo/registry', '.cargo/git'];
const excluded = relative => relative.split('/').some(part => excludedParts.has(part)) || cacheRoots.some(root => relative === root || relative.startsWith(`${root}/`));
const embeddedCrates = ['nsh-core', 'nsh-engine', 'nsh-base', 'nsh-js', 'nsh-macros', 'nsh-package', 'nsh-platform-macos', 'nsh-platform-windows'];
const hashPattern = /^[a-f0-9]{64}$/;
export const sha256 = value => createHash('sha256').update(value).digest('hex');
const stable = value => JSON.stringify(value, function (_key, entry) {
  return entry && typeof entry === 'object' && !Array.isArray(entry)
    ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry;
});
function safePath(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_./@-]+$/.test(value) || value.split('/').some(part => !part || part === '.' || part === '..') || excluded(value)) throw new Error('nsh_compat_unsafe_path');
  return value;
}
async function plain(file, directory = false) {
  const stat = await lstat(file);
  if (stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile())) throw new Error('nsh_compat_not_plain_file');
  return stat;
}
async function present(file) {
  try { await lstat(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function plainDirectory(directory) {
  const parent = path.dirname(directory);
  if (parent !== directory) await plainDirectory(parent);
  await plain(directory, true);
}
export async function ensureNSHDirectory(directory) {
  try { await plainDirectory(directory); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await ensureNSHDirectory(path.dirname(directory));
    try { await mkdir(directory); } catch (mkdirError) { if (mkdirError.code !== 'EEXIST') throw mkdirError; }
    await plain(directory, true);
  }
}

/** Content-only, platform-independent fingerprint; no links or ambient caches. */
export async function hashNSHTree(directory, roots) {
  await plainDirectory(directory);
  const files = [], seen = new Set();
  async function visit(relative) {
    safePath(relative);
    if (seen.has(relative)) throw new Error('nsh_compat_duplicate_path');
    seen.add(relative);
    const file = path.join(directory, relative), stat = await lstat(file);
    if (stat.isSymbolicLink()) throw new Error('nsh_compat_symlink');
    if (stat.isDirectory()) {
      for (const name of (await readdir(file)).sort()) if (!excluded(`${relative}/${name}`)) await visit(`${relative}/${name}`);
    } else {
      if (!stat.isFile() || files.length >= 10000 || stat.size > 64 * 1024 * 1024) throw new Error('nsh_compat_tree_limit');
      files.push({ path: relative, sha256: sha256(await readFile(file)) });
    }
  }
  for (const root of roots) await visit(safePath(root));
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { files, sha256: sha256(JSON.stringify(files)) };
}

/** Deliberately limited unified diff: UTF-8/LF files, exact coordinates, explicitly
 * declared creates only; no renames/deletes, fuzzy offsets, binary blocks or shell utilities. */
export function applyStrictUnifiedPatch(text, read, declaredFiles = []) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 2 * 1024 * 1024 || text.includes('\r') || !text.endsWith('\n')) throw new Error('nsh_compat_invalid_patch');
  const lines = text.slice(0, -1).split('\n'), outputs = new Map();
  let cursor = 0, hunks = 0;
  while (cursor < lines.length) {
    const before = lines[cursor++], after = lines[cursor++]?.match(/^\+\+\+ b\/(.+)$/);
    const create = before === '--- /dev/null';
    if (!after || !create && before !== `--- a/${after[1]}`) throw new Error('nsh_compat_patch_header');
    const file = safePath(after[1]);
    if (outputs.has(file) || outputs.size >= 64) throw new Error('nsh_compat_duplicate_patch_file');
    const declaration = declaredFiles.find(item => item.path === file);
    if (create !== (declaration?.beforeExists === false) || create && declaration.beforeSha256 !== sha256('')) throw new Error('nsh_compat_patch_create_declaration');
    const original = read(file);
    if (create ? original !== undefined : typeof original !== 'string' || original.includes('\r') || !original.endsWith('\n')) throw new Error('nsh_compat_patch_source_encoding');
    const source = create ? [] : original.slice(0, -1).split('\n'), output = [];
    let position = 0, count = 0;
    while (cursor < lines.length && !lines[cursor].startsWith('--- ')) {
      const header = lines[cursor++]?.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/);
      if (!header || ++hunks > 4096) throw new Error('nsh_compat_patch_hunk');
      const oldStart = Number(header[1]), oldCount = Number(header[2] ?? 1), newStart = Number(header[3]), newCount = Number(header[4] ?? 1);
      if (create) {
        if (count || header[1] !== '0' || header[2] !== '0' || header[3] !== '1' || !header[4] || !Number.isSafeInteger(newCount) || newCount < 1) throw new Error('nsh_compat_patch_create_coordinates');
        for (let index = 0; index < newCount; index++) {
          const line = lines[cursor++];
          if (!line?.startsWith('+')) throw new Error('nsh_compat_patch_create_count');
          output.push(line.slice(1));
        }
        count++;
        continue;
      }
      if (![oldStart, oldCount, newStart, newCount].every(Number.isSafeInteger) || oldStart < 1 || newStart < 1 || oldStart - 1 < position || oldStart - 1 > source.length) throw new Error('nsh_compat_patch_coordinates');
      output.push(...source.slice(position, oldStart - 1)); position = oldStart - 1;
      if (newStart !== output.length + 1) throw new Error('nsh_compat_patch_new_coordinates');
      let removed = 0, added = 0;
      while (removed < oldCount || added < newCount) {
        const line = lines[cursor++], prefix = line?.[0], content = line?.slice(1);
        if (![' ', '-', '+'].includes(prefix)) throw new Error('nsh_compat_patch_count');
        if (prefix !== '+') {
          if (removed >= oldCount || source[position++] !== content) throw new Error('nsh_compat_patch_context');
          removed++;
        }
        if (prefix !== '-') {
          if (added >= newCount) throw new Error('nsh_compat_patch_count');
          output.push(content); added++;
        }
      }
      count++;
    }
    if (!count) throw new Error('nsh_compat_empty_patch_file');
    output.push(...source.slice(position)); outputs.set(file, `${output.join('\n')}\n`);
  }
  if (!outputs.size) throw new Error('nsh_compat_empty_patch');
  return outputs;
}

async function withLock(directory, action) {
  try { await mkdir(directory); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('nsh_compat_busy: another preparation/build owns the lock; stale locks require explicit inspection'); throw error; }
  try { return await action(); }
  finally { await rm(directory, { recursive: true }); }
}
async function revisionOf(source) {
  let git = path.join(source, '.git');
  const stat = await lstat(git);
  if (stat.isFile()) {
    const pointer = (await readFile(git, 'utf8')).trim().match(/^gitdir: (.+)$/);
    if (!pointer) throw new Error('nsh_compat_git_pointer');
    git = path.resolve(source, pointer[1]);
  } else await plain(git, true);
  const head = (await readFile(path.join(git, 'HEAD'), 'utf8')).trim();
  if (/^[a-f0-9]{40}$/.test(head)) return head;
  const ref = head.match(/^ref: (refs\/[a-zA-Z0-9_./-]+)$/)?.[1];
  if (!ref || ref.includes('..')) throw new Error('nsh_compat_revision');
  try { return (await readFile(path.join(git, ref), 'utf8')).trim(); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return (await readFile(path.join(git, 'packed-refs'), 'utf8')).split('\n').find(line => line.endsWith(` ${ref}`))?.split(' ')[0];
  }
}
const decode = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes);

export async function prepareNSHCompatibility({ sourceDir = process.env.NSH_SOURCE_DIR, root = packageRoot, manifestPath = defaultManifest } = {}) {
  if (!sourceDir) throw new Error('NSH_SOURCE_DIR is required: an exact audited NSH 0.4.0 source tree, not the old distribution');
  sourceDir = path.resolve(sourceDir);
  root = path.resolve(root);
  const relativeOutput = path.relative(sourceDir, path.join(root, '.nsh'));
  if (!relativeOutput || !path.isAbsolute(relativeOutput) && relativeOutput !== '..' && !relativeOutput.startsWith(`..${path.sep}`)) throw new Error('nsh_compat_output_overlaps_source');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.version !== '0.4.0' || !/^[a-f0-9]{40}$/.test(manifest.revision) || !hashPattern.test(manifest.source?.sha256) || !Array.isArray(manifest.source.roots) || !Array.isArray(manifest.source.files) || !Array.isArray(manifest.patches) || !manifest.patches.length) throw new Error('nsh_compat_manifest');
  const patchNames = new Set(), patches = [];
  for (const entry of manifest.patches) {
    const name = safePath(entry.file);
    if (patchNames.has(name) || !hashPattern.test(entry.sha256) || !Array.isArray(entry.files) || !entry.files.length) throw new Error('nsh_compat_duplicate_or_invalid_patch');
    patchNames.add(name);
    const file = path.join(path.dirname(manifestPath), name);
    await plainDirectory(path.dirname(file)); await plain(file);
    const bytes = await readFile(file);
    if (sha256(bytes) !== entry.sha256) throw new Error('nsh_compat_patch_hash');
    const names = new Set();
    for (const changed of entry.files) {
      safePath(changed.path);
      if (names.has(changed.path) || !hashPattern.test(changed.beforeSha256) || !hashPattern.test(changed.afterSha256)) throw new Error('nsh_compat_patch_files');
      if (changed.beforeExists !== undefined && typeof changed.beforeExists !== 'boolean' || changed.beforeExists === false && changed.beforeSha256 !== sha256('')) throw new Error('nsh_compat_patch_create_declaration');
      names.add(changed.path);
    }
    patches.push({ ...entry, text: decode(bytes) });
  }
  if (await revisionOf(sourceDir) !== manifest.revision) throw new Error('nsh_compat_wrong_revision');
  const baseline = await hashNSHTree(sourceDir, manifest.source.roots);
  if (baseline.sha256 !== manifest.source.sha256) throw new Error('nsh_compat_wrong_baseline');
  const expected = new Map(baseline.files.map(file => [file.path, file.sha256]));
  const critical = new Set();
  for (const file of manifest.source.files) {
    safePath(file.path);
    if (critical.has(file.path) || expected.get(file.path) !== file.sha256) throw new Error('nsh_compat_baseline_file');
    critical.add(file.path);
  }
  if (!critical.has('Cargo.lock')) throw new Error('nsh_compat_unpinned_lock');
  const preparerSha256 = sha256(await readFile(fileURLToPath(import.meta.url)));
  const digest = sha256(stable({ manifest, preparerSha256 }));
  const cache = path.join(root, '.nsh/compat');
  await ensureNSHDirectory(cache);
  const destination = path.join(cache, digest);
  return withLock(path.join(cache, '.prepare.lock'), async () => {
    let stage;
    try {
      // Compute every post-patch file hash before trusting or publishing a cache.
      const modified = new Map();
      for (const patch of patches) {
        for (const file of patch.files) {
          if (file.beforeExists === false) {
            if (expected.has(file.path) || modified.has(file.path)) throw new Error('nsh_compat_patch_create_existing');
            if (!manifest.source.roots.some(root => file.path.startsWith(`${root}/`))) throw new Error('nsh_compat_patch_create_outside_roots');
            const parts = file.path.split('/');
            for (let index = 1; index <= parts.length; index++) {
              const candidate = path.join(sourceDir, ...parts.slice(0, index));
              if (!await present(candidate)) break;
              if (index === parts.length) throw new Error('nsh_compat_patch_create_existing');
              await plain(candidate, true);
            }
            continue;
          }
          if (expected.get(file.path) !== file.beforeSha256) throw new Error('nsh_compat_patch_before_hash');
          if (!modified.has(file.path)) {
            const bytes = await readFile(path.join(sourceDir, file.path));
            if (sha256(bytes) !== file.beforeSha256) throw new Error('nsh_compat_source_changed');
            modified.set(file.path, decode(bytes));
          }
        }
        const output = applyStrictUnifiedPatch(patch.text, file => {
          if (!patch.files.some(item => item.path === file)) throw new Error('nsh_compat_undeclared_patch_file');
          return modified.get(file);
        }, patch.files);
        // The synchronous parser reads only prevalidated UTF-8 source strings.
        for (const file of patch.files) {
          if (!output.has(file.path) || sha256(output.get(file.path)) !== file.afterSha256) throw new Error('nsh_compat_patch_after_hash');
          expected.set(file.path, file.afterSha256); modified.set(file.path, output.get(file.path));
        }
      }
      const files = [...expected].map(([path, sha256]) => ({ path, sha256 })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
      const finalTreeSha256 = sha256(JSON.stringify(files));
      const receipt = { schemaVersion: 1, digest, preparerSha256, revision: manifest.revision, baselineTreeSha256: baseline.sha256, sourceLockSha256: expected.get('Cargo.lock'), finalTreeSha256, patches: manifest.patches, files };
      async function verify(directory) {
        await plainDirectory(directory);
        const saved = JSON.parse(await readFile(path.join(directory, 'receipt.json'), 'utf8'));
        if (stable(saved) !== stable(receipt) || (await hashNSHTree(path.join(directory, 'source'), manifest.source.roots)).sha256 !== finalTreeSha256) throw new Error('nsh_compat_corrupt_preparation');
      }
      if (await present(destination)) await verify(destination);
      else {
        stage = await mkdtemp(path.join(cache, '.stage-'));
        const copy = path.join(stage, 'source');
        for (const file of baseline.files) {
          const from = path.join(sourceDir, file.path), to = path.join(copy, file.path);
          await mkdir(path.dirname(to), { recursive: true });
          await copyFile(from, to);
          if (sha256(await readFile(to)) !== file.sha256) throw new Error('nsh_compat_source_changed_during_copy');
        }
        for (const [file, text] of modified) {
          await mkdir(path.dirname(path.join(copy, file)), { recursive: true });
          await writeFile(path.join(copy, file), text);
        }
        await writeFile(path.join(stage, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
        await verify(stage);
        await rename(stage, destination); stage = undefined;
      }
      return { digest, sourceDir: path.join(destination, 'source'), sourceRoots: manifest.source.roots, directory: destination, receipt,
        cargoPatches: embeddedCrates.map(name => `${JSON.stringify(name)} = { path = ${JSON.stringify(path.join(destination, 'source/crates', name).replaceAll('\\', '/'))} }`).join('\n') };
    } finally { if (stage) await rm(stage, { recursive: true, force: true }); }
  });
}

export function runOfflineCargo(cargo, args, cwd) {
  const env = { ...process.env, CARGO_NET_OFFLINE: 'true', RUSTUP_AUTO_INSTALL: '0' };
  const wrapper = cargoWrapper();
  if (wrapper) env.RUSTC_WRAPPER = wrapper;
  const result = spawnSync(cargo, args, { cwd, stdio: 'inherit', env, windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`nsh_compat_cargo_failed (${result.status}); offline only, no dependencies were installed`);
}
export function cargoExecutable() {
  return process.env.CARGO || path.join(os.homedir(), '.cargo/bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo');
}

/** One Cargo target root shared by every compatibility digest. Cargo fingerprints
 * artifacts against their own source tree, so a shared directory cannot hand a
 * stale build to a new digest; it only removes the repeated dependency build that
 * a per-digest target used to duplicate once per run. */
export function sharedCargoTarget(nshDirectory, ...segments) {
  return path.join(nshDirectory, 'cargo-target', ...segments);
}

/** Optional compile cache wrapper. Off by default: sccache 0.19 rejects the
 * compile commands rustc 1.99 emits (every request returns UnhandledCompile), so
 * enabling it silently would add an IPC hop and never hit the cache. Set
 * NSH_CARGO_WRAPPER to opt in once the installed pair actually caches. */
export function cargoWrapper() {
  return process.env.NSH_CARGO_WRAPPER ?? '';
}

/** Publish only a complete script-owned staging directory; preserve old output
 * on failure, including Windows' inability to rename over an existing folder. */
export async function publishNSHDirectory(staging, destination, move = rename, remove = rm) {
  const backup = `${destination}.previous-${randomUUID()}`;
  let previous = false;
  try { await move(destination, backup); previous = true; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { await move(staging, destination); }
  catch (error) {
    if (previous) {
      try { await move(backup, destination); }
      catch (restore) { throw new AggregateError([error, restore], 'nsh_compat_publish_rollback_failed; prior output remains in the previous directory'); }
    }
    throw error;
  }
  if (previous) {
    try { await remove(backup, { recursive: true }); }
    catch { console.warn('nsh_compat_publish_committed_cleanup_pending: previous output retained'); }
  }
}

/** CLI and physical devhost are inseparable, digest-verified native artifacts. */
export async function ensureNSHCompatibilityTools(prepared, { cargo = cargoExecutable(), runCargo = runOfflineCargo } = {}) {
  const platform = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : null;
  if (!platform) throw new Error('nsh_compat_requires_macos_or_windows');
  const directory = path.join(prepared.directory, `tools-${process.platform}-${process.arch}`);
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const paths = [`bin/nsh${suffix}`, `runtime/${platform}/nsh-${platform}-host${suffix}`];
  async function verify() {
    await plainDirectory(directory);
    const receipt = JSON.parse(await readFile(path.join(directory, 'receipt.json'), 'utf8'));
    if (receipt.digest !== prepared.digest || receipt.files.length !== paths.length) throw new Error('nsh_compat_tool_receipt');
    for (const file of paths) {
      await plain(path.join(directory, file));
      if (receipt.files.find(item => item.path === file)?.sha256 !== sha256(await readFile(path.join(directory, file)))) throw new Error('nsh_compat_tool_hash');
    }
  }
  return withLock(path.join(prepared.directory, '.tools.lock'), async () => {
    if (await present(directory)) await verify();
    else {
      const stage = await mkdtemp(path.join(prepared.directory, '.tools-stage-'));
      try {
        const target = sharedCargoTarget(path.resolve(prepared.directory, '../..'), `tools-${process.platform}-${process.arch}`);
        await ensureNSHDirectory(target);
        await runCargo(cargo, ['build', '--offline', '--locked', '--manifest-path', path.join(prepared.sourceDir, 'Cargo.toml'), '--target-dir', target, '-p', 'nsh-cli', '-p', `nsh-${platform}-host`], prepared.sourceDir);
        if ((await hashNSHTree(prepared.sourceDir, prepared.sourceRoots)).sha256 !== prepared.receipt.finalTreeSha256) throw new Error('nsh_compat_compiler_modified_source');
        const files = [];
        for (const file of paths) {
          const destination = path.join(stage, file);
          await mkdir(path.dirname(destination), { recursive: true });
          await copyFile(path.join(target, 'debug', path.basename(file)), destination);
          if (process.platform !== 'win32') await chmod(destination, 0o755);
          files.push({ path: file, sha256: sha256(await readFile(destination)) });
        }
        await writeFile(path.join(stage, 'receipt.json'), `${JSON.stringify({ digest: prepared.digest, files }, null, 2)}\n`);
        await rename(stage, directory);
      } finally { await rm(stage, { recursive: true, force: true }); }
      await verify();
    }
    return { digest: prepared.digest, bin: path.join(directory, paths[0]), runtime: path.join(directory, 'runtime'),
      env: { ...process.env, NSH_BIN: path.join(directory, paths[0]), NSH_RUNTIME: path.join(directory, 'runtime'), CARGO_NET_OFFLINE: 'true', RUSTUP_AUTO_INSTALL: '0' } };
  });
}
