import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expect, test } from 'vitest';
import { prepareCollectionsFixture } from './tests/settings-collections-fixture-config.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
function run(steps: string[]) {
  const parent = path.join(process.env.TMPDIR || tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true });
  const temporary = mkdtempSync(path.join(parent, 'settings-collections-'));
  try {
    const fixture = prepareCollectionsFixture(directory, temporary);
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', fixture.entry, '--web-host', fixture.host], { cwd: temporary, input: steps.join('\n'), encoding: 'utf8', timeout: 60_000 });
    expect(result.error, result.stdout + result.stderr).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
// Prepared only: this file launches NSH. Do not include it in pure Vitest commands.
test('production Agent editor displays object model/variant and stored prompt; patches one field', () => run([
  'await app.waitFor("text:review");', 'await app.press("text:review");', 'await app.waitFor("id:settings-model");',
  'expect(app.value("id:settings-model")).toBe("example/model#deep");',
  'expect(app.value("id:settings-system")).toBe("Stored fixture prompt");',
  'await app.waitUntil(() => app.enabled("id:settings-description"));', 'await app.type("id:settings-description", "Edited fixture");', 'await app.waitUntil(() => app.enabled("text:Save"));', 'await app.press("text:Save");',
  'await app.waitFor("text:Done");', 'await app.press("id:collections-fixture-audit");',
  'await app.waitUntil(() => app.texts().some(text => text.includes("\\"agentWrites\\":1")));',
]), 75_000);

test('production saved-permission revoke failure retains row and explicit retry removes it', () => run([
  'await app.waitFor("text:npm fixture");', 'await app.waitUntil(() => app.enabled("id:saved-permission-delete-saved-fixture"));', 'await app.press("id:saved-permission-delete-saved-fixture");',
  'await app.waitFor("text:Could not delete saved permission");', 'expect(app.texts().join("\\n")).toContain("npm fixture");',
  'await app.press("id:saved-permissions-refresh");', 'await app.waitFor("id:saved-permission-delete-saved-fixture");', 'await app.waitUntil(() => app.enabled("id:saved-permission-delete-saved-fixture"));',
  'await app.press("id:saved-permission-delete-saved-fixture");', 'await app.waitFor("text:No saved permissions for this project");',
]), 75_000);

test('production MCP JSON parse/cancel never writes or connects; reviewed import retains OAuth', () => {
  const source = JSON.stringify({ mcp: { imported: { type: 'remote', url: 'https://mcp.example.test', oauth: { clientId: 'example-client', scope: 'read write', redirectUri: 'https://callback.example.test' } } } });
  run([
    'await app.press("id:collections-fixture-mcp");', 'await app.waitFor("id:mcp-import-open");', 'await app.waitUntil(() => app.enabled("id:mcp-import-open"));', 'await app.press("id:mcp-import-open");',
    'await app.waitFor("id:mcp-import-sheet");', 'await app.waitFor("id:mcp-import-source");',
    'await app.type("id:mcp-import-source", "{invalid");', 'await app.press("id:mcp-import-apply");',
    'await app.waitUntil(() => app.texts().some(text => text.includes("Cannot import this MCP configuration")));', 'app.onDialog(() => "Discard"); await app.press("id:mcp-import-cancel");',
    'await app.waitUntil(() => !app.shows("id:mcp-import-source"));',
    'await app.press("id:collections-fixture-audit");', 'await app.waitUntil(() => app.texts().some(text => text.includes("\\"mcpWrites\\":0")));',
    'await app.waitUntil(() => app.enabled("id:mcp-import-open"));', 'await app.press("id:mcp-import-open");', 'await app.waitFor("id:mcp-import-source");', `await app.type("id:mcp-import-source", ${JSON.stringify(source)});`,
    'await app.press("id:mcp-import-apply");', 'await app.waitFor("id:mcp-oauth-scope");',
    'expect(app.value("id:mcp-oauth-scope")).toBe("read write");',
    'await app.waitUntil(() => !app.shows("id:mcp-import-source"));',
    'await app.press("id:collections-fixture-audit");', 'await app.waitUntil(() => app.texts().some(text => text.includes("\\"mcpWrites\\":0")));',
    'await app.waitUntil(() => app.enabled("text:Save"));', 'await app.press("text:Save");', 'await app.waitFor("text:Done");',
    'await app.press("id:collections-fixture-audit");', 'await app.waitUntil(() => app.texts().some(text => text.includes("\\"mcpWrites\\":1")));',
  ]);
}, 75_000);

test('production plugin status exposes full failure/copy, real reload and in-place package update', () => run([
  'await app.press("id:collections-fixture-plugins");', 'await app.waitFor("text:example-plugin@latest");',
  'await app.press("text:example-plugin@latest");', 'await app.waitFor("text:Failed to load");',
  'await app.press("text:Expand (3 lines)");', 'await app.waitUntil(() => app.texts().some(text => text.includes("Third detail")));',
  'await app.press("id:plugin-copy-error");', 'await app.waitFor("text:Error copied");',
  'await app.press("id:plugin-runtime-refresh");', 'await app.press("id:collections-fixture-audit");',
  'await app.waitUntil(() => app.texts().some(text => text.includes("\\"reloads\\":0")));', 'await app.waitUntil(() => app.enabled("id:plugin-reload"));', 'await app.press("id:plugin-reload");',
  'await app.waitFor("text:Reloaded");', 'await app.waitUntil(() => app.enabled("id:plugin-update"));', 'await app.press("id:plugin-update");',
  'await app.waitFor("text:Loaded · 2.0.0");', 'await app.press("id:collections-fixture-audit");',
  'await app.waitUntil(() => app.texts().some(text => text.includes("\\"updates\\":1")));',
]), 75_000);
