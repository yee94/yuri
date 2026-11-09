import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

test('runtime Instance/MCP slots use real NSH headless components on both platform models', () => {
  const root = path.dirname(fileURLToPath(import.meta.url)), parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true }); const directory = mkdtempSync(path.join(parent, 'desktop-header-services-'));
  try {
    writeFileSync(path.join(directory, 'nsh.json'), JSON.stringify({ name: 'Header services fixture', id: 'example.yuri.header-services', version: '0.1.0', build: 1, theme: path.join(root, 'theme.json'), capabilities: { host: ['desktop.header.services.test'] } }));
    writeFileSync(path.join(directory, 'App.tsx'), `import ${JSON.stringify(path.join(root, 'desktop-header-services-fixture.tsx'))};\n`);
    writeFileSync(path.join(directory, 'Services.test.tsx'), `import ${JSON.stringify(path.join(root, 'desktop-header-services-headless.tsx'))};\n`);
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'Services.test.tsx'], { cwd: directory, encoding: 'utf8', timeout: 120_000 });
    expect(result.error, result.stdout + result.stderr).toBeUndefined(); expect(result.status, result.stdout + result.stderr).toBe(0);
    writeFileSync(path.join(directory, 'Geometry.test.tsx'), `import { open, test } from 'nsh/test';
for (const platform of ['macos','windows']) test(platform + ' native services geometry', async () => {
  const app = await open('./App.tsx', { platform, width:1000, height:700 });
  await app.press('id:services-show-instance'); await app.waitFor('id:desktop-header-services-instance-row-a');
  await app.setViewport(360,500); await app.press('id:services-show-mcp'); await app.waitFor('id:desktop-header-services-mcp-toggle-Alpha');
});`);
    const geometry = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'Geometry.test.tsx', '--trace'], { cwd: directory, encoding: 'utf8', timeout: 30_000 });
    expect(geometry.status, geometry.stdout + geometry.stderr).toBe(0);
    const batches = geometry.stdout.split('── open(App.tsx):').slice(1); expect(batches).toHaveLength(2);
    for (const batch of batches) {
      const ids = new Map<string, number>(), frames = new Map<number, { width: number; height: number }>();
      for (const line of batch.split('\n')) {
        const id = /ViewProps \{ id: (\d+), .*test_id: Some\("([^"]+)"\)/.exec(line);
        if (id) ids.set(id[2], Number(id[1]));
        const frame = /Frame \{ id: (\d+), x: -?[\d.]+, y: -?[\d.]+, w: ([\d.]+), h: ([\d.]+)/.exec(line);
        if (frame) frames.set(Number(frame[1]), { width: Number(frame[2]), height: Number(frame[3]) });
      }
      const frame = (name: string) => { const value = frames.get(ids.get(`desktop-header-services-${name}`)!); expect(value, name).toBeDefined(); return value!; };
      expect(frame('fixture-surface').width).toBe(336);
      expect(frame('mcp-refresh')).toMatchObject({ width: 28, height: 28 });
      expect(frame('mcp-list').height).toBeLessThanOrEqual(256);
      expect(frame('mcp-row-Alpha').width).toBeLessThanOrEqual(312);
      expect(frame('instance-default-a')).toMatchObject({ width: 32, height: 32 });
      expect(frame('instance-new-window-a')).toMatchObject({ width: 32, height: 32 });
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 130_000);
