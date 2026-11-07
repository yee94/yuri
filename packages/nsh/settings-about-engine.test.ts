import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expect, test } from 'vitest';
import { prepareAboutFixture } from './tests/settings-about-fixture-config.mjs';

/** Prepared for main. Opt-in only; this task must not launch an NSH engine. */
test.skipIf(process.env.NSH_ABOUT_ENGINE !== '1')('production About exposes real identities, unsupported client updates, and safe export recovery', () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const temporary = mkdtempSync(path.join(process.env.OPENCODE_TMP_DIR || tmpdir(), 'nsh-about-engine-'));
  try {
    const fixture = prepareAboutFixture(root, temporary);
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', fixture.entry, '--web-host', fixture.host], { cwd: temporary, timeout: 75_000, encoding: 'utf8', input: [
      'await app.waitFor("id:about-fixture-ready");', 'expect(app.shows("id:about-fixture-admission-error")).toBe(false);',
      'await app.waitFor("text:0.8.1 (42)");', 'await app.waitFor("text:2.3.0");',
      'expect(app.texts().join("\\n")).toContain("2.1.7");',
      'expect(app.enabled("id:about-client-update")).toBe(true);',
      'await app.press("id:about-client-update"); await app.waitFor("id:about-client-unsupported");',
      'app.onDialog(() => "Cancel"); await app.press("id:about-host-update");',
      'await app.press("id:about-fixture-audit"); await app.waitUntil(() => app.texts().some(text => text.includes("\\"submissions\\":0")));',
      'app.onDialog(() => "Update and restart"); await app.press("id:about-host-update"); await app.waitFor("id:about-host-progress");',
      'await app.press("id:about-fixture-update-failed"); await app.press("id:about-host-check"); await app.waitFor("id:about-host-update");',
      'await app.press("id:about-host-update"); await app.waitFor("id:about-host-progress");',
      'await app.press("id:about-fixture-update-succeeded"); await app.press("id:about-host-check"); await app.waitFor("text:Update complete");',
      'await app.press("id:about-diagnostics-toggle");', 'await app.waitFor("id:about-export");',
      'await app.press("id:about-fixture-event");',
      'await app.press("id:about-fixture-export-cancelled");', 'await app.press("id:about-export");',
      'await app.waitUntil(() => app.enabled("id:about-export"));', 'expect(app.shows("id:about-export-success")).toBe(false);',
      'await app.press("id:about-fixture-export-failed");', 'await app.press("id:about-export");', 'await app.waitFor("id:about-export-error");',
      'await app.press("id:about-fixture-export-shared");', 'await app.press("id:about-export");', 'await app.waitFor("id:about-export-success");',
      'await app.press("id:about-fixture-fail-info");', 'await app.press("id:about-refresh");',
      'await app.waitFor("text:Could not refresh this information. The last confirmed value is kept; retry to refresh.");',
      'expect(app.texts().join("\\n")).toContain("2.3.0");',
      'await app.press("id:about-fixture-missing");', 'await app.press("id:about-refresh");',
      'await app.waitUntil(() => app.texts().filter(text => text === "unknown").length >= 2);',
      'await app.press("id:about-fixture-audit");',
      'await app.waitUntil(() => app.texts().some(text => text.includes("\\"exports\\":3")));',
    ].join('\n') });
    expect(result.error, result.stdout + result.stderr).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}, 90_000);
