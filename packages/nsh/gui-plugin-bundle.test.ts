import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('bundles the prepared content adapter without pulling Web globals, React, SDK or runtime into QuickJS', () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const temporary = mkdtempSync(path.join(process.env.OPENCODE_TMP_DIR || tmpdir(), 'gui-plugin-bundle-'));
  try {
    const metadata = path.join(temporary, 'graph.json');
    const result = spawnSync('bun', ['build', ...['gui-plugin-browser.ts', 'gui-plugin-composition.ts', 'gui-plugin-channel.ts', 'gui-plugin-exports.ts'].map(file => path.join(root, file)), '--target=browser', '--format=esm', '--metafile=' + metadata, '--outdir=' + path.join(temporary, 'browser')], { encoding: 'utf8', timeout: 30_000 });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const graph = JSON.parse(readFileSync(metadata, 'utf8'));
    const inputs = Object.keys(graph.inputs);
    expect(inputs).toHaveLength(7);
    expect(inputs.every(file => /(?:gui-plugin-(?:preview|browser|composition|channel|transport|exports)|runtime-scope)\.ts$/.test(file))).toBe(true);
    for (const entry of ['browser', 'composition', 'channel', 'exports']) expect(readFileSync(path.join(temporary, 'browser', `gui-plugin-${entry}.js`), 'utf8')).not.toMatch(/__YURI_LOCAL_ORIGIN__|__YURI_HOME__|RuntimeBridge|react-dom|\brequire\(/);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
