import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export function withProjectsParityFixture(root, run) {
  const parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(path.join(parent, 'nsh-projects-parity-'));
  try {
    const host = path.join(directory, 'host.js'), entry = 'App.tsx';
    // Bundle first. The exact audit grant exists only in this isolated test app.
    const build = spawnSync('bun', ['build', 'projects-parity-host.js', '--target=browser', '--format=esm', '--outfile', host], { cwd: root, encoding: 'utf8', timeout: 30_000 });
    if (build.error) throw build.error;
    if (build.status !== 0) throw new Error('Projects Host bundle failed: ' + build.stdout + build.stderr);
    writeFileSync(path.join(directory, 'nsh.json'), JSON.stringify({ name: 'Projects parity fixture', id: `example.yuri.${path.basename(directory)}`, version: '0.1.0', build: 1, theme: path.join(root, 'theme.json'), capabilities: { host: ['runtime.request', 'projects.fixture.audit', 'projects.fixture.complete'] } }));
    writeFileSync(path.join(directory, entry), `import ${JSON.stringify(path.join(root, 'projects-parity.fixture.tsx'))};\n`);
    return run({ directory, entry, host });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
