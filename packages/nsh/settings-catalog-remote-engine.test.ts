import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const root = path.dirname(fileURLToPath(import.meta.url));
function run(steps: string[]) {
  const parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode'); mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(path.join(parent, 'settings-catalog-remote-'));
  try {
    writeFileSync(path.join(directory, 'nsh.json'), JSON.stringify({ name: 'Catalog and remote fixture', id: 'example.yuri.catalog-remote', version: '0.1.0', build: 1, theme: path.join(root, 'theme.json'), capabilities: { clipboard: true, host: ['connection.list', 'runtime.request', 'catalogRemote.fixture.scenario', 'catalogRemote.fixture.audit'] } }));
    writeFileSync(path.join(directory, 'App.tsx'), `import ${JSON.stringify(path.join(root, 'settings-catalog-remote-fixture.tsx'))};`);
    writeFileSync(path.join(directory, 'Settings.test.tsx'), `import { expect, open, test } from 'nsh/test';
test('real Settings owners with synthetic Host', async () => {
const app = await open('./App.tsx', { platform: 'macos', width: 1280, height: 1000 });
const ready = async () => app.waitFor('text:protection=ready;pending=false;dirty=false;picker=false');
const audit = async () => { await app.press('id:catalog-remote-audit'); await app.wait(25); return JSON.parse(app.texts().find(value => value.startsWith('{"installs":'))); };
const remote = async () => { await ready(); await app.press('id:desktop-settings-page:remote-instances'); await app.waitFor('id:remote-client-desktop'); await ready(); };
await app.waitFor('id:skills-catalog-install-fixture-skill'); await ready();
${steps.join('\n')}
});`);
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'Settings.test.tsx', '--web-host', path.join(root, 'tests/settings-catalog-remote-host.js')], { cwd: directory, encoding: 'utf8', timeout: 60_000 });
    expect(result.error, result.stdout + result.stderr).toBeUndefined(); expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('catalog scans authenticate with metadata, invalidate edited scans, add/remove latest sources and preserve other catalogs', () => run([
  'await app.press("id:skills-catalog-more"); await app.waitFor("id:skills-catalog-install-second-skill"); await ready();',
  'await app.press("id:skills-catalog-add"); await app.waitFor("id:skills-catalog-name"); await app.type("id:skills-catalog-name", "Team source"); await app.type("id:skills-catalog-repository", "https://example.invalid/team/private");',
  'app.onDialog(() => "Cancel"); await app.press("id:skills-catalog-panel-close"); expect(app.value("id:skills-catalog-name")).toBe("Team source");',
  'await app.press("id:skills-catalog-scan"); await app.waitFor("id:skills-catalog-scan-identity"); await app.press("role:combobox[Select a Git identity (SSH key)]"); await app.press("text:Team identity"); await app.press("id:skills-catalog-scan"); await app.waitUntil(() => app.enabled("id:skills-catalog-save"));',
  'await app.type("id:skills-catalog-subpath", "tools"); expect(app.enabled("id:skills-catalog-save")).toBe(false); await app.press("id:skills-catalog-scan"); await app.waitUntil(() => app.enabled("id:skills-catalog-save")); await app.press("id:skills-catalog-save"); await app.waitFor("id:skills-catalog-panel", {state:"gone"}); await ready();',
  'let value = await audit(); expect(value.catalogs.length).toBe(2); expect(value.catalogs[0].retained).toBe(7); expect(value.catalogs[1].gitIdentityId).toBe("team-identity"); expect(value.scans.length).toBe(3);',
  'app.onDialog(() => "Remove Catalog"); await app.press("id:skills-catalog-remove"); await app.waitUntil(() => !app.shows("id:skills-catalog-remove")); await ready(); value = await audit(); expect(value.catalogs.length).toBe(1); expect(value.catalogs[0].retained).toBe(7);',
]), 80_000);

test('catalog private identity is initially clean; exact project destination and per-skill conflict decisions survive pending ACK', () => run([
  'await app.press("id:skills-catalog-install-fixture-skill"); await app.waitFor("id:skills-catalog-install-confirm"); await app.waitFor("text:protection=ready;pending=false;dirty=false;picker=true");',
  'await app.press("role:combobox[Destination]"); await app.press("text:Project / Agents"); await app.press("role:combobox[Project]"); await app.press("text:Other workspace");',
  'await app.press("id:skills-catalog-install-confirm"); await app.waitFor("id:skills-conflict-fixture-skill"); await app.press("id:skills-conflicts-overwrite-all");',
  'await app.press("role:combobox[sibling · project · agents]"); await app.press("text:Skip");',
  'await app.press("id:catalog-remote-hold"); await app.press("id:skills-catalog-install-confirm"); await app.waitFor("text:protection=ready;pending=true;dirty=true;picker=true"); expect(app.enabled("id:desktop-settings-close")).toBe(false); expect(app.enabled("id:skills-catalog-panel-close")).toBe(false);',
  'await app.press("id:catalog-remote-release"); await app.waitUntil(() => app.enabled("id:skills-catalog-panel-close")); const value = await audit(); expect(value.installs.length).toBe(2); expect(value.installs[1].body.targetSource).toBe("agents"); expect(value.installs[1].path).toContain("directory=%2Ffixture%2Fother"); expect(value.installs[1].body.conflictDecisions).toEqual({"fixture-skill":"overwrite",sibling:"skip"});',
  'await app.press("id:skills-catalog-panel-close"); await ready();',
]), 80_000);

test('unknown install ACK is never replayed by refresh and preserves the draft until explicit discard', () => run([
  'await app.press("id:skills-catalog-install-fixture-skill"); await app.waitUntil(() => app.enabled("id:skills-catalog-install-confirm")); await app.press("id:catalog-remote-install-unknown"); await app.press("id:skills-catalog-install-confirm"); await app.waitUntil(() => app.enabled("id:skills-catalog-panel-close")); expect(app.enabled("id:skills-catalog-install-confirm")).toBe(false);',
  'app.onDialog(() => "Cancel"); await app.press("id:skills-catalog-panel-close"); expect(app.shows("id:skills-catalog-install-confirm")).toBe(true); expect((await audit()).installs.length).toBe(1);',
  'app.onDialog(() => "Discard"); await app.press("id:skills-catalog-panel-close"); await ready(); await app.press("id:skills-catalog-refresh"); await ready(); expect((await audit()).installs.length).toBe(1);',
]), 80_000);

test('remote devices retain independent snapshots through failures; rename/revoke/cancel/purge use actual Host ACKs', () => run([
  'await remote(); await app.press("id:catalog-remote-clients-fail"); await app.press("id:remote-clients-refresh"); await app.waitFor("id:remote-clients-stale"); expect(app.shows("id:remote-client-desktop")).toBe(true); expect(app.shows("id:remote-pending-old-pending")).toBe(true);',
  'await app.press("id:remote-clients-refresh"); await app.waitFor("id:remote-clients-stale", {state:"gone"}); await app.press("id:remote-client-rename-desktop"); await app.waitFor("id:remote-client-name"); await app.clear("id:remote-client-name"); await app.type("id:remote-client-name", "Edited synthetic desktop");',
  'app.onDialog(() => "Cancel"); await app.press("id:remote-instances-panel-close"); expect(app.value("id:remote-client-name")).toBe("Edited synthetic desktop");',
  'await app.press("id:catalog-remote-write-fail"); await app.press("id:remote-client-name-save"); await app.waitUntil(() => app.enabled("id:remote-client-name-save")); expect(app.value("id:remote-client-name")).toBe("Edited synthetic desktop"); await app.press("id:remote-client-name-save"); await app.waitFor("id:remote-instances-panel", {state:"gone"}); await ready();',
  'app.onDialog(() => "Revoke"); await app.press("id:remote-client-revoke-desktop"); await app.waitUntil(() => !app.enabled("id:remote-client-revoke-desktop")); await ready();',
  'app.onDialog(() => "Cancel"); await app.press("id:remote-pending-cancel-old-pending"); expect(app.shows("id:remote-pending-old-pending")).toBe(true);',
  'app.onDialog(() => "Remove"); await app.press("id:remote-pending-cancel-old-pending"); await app.waitFor("id:remote-pending-old-pending", {state:"gone"}); await ready();',
  'app.onDialog(() => "Clear revoked"); await app.press("id:remote-clients-purge"); await app.waitFor("id:remote-client-revoked", {state:"gone"}); await ready(); const value = await audit(); expect(value.names).toEqual(["Edited synthetic desktop"]); expect(value.revokes).toEqual(["desktop"]); expect(value.cancels).toEqual(["old-pending"]);',
]), 80_000);

test('pairing cannot use stale transports; a single-use QR copies only on request and clears in background', () => run([
  'await remote(); await app.press("id:catalog-remote-transports-fail"); await app.press("id:remote-clients-add"); await app.waitUntil(() => app.enabled("id:remote-instances-panel-close")); expect(app.enabled("id:remote-pair-create")).toBe(false); await app.press("id:remote-instances-panel-close"); await ready();',
  'await app.press("id:remote-clients-add"); await app.waitUntil(() => app.enabled("id:remote-pair-create")); expect(app.clipboard()).toBe(null); await app.press("id:remote-pair-create"); await app.waitFor("id:remote-pair-qr"); expect(app.clipboard()).toBe(null); await app.press("id:remote-pair-copy"); await app.waitUntil(() => app.clipboard() !== null); expect(app.clipboard()).toContain("yuri://connect?");',
  'expect((await audit()).pairings.length).toBe(1); await app.setLifecycle("background"); expect(app.shows("id:remote-pair-qr")).toBe(false); expect(app.shows("id:remote-pair-copy")).toBe(false); await app.setLifecycle("active"); expect(app.shows("id:remote-pair-qr")).toBe(false); expect(app.enabled("id:remote-pair-create")).toBe(false);',
]), 80_000);

test('pending read failure cannot fake redemption, and a late pairing ACK cannot restore a cleared secret', () => run([
  'await remote(); await app.press("id:remote-clients-add"); await app.waitUntil(() => app.enabled("id:remote-pair-create")); await app.press("id:remote-pair-create"); await app.waitFor("id:remote-pair-qr");',
  'await app.press("id:catalog-remote-pending-fail"); await app.press("id:remote-clients-refresh"); await app.waitFor("id:remote-clients-stale"); expect(app.shows("id:remote-pair-qr")).toBe(true); expect(app.shows("id:remote-pending-created-pair")).toBe(true);',
  'await app.press("id:remote-instances-panel-close"); await ready(); await app.press("id:remote-clients-add"); await app.waitUntil(() => app.enabled("id:remote-pair-create")); await app.press("id:catalog-remote-hold"); await app.press("id:remote-pair-create"); await app.waitFor("text:protection=ready;pending=true;dirty=true;picker=true");',
  'await app.setLifecycle("background"); await app.setLifecycle("active"); await app.press("id:catalog-remote-release"); await app.waitUntil(() => app.enabled("id:remote-instances-panel-close")); expect(app.shows("id:remote-pair-qr")).toBe(false); expect(app.shows("id:remote-pair-copy")).toBe(false); expect(app.enabled("id:remote-pair-create")).toBe(false); expect((await audit()).pairings.length).toBe(2);',
]), 80_000);

test('unconfirmed pairing POST remains single-shot while refresh only reads and Cancel retains the draft', () => run([
  'await remote(); await app.press("id:remote-clients-add"); await app.waitUntil(() => app.enabled("id:remote-pair-create")); await app.press("id:catalog-remote-pair-unknown"); await app.press("id:remote-pair-create"); await app.waitUntil(() => app.enabled("id:remote-instances-panel-close")); expect(app.enabled("id:remote-pair-create")).toBe(false);',
  'await app.press("id:remote-clients-refresh"); await app.waitUntil(() => app.enabled("id:remote-instances-panel-close")); expect((await audit()).pairings.length).toBe(1); app.onDialog(() => "Cancel"); await app.press("id:remote-instances-panel-close"); expect(app.shows("id:remote-pair-create")).toBe(true);',
  'app.onDialog(() => "Discard"); await app.press("id:remote-instances-panel-close"); await ready(); expect(app.enabled("id:desktop-settings-close")).toBe(true);',
]), 80_000);
