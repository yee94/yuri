import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installPinnedOpenCode2Cli } from '../../server/lib/opencode/ensure-cli.js';
import { createOpenCodeUpdateDiscovery } from '../../server/lib/opencode/update-discovery.js';
import { isOpenCode2VersionAtLeast } from '../../server/lib/opencode/opencode2-pin.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '../..');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} exited with ${result.status}`);
}

async function installedDependency(name, from) {
  for (let directory = from; ; directory = path.dirname(directory)) {
    const candidate = path.join(directory, 'node_modules', name);
    try { return await fs.realpath(candidate); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (path.dirname(directory) === directory) return null;
  }
}

// Preserve the installed, lockfile-resolved dependency graph, including duplicate
// versions, optional native packages, runtime assets and worker entrypoints.
export async function copyProductionDependencies(source, destination) {
  const copies = new Map();
  async function linkDependency(name, from, into, optional) {
    const resolved = await installedDependency(name, from);
    if (!resolved) {
      if (optional) return;
      throw new Error(`Missing production dependency ${name} of ${from}`);
    }
    let target = copies.get(resolved);
    if (!target) {
      const pkg = JSON.parse(await fs.readFile(path.join(resolved, 'package.json'), 'utf8'));
      target = path.join(destination, 'node_modules/.yuri-packages', String(copies.size), 'node_modules', pkg.name);
      copies.set(resolved, target);
      await fs.cp(resolved, target, {
        recursive: true, verbatimSymlinks: true,
        filter: (file) => file === resolved || !path.relative(resolved, file).split(path.sep).includes('node_modules'),
      });
      await dependencies(pkg, resolved, target);
    }
    const link = path.join(into, 'node_modules', name);
    await fs.mkdir(path.dirname(link), { recursive: true });
    await fs.symlink(path.relative(path.dirname(link), target), link);
  }
  async function dependencies(pkg, from, into) {
    const names = { ...pkg.peerDependencies, ...pkg.dependencies, ...pkg.optionalDependencies };
    for (const name of Object.keys(names).sort()) {
      const optional = Object.hasOwn(pkg.optionalDependencies ?? {}, name)
        || (!Object.hasOwn(pkg.dependencies ?? {}, name) && pkg.peerDependenciesMeta?.[name]?.optional === true);
      await linkDependency(name, from, into, optional);
    }
  }
  const pkg = JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8'));
  await dependencies(pkg, source, destination);
}

export async function assertContainedSymlinks(root) {
  root = await fs.realpath(root);
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const link = await fs.readlink(file);
        const resolved = await fs.realpath(file);
        const relative = path.relative(root, resolved);
        if (path.isAbsolute(link) || relative.startsWith(`..${path.sep}`) || relative === '..') {
          throw new Error(`Non-portable symlink: ${path.relative(root, file)}`);
        }
      } else if (entry.isDirectory()) await visit(file);
    }
  }
  await visit(root);
}

async function main() {
  if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch)
    || !process.report.getReport().header.glibcVersionRuntime || process.versions.node.split('.')[0] !== '24') {
    throw new Error('Build portable packages natively on glibc Linux x64/arm64 using Node 24');
  }
  const output = path.resolve(process.argv.slice(2).find((arg) => arg !== '--') || path.join(webRoot, 'portable-dist'));
  await fs.mkdir(output, { recursive: true });
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'yuri-portable-build-'));
  try {
    const root = path.join(temporary, 'yuri');
    const lib = path.join(root, 'lib');
    await fs.mkdir(path.join(root, 'runtime'), { recursive: true });
    await fs.copyFile(process.execPath, path.join(root, 'runtime/node'));
    await fs.chmod(path.join(root, 'runtime/node'), 0o755);
    await fs.mkdir(path.join(root, 'runtime/lib'));
    for (const library of ['libstdc++.so.6', 'libgcc_s.so.1', 'libgomp.so.1', 'libatomic.so.1']) {
      const resolved = spawnSync('gcc', [`-print-file-name=${library}`], { encoding: 'utf8' });
      if (resolved.status !== 0 || !path.isAbsolute(resolved.stdout.trim())) throw new Error(`Cannot locate ${library}`);
      await fs.copyFile(await fs.realpath(resolved.stdout.trim()), path.join(root, 'runtime/lib', library));
    }
    await fs.copyFile('/usr/share/doc/libstdc++6/copyright', path.join(root, 'runtime/GCC-COPYRIGHT'));
    const license = await fetch(`https://raw.githubusercontent.com/nodejs/node/v${process.versions.node}/LICENSE`, { signal: AbortSignal.timeout(30000) });
    if (!license.ok) throw new Error('Cannot fetch the bundled Node license');
    await fs.writeFile(path.join(root, 'runtime/NODE-LICENSE'), await license.text());
    const pkg = JSON.parse(await fs.readFile(path.join(webRoot, 'package.json'), 'utf8'));
    for (const file of pkg.files) {
      await fs.cp(path.join(webRoot, file), path.join(lib, file), {
        recursive: true,
        filter: (source) => !/\.(?:test|spec)\./.test(source),
      });
    }
    await copyProductionDependencies(webRoot, lib);
    const version = process.env.YURI_OPENCODE2_VERSION || await createOpenCodeUpdateDiscovery()();
    if (!isOpenCode2VersionAtLeast(version)) throw new Error('Bundled OpenCode is below the supported version floor');
    const binary = await installPinnedOpenCode2Cli({ version, dataDir: path.join(temporary, 'opencode') });
    await fs.mkdir(path.join(root, 'bin'));
    await fs.copyFile(binary, path.join(root, 'bin/opencode'));
    await fs.chmod(path.join(root, 'bin/opencode'), 0o755);
    await fs.copyFile(path.join(here, 'launcher.sh'), path.join(root, 'yuri'));
    await fs.chmod(path.join(root, 'yuri'), 0o755);
    await fs.copyFile(path.join(here, 'verify.mjs'), path.join(root, 'verify.mjs'));
    await fs.copyFile(path.join(webRoot, 'bin/install-portable.sh'), path.join(root, 'install.sh'));
    await fs.copyFile(path.resolve(webRoot, '../../LICENSE'), path.join(root, 'LICENSE'));
    await fs.writeFile(path.join(root, 'portable.json'), JSON.stringify({
      format: 1, version: pkg.version, platform: process.platform, arch: process.arch,
      nodeVersion: process.versions.node, nodeAbi: process.versions.modules, opencodeVersion: version,
    }, null, 2));
    await assertContainedSymlinks(root);
    run(path.join(root, 'runtime/node'), [path.join(root, 'verify.mjs'), pkg.version], {
      env: { ...process.env, LD_LIBRARY_PATH: path.join(root, 'runtime/lib') },
    });
    const name = `yuri-${pkg.version}-linux-${process.arch}.tar.gz`;
    run('tar', ['-czf', path.join(output, name), '-C', temporary, 'yuri']);
    const digest = createHash('sha256').update(await fs.readFile(path.join(output, name))).digest('hex');
    await fs.writeFile(path.join(output, `${name}.sha256`), `${digest}  ${name}\n`);
    console.log(path.join(output, name));
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
