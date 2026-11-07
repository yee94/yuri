import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { prepareSessionSwitcherFixture } from './tests/session-switcher-fixture-config.mjs';

// Never run by default. This session intentionally authorizes compile/pure checks only.
it.skipIf(process.env.NSH_SESSION_SWITCHER_ENGINE !== '1')('production catalog/header/Chat draft owners: switch and system Back retain the original draft', () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(path.join(parent, 'session-switcher-engine-'));
  try {
    const fixture = prepareSessionSwitcherFixture(root, directory);
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', fixture.entry, '--web-host', fixture.host], { cwd: directory, encoding: 'utf8', timeout: 75_000, input: [
      'await app.waitFor("text:ready");',
      'await app.type("id:session-switcher-draft", "Keep the original Chat draft");',
      'await app.press("id:chat-header-metadata"); await app.waitFor("text:28.9K/400.0K");',
      'await app.press("id:chat-header-metadata");',
      'await app.press("id:session-switcher-open"); await app.waitFor("id:project-session-ses_a");',
      'await app.press("id:project-session-ses_a"); await app.waitFor("id:session-switcher-draft");',
      'expect(app.value("id:session-switcher-draft")).toBe("Keep the original Chat draft");',
      'await app.press("id:session-switcher-open"); await app.waitFor("id:project-session-ses_b");',
      'await app.press("id:project-session-ses_b"); await app.waitUntil(() => app.texts().includes("/workspace/second"));',
      'expect(app.value("id:session-switcher-draft")).toBe("");',
      'await app.back(); await app.waitFor("id:session-switcher-draft");',
      'expect(app.value("id:session-switcher-draft")).toBe("Keep the original Chat draft");',
      `await app.press("id:session-switcher-audit"); await app.waitUntil(() => app.texts().some(text => text.startsWith(${JSON.stringify('{"requests":')})));`,
      `const audit = JSON.parse(app.texts().find(text => text.startsWith(${JSON.stringify('{"requests":')})));`,
      'expect(audit.rejected).toBe(0); expect(audit.requests.every(row => row.method === "GET")).toBe(true);',
      'expect(app.texts().join("\\n")).not.toMatch(/Unexpected fixture|HTTP 503|ReferenceError|TypeError|capability.*denied/i);',
    ].join('\n') });
    expect(result.error, result.stdout + result.stderr).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 100_000);
