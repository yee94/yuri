import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expect, test } from 'vitest';
import { prepareRetentionFixture } from './tests/settings-retention-fixture-config.mjs';

/** Prepared only. Do not enable without a separate explicit engine authorization. */
test.skipIf(process.env.NSH_RETENTION_ENGINE !== '1')('production retention section preserves preferences and scans but blocks cleanup without server atomic admission', () => {
  if (!process.env.OPENCODE_TMP_DIR) throw new Error('Approved temporary directory required');
  const root = path.dirname(fileURLToPath(import.meta.url));
  const temporary = mkdtempSync(path.join(process.env.OPENCODE_TMP_DIR, 'retention-engine-'));
  try {
    const fixture = prepareRetentionFixture(root, temporary);
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', fixture.entry, '--web-host', fixture.host], { cwd: temporary, encoding: 'utf8', timeout: 75_000, input: [
      'await app.waitFor("text:Eligible for archiving right now: 2");',
      'await app.waitFor("id:retention-error"); expect(app.enabled("id:retention-run")).toBe(false);',
      'expect(app.shows("id:retention-result-expired-a")).toBe(false);',
      'await app.clear("id:retention-days"); await app.type("id:retention-days", "60"); expect(app.value("id:retention-days")).toBe("60");',
      'await app.press("id:retention-save"); await app.waitUntil(() => app.enabled("id:retention-refresh"));',
      'expect(app.enabled("id:retention-run")).toBe(false);',
      'await app.press("id:retention-fixture-audit");',
      'await app.waitUntil(() => app.texts().some(text => text.includes("\\\"settingsWrites\\\":1")));',
      'expect(app.texts().join("\\n")).toContain("\\\"archiveWrites\\\":0"); expect(app.texts().join("\\n")).toContain("\\\"deleteWrites\\\":0");',
      'await app.press("id:retention-fixture-partial");',
      'await app.press("id:retention-refresh");',
      'await app.waitFor("id:retention-error");',
      'expect(app.enabled("id:retention-run")).toBe(false);',
      'await app.press("id:retention-fixture-zh");',
      'await app.waitFor("text:候选数量未知。需要完整会话目录及实时活动快照。");',
    ].join('\n') });
    expect(result.error, result.stdout + result.stderr).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}, 90_000);
