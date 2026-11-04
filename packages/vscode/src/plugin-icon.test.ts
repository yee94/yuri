import { afterEach, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { queryPluginRegistry } from './opencodeConfig';

afterEach(() => { vi.unstubAllGlobals(); });

test('README and description are only serialized when the registry caller requests details', async () => {
  const readme = '# Developer guide';
  const description = 'Developer description';
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({
    'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': { description } }, readme,
  })));
  const ordinary = (await queryPluginRegistry(['tour-package'], { refresh: true })).results[0];
  expect(ordinary).not.toHaveProperty('readme');
  expect(ordinary).not.toHaveProperty('description');
  const detail = (await queryPluginRegistry(['tour-package'], { details: true })).results[0];
  expect(detail).toMatchObject({ description, readme });
});

test('registry serializes top-level icons for local package directories and built entries', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuri-vscode-plugin-icon-'));
  try {
    const icon = 'data:image/svg+xml,%3Csvg/%3E';
    await fs.mkdir(path.join(root, 'dist'));
    const entry = path.join(root, 'dist', 'index.mjs');
    await fs.writeFile(entry, '');
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ icon }));
    const { results } = await queryPluginRegistry([root, entry]);
    expect(results).toHaveLength(2);
    for (const result of results) expect(result).toMatchObject({ kind: 'path-ok', icon });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('npm registry uses latest top-level icon and does not fall back to magpie.icon', async () => {
  const icon = 'https://example.test/plugin.svg';
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({
    'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': { icon, magpie: { icon: 'https://example.test/old.svg' } } },
  })));
  expect((await queryPluginRegistry(['icon-package'], { refresh: true })).results[0]).toMatchObject({ kind: 'npm-ok', icon });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({
    'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': { magpie: { icon } } },
  })));
  expect((await queryPluginRegistry(['old-icon-package'], { refresh: true })).results[0]).not.toHaveProperty('icon');
});
