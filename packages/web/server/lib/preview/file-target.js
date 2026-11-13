import fs from 'node:fs/promises';
import path from 'node:path';

const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};

export const createFileTarget = async (directory, filePath) => {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)
    || typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw Object.assign(new Error('Invalid file target'), { status: 400 });
  const [root, entry] = await Promise.all([fs.realpath(directory), fs.realpath(filePath)]);
  if (!inside(root, entry)) throw Object.assign(new Error('File outside project'), { status: 403 });
  if (!(await fs.stat(root)).isDirectory() || !(await fs.stat(entry)).isFile()
    || !/\.html?$/i.test(entry)) throw Object.assign(new Error('HTML file required'), { status: 400 });
  const entryPath = `/${path.relative(root, entry).split(path.sep).map(encodeURIComponent).join('/')}`;
  return { kind: 'file', root, entryPath };
};

/** Resolve every descendant again: a symlink added after registration grants no escape. */
export const resolveFileTargetResource = async (root, resourcePath) => {
  const decoded = decodeURIComponent(resourcePath);
  let candidate = path.resolve(root, `.${decoded}`);
  if (!inside(root, candidate)) throw Object.assign(new Error('File outside project'), { status: 403 });
  candidate = await fs.realpath(candidate);
  if (!inside(root, candidate)) throw Object.assign(new Error('File outside project'), { status: 403 });
  let stat = await fs.stat(candidate);
  if (stat.isDirectory()) {
    candidate = await fs.realpath(path.join(candidate, 'index.html'));
    if (!inside(root, candidate)) throw Object.assign(new Error('File outside project'), { status: 403 });
    stat = await fs.stat(candidate);
  }
  if (!stat.isFile()) throw Object.assign(new Error('File required'), { status: 400 });
  if (stat.size > 100 * 1024 * 1024) throw Object.assign(new Error('File too large'), { status: 413 });
  return candidate;
};

export const readFileTargetText = (file, signal) => fs.readFile(file, { encoding: 'utf8', signal });
