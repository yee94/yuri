import fs from 'node:fs/promises';
import path from 'node:path';

const ICON_MAX_LENGTH = 3 << 19;

/**
 * A package's own picture from the top-level package.json `icon`:
 * an https URL or a data:image URI, at most ~1.5 MB. Anything else is dropped.
 * Nothing is fetched here; the client renders it as an image.
 *
 * @param {unknown} value
 * @returns {string | undefined}
 */
export function sanitizePluginIcon(value) {
  const icon = typeof value === 'string' ? value.trim() : '';
  return icon.length > 0 && icon.length <= ICON_MAX_LENGTH && /^(https:\/\/|data:image\/)/i.test(icon)
    ? icon
    : undefined;
}

/** Read the nearest package manifest for a local package directory or entry file. */
export async function readLocalPluginIcon(absolutePath) {
  try {
    const stat = await fs.stat(absolutePath);
    let directory = stat.isDirectory() ? absolutePath : path.dirname(absolutePath);
    for (let depth = 0; depth < 32; depth++) {
      const manifest = path.join(directory, 'package.json');
      try {
        const metadata = await fs.stat(manifest);
        if (!metadata.isFile() || metadata.size > 2 * 1024 * 1024) return undefined;
        return sanitizePluginIcon(JSON.parse(await fs.readFile(manifest, 'utf8')).icon);
      } catch (error) {
        if (error?.code !== 'ENOENT') return undefined;
      }
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  } catch {
    // Optional artwork must not change the plugin path's load status.
  }
  return undefined;
}
