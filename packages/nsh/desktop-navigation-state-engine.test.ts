import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

// Headless engine + real NSH Storage only; no foreground/native window or real Host.
it('NSH authority effect and Storage preserve navigation priority, origin isolation, failures and bounded stale admission', () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(path.join(parent, 'desktop-navigation-'));
  try {
    writeFileSync(path.join(directory, 'nsh.json'), JSON.stringify({ name: 'Navigation fixture', id: 'example.yuri.navigation-fixture', version: '0.1.0', build: 1, theme: path.join(root, 'theme.json') }));
    writeFileSync(path.join(directory, 'App.tsx'), `import ${JSON.stringify(path.join(root, 'desktop-navigation-state-fixture.tsx'))};\n`);
    writeFileSync(path.join(directory, 'Navigation.test.tsx'), `
import { expect, open, test } from 'nsh/test';
const disk = 'disk:A@https://a.example=saved-A|B@https://b.example=saved-B';
test('late validation loses to user action and the default Storage adapter restores its exact metadata after remount', async () => {
  const app = await open('./App.tsx');
  await app.press('id:nav-hold'); await app.press('id:nav-seed'); await app.waitFor('text:calls:1');
  await app.press('id:nav-user'); await app.press('id:nav-release'); await app.press('id:nav-flush');
  await app.waitFor('text:write:idle'); expect(app.texts()).toContain('applied:user');
  expect(app.texts()).toContain('restore:superseded');
  await app.press('id:nav-restart'); await app.waitFor('text:restore:restored');
  expect(app.texts()).toContain('applied:user'); expect(app.texts()).toContain('calls:2');
});
test('same ID new origin cannot receive old restore', async () => {
  const app = await open('./App.tsx');
  await app.press('id:nav-hold'); await app.press('id:nav-seed'); await app.waitFor('text:calls:1');
  await app.press('id:nav-new-origin'); await app.press('id:nav-release'); await app.waitFor('text:restore:empty');
  expect(app.texts()).toContain('applied:none'); expect(app.texts()).toContain('calls:1');
  await app.press('id:nav-inspect'); await app.waitFor('text:' + disk);
});
test('unconfirmed runtimeScope refuses reads and writes and preserves existing metadata', async () => {
  const app = await open('./App.tsx');
  await app.press('id:nav-hold'); await app.press('id:nav-seed'); await app.waitFor('text:calls:1');
  await app.press('id:nav-unconfirmed'); await app.press('id:nav-user'); await app.press('id:nav-release');
  expect(app.texts()).toContain('applied:user'); expect(app.texts()).toContain('writes:0');
  await app.press('id:nav-inspect'); await app.waitFor('text:' + disk);
});
test('successful empty is distinct from failed Storage read and failed lookup', async () => {
  const empty = await open('./App.tsx'); await empty.press('id:nav-empty'); await empty.waitFor('text:restore:empty');
  expect(empty.texts()).toContain('applied:none'); expect(empty.texts()).toContain('calls:0');
  const read = await open('./App.tsx'); await read.press('id:nav-fail-read'); await read.press('id:nav-seed');
  await read.waitFor('text:restore:error'); expect(read.texts()).toContain('applied:none');
  await read.press('id:nav-retry-restore'); await read.waitFor('text:restore:restored');
  expect(read.texts()).toContain('applied:saved-A');
  const lookup = await open('./App.tsx'); await lookup.press('id:nav-fail-lookup'); await lookup.press('id:nav-seed');
  await lookup.waitFor('text:restore:error'); expect(lookup.texts()).toContain('applied:none');
  await lookup.press('id:nav-inspect'); await lookup.waitFor('text:' + disk);
  await lookup.press('id:nav-retry-restore'); await lookup.waitFor('text:restore:restored');
  expect(lookup.texts()).toContain('applied:saved-A'); expect(lookup.texts()).toContain('calls:2');
});
test('failed close flush retains prior and retries metadata without running restore again', async () => {
  const app = await open('./App.tsx'); await app.press('id:nav-seed'); await app.waitFor('text:restore:restored');
  await app.press('id:nav-fail-write'); await app.press('id:nav-user'); await app.waitFor('text:write:error');
  await app.press('id:nav-close'); await app.waitFor('text:close:false');
  await app.press('id:nav-inspect'); await app.waitFor('text:' + disk);
  await app.press('id:nav-recover-write'); await app.press('id:nav-close'); await app.waitFor('text:close:true');
  await app.press('id:nav-inspect');
  await app.waitFor('text:disk:B@https://b.example=saved-B|A@https://a.example=user');
  expect(app.texts()).toContain('applied:user'); expect(app.texts()).toContain('calls:1');
});
test('one old validation during bounded Host churn cannot apply or delete current B', async () => {
  const app = await open('./App.tsx'); await app.press('id:nav-hold'); await app.press('id:nav-seed'); await app.waitFor('text:calls:1');
  await app.press('id:nav-churn'); expect(app.texts()).toContain('calls:1');
  await app.press('id:nav-release-missing'); await app.waitFor('text:restore:restored');
  expect(app.texts()).toContain('applied:saved-B'); expect(app.texts()).toContain('calls:2');
  await app.press('id:nav-inspect'); await app.waitFor('text:' + disk);
});
`);
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'Navigation.test.tsx'], { cwd: directory, encoding: 'utf8', timeout: 60_000 });
    expect(result.error, result.stdout + result.stderr).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 75_000);
