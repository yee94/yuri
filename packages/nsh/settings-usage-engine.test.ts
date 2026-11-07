import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { prepareSettingsUsageFixture } from './settings-usage-fixture-config.mjs';

// Prepared only. This change does not authorize an NSH engine/UIKit/device run.
it.skipIf(process.env.NSH_SETTINGS_USAGE_ENGINE !== '1')('production Usage: accounts-only, value labels, real model toggle, authority recovery and route request budget', () => {
  const root = path.dirname(fileURLToPath(import.meta.url)), parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true }); const directory = mkdtempSync(path.join(parent, 'settings-usage-engine-'));
  try {
    const fixture = prepareSettingsUsageFixture(root, directory);
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', fixture.entry], { cwd: fixture.directory, encoding: 'utf8', timeout: 75_000, input: [
      'await app.waitFor("id:usage-account-z-account");',
      'expect(app.texts()).toContain("$19.25"); expect(app.texts()).toContain("13% · 13 / 100");',
      'expect(app.texts()).toContain("Cached reading; awaiting fresh quota data");',
      'const reveal = async id => { for (let i = 0; i < 16 && !app.shows(id); i++) await app.scroll("id:usage-scroll", 200); await app.waitFor(id); };',
      'await reveal("id:usage-model-gemini/z-model"); await app.press("id:usage-model-gemini/z-model");',
      'await app.waitUntil(() => app.texts().includes("reads=3, writes=1"));',
      'await app.press("id:usage-fixture-ack-failure"); await app.press("id:usage-model-gemini/z-model");',
      'await app.waitUntil(() => app.texts().includes("reads=5, writes=2"));',
      'await app.press("id:usage-fixture-active"); await app.wait(100);',
      'expect(app.texts()).toContain("reads=5, writes=2");',
      'await app.press("id:usage-fixture-active"); await app.waitUntil(() => app.texts().includes("reads=6, writes=2"));',
      'expect(app.texts().join("\\n")).not.toMatch(/ReferenceError|TypeError|Unexpected synthetic|capability.*denied/i);',
    ].join('\n') });
    expect(result.error, result.stdout + result.stderr).toBeUndefined(); expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 100_000);
