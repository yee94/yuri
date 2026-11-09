import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const root = path.dirname(fileURLToPath(import.meta.url));
const engine = process.env.NSH_REMOTE_CONNECTIONS_ENGINE === '1' ? test : test.skip;
engine.each(['macos', 'windows'])('real native slot invokes injected port and shares Settings dirty guard (%s headless)', platform => {
  const parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode'); mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(path.join(parent, 'desktop-ssh-'));
  try {
    writeFileSync(path.join(directory, 'nsh.json'), JSON.stringify({ name: 'Synthetic SSH slot', id: 'example.yuri.ssh-fixture', version: '0.1.0', build: 1, theme: path.join(root, 'theme.json'), capabilities: {} }));
    writeFileSync(path.join(directory, 'App.tsx'), `import ${JSON.stringify(path.join(root, 'desktop-remote-connections-fixture.tsx'))};`);
    writeFileSync(path.join(directory, 'Slot.test.tsx'), `import { expect, open, test } from 'nsh/test';
test('actual injected native slot, not OS SSH', async () => {
  const app = await open('./App.tsx', { platform: ${JSON.stringify(platform)}, width: 1100, height: 1900 });
  await app.waitFor('id:desktop-ssh-fixture'); await app.press('id:desktop-ssh-fixture');
  await app.waitFor('id:desktop-ssh-label'); expect(app.value('id:desktop-ssh-label')).toBe('Fixture SSH');
  await app.type('id:desktop-ssh-label', ' keep draft');
  await app.waitFor('text:guard=ready;dirty=true;pending=false');
  app.onDialog(() => 'Cancel'); await app.press('id:desktop-ssh-add'); expect(app.value('id:desktop-ssh-label')).toBe('Fixture SSH keep draft');
  await app.press('id:desktop-ssh-save'); await app.waitFor('text:guard=ready;dirty=false;pending=false');
  await app.press('id:desktop-ssh-check'); await app.waitFor('text:Done');
  await app.press('id:desktop-ssh-connect'); await app.waitFor('text:Ready');
  expect(app.enabled('id:desktop-ssh-host')).toBe(false);
   await app.press('id:desktop-ssh-select-config');
   await app.press('id:desktop-ssh-sync-push'); await app.waitFor('id:desktop-ssh-review-skills');
   expect(app.texts().some(value => value === 'opencode.jsonc · 42')).toBe(false);
   await app.press('id:desktop-ssh-select-config');
   await app.press('id:desktop-ssh-sync-push'); await app.waitFor('text:opencode.jsonc · 42');
   await app.waitFor('id:desktop-ssh-review-agents-root');
   await app.press('id:desktop-ssh-sync-apply'); await app.waitFor('id:desktop-ssh-sync-success');
   await app.press('id:desktop-ssh-history-push'); await app.waitFor('id:desktop-ssh-history-prior-native-run');
  await app.press('id:desktop-ssh-cancel'); await app.waitFor('text:Idle');
  expect(app.enabled('id:desktop-ssh-host')).toBe(true);
  await app.press('id:ssh-fixture-fr'); await app.waitFor('text:Hôte SSH');
  await app.press('id:ssh-fixture-hide'); expect(app.enabled('id:desktop-ssh-connect')).toBe(false);
   expect(app.texts().some(value => value.includes('save;check;connect;preview-push;preview-push;sync-apply;history;cancel;'))).toBe(true);
});`);
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'Slot.test.tsx'], { cwd: directory, encoding: 'utf8', timeout: 90_000 });
    expect(result.error, result.stdout + result.stderr).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 120_000);
