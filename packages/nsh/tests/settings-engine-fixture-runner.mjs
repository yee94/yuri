import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export function prepareSettingsEngineFixture(root, directory, entry, hostSource, extraCapabilities = []) {
  const host = path.join(directory, 'host.js');
  writeFileSync(path.join(directory, 'nsh.json'), JSON.stringify({
    name: 'Settings engine fixture', id: 'example.yuri.settings.' + path.basename(directory).replace(/[^a-z0-9]/gi, '').toLowerCase(), version: '0.1.0', build: 1,
    theme: path.join(root, 'theme.json'), capabilities: { clipboard: true, host: ['connection.list', 'runtime.request', 'settings.fixture.scope', 'settings.fixture.scopeAudit', ...extraCapabilities] },
  }));
  writeFileSync(path.join(directory, 'tsconfig.json'), JSON.stringify({ extends: path.join(root, 'tsconfig.json'), include: ['*.tsx', '*.ts'] }));
  writeFileSync(path.join(directory, 'App.tsx'), `import ${JSON.stringify(path.join(root, entry))};\n`);
  const build = spawnSync('bun', ['build', hostSource, '--target=browser', '--format=esm', '--outfile', host], { cwd: root, encoding: 'utf8', timeout: 30_000 });
  if (build.error) throw build.error;
  if (build.status !== 0) throw new Error('Settings fixture Host bundle failed: ' + build.stdout + build.stderr);
  return { entry: 'App.tsx', host };
}

/** Driver remains under the repository; App/config/bytecode/Host/Storage are scenario-local. */
export function runSettingsEngineFixture(root, entry, hostSource, steps, timeout, extraCapabilities = []) {
  const parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true });
  const temporary = mkdtempSync(path.join(parent, 'nsh-settings-engine-'));
  const driverDirectory = mkdtempSync(path.join(root, 'tests', '.settings-engine-'));
  try {
    const fixture = prepareSettingsEngineFixture(root, temporary, entry, hostSource, extraCapabilities);
    const driver = path.join(driverDirectory, 'settings-engine.test.tsx');
    writeFileSync(driver, [
      'import { expect, open, test } from "nsh/test";',
      'test("production settings with admitted synthetic Host", async () => {',
      `const app = await open(${JSON.stringify(path.join(temporary, fixture.entry))}, { platform: "macos", storage: {}, network: {} });`,
      'try {', ...steps, '} finally { app.dispose(); }', '});',
    ].join('\n'));
    return spawnSync(process.env.NSH_BIN || 'nsh', ['test', driver, '--web-host', fixture.host], { cwd: temporary, encoding: 'utf8', timeout });
  } finally {
    rmSync(driverDirectory, { recursive: true, force: true });
    rmSync(temporary, { recursive: true, force: true });
  }
}
