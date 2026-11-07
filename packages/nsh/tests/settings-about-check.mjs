import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { prepareAboutFixture } from './settings-about-fixture-config.mjs';

/** Compile/bundle only. Never launches an engine or touches production build scripts. */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = mkdtempSync(path.join(process.env.OPENCODE_TMP_DIR || tmpdir(), 'settings-about-check-'));
try {
  const fixture = prepareAboutFixture(root, temporary);
  const generated = JSON.parse(readFileSync(path.join(root, '.nsh/tsconfig.json'), 'utf8').replace(/^\/\/.*$/gm, ''));
  const config = path.join(temporary, 'tsconfig.json');
  writeFileSync(config, JSON.stringify({
    extends: path.join(root, 'tsconfig.json'),
    files: generated.files.map(file => path.resolve(root, '.nsh', file)),
    include: [path.join(root, 'settings-about-core.ts'), path.join(root, 'settings-about.tsx'), path.join(root, 'settings-about-fixture.tsx'), path.join(root, 'settings-about-diagnostics.ts'), path.join(root, 'settings-about-root.ts')],
    exclude: [],
  }));
  const bundle = process.argv.includes('--bundle');
  const command = bundle ? (process.env.NSH_BIN || 'nsh') : process.execPath;
  const args = process.argv.includes('--bundle') ? ['build', fixture.entry, '--release', '--out', path.join(temporary, 'bundle')]
    : [path.resolve(root, '../../node_modules/typescript/bin/tsc'), '--noEmit', '--project', config];
  const result = spawnSync(command, args, { cwd: temporary, encoding: 'utf8', timeout: 120_000 });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
  if (bundle && result.status === 0) {
    const map = JSON.parse(readFileSync(path.join(temporary, 'bundle/bundle.js.map'), 'utf8'));
    const forbidden = map.sources.filter(source => /node_modules\/(?:react(?:-dom)?|@tanstack|@opencode-ai\/sdk|@capacitor)\/|ui\/src\/lib\/(?:opencode\/client|mobileAppVersion|i18n\/context)\./.test(source));
    if (forbidden.length) throw new Error('About bundle crossed its native boundary: ' + forbidden.join(', '));
    console.log(`About bundle boundary checked (${map.sources.length} sources; no React/SDK/Capacitor browser tree)`);
  }
} finally { rmSync(temporary, { recursive: true, force: true }); }
