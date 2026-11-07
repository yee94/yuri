import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** One standalone Host, app config and Storage namespace per case; never changes production capabilities. */
export function withProjectSettingsFixture(root, run) {
  const parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(path.join(parent, 'nsh-project-settings-'));
  try {
    const host = path.join(directory, 'host.js'), entry = 'App.tsx';
    writeFileSync(path.join(directory, 'nsh.json'), JSON.stringify({
      name: 'Project settings fixture', id: 'example.yuri.project-settings', version: '0.1.0', build: 1,
      theme: path.join(root, 'theme.json'),
      capabilities: { host: ['runtime.request', 'projectSettings.fixture.audit'] },
    }));
    writeFileSync(path.join(directory, entry), `import ${JSON.stringify(path.join(root, 'project-settings-fixture.tsx'))};\n`);
    const build = spawnSync('bun', ['build', 'tests/project-settings-host.js', '--target=browser', '--format=esm', '--outfile', host], { cwd: root, encoding: 'utf8', timeout: 30_000 });
    if (build.error) throw build.error;
    if (build.status !== 0) throw new Error('Project settings fixture Host bundle failed: ' + build.stdout + build.stderr);
    return run({ directory, entry, host });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
