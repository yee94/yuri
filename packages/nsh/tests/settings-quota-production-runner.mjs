import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const quotaProductionCapabilities = ['connection.list', 'connection.select', 'runtime.request', 'runtime.stream', 'runtime.stop', 'appearance.reset', 'appearance.apply', 'notification.configure', 'speech.prepare', 'speech.stop', 'speech.release', 'native.diagnostics.status'];

/** No production entry/config writes; every test gets an isolated app identity and Storage. */
export function withQuotaProductionFixture(root, run) {
  const parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(path.join(parent, 'nsh-settings-quota-production-'));
  try {
    const entry = 'App.tsx', host = path.join(directory, 'host.js');
    writeFileSync(path.join(directory, 'nsh.json'), JSON.stringify({ name: 'Quota production synthetic fixture', id: 'example.yuri.quota-production.' + path.basename(directory).replace(/[^a-z0-9]/gi, '').toLowerCase(), version: '0.1.0', build: 1, theme: path.join(root, 'theme.json'), capabilities: { host: quotaProductionCapabilities } }));
    writeFileSync(path.join(directory, 'tsconfig.json'), JSON.stringify({ extends: path.join(root, 'tsconfig.json'), include: ['*.ts', '*.tsx'] }));
    writeFileSync(path.join(directory, entry), `import ${JSON.stringify(path.join(root, 'App.tsx'))};\n`);
    // This seeds only the initial Tab; no fixture route, credentials component or callback exists.
    writeFileSync(path.join(directory, 'RootSettings.tsx'), `import { mount } from 'nsh';\nimport { YuriNativeApp } from ${JSON.stringify(path.join(root, 'application'))};\nimport { app } from ${JSON.stringify(path.join(root, 'state'))};\napp.tab.set(3);\nmount(YuriNativeApp);\n`);
    const built = spawnSync('bun', ['build', 'tests/settings-quota-production-host.js', '--target=browser', '--format=esm', '--outfile', host], { cwd: root, encoding: 'utf8', timeout: 30_000 });
    if (built.error) throw built.error;
    if (built.status !== 0) throw new Error('Quota production Host static bundle failed: ' + built.stdout + built.stderr);
    return run({ directory, entry, host });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
