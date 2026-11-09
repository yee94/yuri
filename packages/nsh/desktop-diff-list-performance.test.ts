import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('short/12000-line native list documents retain full copy and bounded mounts; 50 inputs create no views on both desktop models', () => {
  const root = path.dirname(fileURLToPath(import.meta.url)), parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true }); const directory = mkdtempSync(path.join(parent, 'diff-list-perf-'));
  try {
    writeFileSync(path.join(directory, 'nsh.json'), JSON.stringify({ name: 'Diff list performance', id: 'example.yuri.diff-list-perf', version: '0.1.0', build: 1, theme: path.join(root, 'theme.json'), capabilities: { clipboard: true, host: ['runtime.request'] } }));
    writeFileSync(path.join(directory, 'App.tsx'), `import ${JSON.stringify(path.join(root, 'desktop-diff-list.fixture.tsx'))};\n`);
    for (const platform of ['macos', 'windows']) {
      const counts: { created: number; initialItems: number; inputCreated: number; inputItems: number; inputBatches: number }[] = [];
      for (const lines of [400, 12000]) {
        writeFileSync(path.join(directory, 'Perf.test.tsx'), `import { expect, open, test } from 'nsh/test';
test('bounded native document', async () => {
 const reads=[];
  const app=await open('./App.tsx',{platform:${JSON.stringify(platform)},clock:{},width:1400,height:900,host:{params:{history:true,single:true,lines:${lines}},handlers:{'runtime.request':value=>{reads.push(value);throw new Error('Historical must not read current Git');}}}});
  await app.waitFor('text:NEW_HISTORY'); await app.wait(50);
  expect(app.shows('text:NEW_END')).toBe(false);
 await app.press('id:desktop-diff-copy'); await app.waitUntil(()=>app.clipboard()?.endsWith('NEW_END'));
 expect(app.clipboard()).toBe('OLD_HISTORY\\n'.repeat(${lines})+'OLD_END\\n\\n'+'NEW_HISTORY\\n'.repeat(${lines})+'NEW_END');
 for(let i=0;i<50;i++) await app.type('id:diff-list-composer','x');
 expect(reads).toEqual([]); expect(app.count('id:desktop-native-diff')).toBe(1); expect(app.value('id:diff-list-composer')).toBe('x'.repeat(50));
});`);
        const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'Perf.test.tsx', '--trace'], { cwd: directory, encoding: 'utf8', timeout: 40_000, maxBuffer: 32 * 1024 * 1024 });
        expect(result.error, result.stdout + result.stderr).toBeUndefined(); expect(result.status, result.stdout + result.stderr).toBe(0);
        const trace = result.stdout + result.stderr;
        let input = false, created = 0, initialItems = 0, inputCreated = 0, inputItems = 0, inputBatches = 0;
        for (const line of trace.split('\n')) {
          const batch = /── (.*): (\d+) items/.exec(line);
          if (batch) { if (batch[1]!.startsWith('press(id:desktop-diff-copy')) input = true; if (input) { inputBatches++; inputItems += Number(batch[2]); } else initialItems += Number(batch[2]); }
          if (/\bCreate \{/.test(line)) { created++; if (input) inputCreated++; }
        }
        expect(inputBatches, 'trace must observe the copy preceding 50 confirmed input edits').toBeGreaterThanOrEqual(1);
        expect(created, 'trace must observe real native view creation').toBeGreaterThan(0);
        expect(created).toBeLessThan(2000);
        expect(inputCreated, 'input must not remount the document or any native view').toBe(0);
        console.info('Diff native budget', { platform, lines, created, initialItems, inputCreated, inputItems, inputBatches });
        counts.push({ created, initialItems, inputCreated, inputItems, inputBatches });
      }
      expect(counts[1]!.created).toBeLessThanOrEqual(counts[0]!.created + 12);
      expect(counts[1]!.initialItems).toBeLessThanOrEqual(counts[0]!.initialItems + 64);
      expect(counts[1]!.inputItems).toBe(counts[0]!.inputItems);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 170_000);
