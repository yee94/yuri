import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { prepareSessionSwitcherFixture } from './session-switcher-fixture-config.mjs';

// Compile/bundle only: no engine, simulator, production Host or main application build.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode');
mkdirSync(parent, { recursive: true });
const directory = mkdtempSync(path.join(parent, 'session-switcher-check-'));
try {
  const fixture = prepareSessionSwitcherFixture(root, directory);
  const generated = JSON.parse(readFileSync(path.join(root, '.nsh/tsconfig.json'), 'utf8').replace(/^\/\/.*$/gm, ''));
  const config = path.join(directory, 'tsconfig.json');
  writeFileSync(config, JSON.stringify({ extends: path.join(root, 'tsconfig.json'), files: generated.files.map(file => path.resolve(root, '.nsh', file)), include: [path.join(root, 'session-switcher.tsx'), path.join(root, 'session-switcher-actions.ts'), path.join(root, 'session-switcher-fixture.tsx')], exclude: [] }));
  const bundle = process.argv.includes('--bundle');
  const command = bundle ? process.env.NSH_BIN || 'nsh' : process.execPath;
  const args = bundle ? ['build', fixture.entry, '--release', '--out', path.join(directory, 'bundle')]
    : [path.resolve(root, '../../node_modules/typescript/bin/tsc'), '--noEmit', '--project', config];
  const result = spawnSync(command, args, { cwd: directory, encoding: 'utf8', timeout: 120_000 });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
  if (bundle && result.status === 0) {
    const map = JSON.parse(readFileSync(path.join(directory, 'bundle/bundle.js.map'), 'utf8'));
    const forbidden = map.sources.filter(source => /node_modules\/(?:react(?:-dom)?|@tanstack|@opencode-ai\/sdk|@capacitor)\/|ui\/src\/lib\/(?:opencode\/client|mobileAppVersion|i18n\/context)\./.test(source));
    if (forbidden.length) throw new Error('Native boundary crossed: ' + forbidden.join(', '));
    console.log(`Session switcher isolated bundle: ${map.sources.length} sources, no browser runtime tree`);
  }
} finally { rmSync(directory, { recursive: true, force: true }); }
