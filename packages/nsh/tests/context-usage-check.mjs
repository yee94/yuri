import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode');
mkdirSync(parent, { recursive: true });
const directory = mkdtempSync(path.join(parent, 'context-usage-check-'));
try {
  const generated = JSON.parse(readFileSync(path.join(root, '.nsh/tsconfig.json'), 'utf8').replace(/^\/\/.*$/gm, ''));
  const config = path.join(directory, 'tsconfig.json');
  writeFileSync(config, JSON.stringify({ extends: path.join(root, 'tsconfig.json'), files: generated.files.map(file => path.resolve(root, '.nsh', file)), include: [path.join(root, 'state.ts'), path.join(root, 'context-usage.tsx'), path.join(root, 'context-usage-core.ts'), path.join(root, 'context-usage-source.ts'), path.join(root, 'context-usage-authority.ts'), path.join(root, 'context-usage-format.ts'), path.join(root, 'context-usage-fixture.tsx'), path.join(root, 'context-usage-route.tsx'), path.join(root, 'context-usage-route-core.ts'), path.join(root, 'context-usage-palette.ts')], exclude: [] }));
  const typed = spawnSync(process.execPath, [path.resolve(root, '../../node_modules/typescript/bin/tsc'), '--noEmit', '--project', config], { cwd: directory, encoding: 'utf8', timeout: 120_000 });
  if (typed.status !== 0) throw new Error(typed.stdout + typed.stderr);
  const graph = path.join(directory, 'graph.json');
  const built = spawnSync('bun', ['build', path.join(root, 'context-usage-fixture.tsx'), path.join(root, 'context-usage-source.ts'), path.join(root, 'context-usage-route.tsx'), path.join(root, 'context-usage-palette.ts'), '--target=browser', '--external=nsh', '--external=nsh/*', `--metafile=${graph}`, '--outdir', path.join(directory, 'bundle')], { cwd: directory, encoding: 'utf8', timeout: 60_000 });
  if (built.status !== 0) throw new Error(built.stdout + built.stderr);
  const files = Object.keys(JSON.parse(readFileSync(graph, 'utf8')).inputs);
  const forbidden = files.filter(file => /(?:^|\/)(?:application|state)\.tsx?$|node_modules\/(?:react(?:-dom)?|@tanstack|@opencode-ai\/sdk|@capacitor)\/|ui\/src\/lib\/(?:runtime-fetch|timeFormat|i18n\/context)\./.test(file));
  if (forbidden.length) throw new Error('Context overview crossed browser/main boundary: ' + forbidden.join(', '));
  console.log(`Context overview focused types + own bundle passed (${files.length} sources)`);
} finally { rmSync(directory, { recursive: true, force: true }); }
