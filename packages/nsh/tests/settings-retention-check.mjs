import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareRetentionFixture } from './settings-retention-fixture-config.mjs';

/** Static only. No engine, UIKit, main build, real Host or network. All outputs use the approved temp directory. */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!process.env.OPENCODE_TMP_DIR) throw new Error('Set OPENCODE_TMP_DIR to the approved OpenCode temporary directory');
const temporary = mkdtempSync(path.join(process.env.OPENCODE_TMP_DIR, 'settings-retention-check-'));
try {
  const fixture = prepareRetentionFixture(root, temporary);
  const generated = JSON.parse(readFileSync(path.join(root, '.nsh/tsconfig.json'), 'utf8').replace(/^\/\/.*$/gm, ''));
  const config = path.join(temporary, 'tsconfig.json'), out = path.join(temporary, 'bundle');
  writeFileSync(config, JSON.stringify({
    extends: path.join(root, 'tsconfig.json'), files: generated.files.map(file => path.resolve(root, '.nsh', file)),
    include: [path.join(root, 'settings-retention*.ts'), path.join(root, 'settings-retention*.tsx')], exclude: [path.join(root, '*.test.ts')],
  }));
  const bundle = process.argv.includes('--bundle');
  const result = spawnSync(bundle ? (process.env.NSH_BIN || 'nsh') : process.execPath,
    bundle ? ['build', fixture.entry, '--release', '--out', out] : [path.resolve(root, '../../node_modules/typescript/bin/tsc'), '--noEmit', '--project', config],
    { cwd: temporary, encoding: 'utf8', timeout: 120_000 });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
  if (bundle && result.status === 0) {
    const map = JSON.parse(readFileSync(path.join(out, 'bundle.js.map'), 'utf8'));
    const forbidden = map.sources.filter(source => /node_modules\/(?:react(?:-dom)?|@tanstack|@opencode(?:-ai)?\/(?:sdk|client)|@capacitor)\/|ui\/src\/(?:hooks\/useSessionAutoCleanup|stores\/globalSessions|lib\/(?:opencode\/client|i18n\/context))\./.test(source));
    if (forbidden.length) throw new Error('Retention bundle crossed native boundary: ' + forbidden.join(', '));
    console.log(`Retention static boundary checked (${map.sources.length} sources)`);
  }
} finally { rmSync(temporary, { recursive: true, force: true }); }
