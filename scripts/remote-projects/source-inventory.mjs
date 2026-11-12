import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

export function trackedPathsFromIndex(bytes) {
  if (bytes.length < 32 || bytes.toString('ascii', 0, 4) !== 'DIRC') throw new Error('Invalid source index');
  const version = bytes.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`Unsupported source index version ${version}; refusing incomplete snapshot`);
  const end = bytes.length - 20;
  if (!createHash('sha1').update(bytes.subarray(0, end)).digest().equals(bytes.subarray(end))) throw new Error('Source index checksum mismatch');
  const count = bytes.readUInt32BE(8), files = [];
  let offset = 12;
  for (let entry = 0; entry < count; entry++) {
    const start = offset;
    if (offset + 62 > end) throw new Error('Truncated source index entry');
    const flags = bytes.readUInt16BE(offset + 60);
    offset += 62;
    if (flags & 0x4000) {
      if (version < 3 || offset + 2 > end) throw new Error('Unsupported source index flags');
      offset += 2;
    }
    const terminator = bytes.indexOf(0, offset);
    if (terminator < offset || terminator >= end) throw new Error('Unterminated source index path');
    const file = bytes.toString('utf8', offset, terminator);
    if (!file || path.isAbsolute(file) || file.split('/').some(part => part === '..')) throw new Error('Unsafe source index path');
    const length = flags & 0xfff;
    if (length !== 0xfff && terminator - offset !== length) throw new Error('Source index path length mismatch');
    files.push(file);
    offset = start + Math.ceil((terminator + 1 - start) / 8) * 8;
    if (offset > end) throw new Error('Truncated source index padding');
  }
  while (offset < end) {
    if (offset + 8 > end) throw new Error('Truncated source index extension');
    const name = bytes.toString('ascii', offset, offset + 4), length = bytes.readUInt32BE(offset + 4);
    if (name === 'link' || name === 'sdir') throw new Error('Split/sparse source index requires explicit inventory support');
    offset += 8 + length;
    if (offset > end) throw new Error('Truncated source index extension data');
  }
  return [...new Set(files)].sort();
}

export function listSnapshotSource(root) {
  const marker = path.join(root, '.git');
  const gitDirectory = fs.statSync(marker).isDirectory() ? marker : (() => {
    const contents = fs.readFileSync(marker, 'utf8').trim();
    if (!contents.startsWith('gitdir: ')) throw new Error('Unsupported repository metadata');
    return path.resolve(root, contents.slice(8));
  })();
  const tracked = trackedPathsFromIndex(fs.readFileSync(path.join(gitDirectory, 'index')));
  const unignored = spawnSync('rg', ['--files', '--hidden', '--null', '-g', '!.git'], { cwd: root, encoding: 'utf8', maxBuffer: 30000000 });
  if (unignored.error || (unignored.status !== 0 && unignored.status !== 1)) throw new Error('Cannot inventory nonignored source');
  return [...new Set([...tracked, ...unignored.stdout.split('\0').filter(Boolean)])].sort();
}
