import { afterEach, describe, expect, it, vi } from 'vitest';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { applyStrictUnifiedPatch, ensureNSHCompatibilityTools, hashNSHTree, prepareNSHCompatibility, publishNSHDirectory, sha256 } from './scripts/nsh-compat.mjs';

const temporary: string[] = [];
afterEach(async () => { for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true }); });
const patch = '--- a/src/main.rs\n+++ b/src/main.rs\n@@ -1,2 +1,2 @@\n first\n-old\n+new\n';
const createPatch = '--- /dev/null\n+++ b/src/new/tests.rs\n@@ -0,0 +1,2 @@\n+created\n+test\n';
const createFile = { path: 'src/new/tests.rs', beforeExists: false, beforeSha256: sha256(''), afterSha256: sha256('created\ntest\n') };
type PatchFile = { path: string; beforeExists?: boolean; beforeSha256: string; afterSha256: string };
async function fixture() {
  const directory = await mkdtemp(path.join(await realpath(os.tmpdir()), 'nsh-compat-test-')); temporary.push(directory);
  const sourceDir = path.join(directory, 'upstream'), root = path.join(directory, 'product');
  await mkdir(path.join(sourceDir, '.git'), { recursive: true }); await mkdir(path.join(sourceDir, 'src'));
  await mkdir(root); await writeFile(path.join(sourceDir, '.git/HEAD'), `${'e'.repeat(40)}\n`);
  await writeFile(path.join(sourceDir, 'src/main.rs'), 'first\nold\n'); await writeFile(path.join(sourceDir, 'Cargo.lock'), 'locked\n');
  const roots = ['src', 'Cargo.lock'], baseline = await hashNSHTree(sourceDir, roots);
  const changedFiles: PatchFile[] = [{ path: 'src/main.rs', beforeSha256: sha256('first\nold\n'), afterSha256: sha256('first\nnew\n') }];
  const manifest = { schemaVersion: 1, version: '0.4.0', revision: 'e'.repeat(40), source: { roots, sha256: baseline.sha256, files: baseline.files },
    patches: [{ file: 'change.patch', sha256: sha256(patch), files: changedFiles }] };
  const manifestPath = path.join(directory, 'manifest.json'); await writeFile(path.join(directory, 'change.patch'), patch);
  const save = () => writeFile(manifestPath, JSON.stringify(manifest)); await save();
  return { directory, sourceDir, root, manifest, manifestPath, save, prepare: () => prepareNSHCompatibility({ sourceDir, root, manifestPath }) };
}

describe('strict NSH source patch preparation', () => {
  it('permits only an explicitly absent declared file with one exact zero-source hunk', () => {
    expect(applyStrictUnifiedPatch(createPatch, () => undefined, [createFile]).get(createFile.path)).toBe('created\ntest\n');
    for (const declaration of [[], [{ ...createFile, beforeExists: undefined }], [{ ...createFile, beforeExists: true }], [{ ...createFile, beforeExists: 'false' }], [{ ...createFile, beforeSha256: '0'.repeat(64) }]]) {
      expect(() => applyStrictUnifiedPatch(createPatch, () => undefined, declaration)).toThrow('create_declaration');
    }
    for (const existing of ['', 'existing\n']) expect(() => applyStrictUnifiedPatch(createPatch, () => existing, [createFile])).toThrow('source_encoding');
    for (const bad of [
      createPatch.replace('-0,0', '-1,0'), createPatch.replace('-0,0', '-0'),
      createPatch.replace('-0,0', '-00,0'), createPatch.replace('-0,0', '-0,1'),
      createPatch.replace('+1,2', '+0,2'), createPatch.replace('+1,2', '+2,2'),
      createPatch.replace('+1,2', '+1,0'), createPatch.replace('+1,2', '+1,9007199254740992'),
      createPatch.replace('+created', ' created'), createPatch.replace('+created', '-created'),
      createPatch + '@@ -0,0 +1,1 @@\n+extra\n', createPatch + '+extra\n',
      createPatch.replace('--- /dev/null', '--- a/src/new/tests.rs'),
      createPatch.replace('+++ b/src/new/tests.rs', '+++ /dev/null'),
      'diff --git a/src/new/tests.rs b/src/new/tests.rs\n' + createPatch,
      createPatch.replaceAll('\n', '\r\n'), createPatch.slice(0, -1),
    ]) expect(() => applyStrictUnifiedPatch(bad, () => undefined, [createFile])).toThrow();
    expect(() => applyStrictUnifiedPatch(createPatch + createPatch, () => undefined, [createFile])).toThrow('duplicate');
    for (const target of ['../escape.rs', '/absolute.rs', 'C:/escape.rs', 'src/../escape.rs', 'src\\escape.rs', 'src//file.rs', '.git/config']) {
      expect(() => applyStrictUnifiedPatch(createPatch.replaceAll(createFile.path, target), () => undefined, [{ ...createFile, path: target }])).toThrow('unsafe_path');
    }
  });
  it('includes creations in the complete receipt, ordered hash chain and cache validation', async () => {
    const test = await fixture();
    await writeFile(path.join(test.directory, 'create.patch'), createPatch);
    test.manifest.patches.push({ file: 'create.patch', sha256: sha256(createPatch), files: [{ ...createFile }] });
    const next = '--- a/src/new/tests.rs\n+++ b/src/new/tests.rs\n@@ -1,2 +1,2 @@\n created\n-test\n+next\n';
    await writeFile(path.join(test.directory, 'next.patch'), next);
    test.manifest.patches.push({ file: 'next.patch', sha256: sha256(next), files: [{ ...createFile, beforeExists: true, beforeSha256: createFile.afterSha256, afterSha256: sha256('created\nnext\n') }] });
    await test.save();
    const prepared = await test.prepare();
    expect(prepared.receipt.files.map((file: { path: string }) => file.path)).toEqual(['Cargo.lock', 'src/main.rs', createFile.path]);
    expect(await readFile(path.join(prepared.sourceDir, createFile.path), 'utf8')).toBe('created\nnext\n');
    expect((await hashNSHTree(prepared.sourceDir, test.manifest.source.roots)).sha256).toBe(prepared.receipt.finalTreeSha256);
    expect((await test.prepare()).digest).toBe(prepared.digest);
    await expect(lstat(path.join(test.sourceDir, createFile.path))).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(path.join(prepared.sourceDir, createFile.path), 'tampered\n');
    await expect(test.prepare()).rejects.toThrow('corrupt_preparation');
    await rm(path.join(prepared.sourceDir, createFile.path));
    await expect(test.prepare()).rejects.toThrow('corrupt_preparation');
  });
  it.each(['undeclared', 'invalid-flag', 'wrong-empty-hash', 'wrong-after-hash', 'existing', 'duplicate', 'duplicate-declaration', 'undeclared-target', 'outside-roots', 'escape', 'absolute', 'backslash', 'cache-path', 'symlink-parent', 'symlink-target', 'directory-target', 'delete', 'rename', 'fuzz', 'nonzero-old-count', 'wrong-new-start', 'context-line', 'second-hunk', 'trailing-payload', 'crlf', 'unterminated', 'missing-hunk'])('rejects creation boundary %s without changing prior source or App', async boundary => {
    const test = await fixture(), prior = await test.prepare();
    const oldApp = path.join(test.root, '.nsh/desktop/YuriNative.app'); await mkdir(oldApp, { recursive: true });
    await writeFile(path.join(oldApp, 'old'), 'unchanged');
    const file: PatchFile = { ...createFile };
    let text = createPatch;
    if (boundary === 'undeclared') file.beforeExists = undefined;
    if (boundary === 'invalid-flag') Object.assign(file, { beforeExists: 'false' });
    if (boundary === 'wrong-empty-hash') file.beforeSha256 = '0'.repeat(64);
    if (boundary === 'wrong-after-hash') file.afterSha256 = '0'.repeat(64);
    if (boundary === 'existing') { file.path = 'src/main.rs'; text = text.replaceAll(createFile.path, file.path); }
    if (boundary === 'duplicate') text += text;
    if (boundary === 'outside-roots') { file.path = 'outside.rs'; text = text.replaceAll(createFile.path, file.path); }
    const unsafeTargets: Record<string, string> = { escape: '../escape.rs', absolute: '/absolute.rs', backslash: 'src\\escape.rs', 'cache-path': 'src/target/file.rs' };
    if (unsafeTargets[boundary]) { file.path = unsafeTargets[boundary]; text = text.replaceAll(createFile.path, file.path); }
    if (boundary === 'undeclared-target') text = text.replaceAll(createFile.path, 'src/undeclared.rs');
    if (boundary === 'symlink-parent') await symlink(test.root, path.join(test.sourceDir, 'src/new'));
    if (boundary === 'symlink-target' || boundary === 'directory-target') {
      await mkdir(path.join(test.sourceDir, 'src/new'));
      if (boundary === 'symlink-target') await symlink(path.join(test.sourceDir, 'Cargo.lock'), path.join(test.sourceDir, file.path));
      else await mkdir(path.join(test.sourceDir, file.path));
    }
    if (boundary === 'delete') text = text.replace('+++ b/src/new/tests.rs', '+++ /dev/null');
    if (boundary === 'rename') text = text.replace('--- /dev/null', '--- a/src/main.rs');
    if (boundary === 'fuzz') text = text.replace('-0,0', '-1,0');
    if (boundary === 'nonzero-old-count') text = text.replace('-0,0', '-0,1');
    if (boundary === 'wrong-new-start') text = text.replace('+1,2', '+2,2');
    if (boundary === 'context-line') text = text.replace('+created', ' created');
    if (boundary === 'second-hunk') text += '@@ -0,0 +1,1 @@\n+extra\n';
    if (boundary === 'trailing-payload') text += '+extra\n';
    if (boundary === 'crlf') text = text.replaceAll('\n', '\r\n');
    if (boundary === 'unterminated') text = text.slice(0, -1);
    if (boundary === 'missing-hunk') text = text.split('\n').slice(0, 2).join('\n') + '\n';
    await writeFile(path.join(test.directory, 'create.patch'), text);
    test.manifest.patches.push({ file: 'create.patch', sha256: sha256(text), files: boundary === 'duplicate-declaration' ? [file, { ...file }] : [file] });
    await test.save();
    await expect(test.prepare()).rejects.toThrow();
    expect(await readFile(path.join(prior.sourceDir, 'src/main.rs'), 'utf8')).toBe('first\nnew\n');
    expect(await readFile(path.join(test.sourceDir, 'src/main.rs'), 'utf8')).toBe('first\nold\n');
    expect(await readFile(path.join(test.sourceDir, 'Cargo.lock'), 'utf8')).toBe('locked\n');
    expect(await readFile(path.join(oldApp, 'old'), 'utf8')).toBe('unchanged');
    expect(await readdir(path.join(test.root, '.nsh/compat'))).toEqual([prior.digest]);
  });
  it('never treats an existing empty source file as absent or recreates an earlier patch output', async () => {
    const test = await fixture();
    await mkdir(path.join(test.sourceDir, 'src/new'));
    await writeFile(path.join(test.sourceDir, createFile.path), '');
    const baseline = await hashNSHTree(test.sourceDir, test.manifest.source.roots);
    test.manifest.source.sha256 = baseline.sha256;
    test.manifest.source.files = baseline.files;
    await writeFile(path.join(test.directory, 'create.patch'), createPatch);
    test.manifest.patches.push({ file: 'create.patch', sha256: sha256(createPatch), files: [{ ...createFile }] });
    await test.save();
    await expect(test.prepare()).rejects.toThrow('create_existing');
    expect(await readFile(path.join(test.sourceDir, createFile.path), 'utf8')).toBe('');
    await rm(path.join(test.sourceDir, createFile.path));
    const absent = await hashNSHTree(test.sourceDir, test.manifest.source.roots);
    test.manifest.source.sha256 = absent.sha256;
    test.manifest.source.files = absent.files;
    await writeFile(path.join(test.directory, 'recreate.patch'), createPatch);
    test.manifest.patches.push({ file: 'recreate.patch', sha256: sha256(createPatch), files: [{ ...createFile }] });
    await test.save();
    await expect(test.prepare()).rejects.toThrow('create_existing');
    await expect(lstat(path.join(test.sourceDir, createFile.path))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(path.join(test.root, '.nsh/compat'))).toEqual([]);
  });
  it('uses exact coordinates and context, not fuzzy replacement', () => {
    expect(applyStrictUnifiedPatch(patch, () => 'first\nold\n').get('src/main.rs')).toBe('first\nnew\n');
    expect(() => applyStrictUnifiedPatch(patch, () => 'extra\nfirst\nold\n')).toThrow('context');
    expect(() => applyStrictUnifiedPatch(patch.replace('-1,2', '-2,2'), () => 'first\nold\n')).toThrow();
    expect(() => applyStrictUnifiedPatch(patch.replace('+1,2', '+2,2'), () => 'first\nold\n')).toThrow('new_coordinates');
    expect(() => applyStrictUnifiedPatch(patch.replace('+1,2', '+1,3'), () => 'first\nold\n')).toThrow();
    expect(() => applyStrictUnifiedPatch(patch.replace(' first', ' wrong'), () => 'first\nold\n')).toThrow('context');
  });
  it.each(['../escape.rs', '/absolute.rs', 'C:/escape.rs', 'src/../escape.rs', 'src\\escape.rs', 'src//file.rs', '.git/config'])('rejects escaping or ambiguous path %s', file => {
    const bad = patch.replaceAll('src/main.rs', file);
    expect(() => applyStrictUnifiedPatch(bad, () => 'first\nold\n')).toThrow('unsafe_path');
  });
  it('rejects duplicate targets, header tricks, binary/trailing payloads and unbounded input', () => {
    expect(() => applyStrictUnifiedPatch(patch + patch, () => 'first\nold\n')).toThrow('duplicate');
    for (const bad of [patch.replace('b/src/main.rs', 'b/other.rs'), patch + 'binary\n', patch.replaceAll('\n', '\r\n'), patch.slice(0, -1), 'x'.repeat(2 * 1024 * 1024 + 1)]) {
      expect(() => applyStrictUnifiedPatch(bad, () => 'first\nold\n')).toThrow();
    }
  });
  it('copies without hardlinks, retains exact source/lock, publishes stable digest and verifies cache', async () => {
    const test = await fixture(), prepared = await test.prepare(), again = await test.prepare();
    expect(again.digest).toBe(prepared.digest);
    expect(await readFile(path.join(test.sourceDir, 'src/main.rs'), 'utf8')).toBe('first\nold\n');
    expect(await readFile(path.join(prepared.sourceDir, 'src/main.rs'), 'utf8')).toBe('first\nnew\n');
    expect(await readFile(path.join(prepared.sourceDir, 'Cargo.lock'), 'utf8')).toBe('locked\n');
    expect((await stat(path.join(prepared.sourceDir, 'Cargo.lock'))).ino).not.toBe((await stat(path.join(test.sourceDir, 'Cargo.lock'))).ino);
    expect(prepared.receipt.files).toHaveLength(2);
    expect(prepared.receipt.sourceLockSha256).toBe(sha256('locked\n'));
    expect((await hashNSHTree(test.sourceDir, test.manifest.source.roots)).sha256).toBe(test.manifest.source.sha256);
    await writeFile(path.join(prepared.sourceDir, 'src/main.rs'), 'corrupt\n');
    await expect(test.prepare()).rejects.toThrow('corrupt_preparation');
  });
  it('fails closed for wrong revision, wrong baseline, changed lock and duplicate manifest patches', async () => {
    const test = await fixture();
    await writeFile(path.join(test.sourceDir, '.git/HEAD'), `${'a'.repeat(40)}\n`);
    await expect(test.prepare()).rejects.toThrow('wrong_revision');
    await writeFile(path.join(test.sourceDir, '.git/HEAD'), `${test.manifest.revision}\n`);
    await writeFile(path.join(test.sourceDir, 'Cargo.lock'), 'unlocked\n');
    await expect(test.prepare()).rejects.toThrow('wrong_baseline');
    await writeFile(path.join(test.sourceDir, 'Cargo.lock'), 'locked\n');
    test.manifest.patches.push(test.manifest.patches[0]); await test.save();
    await expect(test.prepare()).rejects.toThrow('duplicate');
  });
  it('rejects symlinks and caches do not enter the source fingerprint', async () => {
    const test = await fixture(), before = await hashNSHTree(test.sourceDir, test.manifest.source.roots);
    await mkdir(path.join(test.sourceDir, 'src/target')); await writeFile(path.join(test.sourceDir, 'src/target/cache'), 'ignored');
    expect((await hashNSHTree(test.sourceDir, test.manifest.source.roots)).sha256).toBe(before.sha256);
    await symlink(path.join(test.sourceDir, 'Cargo.lock'), path.join(test.sourceDir, 'src/link'));
    await expect(test.prepare()).rejects.toThrow('symlink');
  });
  it.each(['cache', '.cargo/cache', '.cargo/registry/cache', '.cargo/git', 'src/target/cache', 'src/node_modules/cache', 'src/.nsh/cache', 'src/.git/cache', 'src/.cache/cache', 'src/dist/cache'])('excludes known artifact location %s without accepting it as a patch target', async artifact => {
    const test = await fixture();
    await mkdir(path.join(test.sourceDir, '.cargo'));
    await writeFile(path.join(test.sourceDir, '.cargo/config.toml'), '[net]\noffline = true\n');
    test.manifest.source.roots.push('.cargo');
    const before = await hashNSHTree(test.sourceDir, test.manifest.source.roots);
    await mkdir(path.join(test.sourceDir, artifact), { recursive: true });
    await writeFile(path.join(test.sourceDir, artifact, 'file.rs'), 'user cache, not audited source\n');
    const after = await hashNSHTree(test.sourceDir, test.manifest.source.roots);
    expect(after).toEqual(before);
    expect(() => applyStrictUnifiedPatch(patch.replaceAll('src/main.rs', `${artifact}/file.rs`), () => 'first\nold\n')).toThrow('unsafe_path');
    await expect(hashNSHTree(test.sourceDir, [`${artifact}/file.rs`])).rejects.toThrow('unsafe_path');
    test.manifest.source.sha256 = before.sha256;
    test.manifest.source.files = before.files;
    await test.save();
    const prepared = await test.prepare();
    await expect(lstat(path.join(prepared.sourceDir, artifact, 'file.rs'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(prepared.receipt.files).toHaveLength(before.files.length);
  });
  it.each(['src/image/cache.rs', 'src/image/cache/tests.rs'])('hashes and copies legitimate cache module %s and rejects source or prepared tampering', async target => {
    const test = await fixture();
    await mkdir(path.join(test.sourceDir, 'src/image/cache'), { recursive: true });
    const sources = { 'src/image/cache.rs': '#[cfg(test)]\nmod tests;\n', 'src/image/cache/tests.rs': '#[test]\nfn cached_image() {}\n' };
    for (const [file, text] of Object.entries(sources)) await writeFile(path.join(test.sourceDir, file), text);
    const baseline = await hashNSHTree(test.sourceDir, test.manifest.source.roots);
    expect(baseline.files.map(file => file.path)).toEqual(['Cargo.lock', 'src/image/cache.rs', 'src/image/cache/tests.rs', 'src/main.rs']);
    test.manifest.source.sha256 = baseline.sha256;
    test.manifest.source.files = baseline.files;
    await test.save();
    const prepared = await test.prepare();
    for (const [file, text] of Object.entries(sources)) {
      expect(await readFile(path.join(prepared.sourceDir, file), 'utf8')).toBe(text);
      expect(prepared.receipt.files).toContainEqual({ path: file, sha256: sha256(text) });
      expect((await stat(path.join(prepared.sourceDir, file))).ino).not.toBe((await stat(path.join(test.sourceDir, file))).ino);
    }
    expect((await test.prepare()).digest).toBe(prepared.digest);
    const original = await readFile(path.join(test.sourceDir, target), 'utf8');
    await writeFile(path.join(prepared.sourceDir, target), 'tampered prepared cache module\n');
    await expect(test.prepare()).rejects.toThrow('corrupt_preparation');
    await writeFile(path.join(prepared.sourceDir, target), original);
    await writeFile(path.join(test.sourceDir, target), 'tampered original cache module\n');
    await expect(test.prepare()).rejects.toThrow('wrong_baseline');
    expect(await readFile(path.join(prepared.sourceDir, target), 'utf8')).toBe(original);
  });
  it('permits exact declared patches in a legitimate cache source directory, not an implicit creation', () => {
    const target = 'src/image/cache/tests.rs';
    expect(applyStrictUnifiedPatch(patch.replaceAll('src/main.rs', target), () => 'first\nold\n').get(target)).toBe('first\nnew\n');
    const creation = createPatch.replaceAll(createFile.path, target), declared = [{ ...createFile, path: target }];
    expect(applyStrictUnifiedPatch(creation, () => undefined, declared).get(target)).toBe('created\ntest\n');
    expect(() => applyStrictUnifiedPatch(creation, () => undefined)).toThrow('create_declaration');
    expect(() => applyStrictUnifiedPatch(creation, () => 'existing\n', declared)).toThrow('source_encoding');
  });
  it('does not mistake a symlink in a legitimate cache source directory for an ignorable artifact', async () => {
    const test = await fixture(), prior = await test.prepare();
    await mkdir(path.join(test.sourceDir, 'src/image/cache'), { recursive: true });
    await symlink(path.join(test.sourceDir, 'Cargo.lock'), path.join(test.sourceDir, 'src/image/cache/tests.rs'));
    await expect(test.prepare()).rejects.toThrow('symlink');
    expect(await readFile(path.join(prior.sourceDir, 'src/main.rs'), 'utf8')).toBe('first\nnew\n');
    expect(await readdir(path.join(test.root, '.nsh/compat'))).toEqual([prior.digest]);
  });
  it('keeps the previously published source and old App on failed patch verification', async () => {
    const test = await fixture(), prior = await test.prepare();
    const oldApp = path.join(test.root, '.nsh/desktop/YuriNative.app'); await mkdir(oldApp, { recursive: true });
    await writeFile(path.join(oldApp, 'old'), 'unchanged');
    test.manifest.patches[0].files[0].afterSha256 = '0'.repeat(64); await test.save();
    await expect(test.prepare()).rejects.toThrow('after_hash');
    expect(await readFile(path.join(prior.sourceDir, 'src/main.rs'), 'utf8')).toBe('first\nnew\n');
    expect(await readFile(path.join(oldApp, 'old'), 'utf8')).toBe('unchanged');
    expect(await readFile(path.join(test.sourceDir, 'src/main.rs'), 'utf8')).toBe('first\nold\n');
    expect((await hashNSHTree(test.sourceDir, test.manifest.source.roots)).sha256).toBe(test.manifest.source.sha256);
  });
  it('serializes concurrent preparation and never steals an existing lock', async () => {
    const test = await fixture();
    const results = await Promise.allSettled([test.prepare(), test.prepare()]);
    const completed = results.filter(result => result.status === 'fulfilled');
    expect(completed.length).toBeGreaterThanOrEqual(1);
    expect(new Set(completed.map(result => result.value.digest)).size).toBe(1);
    for (const result of results) if (result.status === 'rejected') expect(result.reason.message).toContain('busy');
    const lock = path.join(test.root, '.nsh/compat/.prepare.lock'); await mkdir(lock);
    await expect(test.prepare()).rejects.toThrow('busy'); expect((await lstat(lock)).isDirectory()).toBe(true);
  });
  it('applies ordered patches only against the exact preceding output hash', async () => {
    const test = await fixture();
    const second = patch.replace('-old', '-new').replace('+new', '+next');
    await writeFile(path.join(test.directory, 'second.patch'), second);
    test.manifest.patches.push({ file: 'second.patch', sha256: sha256(second), files: [{ path: 'src/main.rs', beforeSha256: sha256('first\nnew\n'), afterSha256: sha256('first\nnext\n') }] });
    await test.save();
    const prepared = await test.prepare();
    expect(await readFile(path.join(prepared.sourceDir, 'src/main.rs'), 'utf8')).toBe('first\nnext\n');
    test.manifest.patches.reverse(); await test.save();
    await expect(test.prepare()).rejects.toThrow('before_hash');
  });
  it.each(['valid', 'reordered', 'stale-before', 'implicit-create', 'wrong-empty-before', 'wrong-created-after', 'duplicate-create', 'undeclared-create'])('checks third-patch provenance and four exact creates: %s', async boundary => {
    const test = await fixture();
    const second = patch.replace('-old', '-new').replace('+new', '+next');
    await writeFile(path.join(test.directory, 'second.patch'), second);
    test.manifest.patches.push({ file: 'second.patch', sha256: sha256(second), files: [{ path: 'src/main.rs', beforeSha256: sha256('first\nnew\n'), afterSha256: sha256('first\nnext\n') }] });
    await test.save();
    const prior = await test.prepare(), oldApp = path.join(test.root, '.nsh/desktop/YuriNative.app');
    await mkdir(oldApp, { recursive: true }); await writeFile(path.join(oldApp, 'old'), 'unchanged');
    const creates: PatchFile[] = Array.from({ length: 4 }, (_, index) => ({ path: `src/list/snapshot${index}.rs`, beforeExists: false, beforeSha256: sha256(''), afterSha256: sha256(`snapshot ${index}\n`) }));
    let text = patch.replace('-old', '-next').replace('+new', '+final') + creates.map((file, index) => `--- /dev/null\n+++ b/${file.path}\n@@ -0,0 +1,1 @@\n+snapshot ${index}\n`).join('');
    const files: PatchFile[] = [{ path: 'src/main.rs', beforeExists: true, beforeSha256: sha256('first\nnext\n'), afterSha256: sha256('first\nfinal\n') }, ...creates];
    if (boundary === 'stale-before') files[0].beforeSha256 = sha256('first\nnew\n');
    if (boundary === 'implicit-create') delete files[1].beforeExists;
    if (boundary === 'wrong-empty-before') files[1].beforeSha256 = sha256('not absent');
    if (boundary === 'wrong-created-after') files[1].afterSha256 = sha256('wrong content\n');
    if (boundary === 'duplicate-create') text += `--- /dev/null\n+++ b/${creates[0].path}\n@@ -0,0 +1,1 @@\n+snapshot 0\n`;
    if (boundary === 'undeclared-create') text = text.replaceAll(creates[0].path, 'src/list/undeclared.rs');
    await writeFile(path.join(test.directory, 'third.patch'), text);
    const third = { file: 'third.patch', sha256: sha256(text), files };
    test.manifest.patches.push(third);
    if (boundary === 'reordered') [test.manifest.patches[1], test.manifest.patches[2]] = [test.manifest.patches[2], test.manifest.patches[1]];
    await test.save();
    if (boundary === 'valid') {
      const prepared = await test.prepare();
      expect(prepared.receipt.files).toHaveLength(6);
      expect(prepared.receipt.patches.map((entry: { file: string }) => entry.file)).toEqual(['change.patch', 'second.patch', 'third.patch']);
      expect(await readFile(path.join(prepared.sourceDir, 'src/main.rs'), 'utf8')).toBe('first\nfinal\n');
      for (const [index, file] of creates.entries()) expect(await readFile(path.join(prepared.sourceDir, file.path), 'utf8')).toBe(`snapshot ${index}\n`);
      expect((await test.prepare()).digest).toBe(prepared.digest);
    } else {
      await expect(test.prepare()).rejects.toThrow();
      expect(await readdir(path.join(test.root, '.nsh/compat'))).toEqual([prior.digest]);
    }
    expect(await readFile(path.join(prior.sourceDir, 'src/main.rs'), 'utf8')).toBe('first\nnext\n');
    expect(await readFile(path.join(test.sourceDir, 'src/main.rs'), 'utf8')).toBe('first\nold\n');
    expect(await readFile(path.join(oldApp, 'old'), 'utf8')).toBe('unchanged');
    for (const file of creates) await expect(lstat(path.join(test.sourceDir, file.path))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('does not create directories through a symlinked output root', async () => {
    const test = await fixture();
    await symlink(test.sourceDir, path.join(test.root, '.nsh'));
    await expect(test.prepare()).rejects.toThrow();
    await expect(lstat(path.join(test.sourceDir, 'compat'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('never prepares inside the externally selected source tree', async () => {
    const test = await fixture();
    await expect(prepareNSHCompatibility({ sourceDir: test.sourceDir, root: test.sourceDir, manifestPath: test.manifestPath })).rejects.toThrow('overlaps_source');
    await expect(lstat(path.join(test.sourceDir, '.nsh'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('restores an old App when the final directory publication fails', async () => {
    const test = await fixture(), staging = path.join(test.root, 'staging'), destination = path.join(test.root, 'App');
    await mkdir(staging); await mkdir(destination);
    await writeFile(path.join(staging, 'value'), 'new'); await writeFile(path.join(destination, 'value'), 'old');
    let moves = 0;
    const move: typeof rename = async (from, to) => {
      if (++moves === 2) throw new Error('injected publication failure');
      await rename(from, to);
    };
    await expect(publishNSHDirectory(staging, destination, move)).rejects.toThrow('publication failure');
    expect(await readFile(path.join(destination, 'value'), 'utf8')).toBe('old');
    expect(await readFile(path.join(staging, 'value'), 'utf8')).toBe('new');
    await publishNSHDirectory(staging, destination);
    expect(await readFile(path.join(destination, 'value'), 'utf8')).toBe('new');
  });
  it('reports post-commit cleanup separately rather than falsely reporting a failed publication', async () => {
    const test = await fixture(), staging = path.join(test.root, 'staging'), destination = path.join(test.root, 'App');
    await mkdir(staging); await mkdir(destination);
    await writeFile(path.join(staging, 'value'), 'new'); await writeFile(path.join(destination, 'value'), 'old');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await publishNSHDirectory(staging, destination, rename, async () => { throw new Error('cleanup unavailable'); });
      expect(await readFile(path.join(destination, 'value'), 'utf8')).toBe('new');
      const previous = (await readdir(test.root)).find(name => name.startsWith('App.previous-'))!;
      expect(await readFile(path.join(test.root, previous, 'value'), 'utf8')).toBe('old');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('publish_committed_cleanup_pending'));
    } finally { warn.mockRestore(); }
  });
  it.skipIf(!['darwin', 'win32'].includes(process.platform))('publishes CLI/devhost together and rejects missing or corrupt cached runtime (injected compiler, not OS evidence)', async () => {
    const test = await fixture(), prepared = await test.prepare();
    const suffix = process.platform === 'win32' ? '.exe' : '', platform = process.platform === 'darwin' ? 'macos' : 'windows';
    let builds = 0;
    const runCargo = async (_cargo: string, args: string[], cwd: string) => {
      builds++;
      expect(args).toEqual(expect.arrayContaining(['--offline', '--locked', '-p', 'nsh-cli', `nsh-${platform}-host`]));
      expect(cwd).toBe(prepared.sourceDir);
      const target = args[args.indexOf('--target-dir') + 1]; await mkdir(path.join(target, 'debug'), { recursive: true });
      await writeFile(path.join(target, 'debug', `nsh${suffix}`), 'injected cli');
      await writeFile(path.join(target, 'debug', `nsh-${platform}-host${suffix}`), 'injected host');
    };
    const tools = await ensureNSHCompatibilityTools(prepared, { runCargo });
    expect(builds).toBe(1);
    expect(tools.env.NSH_BIN).toBe(tools.bin); expect(tools.env.NSH_RUNTIME).toBe(tools.runtime);
    expect(tools.bin.startsWith(prepared.directory)).toBe(true); expect(tools.runtime.startsWith(prepared.directory)).toBe(true);
    await ensureNSHCompatibilityTools(prepared, { runCargo }); expect(builds).toBe(1);
    await writeFile(tools.bin, 'corrupt');
    await expect(ensureNSHCompatibilityTools(prepared, { runCargo })).rejects.toThrow('tool_hash');
    expect(builds).toBe(1);
    await writeFile(tools.bin, 'injected cli');
    await rm(path.join(tools.runtime, platform, `nsh-${platform}-host${suffix}`));
    await expect(ensureNSHCompatibilityTools(prepared, { runCargo })).rejects.toMatchObject({ code: 'ENOENT' });
    expect(builds).toBe(1);
  });
  it.skipIf(!['darwin', 'win32'].includes(process.platform))('never publishes partial tooling after an offline compiler failure (injected compiler)', async () => {
    const test = await fixture(), prepared = await test.prepare();
    const runCargo = async () => { throw new Error('offline cache missing'); };
    await expect(ensureNSHCompatibilityTools(prepared, { runCargo })).rejects.toThrow('offline cache missing');
    await expect(lstat(path.join(prepared.directory, `tools-${process.platform}-${process.arch}`))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(path.join(prepared.directory, '.tools.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await hashNSHTree(test.sourceDir, test.manifest.source.roots)).sha256).toBe(test.manifest.source.sha256);
  });
  it('hashes the shipped exact patch against the audited source hash chain', async () => {
    const root = path.dirname(fileURLToPath(import.meta.url));
    const manifest = JSON.parse(await readFile(path.join(root, 'patches/nsh-0.4.0/manifest.json'), 'utf8'));
    expect(manifest.revision).toBe('e626a8dd8f8d8b277b9507cfd5ac74d0e67020f3');
    for (const entry of manifest.patches) expect(sha256(await readFile(path.join(root, 'patches/nsh-0.4.0', entry.file)))).toBe(entry.sha256);
  });
  it('pins the shipped Shift→Diff→List→DevFrame→ListContract provenance, exact List SHA and four create declarations', async () => {
    const root = path.dirname(fileURLToPath(import.meta.url));
    const manifest = JSON.parse(await readFile(path.join(root, 'patches/nsh-0.4.0/manifest.json'), 'utf8'));
    expect(manifest.patches.map((entry: { file: string }) => entry.file)).toEqual(['appkit-shift.patch', 'diff-parent-viewport.patch', 'list-scroll-snapshot.patch', 'dev-bundle-frame-limit.patch', 'list-scroll-snapshot-contract-fix.patch']);
    const list = manifest.patches[2];
    expect(list.sha256).toBe('a68c39e74ab98f2685b12464086796f644bceea5281a62180295feff5270e674');
    expect(list.files).toHaveLength(21);
    expect(new Set(list.files.map((file: PatchFile) => file.path)).size).toBe(21);
    const previous = new Map<string, string>();
    for (const entry of manifest.patches.slice(0, 2)) for (const file of entry.files) previous.set(file.path, file.afterSha256);
    for (const file of list.files) {
      if (previous.has(file.path)) expect(file.beforeSha256).toBe(previous.get(file.path));
      expect(typeof file.beforeExists).toBe('boolean');
    }
    const creates = list.files.filter((file: PatchFile) => file.beforeExists === false);
    expect(creates.map((file: PatchFile) => file.path)).toEqual([
      'crates/nsh-core/src/core/scroll_snapshot.rs',
      'crates/nsh-core/src/core/tests/list_scroll_snapshot.rs',
      'crates/nsh-testing/tests/testing/list-scroll-snapshot/App.test.tsx',
      'crates/nsh-testing/tests/testing/list-scroll-snapshot/App.tsx',
    ]);
    const text = await readFile(path.join(root, 'patches/nsh-0.4.0', list.file), 'utf8');
    expect(text).not.toMatch(/^(diff --git|index |rename |deleted file)/m);
    expect(text.match(/^--- \/dev\/null$/gm)).toHaveLength(4);
    for (const file of creates) {
      expect(file.beforeSha256).toBe(sha256(''));
      expect(text).toContain(`--- /dev/null\n+++ b/${file.path}\n@@ -0,0 +1,`);
    }
  });
  it('pins DevFrame to its frozen two-file nonoverlapping provenance and finite 64 MiB bound', async () => {
    const root = path.dirname(fileURLToPath(import.meta.url)), patches = path.join(root, 'patches/nsh-0.4.0');
    const manifest = JSON.parse(await readFile(path.join(patches, 'manifest.json'), 'utf8'));
    const ledger = JSON.parse(await readFile(path.join(patches, 'dev-bundle-frame-limit.hashes.json'), 'utf8'));
    const dev = manifest.patches[3];
    expect(dev.file).toBe('dev-bundle-frame-limit.patch');
    expect(dev.sha256).toBe('86eee6d37cd33a8c74a469a25e72b4a1114b2502f5867b20c1c0c1d3655946af');
    expect(dev.sha256).toBe(ledger.sha256);
    expect(manifest.source.sha256).toBe(ledger.baselineSourceSha256);
    expect(dev.files).toEqual(ledger.files.map((file: PatchFile & { afterExists: boolean }) => {
      expect(file.afterExists).toBe(true);
      return { path: file.path, beforeExists: file.beforeExists, beforeSha256: file.beforeSha256, afterSha256: file.afterSha256 };
    }));
    expect(dev.files.map((file: PatchFile) => file.path)).toEqual(['crates/nsh-dev/src/client.rs', 'crates/nsh-dev/tests/roundtrip.rs']);
    const preceding = new Set(manifest.patches.slice(0, 3).flatMap((entry: { files: PatchFile[] }) => entry.files.map(file => file.path)));
    for (const file of dev.files) { expect(file.beforeExists).toBe(true); expect(preceding.has(file.path)).toBe(false); }
    const text = await readFile(path.join(patches, dev.file), 'utf8');
    expect(sha256(text)).toBe(dev.sha256);
    expect(text).not.toMatch(/^(diff --git|index |--- \/dev\/null|\+\+\+ \/dev\/null|rename )/m);
    expect(text).toContain('WebSocketConfig::default().max_frame_size(Some(64 << 20))');
    expect(text).toContain('connect_with_config(url.as_str(), Some(config), 3)');
    expect(text).not.toContain('max_frame_size(None)');
  });
  it('pins the append-only List contract fix to its sanitized three-file ledger without changing List or DevFrame', async () => {
    const root = path.dirname(fileURLToPath(import.meta.url)), patches = path.join(root, 'patches/nsh-0.4.0');
    const manifest = JSON.parse(await readFile(path.join(patches, 'manifest.json'), 'utf8'));
    const ledgerText = await readFile(path.join(patches, 'list-scroll-snapshot-contract-fix.hashes.json'), 'utf8');
    const ledger = JSON.parse(ledgerText), fix = manifest.patches[4];
    expect(fix.file).toBe('list-scroll-snapshot-contract-fix.patch');
    expect(fix.sha256).toBe('5e83490bd17df64e1d1206b50da823468639bbaac772c1379a6db25eb510f887');
    expect(fix.sha256).toBe(ledger.sha256);
    expect(fix.files).toEqual(ledger.files);
    expect(ledger.basePreparationDigest).toBe('8a261f52b450ac75cc77225f2751bda1dc59097dd1e48ac5677f67d3ad77ff25');
    expect(ledger.baselineSourceSha256).toBe(manifest.source.sha256);
    expect(ledger.cargoLockSha256).toBe(manifest.source.files.find((file: { path: string }) => file.path === 'Cargo.lock').sha256);
    expect(Object.keys(ledger).sort()).toEqual(['schemaVersion', 'version', 'revision', 'file', 'sha256', 'cargoLockSha256', 'basePreparationDigest', 'baselineSourceSha256', 'files'].sort());
    expect(ledgerText).not.toMatch(/\/Users\/|[A-Za-z]:\\|\.scratch\//);
    expect(fix.files.map((file: PatchFile) => file.path)).toEqual(['crates/nsh-core/src/js/host.rs', 'crates/nsh-core/src/js/mod.rs', 'crates/nsh-core/unitless.txt']);
    const preceding = new Set(manifest.patches.slice(0, 4).flatMap((entry: { files: PatchFile[] }) => entry.files.map(file => file.path)));
    for (const file of fix.files) { expect(file.beforeExists).toBe(true); expect(preceding.has(file.path)).toBe(false); }
    const text = await readFile(path.join(patches, fix.file), 'utf8');
    expect(sha256(text)).toBe(fix.sha256);
    expect(text).not.toMatch(/^(diff --git|index |--- \/dev\/null|\+\+\+ \/dev\/null|rename )/m);
    expect(text.split('\n').filter(line => line.startsWith('-') && !line.startsWith('---'))).toHaveLength(0);
    expect(text.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++'))).toHaveLength(4);
    expect(text).toContain('+    EventKind::ScrollSnapshot,');
    expect(text).toContain('+            "onScrollSnapshot?",');
    expect(text).toContain('dimensionless zoom scale factor (zoomed extent / unzoomed extent), as ScrollEvent.zoom_scale');
  });
});
