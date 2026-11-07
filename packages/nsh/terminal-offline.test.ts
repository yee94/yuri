import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
// @ts-expect-error Local build-owner hook has no runtime TypeScript dependency.
import { stageTerminalOfflineResources } from './terminal-offline.mjs';

it('stages exact installed Ghostty JS/WASM/license with SHA manifest in a temporary Resources directory, offline', async () => {
  const root = path.dirname(fileURLToPath(import.meta.url)), temporary = mkdtempSync(path.join(process.env.OPENCODE_TMP_DIR || tmpdir(), 'terminal-offline-'));
  try {
    const manifest = await stageTerminalOfflineResources(temporary, path.join(root, '../..'));
    expect(manifest).toMatchObject({ package: 'ghostty-web', version: '0.4.0' }); expect(manifest.files).toHaveLength(3);
    expect(readFileSync(path.join(temporary, 'terminal-ghostty.js'))).toEqual(readFileSync(path.join(root, '../../node_modules/ghostty-web/dist/ghostty-web.umd.cjs')));
    expect(readFileSync(path.join(temporary, 'terminal-ghostty.wasm'))).toEqual(readFileSync(path.join(root, '../../node_modules/ghostty-web/ghostty-vt.wasm')));
    expect(JSON.parse(readFileSync(path.join(temporary, 'terminal-ghostty-manifest.json'), 'utf8'))).toEqual(manifest);
    expect(JSON.stringify(manifest)).not.toContain(root); expect(JSON.stringify(manifest)).not.toMatch(/https?:/);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
