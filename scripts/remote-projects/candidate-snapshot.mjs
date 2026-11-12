import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { listSnapshotSource } from './source-inventory.mjs';

const source = process.cwd();
const evidence = path.resolve(process.env.REMOTE_PROJECTS_CANDIDATE_EVIDENCE ?? '.scratch/remote-projects/performance/candidate');
if (fs.existsSync(path.join(evidence, 'source-manifest.json'))) throw new Error('Refusing to overwrite an existing candidate manifest; choose a new evidence directory');
fs.mkdirSync(evidence, { recursive: true });
const list = () => listSnapshotSource(source);
const excluded = file => file.split('/').some(part => /^(node_modules|\.git|\.scratch|scratch|Pods|DerivedData|\.config)$/.test(part) || /^\.env(?:\.|$)/.test(part))
  || /^(?:packages\/[^/]+\/)?(?:dist|dist-bundle|build)\//.test(file)
  || /(^|\/)(\.npmrc|\.netrc|auth\.json|credentials(?:\.(?:jsonc?|ya?ml|toml))?|settings\.local\.json|opencode\.jsonc?)$/i.test(file)
  || /\.(pem|p12|pfx|key|mobileprovision)$/i.test(file)
  || /(^|\/)(\.claude|\.opencode)\/(settings|config|auth)[^/]*\.jsonc?$/.test(file);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const startedAt = new Date().toISOString();
const inventory = list();
const temp = path.join(process.env.TMPDIR ?? os.tmpdir(), 'opencode');
fs.mkdirSync(temp, { recursive: true });
const root = fs.mkdtempSync(path.join(temp, 'remote-projects-candidate-'));
const repo = path.join(root, 'repo');
fs.mkdirSync(repo);
const files = [], skipped = [], changedDuringSnapshot = [];
for (const file of inventory) {
  if (excluded(file)) { skipped.push({ file, reason: 'excluded secret/config/generated/dependency path' }); continue; }
  const original = path.join(source, file);
  if (!fs.existsSync(original)) { skipped.push({ file, reason: 'tracked deletion or disappeared' }); continue; }
  const stat = fs.lstatSync(original);
  const target = path.join(repo, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (stat.isSymbolicLink()) {
    const link = fs.readlinkSync(original);
    if (path.isAbsolute(link) || !path.resolve(path.dirname(original), link).startsWith(source + path.sep)) {
      skipped.push({ file, reason: 'external symlink not copied' }); continue;
    }
    fs.symlinkSync(link, target);
    files.push({ file, sha256: hash(link), symlink: true });
  } else if (stat.isFile()) {
    const bytes = fs.readFileSync(original);
    fs.writeFileSync(target, bytes, { mode: stat.mode & 0o777 });
    files.push({ file, sha256: hash(bytes), bytes: bytes.length });
  }
}
for (const file of files) {
  try {
    const bytes = file.symlink ? fs.readlinkSync(path.join(source, file.file)) : fs.readFileSync(path.join(source, file.file));
    if (hash(bytes) !== file.sha256) changedDuringSnapshot.push(file.file);
  } catch { changedDuringSnapshot.push(file.file); }
}
const afterInventory = list().filter(f => !excluded(f));
const beforeInventory = inventory.filter(f => !excluded(f));
const sourceHash = hash(files.map(f => `${f.file}\0${f.sha256}\0`).join(''));
const record = { classification: 'candidate diagnostic snapshot, not final code', startedAt, completedAt: new Date().toISOString(), root, repo, sourceHash,
  inventory: 'read-only Git index v2/v3 + ripgrep ignore-aware hidden file inventory; no git command; working-file bytes, not HEAD archive',
  fileCount: files.length, changedDuringSnapshot, addedDuringSnapshot: afterInventory.filter(f => !beforeInventory.includes(f)), removedDuringSnapshot: beforeInventory.filter(f => !afterInventory.includes(f)), files, skipped };
fs.writeFileSync(path.join(evidence, 'source-manifest.json'), JSON.stringify(record, null, 2) + '\n');
console.log(JSON.stringify({ root, repo, sourceHash, fileCount: files.length, startedAt, completedAt: record.completedAt, changedDuringSnapshot }));
