import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

test('desktop header real NSH headless rendering and guarded interactions on both platform models', () => {
  const root = path.dirname(fileURLToPath(import.meta.url)), parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true }); const directory = mkdtempSync(path.join(parent, 'desktop-chat-header-'));
  try {
    writeFileSync(path.join(directory, 'nsh.json'), JSON.stringify({ name: 'Desktop chat header fixture', id: 'example.yuri.desktop-chat-header', version: '0.1.0', build: 1, theme: path.join(root, 'theme.json'), capabilities: { host: ['desktop.chat.header.test'] } }));
    writeFileSync(path.join(directory, 'App.tsx'), `import ${JSON.stringify(path.join(root, 'desktop-chat-header-fixture.tsx'))};\n`);
    writeFileSync(path.join(directory, 'Header.test.tsx'), `import ${JSON.stringify(path.join(root, 'tests/desktop-chat-header/Header.test.tsx'))};\n`);
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'Header.test.tsx'], { cwd: directory, encoding: 'utf8', timeout: 120_000 });
    expect(result.error, result.stdout + result.stderr).toBeUndefined(); expect(result.status, result.stdout + result.stderr).toBe(0);
    writeFileSync(path.join(directory, 'Geometry.test.tsx'), `import { open, test } from 'nsh/test';\nfor (const platform of ['macos', 'windows']) test(platform + ' mount frames', async () => { const app = await open('./App.tsx', { platform, width: 1000, height: 700 }); await app.setViewport(420, 360); await app.press('id:desktop-chat-header-menu'); await app.press('id:desktop-chat-header-menu-usage'); });\n`);
    const geometry = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'Geometry.test.tsx', '--trace'], { cwd: directory, encoding: 'utf8', timeout: 30_000 });
    expect(geometry.status, geometry.stdout + geometry.stderr).toBe(0);
    const batches = geometry.stdout.split('── open(App.tsx):').slice(1);
    expect(batches).toHaveLength(2);
    for (const batch of batches) {
      const ids = new Map<string, number>(), parents = new Map<number, number>(), frames = new Map<number, { x: number; y: number; width: number; height: number }>();
      for (const line of batch.split('\n')) {
        const id = /ViewProps \{ id: (\d+), .*test_id: Some\("([^"]+)"\)/.exec(line);
        if (id) ids.set(id[2], Number(id[1]));
        const parent = /Insert \{ parent: (\d+), child: (\d+)/.exec(line);
        if (parent) parents.set(Number(parent[2]), Number(parent[1]));
        const frame = /Frame \{ id: (\d+), x: (-?[\d.]+), y: (-?[\d.]+), w: ([\d.]+), h: ([\d.]+)/.exec(line);
        if (frame) frames.set(Number(frame[1]), { x: Number(frame[2]), y: Number(frame[3]), width: Number(frame[4]), height: Number(frame[5]) });
      }
      const nodeID = (name: string) => ids.get(name === 'github' ? 'desktop-header-github-menu' : `desktop-chat-header-${name}`)!;
      const frame = (name: string) => { const value = frames.get(nodeID(name)); expect(value, name).toBeDefined(); return value!; };
      expect(frame('actions')).toMatchObject({ width: 260, height: 48 });
      expect(frame('menu')).toMatchObject({ width: 32, height: 32 });
      expect(frame('work-status')).toMatchObject({ width: 28, height: 28 });
      expect(frame('context-ring')).toMatchObject({ width: 16, height: 16 });
      expect(frame('open-app-split')).toMatchObject({ width: 48, height: 28 });
      expect(frame('host')).toMatchObject({ width: 48, height: 28 });
      expect(frame('panel')).toMatchObject({ width: 28, height: 28 });
      expect(frame('github')).toMatchObject({ width: 24, height: 24 });
      expect(frame('services').width).toBeLessThanOrEqual(396);
      const rootID = ids.get('desktop-chat-header-actions')!;
      const relativeX = (name: string) => {
        let id = nodeID(name), x = 0;
        for (let depth = 0; depth < 20 && id !== rootID; depth++) { x += frames.get(id)?.x ?? 0; id = parents.get(id)!; }
        expect(id).toBe(rootID); return x;
      };
      expect(['menu', 'context', 'work-status', 'open-app-split', 'host', 'panel', 'github'].map(relativeX)).toEqual([0, 36, 68, 100, 152, 204, 236]);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 130_000);
