import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const root = path.dirname(fileURLToPath(import.meta.url));
function run(steps: string[], extended = false, width = 1280) {
  const parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(path.join(parent, 'desktop-settings-content-'));
  try {
    writeFileSync(path.join(directory, 'nsh.json'), JSON.stringify({ name: 'Desktop Settings content fixture', id: 'example.yuri.desktop-settings-content', version: '0.1.0', build: 1, theme: path.join(root, 'theme.json'), capabilities: { host: ['connection.list', 'runtime.request', 'projectSettings.fixture.audit', 'desktopSettings.fixture.scenario', 'voiceRecognition.capabilities', 'native.clientMetadata', 'native.diagnostics.status', 'notification.status', 'notification.configure', 'notification.test'] } }));
    writeFileSync(path.join(directory, 'App.tsx'), `import ${JSON.stringify(path.join(root, 'desktop-settings-content-fixture.tsx'))};`);
    writeFileSync(path.join(directory, 'host-entry.js'), `
import { createHost as createProjectHost } from ${JSON.stringify(path.join(root, 'tests/project-settings-host.js'))};
import { createSettingsProtectionFixtureHost } from ${JSON.stringify(path.join(root, 'settings-desktop-protection-host.ts'))};
export function createHost() {
  const base = createProjectHost({ writeFailures: 0, readbackFailures: 1 });
  const extended = ${extended ? 'createSettingsProtectionFixtureHost()' : 'null'};
  const scope = { hostID: 'desktop-settings-fixture', lease: 'fixture-only-memory-lease' };
  let hold = false, release = null, preferences = { fontSize: 100 };
  return { call(name, input = {}) {
    if (name === 'connection.list') return { selected: scope.hostID, runtimeScope: scope, connections: [{ id: scope.hostID, label: 'Synthetic Settings Host', url: 'https://settings.example.invalid', lastUsedAt: 0 }] };
    if (name === 'voiceRecognition.capabilities') return { providers: ['local'], maximumSeconds: 60, maximumBytes: 1920000 };
    if (name === 'native.clientMetadata') return { schemaVersion: 1, version: '1.0.0', build: '1', updates: { status: 'unsupported' } };
    if (name === 'native.diagnostics.status') return { schemaVersion: 2, enabled: false, mode: 'event-recorder', recordingLease: null };
    if (name === 'notification.status') return { authorization: 'authorized', alert: 'enabled', sound: 'enabled', badge: 'enabled', backgroundPush: false };
    if (name === 'notification.configure') return { lease: 'synthetic-notification-lease' };
    if (name === 'notification.test') { const result = { result: 'scheduled' }; if (hold) { hold = false; return new Promise(resolve => { release = () => resolve(result); }); } return result; }
    if (name === 'desktopSettings.fixture.scenario') {
      if (input.mode === 'hold-write') hold = true;
      else if (input.mode === 'release-write') { if (!release) throw new Error('No held write'); const done = release; release = null; done(); }
      else throw new Error('Unknown scenario');
      return null;
    }
    if (name === 'runtime.request') {
      if (input.expectedHost?.hostID !== scope.hostID || input.expectedHost?.lease !== scope.lease) throw new Error('Fixture scope mismatch');
      if (extended) { const response = extended(input); if (response) { if (input.path === '/api/config/settings') response.body = { ...base.call(name, { ...input, method: 'GET' }).body, ...response.body }; if (hold && input.method !== 'GET') { hold = false; return new Promise(resolve => { release = () => resolve(response); }); } return response; } }
      if (input.path === '/api/config/themes') return { status: 200, body: { themes: [] } };
      if (input.path === '/api/config/settings') {
        if (input.method === 'PUT') preferences = { ...preferences, ...input.body };
        return { status: 200, body: { ...base.call(name, { ...input, method: 'GET' }).body, ...preferences } };
      }
      if (input.path.startsWith('/api/fs/write') && hold) {
        hold = false; const response = base.call(name, input);
        return new Promise(resolve => { release = () => resolve(response); });
      }
    }
    return base.call(name, input);
  } };
}`);
    const host = path.join(directory, 'host.js');
    const build = spawnSync('bun', ['build', path.join(directory, 'host-entry.js'), '--target=browser', '--format=esm', '--outfile', host], { encoding: 'utf8', timeout: 30_000 });
    expect(build.status, build.stdout + build.stderr).toBe(0);
    writeFileSync(path.join(directory, 'Content.test.tsx'), `import { expect, open, test } from 'nsh/test';
test('actual SettingsPage contents and owner guards', async () => {
const app = await open('./App.tsx', { platform: 'macos', width: ${width}, height: 1000 });
${steps.join('\n')}
});`);
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'Content.test.tsx', '--web-host', host], { cwd: directory, encoding: 'utf8', timeout: 95_000 });
    expect(result.error, result.stdout + result.stderr).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
const engine = process.env.NSH_DESKTOP_SETTINGS_ENGINE === '1' ? test : test.skip;

engine.each([1280, 800])('entity lists remain mounted beside the same guarded editor at window width %s', width => run([
  'const ready = async () => { await app.waitFor("text:protection=ready;pending=false;dirty=false;picker=false"); }; await ready();',
  'expect(app.shows("id:settings-entity-list")).toBe(true); expect(app.shows("id:settings-project-label")).toBe(true);',
  'for (const [page, query] of [["agents", "Agents"], ["commands", "Commands"], ["mcp", "MCP"], ["plugins", "Plugins"], ["skills.installed", "Skills"]]) { const input = page === "plugins" ? "id:settings-spec" : "id:settings-description";',
  'await app.type("id:desktop-settings-search", query); await app.press("id:desktop-settings-page:" + page); await app.clear("id:desktop-settings-search"); await ready();',
  'await app.waitFor("id:settings-entity-fixture"); expect(app.shows("id:settings-entity-list")).toBe(true); expect(app.shows("id:settings-entity-detail")).toBe(true);',
  'await app.press("id:settings-entity-fixture"); await ready(); await app.waitFor(input); expect(app.shows("id:settings-entity-fixture")).toBe(true);',
  'await app.type(input, " preserve draft"); const draft = app.value(input); await app.waitFor("text:protection=ready;pending=false;dirty=true;picker=false");',
  'app.onDialog(() => "Cancel"); await app.press("id:settings-entity-create"); expect(app.value(input)).toBe(draft);',
  'app.onDialog(() => "Discard"); await app.press("id:settings-entity-create"); await ready(); await app.waitFor("id:settings-entity-fixture"); expect(app.value(input)).toBe("");',
  '}',
  'await app.type("id:desktop-settings-search", "Providers"); await app.press("id:desktop-settings-page:providers"); await app.clear("id:desktop-settings-search"); await ready();',
  'await app.press("id:settings-entity-fixture"); await ready(); await app.waitFor("id:settings-provider-filter"); expect(app.shows("id:settings-entity-fixture")).toBe(true);',
  'await app.press("id:settings-entity-create"); await ready(); await app.type("id:settings-provider-name", "Keep custom provider"); app.onDialog(() => "Cancel"); await app.press("id:settings-entity-fixture"); expect(app.value("id:settings-provider-name")).toBe("Keep custom provider");',
  'app.onDialog(() => "Discard"); await app.type("id:desktop-settings-search", "Magic Prompts"); await app.press("id:desktop-settings-page:magic-prompts"); await app.clear("id:desktop-settings-search"); await ready();',
  'await app.press("id:magic-group-git.commit.generate"); await ready(); await app.waitFor("id:magic-draft-visible"); expect(app.shows("id:magic-group-git.commit.generate")).toBe(true); expect(app.shows("id:settings-entity-list")).toBe(true);',
], true, width), 120_000);

engine('desktop Appearance uses real local code scale, retains Cancel drafts, and does not enable disconnected consumers', () => run([
  'await app.waitFor("id:settings-project-label"); await app.waitFor("text:protection=ready;pending=false;dirty=false;picker=false");',
  'await app.press("id:desktop-settings-page:appearance"); await app.waitFor("id:settings-basics-codeFontSize"); await app.waitFor("text:protection=ready;pending=false;dirty=false;picker=false");',
  'expect(app.texts()).not.toContain("Native iOS experience"); expect(app.shows("id:settings-preference-iosNativeUiEnabled")).toBe(false);',
  'for (const key of ["editorFontSize", "terminalFontSize", "padding", "inputBarOffset"]) expect(app.enabled("id:settings-basics-" + key)).toBe(false);',
  'expect(app.enabled("id:settings-basics-codeFontSize")).toBe(false); await app.press("id:content-fixture-code-ready"); expect(app.enabled("id:settings-basics-codeFontSize")).toBe(true); expect(app.value("id:settings-basics-codeFontSize")).toBe("100");',
  'await app.clear("id:settings-basics-codeFontSize"); await app.type("id:settings-basics-codeFontSize", "150"); await app.waitFor("text:protection=ready;pending=false;dirty=true;picker=false");',
  'app.onDialog(() => "Cancel"); await app.press("id:desktop-settings-close"); expect(app.value("id:settings-basics-codeFontSize")).toBe("150"); expect(app.texts()).toContain("code-font-size=12");',
  'await app.press("id:settings-preferences-save"); await app.waitFor("text:protection=ready;pending=false;dirty=false;picker=false"); expect(app.texts()).toContain("code-font-size=18");',
  'await app.press("id:desktop-settings-close"); await app.waitFor("id:desktop-settings-window", {state:"gone"}); await app.press("id:content-fixture-reopen"); await app.waitFor("id:settings-basics-codeFontSize"); await app.waitFor("text:protection=ready;pending=false;dirty=false;picker=false"); expect(app.value("id:settings-basics-codeFontSize")).toBe("150");',
], true), 120_000);

engine('global config uses the real native Editor, guards reload/close and waits for the exact Host ACK', () => run([
  'await app.waitFor("id:settings-project-label"); await app.waitFor("text:protection=ready;pending=false;dirty=false;picker=false");',
  'await app.type("id:desktop-settings-search", "Global Configuration"); await app.press("id:desktop-settings-page:global-config"); await app.clear("id:desktop-settings-search"); await app.waitFor("id:global-config-editor"); await app.waitFor("text:protection=ready;pending=false;dirty=false;picker=false");',
  'await app.type("id:global-config-editor", "// local edit"); await app.waitFor("text:protection=ready;pending=false;dirty=true;picker=false");',
  'app.onDialog(() => "Cancel"); await app.press("id:global-config-reload"); expect(app.value("id:global-config-editor")).toContain("local edit");',
  'await app.press("id:desktop-settings-close"); expect(app.shows("id:desktop-settings-window")).toBe(true);',
  'await app.press("id:content-fixture-hold"); await app.press("id:global-config-save"); await app.waitFor("text:protection=ready;pending=true;dirty=true;picker=false"); expect(app.enabled("id:desktop-settings-close")).toBe(false);',
  'await app.press("id:content-fixture-release"); await app.waitFor("text:protection=ready;pending=false;dirty=false;picker=false");',
  'await app.press("id:global-config-reload"); await app.waitFor("text:protection=ready;pending=false;dirty=false;picker=false"); expect(app.value("id:global-config-editor")).toContain("local edit");',
  'await app.press("id:desktop-settings-close"); await app.waitFor("id:desktop-settings-window", {state:"gone"});',
], true), 120_000);

engine('actual Projects and Appearance/Chat close and navigate clean, retain denied dirty drafts, and own Select Escape', () => run([
  'await app.waitFor("id:settings-project-label");',
  'await app.waitFor("text:protection=ready;pending=false;dirty=false;picker=false");',
  'await app.press("id:desktop-settings-close"); await app.waitFor("id:desktop-settings-window", { state: "gone" });',
  'expect(app.texts()).toContain("closes=1;navigations=0");',
  'await app.press("id:content-fixture-reopen"); await app.waitFor("id:settings-project-label");',
  'await app.clear("id:settings-project-label"); await app.type("id:settings-project-label", "Project dirty draft");',
  'await app.waitFor("text:protection=ready;pending=false;dirty=true;picker=false");',
  'app.onDialog(() => "Cancel"); await app.press("id:desktop-settings-page:appearance");',
  'expect(app.texts()).toContain("route=projects;entity=catalog-do-not-use"); expect(app.value("id:settings-project-label")).toBe("Project dirty draft");',
  'app.onDialog(() => "Discard"); await app.press("id:desktop-settings-page:appearance");',
  'await app.waitFor("id:settings-basics-fontSize"); await app.waitFor("text:protection=ready;pending=false;dirty=false;picker=false");',
  'await app.press("role:combobox[Select language]"); await app.waitFor("text:protection=ready;pending=false;dirty=false;picker=true");',
  'expect(app.texts()).toContain("page-active=true"); await app.wait(100); expect(app.texts()).toContain("protection=ready;pending=false;dirty=false;picker=true");',
  'expect(app.enabled("id:desktop-settings-close")).toBe(false); expect(app.enabled("id:desktop-settings-page:chat")).toBe(false);',
  'await app.keyboard.press("escape"); await app.waitFor("text:protection=ready;pending=false;dirty=false;picker=false");',
  'expect(app.enabled("id:desktop-settings-close")).toBe(true); expect(app.enabled("id:desktop-settings-page:chat")).toBe(true);',
  'expect(app.shows("id:desktop-settings-window")).toBe(true);',
  'await app.clear("id:settings-basics-fontSize"); await app.type("id:settings-basics-fontSize", "125");',
  'await app.waitFor("text:protection=ready;pending=false;dirty=true;picker=false");',
  'app.onDialog(() => "Cancel"); await app.keyboard.press("escape");',
  'expect(app.value("id:settings-basics-fontSize")).toBe("125");',
  'await app.press("id:settings-preferences-save"); await app.waitFor("text:protection=ready;pending=false;dirty=false;picker=false");',
  'await app.press("id:desktop-settings-page:chat"); await app.waitFor("text:route=chat;entity=");',
  'await app.waitFor("text:protection=ready;pending=false;dirty=false;picker=false");',
  'await app.press("id:desktop-settings-close"); await app.waitFor("id:desktop-settings-window", { state: "gone" });',
  'expect(app.texts()).toContain("closes=2;navigations=2");',
]), 120_000);

engine('actual project save and uncertain read-back block Window Escape/page changes until explicit read-only reconciliation', () => run([
  'await app.waitFor("id:project-setup-wait"); await app.waitFor("text:protection=ready;pending=false;dirty=false;picker=false");',
  'await app.press("id:content-fixture-hold"); await app.press("id:project-setup-wait");',
  'await app.waitFor("text:protection=ready;pending=true;dirty=true;picker=false");',
  'expect(app.enabled("id:desktop-settings-close")).toBe(false); expect(app.enabled("id:desktop-settings-page:chat")).toBe(false);',
  'await app.keyboard.press("escape"); expect(app.shows("id:desktop-settings-window")).toBe(true);',
  'await app.press("id:content-fixture-release"); await app.waitFor("text:HTTP 503: Fixture read-back unavailable");',
  'expect(app.enabled("id:desktop-settings-close")).toBe(false);',
  'await app.press("id:project-setup-save"); await app.waitFor("text:protection=ready;pending=false;dirty=false;picker=false");',
  'await app.press("id:content-fixture-audit"); await app.waitUntil(() => app.texts().some(text => text.includes("\\\"writes\\\":1")));',
  'await app.press("id:desktop-settings-close"); await app.waitFor("id:desktop-settings-window", { state: "gone" });',
  'expect(app.texts()).toContain("closes=1;navigations=0");',
]), 120_000);

engine('actual Collection lists/details protect edited and reverted drafts, save then return after busy has ended', () => run([
  'await app.waitFor("id:settings-project-label"); await app.waitFor("text:protection=ready;pending=false;dirty=false;picker=false");',
  'const ready = async () => app.waitFor("text:protection=ready;pending=false;dirty=false;picker=false");',
  'const go = async (page, query) => { await app.clear("id:desktop-settings-search"); await app.type("id:desktop-settings-search", query); await app.press("id:desktop-settings-page:" + page); await app.clear("id:desktop-settings-search"); await ready(); };',
  'for (const [page, query, field] of [["agents", "Agents", "description"], ["commands", "Commands", "description"], ["mcp", "MCP", "url"], ["plugins", "Plugins", "spec"], ["skills.installed", "Skills", "description"]]) {',
  'await go(page, query); await app.press("id:content-fixture-detail"); await app.waitFor("id:settings-" + field); await ready();',
  'const input = "id:settings-" + field, original = app.value(input); await app.type(input, " edited"); await app.waitFor("text:protection=ready;pending=false;dirty=true;picker=false");',
  'app.onDialog(() => "Cancel"); await app.press("id:content-fixture-list"); expect(app.value(input)).toBe(original + " edited");',
  'await app.clear(input); await app.type(input, original); await ready();',
  'await app.type(input, " saved"); await app.waitFor("text:protection=ready;pending=false;dirty=true;picker=false");',
  'await app.press("id:content-fixture-hold"); await app.press("text:Save"); await app.waitFor("text:protection=ready;pending=true;dirty=true;picker=false"); expect(app.enabled("id:desktop-settings-close")).toBe(false); await app.keyboard.press("escape"); expect(app.shows("id:desktop-settings-window")).toBe(true); await app.press("id:content-fixture-release");',
  'await app.waitFor("text:Done"); await ready(); await app.press("text:Done"); await ready(); expect(app.texts()).toContain("route=" + page + ";entity=");',
  '}',
  'await app.press("id:desktop-settings-close"); await app.waitFor("id:desktop-settings-window", { state: "gone" });',
], true), 120_000);

engine('real model and skill-file popup owners confirm before closing without deactivating the page', () => run([
  'await app.waitFor("id:settings-project-label"); await app.waitFor("text:protection=ready;pending=false;dirty=false;picker=false");',
  'const go = async (page, query) => { await app.clear("id:desktop-settings-search"); await app.type("id:desktop-settings-search", query); await app.press("id:desktop-settings-page:" + page); await app.clear("id:desktop-settings-search"); await app.waitFor("text:protection=ready;pending=false;dirty=false;picker=false"); };',
  'await go("providers", "Providers"); await app.press("id:content-fixture-create"); await app.waitFor("text:Add model"); await app.press("text:Add model"); await app.waitFor("id:settings-model-name");',
  'await app.type("id:settings-model-name", "Uncommitted model"); await app.waitFor("text:protection=ready;pending=false;dirty=true;picker=true"); app.onDialog(() => "Cancel"); await app.press("id:settings-model-cancel"); expect(app.value("id:settings-model-name")).toBe("Uncommitted model");',
  'app.onDialog(() => "Discard"); await app.keyboard.press("escape"); await app.waitFor("text:protection=ready;pending=false;dirty=false;picker=false"); expect(app.shows("id:desktop-settings-window")).toBe(true);',
  'await go("skills.installed", "Skills"); await app.press("id:content-fixture-detail"); await app.waitFor("text:Add File"); await app.press("text:Add File"); await app.waitFor("id:settings-skill-file-content");',
  'await app.type("id:settings-skill-file-content", "Uncommitted file"); await app.waitFor("text:protection=ready;pending=false;dirty=true;picker=true"); app.onDialog(() => "Cancel"); await app.press("id:settings-skill-file-cancel"); expect(app.value("id:settings-skill-file-content")).toBe("Uncommitted file");',
  'app.onDialog(() => "Discard"); await app.press("id:settings-skill-file-cancel"); await app.waitFor("text:protection=ready;pending=false;dirty=false;picker=false"); await app.press("id:desktop-settings-close"); await app.waitFor("id:desktop-settings-window", { state: "gone" });',
], true), 120_000);

engine('Provider auth input survives model editor cover, then its real pending save blocks the outer Window', () => run([
  'await app.waitFor("id:settings-project-label"); await app.waitFor("text:protection=ready;pending=false;dirty=false;picker=false");',
  'await app.type("id:desktop-settings-search", "Providers"); await app.press("id:desktop-settings-page:providers"); await app.clear("id:desktop-settings-search"); await app.waitFor("text:protection=ready;pending=false;dirty=false;picker=false");',
  'await app.press("id:content-fixture-detail"); await app.waitFor("id:integration-api-key"); await app.waitFor("text:protection=ready;pending=false;dirty=false;picker=false");',
  'await app.type("id:integration-api-key", "synthetic-not-a-credential"); await app.waitFor("text:protection=ready;pending=false;dirty=true;picker=false");',
  'await app.press("text:Fixture model"); await app.waitFor("id:settings-model-name"); await app.type("id:settings-model-name", " edited"); app.onDialog(() => "Cancel"); await app.press("id:settings-model-cancel"); expect(app.value("id:settings-model-name")).toContain("edited");',
  'app.onDialog(() => "Discard"); await app.press("id:settings-model-cancel"); await app.waitFor("text:protection=ready;pending=false;dirty=true;picker=false"); expect(app.value("id:integration-api-key")).toBe("synthetic-not-a-credential");',
  'await app.press("id:content-fixture-hold"); await app.press("id:integration-save-key"); await app.waitFor("text:protection=ready;pending=true;dirty=true;picker=false"); expect(app.enabled("id:desktop-settings-close")).toBe(false); await app.press("id:content-fixture-release"); await app.waitFor("text:protection=ready;pending=false;dirty=false;picker=false");',
  'await app.press("id:desktop-settings-close"); await app.waitFor("id:desktop-settings-window", { state: "gone" });',
], true), 120_000);

engine('actual notification preferences and native permission/test busy publish to Window without a real system prompt', () => run([
  'await app.waitFor("id:settings-project-label"); await app.waitFor("text:protection=ready;pending=false;dirty=false;picker=false");',
  'await app.type("id:desktop-settings-search", "Notifications"); await app.press("id:desktop-settings-page:notifications"); await app.clear("id:desktop-settings-search"); await app.waitFor("id:notification-enable"); await app.waitFor("text:protection=ready;pending=false;dirty=false;picker=false");',
  'await app.press("id:notification-enable"); await app.waitFor("text:protection=ready;pending=false;dirty=true;picker=false"); app.onDialog(() => "Cancel"); await app.press("id:desktop-settings-close"); expect(app.shows("id:desktop-settings-window")).toBe(true);',
  'await app.press("id:content-fixture-hold"); await app.press("id:settings-notifications-save"); await app.waitFor("text:protection=ready;pending=true;dirty=true;picker=false"); expect(app.enabled("id:desktop-settings-close")).toBe(false); await app.press("id:content-fixture-release"); await app.waitFor("text:protection=ready;pending=false;dirty=false;picker=false");',
  'await app.press("id:content-fixture-hold"); await app.press("id:notification-test"); await app.waitFor("text:protection=ready;pending=true;dirty=false;picker=false"); expect(app.enabled("id:desktop-settings-close")).toBe(false); await app.press("id:content-fixture-release"); await app.waitFor("text:protection=ready;pending=false;dirty=false;picker=false");',
  'await app.press("id:desktop-settings-close"); await app.waitFor("id:desktop-settings-window", { state: "gone" });',
], true), 120_000);

engine('actual Basics, Summary, Git, Usage, Magic, Archive and About publish live page protection', () => run([
  'await app.waitFor("id:settings-project-label"); await app.waitFor("text:protection=ready;pending=false;dirty=false;picker=false");',
  'const ready = async () => app.waitFor("text:protection=ready;pending=false;dirty=false;picker=false");',
  'const go = async (page, query) => { await app.clear("id:desktop-settings-search"); await app.type("id:desktop-settings-search", query); await app.press("id:desktop-settings-page:" + page); await app.clear("id:desktop-settings-search"); await ready(); };',
  'for (const [page, query, input] of [["sessions", "Sessions", "settings-basics-smallModelOverride"], ["summary-ai", "Summary AI", "settings-basics-summaryCommitPrompt"], ["behavior", "Behavior", "settings-behavior-prompt"], ["voice", "Voice", "settings-basics-sttServerUrl"]]) {',
  'await go(page, query); await app.waitFor("id:" + input); await app.type("id:" + input, " fixture draft"); await app.waitFor("text:protection=ready;pending=false;dirty=true;picker=false"); app.onDialog(() => "Cancel"); await app.keyboard.press("escape"); expect(app.value("id:" + input)).toContain("fixture draft"); app.onDialog(() => "Discard"); await app.press("id:desktop-settings-close"); await app.waitFor("id:desktop-settings-window", { state: "gone" }); await app.press("id:content-fixture-reopen"); await ready();',
  '}',
  'await go("git", "Git"); await app.press("id:content-fixture-detail"); await app.waitFor("id:settings-git-userName"); await ready(); await app.type("id:settings-git-userName", " edited"); await app.waitFor("text:protection=ready;pending=false;dirty=true;picker=false"); await app.press("text:Save"); await ready(); expect(app.texts()).toContain("route=git;entity=");',
  'await go("usage", "Usage"); await app.press("id:usage-magpie-manual"); await app.waitFor("id:usage-magpie-url"); await app.type("id:usage-magpie-url", "https://quota.example.invalid"); await app.waitFor("text:protection=ready;pending=false;dirty=true;picker=false"); app.onDialog(() => "Discard"); await app.press("id:desktop-settings-close"); await app.waitFor("id:desktop-settings-window", { state: "gone" }); await app.press("id:content-fixture-reopen"); await ready();',
  'await go("magic-prompts", "Magic Prompts"); await app.press("id:content-fixture-detail"); await app.waitFor("id:magic-draft-visible"); await ready(); await app.type("id:magic-draft-visible", " edited"); await app.waitFor("text:protection=ready;pending=false;dirty=true;picker=false"); await app.press("id:magic-save-visible"); await ready();',
  'await go("archived-sessions", "Archived sessions"); await ready(); await go("about", "About"); await ready(); await go("instances", "Saved connections"); await ready();',
  'await app.press("id:desktop-settings-close"); await app.waitFor("id:desktop-settings-window", { state: "gone" });',
], true), 120_000);

engine('actual Provider whole-page draft and MCP import popup retain denied input and release only after approval', () => run([
  'await app.waitFor("id:settings-project-label"); await app.waitFor("text:protection=ready;pending=false;dirty=false;picker=false");',
  'const go = async (page, query) => { await app.clear("id:desktop-settings-search"); await app.type("id:desktop-settings-search", query); await app.press("id:desktop-settings-page:" + page); await app.clear("id:desktop-settings-search"); await app.waitFor("text:protection=ready;pending=false;dirty=false;picker=false"); };',
  'await go("providers", "Providers"); await app.press("id:content-fixture-create"); await app.waitFor("id:settings-provider-name");',
  'await app.type("id:settings-provider-name", "Unsaved provider"); await app.waitFor("text:protection=ready;pending=false;dirty=true;picker=false");',
  'app.onDialog(() => "Cancel"); await app.press("id:content-fixture-list"); expect(app.value("id:settings-provider-name")).toBe("Unsaved provider");',
  'app.onDialog(() => "Discard"); await app.press("id:content-fixture-list"); await app.waitFor("text:protection=ready;pending=false;dirty=false;picker=false");',
  'await go("mcp", "MCP"); await app.press("id:content-fixture-create"); await app.waitFor("id:mcp-import-open"); await app.waitFor("text:protection=ready;pending=false;dirty=false;picker=false");',
  'await app.press("id:mcp-import-open"); await app.waitFor("text:protection=ready;pending=false;dirty=false;picker=true");',
  'await app.type("id:mcp-import-source", "{unfinished"); await app.waitFor("text:protection=ready;pending=false;dirty=true;picker=true");',
  'expect(app.enabled("id:desktop-settings-close")).toBe(false); app.onDialog(() => "Cancel"); await app.press("id:mcp-import-cancel"); expect(app.value("id:mcp-import-source")).toBe("{unfinished");',
  'app.onDialog(() => "Discard"); await app.press("id:mcp-import-cancel"); await app.waitFor("text:protection=ready;pending=false;dirty=false;picker=false");',
  'await app.press("id:desktop-settings-close"); await app.waitFor("id:desktop-settings-window", { state: "gone" });',
], true), 120_000);
