import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const evidence = path.resolve(process.env.REMOTE_PROJECTS_CANDIDATE_EVIDENCE ?? '.scratch/remote-projects/performance/candidate');
const snapshot = JSON.parse(fs.readFileSync(path.join(evidence, 'source-manifest.json'), 'utf8'));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'DEVELOPER_DIR'].includes(key)));
const record = { sourceHash: snapshot.sourceHash, classification: 'diagnostic', repo: snapshot.repo, stages: [] };
for (const [command, args] of [
  ['bun', ['install', '--frozen-lockfile', '--backend=copyfile']],
  ['bun', ['run', 'build:web']],
  ['bun', ['run', '--cwd', 'packages/electron', 'rebuild:native']],
]) {
  const startedAt = Date.now();
  console.log(JSON.stringify({ command, args, cwd: snapshot.repo, startedAt }));
  const result = spawnSync(command, args, { env, cwd: snapshot.repo, stdio: 'inherit', timeout: 900000 });
  record.stages.push({ command, args, startedAt, completedAt: Date.now(), exitCode: result.status, error: result.error?.message });
  fs.writeFileSync(path.join(evidence, 'build.json'), JSON.stringify(record, null, 2));
  if (result.status !== 0) { process.exitCode = 2; break; }
}
if (!process.exitCode) {
  // Same resource destination as owning build-web-assets, copying this exact
  // already-built bundle without rebuilding or touching another saved bundle.
  fs.cpSync(path.join(snapshot.repo, 'packages/web/dist'), path.join(snapshot.repo, 'packages/electron/resources/web-dist'), { recursive: true });
  record.electronAssetsStaged = true;
  record.webIndexSha256 = createHash('sha256').update(fs.readFileSync(path.join(snapshot.repo, 'packages/web/dist/index.html'))).digest('hex');
  record.status = 'built-with-independent-electron-native-abi';
  fs.writeFileSync(path.join(evidence, 'build.json'), JSON.stringify(record, null, 2));
}
