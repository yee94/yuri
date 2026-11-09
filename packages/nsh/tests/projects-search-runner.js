import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Own app config, Host bundle and Storage namespace; no production capability changes. */
export function withProjectsSearchFixture(root, run) {
  const parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(path.join(parent, 'nsh-projects-search-'));
  try {
    const host = path.join(directory, 'host.js'), entry = 'App.tsx';
    writeFileSync(path.join(directory, 'nsh.json'), JSON.stringify({
      name: 'Search fixture', id: 'example.yuri.search-fixture', version: '0.1.0', build: 1,
      theme: path.join(root, 'theme.json'), capabilities: { host: ['connection.list', 'runtime.request', 'projectsSearch.fixture.audit'] },
    }));
    writeFileSync(path.join(directory, entry), `import ${JSON.stringify(path.join(root, 'projects-search-fixture.tsx'))};\n`);
    const build = spawnSync('bun', ['build', 'tests/projects-search-host.js', '--target=browser', '--format=esm', '--outfile', host], { cwd: root, encoding: 'utf8', timeout: 30_000 });
    if (build.error) throw build.error;
    if (build.status !== 0) throw new Error('Search fixture Host bundle failed: ' + build.stdout + build.stderr);
    return run({ directory, entry, host });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
