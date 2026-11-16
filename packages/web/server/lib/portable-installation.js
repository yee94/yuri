import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function readPortableInstallation(packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')) {
  const root = path.dirname(packageRoot);
  const marker = path.join(root, 'portable.json');
  if (!fs.existsSync(marker)) return null;
  const manifest = JSON.parse(fs.readFileSync(marker, 'utf8'));
  const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  if (path.basename(packageRoot) !== 'lib' || manifest.format !== 1 || pkg.name !== '@yuriai/web'
    || manifest.version !== pkg.version || manifest.platform !== process.platform || manifest.arch !== process.arch) {
    throw new Error('Invalid Yuri portable installation; reinstall the matching Linux release');
  }
  let launcher = path.join(root, 'yuri');
  if (path.basename(path.dirname(root)) === 'versions') {
    const current = path.join(root, '../..', 'current');
    if (fs.existsSync(current) && fs.realpathSync(current) === fs.realpathSync(root)) {
      launcher = path.join(current, 'yuri');
    }
  }
  return { root, manifest, launcher };
}

export function portableUpdateError(root) {
  const quote = (value) => `'${value.replace(/'/g, "'\\''")}'`;
  const target = path.basename(path.dirname(root)) === 'versions'
    ? ` --install-dir ${quote(path.resolve(root, '../..'))} --no-link` : '';
  return new Error(
    `This is a self-contained Yuri installation, not an npm package. ` +
    `Stop its running servers, then run: bash ${quote(path.join(root, 'install.sh'))} --version <version>${target}. ` +
    'SSH-managed installations are updated when reconnecting from Yuri Desktop.'
  );
}
