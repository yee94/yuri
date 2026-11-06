import fs from 'node:fs/promises';
import path from 'node:path';
import { fail } from './events.js';

export async function resolveImportDirectory(value, allowMissing = false) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.length > 4096) fail('invalid_target');
  const directory = path.resolve(value);
  try {
    const real = await fs.realpath(directory);
    if (!(await fs.stat(real)).isDirectory()) fail('invalid_target');
    return real;
  } catch (error) {
    if (!allowMissing || error.code !== 'ENOENT') throw error;
    const parent = path.dirname(directory);
    if (parent === directory) throw error;
    return path.join(await resolveImportDirectory(parent, true), path.basename(directory));
  }
}

export async function ensureImportDirectory(directory) {
  if (await resolveImportDirectory(directory, true) !== directory) fail('target_changed');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (await resolveImportDirectory(directory) !== directory) fail('target_changed');
}
