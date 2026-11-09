import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Bundle the complete synthetic Host; isolate config and Storage from the production app. */
export function withProjectsNativeFixture(root, kind, run) {
  const sources = { home: ['projects-native.fixture.tsx', 'tests/projects-host.js'], outer: ['projects-outer.fixture.tsx', 'tests/projects-outer-host.js'], catalog: ['root-catalog-native.fixture.tsx', 'tests/root-catalog-host.js'], worktree: ['projects-worktree.fixture.tsx', 'tests/projects-worktree-host.js'] };
  if (!Object.prototype.hasOwnProperty.call(sources, kind)) throw new Error('Unknown Projects native fixture');
  const parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(path.join(parent, 'nsh-projects-native-'));
  try {
    const [source, hostSource] = sources[kind], host = path.join(directory, 'host.js'), entry = 'App.tsx';
    const build = spawnSync('bun', ['build', hostSource, '--target=browser', '--format=esm', '--outfile', host], { cwd: root, encoding: 'utf8', timeout: 30_000 });
    if (build.error) throw build.error;
    if (build.status !== 0) throw new Error('Projects native Host bundle failed: ' + build.stdout + build.stderr);
    writeFileSync(path.join(directory, 'nsh.json'), JSON.stringify({ name: 'Projects native fixture', id: `example.yuri.${path.basename(directory)}`, version: '0.1.0', build: 1, theme: path.join(root, 'theme.json'), capabilities: { host: ['connection.list', 'runtime.request'] } }));
    writeFileSync(path.join(directory, entry), `import ${JSON.stringify(path.join(root, source))};\n`);
    return run({ directory, entry, host });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
