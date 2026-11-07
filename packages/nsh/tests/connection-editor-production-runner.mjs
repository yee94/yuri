import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const connectionEditorProductionCapabilities = [
  'connection.list', 'connection.editor', 'connection.rename', 'connection.edit', 'connection.connect',
  'runtime.request', 'runtime.stream', 'runtime.stop', 'appearance.reset', 'appearance.apply',
  'notification.configure', 'connectionEditor.fixture.audit',
];

/** Unique app identity, config, Host bundle, bytecode and Storage per case. No production file is written. */
export function withConnectionEditorProductionFixture(root, run) {
  const parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(path.join(parent, 'nsh-connection-editor-production-'));
  try {
    const entry = 'App.tsx', host = path.join(directory, 'host.js');
    writeFileSync(path.join(directory, 'nsh.json'), JSON.stringify({
      name: 'Connection editor production fixture', id: 'example.yuri.connection-editor.' + path.basename(directory).replace(/[^a-z0-9]/gi, '').toLowerCase(),
      version: '0.1.0', build: 1, theme: path.join(root, 'theme.json'),
      capabilities: { host: connectionEditorProductionCapabilities },
    }));
    writeFileSync(path.join(directory, 'tsconfig.json'), JSON.stringify({ extends: path.join(root, 'tsconfig.json'), include: ['App.tsx'] }));
    writeFileSync(path.join(directory, entry), `import ${JSON.stringify(path.join(root, 'tests/connection-editor-production-fixture.tsx'))};\n`);
    const build = spawnSync('bun', ['build', 'tests/connection-editor-production-host.js', '--target=browser', '--format=esm', '--outfile', host], { cwd: root, encoding: 'utf8', timeout: 30_000 });
    if (build.error) throw build.error;
    if (build.status !== 0) throw new Error('Connection editor strict Host bundle failed: ' + build.stdout + build.stderr);
    return run({ directory, entry, host });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
