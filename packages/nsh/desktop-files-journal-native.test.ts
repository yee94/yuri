import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const directory = path.dirname(fileURLToPath(import.meta.url));
function run(steps: string[]) {
  const temporary = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'nsh-files-journal-'));
  try {
    writeFileSync(path.join(temporary, 'nsh.json'), JSON.stringify({ name: 'Synthetic document recovery', id: 'example.yuri.journal-test', version: '0.1.0', build: 1, theme: path.join(directory, 'theme.json'), capabilities: { clipboard: true, host: ['runtime.request'] } }));
    writeFileSync(path.join(temporary, 'App.tsx'), `import ${JSON.stringify(path.join(directory, 'desktop-files-journal-fixture.tsx'))};`);
    writeFileSync(path.join(temporary, 'Recovery.test.ts'), `import { test, open, expect } from 'nsh/test'; test('cold document engine', async () => {
      const boot = storage => open('App.tsx', { platform: 'macos', width: 1000, height: 900, storage });
      const stats = app => JSON.parse(app.texts().find(text => text.startsWith('journal-stats:')).slice(14));
      const journal = app => JSON.parse(app.texts().find(text => text.startsWith('journal-state:')).slice(14));
      let app = await boot({}); await app.waitFor('id:desktop-file-editor');
      ${steps.join('\n')}
    }, 60000);`);
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'Recovery.test.ts', '--web-host', path.join(directory, 'desktop-panel-fixture-host.js')], { cwd: temporary, encoding: 'utf8', timeout: 70_000 });
    expect(result.error, result.stdout + result.stderr).toBeUndefined(); expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

test('fresh headless engine hydrates real NSH Storage records into the native Editor, without POST or credentials', () => run([
  'await app.type("id:desktop-file-editor", "RECOVER_NATIVE");',
  'await app.press("id:fixture-journal-flush"); await app.waitFor("text:journal-flushed:true");',
  'const saved = app.storage(); expect(JSON.stringify(saved).includes("synthetic-journal-lease")).toBe(false);',
  'app = await boot(saved); await app.waitFor("id:desktop-file-editor");',
  'expect(app.texts().some(text => text.includes("RECOVER_NATIVE"))).toBe(true);',
  'expect(stats(app).writes).toBe(0); expect(journal(app).records).toBe(1);',
]), 85_000);

test('cold unknown receipt plus stat 401/404 and old remote base remains GET-only in the real native Editor', () => run([
  'await app.type("id:desktop-file-editor", "UNCERTAIN_NATIVE");',
  'await app.press("id:fixture-journal-unknown"); await app.press("id:desktop-editor-save");',
  'await app.waitUntil(() => app.texts().some(text => text.includes("WRITE_UNKNOWN")));',
  'expect(stats(app).writes).toBe(1); const saved = app.storage();',
  'app = await boot(saved); await app.waitFor("id:desktop-file-editor");',
  'for (const status of [401, 404]) { await app.press("id:fixture-journal-" + status); await app.press("id:desktop-editor-save"); await app.waitUntil(() => app.enabled("id:desktop-editor-save")); expect(stats(app).writes).toBe(0); }',
  'await app.press("id:desktop-editor-save"); await app.waitUntil(() => app.enabled("id:desktop-editor-save"));',
  'expect(stats(app).writes).toBe(0); expect(app.texts().some(text => text.includes("UNCERTAIN_NATIVE"))).toBe(true);',
]), 85_000);

test('native Storage failure preserves current input/prior record and exposes explicit retry before saving', () => run([
  'await app.type("id:desktop-file-editor", "PRIOR_NATIVE"); await app.press("id:fixture-journal-flush"); await app.waitFor("text:journal-flushed:true");',
  'const prior = JSON.stringify(app.storage());',
  'await app.press("id:fixture-journal-fail"); await app.type("id:desktop-file-editor", "LATEST_NATIVE");',
  'await app.press("id:desktop-editor-save"); await app.waitFor("id:desktop-editor-journal-retry");',
  'expect(stats(app).writes).toBe(0); expect(JSON.stringify(app.storage())).toBe(prior);',
  'expect(app.texts().some(text => text.includes("LATEST_NATIVE"))).toBe(true);',
  'await app.press("id:fixture-journal-fail"); await app.press("id:desktop-editor-journal-retry");',
  'await app.waitUntil(() => !app.shows("id:desktop-editor-journal-retry"));',
  'expect(JSON.stringify(app.storage()).includes("LATEST_NATIVE")).toBe(true); expect(stats(app).writes).toBe(0);',
]), 85_000);

test('changed authorization never auto-opens or writes an old recovered buffer; recovery keeps a copy-only old partition', () => run([
  'await app.type("id:desktop-file-editor", "OLD_AUTHORITY_DRAFT"); await app.press("id:fixture-journal-flush"); await app.waitFor("text:journal-flushed:true");',
  'app = await boot(app.storage()); await app.waitFor("id:desktop-file-editor");',
  'await app.press("id:fixture-journal-authority"); await app.press("id:fixture-journal-open");',
  'await app.waitFor("id:desktop-file-editor"); expect(app.texts().some(text => text.includes("OLD_AUTHORITY_DRAFT"))).toBe(false);',
  'expect(stats(app).writes).toBe(0); expect(journal(app).records).toBe(1);',
  'await app.press("id:desktop-panel-recovery"); await app.waitFor("text:Unavailable");',
  'const key = Object.keys(app.storage()).find(key => key.startsWith("desktop-file-journal-v1:"));',
  'await app.press("id:desktop-panel-recovery-copy-" + key.slice("desktop-file-journal-v1:".length));',
  'expect(app.clipboard().includes("OLD_AUTHORITY_DRAFT")).toBe(true); expect(stats(app).writes).toBe(0);',
]), 85_000);
