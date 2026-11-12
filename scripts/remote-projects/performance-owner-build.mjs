import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const evidence = path.resolve(process.argv[2]);
const donor = fs.realpathSync(process.argv[3]);
const manifest = JSON.parse(fs.readFileSync(path.join(evidence, 'source-manifest.json'), 'utf8'));
const repo = fs.realpathSync(manifest.repo);
if (repo === donor) throw new Error('Build target must be a new independent frozen workspace');
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const record = { sourceHash: manifest.sourceHash, repo, donor, stages: [], installedDependencies: false,
  rebuiltNativeModules: false, classification: 'production-assets build; no runtime budget claim', startedAt: new Date().toISOString() };
const save = () => fs.writeFileSync(path.join(evidence, 'owner-build.json'), JSON.stringify(record, null, 2));
const contracts = manifest.files.filter(file => file.file === 'bun.lock' || file.file === 'package.json' || /^packages\/[^/]+\/package.json$/.test(file.file));
record.contracts = contracts.map(file => ({ path: file.file, expected: file.sha256, donor: hash(path.join(donor, file.file)) }));
if (record.contracts.some(file => file.expected !== file.donor)) { save(); throw new Error('Dependency donor package/lock contract differs'); }
const workspaces = new Map(contracts.filter(file => file.file.startsWith('packages/')).map(file => {
  const directory = path.dirname(file.file); const pkg = JSON.parse(fs.readFileSync(path.join(repo, file.file), 'utf8'));
  return [pkg.name, directory];
}));
record.overlays = [];
const link = (from, to) => { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.symlinkSync(from, to); };
for (const relative of ['node_modules', ...[...workspaces.values()].map(directory => `${directory}/node_modules`)]) {
  const source = path.join(donor, relative); const target = path.join(repo, relative);
  if (!fs.existsSync(source)) continue;
  if (fs.existsSync(target)) throw new Error(`Refusing to overwrite dependencies: ${relative}`);
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source)) {
    const scoped = entry.startsWith('@');
    const names = scoped ? fs.readdirSync(path.join(source, entry)).map(name => `${entry}/${name}`) : [entry];
    for (const name of names) {
      const workspace = workspaces.get(name);
      link(workspace ? path.join(repo, workspace) : fs.realpathSync(path.join(source, name)), path.join(target, name));
    }
  }
  record.overlays.push(relative);
}
const require = createRequire(path.join(repo, 'packages/electron/package.json'));
record.actualBackend = fs.realpathSync(require.resolve('@yuriai/web/server/index.js'));
record.actualElectron = fs.realpathSync(require.resolve('electron/package.json'));
if (record.actualBackend !== path.join(repo, 'packages/web/server/index.js')) { save(); throw new Error('Actual backend resolved outside frozen workspace'); }
record.backgroundTmux = spawnSync('tmux', ['list-windows', '-a', '-F', '#{window_id} #S:#W #{pane_current_command}'], { encoding: 'utf8' }).stdout;
save();
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'DEVELOPER_DIR'].includes(key)));
for (const [command, args] of [['bun', ['run', '--cwd', 'packages/electron', 'build:web-assets']], ['bun', ['run', '--cwd', 'packages/electron', 'bundle:main']]]) {
  const index = record.stages.length; const log = fs.openSync(path.join(evidence, `owner-build-${index}.log`), 'wx');
  const startedAt = Date.now();
  const result = spawnSync(command, args, { cwd: repo, env, stdio: ['ignore', log, log], timeout: 900000 });
  fs.closeSync(log);
  record.stages.push({ command, args, startedAt, completedAt: Date.now(), exitCode: result.status, error: result.error?.message }); save();
  if (result.status !== 0) { process.exitCode = 1; break; }
}
record.sourceDrift = manifest.files.filter(file => {
  const filename = path.join(repo, file.file);
  if (!fs.existsSync(filename)) return true;
  const actual = file.symlink ? createHash('sha256').update(fs.readlinkSync(filename)).digest('hex') : hash(filename);
  return actual !== file.sha256;
}).map(file => file.file);
record.status = !process.exitCode && !record.sourceDrift.length ? 'built' : 'blocked';
if (record.status === 'built') record.webIndexSha256 = hash(path.join(repo, 'packages/electron/resources/web-dist/index.html'));
record.completedAt = new Date().toISOString(); save();
if (record.status !== 'built') process.exitCode = 1;
console.log(JSON.stringify({ status: record.status, sourceHash: record.sourceHash, stages: record.stages, sourceDrift: record.sourceDrift }));
