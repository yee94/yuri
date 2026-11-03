import { afterEach, beforeEach, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readLocalPluginIcon } from './plugin-icon.js';

let root;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuri-plugin-icon-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

test('local directories and built entry files read the nearest top-level icon', async () => {
  const icon = 'data:image/svg+xml,%3Csvg/%3E';
  await fs.mkdir(path.join(root, 'dist'));
  const entry = path.join(root, 'dist', 'index.mjs');
  await fs.writeFile(entry, '');
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ icon, magpie: { icon: 'https://example.test/old.svg' } }));
  expect(await readLocalPluginIcon(root)).toBe(icon);
  expect(await readLocalPluginIcon(entry)).toBe(icon);
});

test.each([
  { magpie: { icon: 'https://example.test/old.svg' } },
  { icon: 'javascript:alert(1)' },
  { icon: 'file:///private/icon.svg' },
  { icon: 'data:image/svg+xml,' + 'x'.repeat(3 << 19) },
])('no nested-field, unsafe-value or parent-package fallback (%j)', async (manifest) => {
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ icon: 'https://example.test/parent.svg' }));
  const child = path.join(root, 'child');
  await fs.mkdir(child);
  await fs.writeFile(path.join(child, 'package.json'), JSON.stringify(manifest));
  expect(await readLocalPluginIcon(child)).toBeUndefined();
});

test('missing, malformed and oversized optional metadata are harmless', async () => {
  expect(await readLocalPluginIcon(path.join(root, 'missing'))).toBeUndefined();
  const manifest = path.join(root, 'package.json');
  await fs.writeFile(manifest, '{broken');
  expect(await readLocalPluginIcon(root)).toBeUndefined();
  await fs.writeFile(manifest, ' '.repeat(2 * 1024 * 1024 + 1));
  expect(await readLocalPluginIcon(root)).toBeUndefined();
});
