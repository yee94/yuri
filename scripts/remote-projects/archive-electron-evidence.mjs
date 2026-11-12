import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const runFile = path.resolve(process.argv[2]);
const runs = JSON.parse(fs.readFileSync(runFile, 'utf8'));
const out = path.join(path.dirname(runFile), 'artifacts');
const manifest = [];
for (const run of runs.runs) {
  const root = path.join(runs.isolatedRoot, `cold-${run.index}`);
  if (!fs.existsSync(root)) throw new Error(`Raw temporary evidence lost: cold-${run.index}`);
  const destination = path.join(out, `cold-${run.index}`);
  fs.mkdirSync(destination, { recursive: true });
  for (const name of fs.readdirSync(root)) {
    // Do not copy profiles, credential-bearing service config, databases or settings.
    if (!/^(sidebar|transcript)\.png$|^input-[a-z-]+\.json$/.test(name)) continue;
    const raw = fs.readFileSync(path.join(root, name));
    const archived = path.join(destination, name + (name === 'input-trace.json' ? '.gz' : ''));
    fs.writeFileSync(archived, name === 'input-trace.json' ? gzipSync(raw) : raw);
    manifest.push({ original: path.join(root, name), archived: path.relative(path.dirname(runFile), archived), rawBytes: raw.length, rawSha256: createHash('sha256').update(raw).digest('hex') });
  }
}
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ files: manifest.length, manifest: path.join(out, 'manifest.json') }));
