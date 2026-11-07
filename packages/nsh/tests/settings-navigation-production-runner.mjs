import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const settingsNavigationCapabilities = ['connection.list', 'runtime.request', 'runtime.stream', 'runtime.stop', 'appearance.reset', 'appearance.apply', 'notification.configure', 'native.diagnostics.status', 'speech.prepare', 'speech.stop', 'speech.release'];

/** App, native bytecode, config and Storage identity are isolated; no synthetic UI or navigation callbacks. */
export function withSettingsNavigationProductionFixture(root, run) {
  const parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(path.join(parent, 'nsh-settings-navigation-'));
  try {
    const entry = 'App.tsx', host = path.join(directory, 'host.js');
    writeFileSync(path.join(directory, 'nsh.json'), JSON.stringify({ name: 'Settings navigation production fixture', id: 'example.yuri.settings-navigation.' + path.basename(directory).replace(/[^a-z0-9]/gi, '').toLowerCase(), version: '0.1.0', build: 1, theme: path.join(root, 'theme.json'), capabilities: { host: settingsNavigationCapabilities } }));
    writeFileSync(path.join(directory, 'tsconfig.json'), JSON.stringify({ extends: path.join(root, 'tsconfig.json'), include: ['*.tsx', '*.ts'] }));
    writeFileSync(path.join(directory, entry), `import ${JSON.stringify(path.join(root, 'App.tsx'))};\n`);
    // Only the initial tab is seeded for the root-global case. Its Home and every pushed page are production owners.
    writeFileSync(path.join(directory, 'RootSettings.tsx'), `import { mount } from 'nsh';\nimport { YuriNativeApp } from ${JSON.stringify(path.join(root, 'application'))};\nimport { app } from ${JSON.stringify(path.join(root, 'state'))};\napp.tab.set(3);\nmount(YuriNativeApp);\n`);
    const build = spawnSync('bun', ['build', 'tests/settings-navigation-production-host.js', '--target=browser', '--format=esm', '--outfile', host], { cwd: root, encoding: 'utf8', timeout: 30_000 });
    if (build.error) throw build.error;
    if (build.status !== 0) throw new Error('Settings navigation strict Host bundle failed: ' + build.stdout + build.stderr);
    return run({ directory, entry, host });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
