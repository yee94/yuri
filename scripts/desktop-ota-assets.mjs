import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createAssetZip } from '../packages/web/server/lib/zip-assets.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { parse } = createRequire(new URL('../packages/web/package.json', import.meta.url))('jsonc-parser');

// Keep the legacy hash bytes for UI-only lock changes; never substitute any
// installer-owned resolution. All non-UI workspaces are protected conservatively.
export function desktopFingerprintLockfile(currentText, baselineText) {
  const decode = (text) => {
    const errors = [];
    const lock = parse(text, errors, { allowTrailingComma: true });
    if (errors.length || !lock?.packages || !lock?.workspaces) throw new Error('Invalid Bun lockfile');
    return lock;
  };
  const current = decode(currentText), baseline = decode(baselineText);
  const header = ({ packages: _packages, workspaces: _workspaces, ...rest }) => JSON.stringify(rest);
  if (header(current) !== header(baseline)) return currentText;
  const ownership = (lock) => {
    const byName = new Map();
    for (const [key, entry] of Object.entries(lock.packages)) {
      const name = entry[0]?.match(/^(@[^/]+\/[^@]+|[^@]+)@/)?.[1];
      if (!name) throw new Error(`Invalid Bun package resolution: ${key}`);
      const alias = key.match(/(?:^|\/)(@[^/]+\/[^/]+|[^/]+)$/)?.[1];
      for (const label of new Set([name, alias])) {
        const keys = byName.get(label) ?? [];
        keys.push(key);
        byName.set(label, keys);
      }
    }
    const dependencies = (pkg) => Object.keys({ ...pkg?.dependencies, ...pkg?.devDependencies, ...pkg?.optionalDependencies, ...pkg?.peerDependencies });
    const reachable = (names) => {
      const keys = new Set(), seen = new Set(), pending = [...names];
      while (pending.length) {
        const name = pending.pop();
        if (seen.has(name)) continue;
        seen.add(name);
        for (const key of byName.get(name) ?? []) {
          keys.add(key);
          pending.push(...dependencies(lock.packages[key][2]));
        }
      }
      return keys;
    };
    return {
      ui: reachable(dependencies(lock.workspaces['packages/ui'])),
      protected: reachable(Object.entries(lock.workspaces).filter(([directory]) => directory !== 'packages/ui').flatMap(([, pkg]) => dependencies(pkg))),
    };
  };
  const before = ownership(baseline), after = ownership(current);
  for (const key of new Set([...Object.keys(baseline.packages), ...Object.keys(current.packages)])) {
    if (JSON.stringify(current.packages[key]) === JSON.stringify(baseline.packages[key])) continue;
    if (before.protected.has(key) || after.protected.has(key) || (!before.ui.has(key) && !after.ui.has(key))) return currentText;
  }
  return baselineText;
}

// The fingerprint covers executable shell sources and dependency locks,
// independent of build host, generated resources and the marketing version.
export async function desktopShellFingerprint() {
  const hash = createHash('sha256');
  async function visit(relative) {
    for (const entry of (await readdir(path.join(root, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const name = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!['node_modules', 'dist', 'dist-bundle', 'resources', 'scripts'].includes(entry.name)) await visit(name);
      } else if (/\.(?:m?js|cjs|json)$/.test(name) && !/\.(?:test|spec)\./.test(name) && entry.name !== 'package.json') {
        hash.update(name).update(await readFile(path.join(root, name)));
      }
    }
  }
  await visit('packages/electron');
  await visit('packages/web/server/lib/config-sync');
  await visit('packages/web/server/lib/dictation/local');
  for (const name of ['packages/web/server/lib/zip-assets.js', 'packages/web/server/lib/opencode/path-utils.js', 'packages/web/server/lib/dictation/audio.js']) {
    hash.update(name).update(await readFile(path.join(root, name)));
  }
  for (const name of ['package.json', 'packages/electron/package.json', 'packages/web/package.json']) {
    const pkg = JSON.parse(await readFile(path.join(root, name), 'utf8'));
    hash.update(name).update(JSON.stringify({ dependencies: pkg.dependencies, devDependencies: pkg.devDependencies, build: pkg.build }));
  }
  for (const name of ['deploy/update-service/lib/semver.js', 'packages/electron/scripts/bundle-main.mjs']) {
    hash.update(name).update(await readFile(path.join(root, name)));
  }
  let lockfile = await readFile(path.join(root, 'bun.lock'), 'utf8');
  const { baseTag } = JSON.parse(execFileSync(process.execPath, ['scripts/mobile-release-plan.mjs', '--json'], { cwd: root, encoding: 'utf8' }));
  if (baseTag) {
    const baseline = execFileSync('git', ['show', `${baseTag}:bun.lock`], { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    lockfile = desktopFingerprintLockfile(lockfile, baseline);
  }
  // Workspace marketing versions change on every release. Only pinned package
  // resolutions belong in the native fingerprint; declarations are hashed above.
  const packagesOffset = lockfile.indexOf('\n  "packages": {');
  if (packagesOffset < 0) throw new Error('Unsupported Bun lockfile: missing package resolutions');
  hash.update(lockfile.slice(packagesOffset));
  return hash.digest('hex');
}

export async function writeDesktopAssetMetadata(directory) {
  const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const backend = path.join(directory, 'desktop-backend');
  await rm(backend, { recursive: true, force: true });
  await mkdir(backend, { recursive: true });
  for (const directory of ['server', 'shared']) {
    await cp(path.join(root, 'packages/web', directory), path.join(backend, directory), {
      recursive: true,
      filter: (source) => !/\.(?:test|spec)\./.test(source),
    });
  }
  await cp(path.join(root, 'packages/web/package.json'), path.join(backend, 'package.json'));
  const metadata = { applicationId: 'dev.yuri.desktop', shellApiVersion: 2, releaseVersion: version, backendVersion: version, shellFingerprint: await desktopShellFingerprint() };
  await writeFile(path.join(directory, 'desktop-ota.json'), JSON.stringify(metadata));
  return metadata;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const directory = path.join(root, 'packages/web/dist');
  await writeDesktopAssetMetadata(directory);
  createAssetZip(directory, path.resolve(process.argv[2] ?? 'desktop-ota.zip'));
}
