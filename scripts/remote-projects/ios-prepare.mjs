import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const evidence = path.resolve(process.env.REMOTE_PROJECTS_IOS_EVIDENCE ?? '.scratch/remote-projects/performance/ios-baseline');
fs.mkdirSync(evidence, { recursive: true });
const candidate = process.env.REMOTE_PROJECTS_IOS_SOURCE ? JSON.parse(fs.readFileSync(process.env.REMOTE_PROJECTS_IOS_SOURCE, 'utf8')) : null;
const baseline = candidate ? { directory: candidate.repo, commit: candidate.sourceHash } : JSON.parse(fs.readFileSync('.scratch/remote-projects/performance/baseline-environment.json', 'utf8'));
const temporary = path.join(process.env.TMPDIR ?? os.tmpdir(), 'opencode');
const root = fs.mkdtempSync(path.join(temporary, 'remote-projects-ios-'));
const repo = path.join(root, 'repo');
const skip = new Set(['node_modules', '.git', '.scratch', 'Pods', 'dist', 'dist-bundle', 'build']);
fs.cpSync(baseline.directory, repo, { recursive: true, filter: source => !skip.has(path.basename(source)) });
const linkDependencies = directory => {
  const original = path.join(baseline.directory, path.relative(repo, directory), 'node_modules');
  if (fs.existsSync(original)) fs.symlinkSync(original, path.join(directory, 'node_modules'), 'dir');
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) if (item.isDirectory() && item.name !== 'node_modules') linkDependencies(path.join(directory, item.name));
};
linkDependencies(repo);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'SHELL', 'USER', 'LOGNAME'].includes(key)));
env.DEVELOPER_DIR = '/Applications/Xcode.app/Contents/Developer';
const run = args => {
  const result = spawnSync('xcrun', args, { env, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`xcrun ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
};
const before = JSON.parse(run(['simctl', 'list', 'devices', 'booted', '--json']));
fs.writeFileSync(path.join(evidence, 'devices-before.json'), JSON.stringify(before, null, 2));
const deviceName = `Yuri Remote Projects Perf ${Date.now()}`;
const runtime = 'com.apple.CoreSimulator.SimRuntime.iOS-26-5';
const udid = run(['simctl', 'create', deviceName, 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro', runtime]);
const originalPodfile = fs.readFileSync(path.join(repo, 'packages/mobile/ios/App/Podfile'));
const record = { schemaVersion: 1, classification: 'diagnostic', baselineCommit: baseline.commit, root, repo, udid, deviceName, runtime,
  ...(candidate ? { phase: 'candidate', sourceHash: candidate.sourceHash, hubRepo: candidate.repo } : {}),
  bundleId: 'com.yee94.yuri', derivedData: path.join(root, 'DerivedData'), developerDir: env.DEVELOPER_DIR,
  podfileSha256: createHash('sha256').update(originalPodfile).digest('hex'),
  originalWebIndexSha256: createHash('sha256').update(fs.readFileSync(path.join(baseline.directory, 'packages/web/dist/index.html'))).digest('hex'),
  dependencies: `Read-only links to independently installed frozen ${candidate ? 'candidate snapshot' : 'HEAD'} dependencies. Native source/build/Pods/DerivedData are separate copies.`,
  stages: [] };
fs.writeFileSync(path.join(evidence, 'workspace.json'), JSON.stringify(record, null, 2) + '\n');
fs.writeFileSync(path.join(evidence, 'Podfile.original'), originalPodfile);
console.log(JSON.stringify(record, null, 2));
