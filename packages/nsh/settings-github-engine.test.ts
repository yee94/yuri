import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expect, test } from 'vitest';
import { prepareGitHubFixture } from './tests/settings-github-config.mjs';

/** Main runs this serially and explicitly. Never launches UIKit, a real Host, or a browser. */
test.skipIf(process.env.NSH_GITHUB_ENGINE !== '1')('production Native GitHub and discovered import components use strict synthetic Host', () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const temporary = mkdtempSync(path.join(process.env.OPENCODE_TMP_DIR || tmpdir(), 'nsh-github-engine-'));
  try {
    const fixture = prepareGitHubFixture(root, temporary);
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', fixture.entry, '--web-host', fixture.host], { cwd: temporary, timeout: 75_000, encoding: 'utf8', input: [
      'await app.waitFor("id:github-fixture-ready");', 'expect(app.shows("id:github-fixture-admission-error")).toBe(false);',
      'await app.waitFor("text:Fixture OAuth");',
      'await app.press("id:github-connect");', 'await app.waitFor("id:github-user-code");', 'expect(app.texts().join("\\n")).toContain("FAKE-CODE");', 'expect(app.texts().join("\\n")).not.toContain("synthetic-device-code");',
      'await app.press("id:github-cancel");', 'await app.waitUntil(() => !app.shows("id:github-flow"));',
      'await app.press("id:github-fixture-connected");', 'await app.press("id:github-connect");', 'await app.waitFor("text:Fixture Added");',
      'await app.press("id:github-activate-gh-cli-gh-cli");', 'await app.waitUntil(() => !app.shows("id:github-activate-gh-cli-gh-cli") && app.shows("id:github-activate-oauth-synthetic-added"));',
      'expect(app.shows("id:github-remove")).toBe(false);',
      'await app.press("id:github-activate-oauth-synthetic-added");', 'await app.waitUntil(() => !app.shows("id:github-activate-oauth-synthetic-added") && app.shows("id:github-remove"));',
      'await app.press("id:github-remove");', 'await app.waitFor("id:github-delete-confirmation");', 'await app.press("id:github-delete-cancel");',
       'await app.press("id:github-remove");', 'await app.press("id:github-delete-confirm");', 'await app.waitUntil(() => !app.shows("id:github-delete-confirmation"));',
       'await app.press("id:github-fixture-audit");', 'await app.waitUntil(() => app.texts().some(value => value.includes("\\\"removals\\\":1")));',
      'await app.press("id:git-credential-import-git.example-synthetic");', 'await app.waitFor("id:git-credential-editor");',
      'await app.press("id:git-credential-save");', 'await app.waitFor("id:git-credentials-error");',
      'await app.type("id:git-credential-email", "synthetic@example.invalid");', 'await app.press("id:git-credential-save");', 'await app.waitFor("id:git-credentials-saved");',
      'await app.press("id:github-fixture-audit");', 'await app.waitUntil(() => app.texts().some(value => value.includes("\\\"imports\\\":1")));',
      'expect(app.texts().join("\\n")).toContain("\\\"cancellations\\\":1");',
      'expect(app.texts().join("\\n")).toContain("\\\"activations\\\":2");',
      'expect(app.texts().join("\\n")).toContain("\\\"removals\\\":1");',
    ].join('\n') });
    expect(result.error, result.stdout + result.stderr).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}, 90_000);
