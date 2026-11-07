import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Script } from 'node:vm';

/** Optional build-owner hook. Local installed files only; no build, npm, fetch,
 * shell or process execution. Caller supplies the application's Resources dir. */
export async function stageTerminalOfflineResources(resourcesDirectory, repositoryRoot) {
  const dependency = path.join(repositoryRoot, 'node_modules/ghostty-web');
  const pkg = JSON.parse(await readFile(path.join(dependency, 'package.json'), 'utf8'));
  if (pkg.name !== 'ghostty-web' || pkg.version !== '0.4.0') throw new Error('terminal_offline_version_mismatch');
  const definitions = [
    ['dist/ghostty-web.umd.cjs', 'terminal-ghostty.js'],
    ['ghostty-vt.wasm', 'terminal-ghostty.wasm'],
    ['LICENSE', 'terminal-ghostty-LICENSE.txt'],
  ];
  const files = await Promise.all(definitions.map(async ([source, output]) => ({ source, output, bytes: await readFile(path.join(dependency, source)) })));
  if (files[0].bytes.length > 4_000_000 || files[1].bytes.length > 1_500_000 || !files[1].bytes.subarray(0, 4).equals(Buffer.from([0, 97, 115, 109])) || !files[2].bytes.length) throw new Error('terminal_offline_invalid');
  new Script(files[0].bytes.toString('utf8')); // Parse only: no terminal/WASM engine runs.
  const manifest = { schema: 1, package: pkg.name, version: pkg.version, files: files.map(file => ({ source: `ghostty-web/${file.source}`, output: file.output, bytes: file.bytes.length, sha256: createHash('sha256').update(file.bytes).digest('hex') })) };
  await mkdir(resourcesDirectory, { recursive: true });
  for (const file of [...files, { output: 'terminal-ghostty-manifest.json', bytes: Buffer.from(JSON.stringify(manifest, null, 2) + '\n') }]) {
    const destination = path.join(resourcesDirectory, file.output), temporary = destination + '.terminal-stage';
    await writeFile(temporary, file.bytes); await rename(temporary, destination);
  }
  return manifest;
}
