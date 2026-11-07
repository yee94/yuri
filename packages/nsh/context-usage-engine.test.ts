import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { prepareContextUsageFixture } from './tests/context-usage-fixture-config.mjs';

// Explicit future opt-in only. This task does not authorize executing an NSH engine.
it.skipIf(process.env.NSH_CONTEXT_USAGE_ENGINE !== '1')('production overview: all metrics/raw JSON, copy, failed refresh retention, empty success and system Back', () => {
  const root = path.dirname(fileURLToPath(import.meta.url)), parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(path.join(parent, 'context-usage-engine-'));
  try {
    const fixture = prepareContextUsageFixture(root, directory);
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', fixture.entry, '--web-host', fixture.host], { cwd: directory, encoding: 'utf8', timeout: 75_000, input: [
      'await app.waitFor("id:context-usage-total");',
      'expect(app.texts()).toContain("28,900 / 400,000");',
      'for (const label of ["Messages", "User", "Assistant", "Cost", "Session TPS", "Input", "Output", "Reasoning", "Cache Read", "Cache Write", "Cache Hit", "TPS", "Raw Messages"]) expect(app.texts()).toContain(label);',
      'const reveal = async id => { for (let step = 0; step < 16 && !app.shows(id); step++) await app.scroll("id:context-usage-list", 200); await app.waitFor(id); };',
      'await reveal("id:context-usage-expand-final"); await app.press("id:context-usage-expand-final");',
      'await app.waitFor("id:context-usage-json-final"); await app.press("id:context-usage-copy-final");',
      'await app.waitUntil(() => app.clipboard() !== null); expect(JSON.parse(app.clipboard()).info.id).toBe("final");',
      'expect(JSON.parse(app.clipboard()).parts[0].text).toContain("``` and <b>not markup</b>");',
      'await app.press("id:context-usage-fixture-fail"); await app.waitFor("id:context-usage-error");',
      'expect(app.texts()).toContain("28,900 / 400,000");',
      'await app.press("id:context-usage-retry"); await app.waitFor("id:context-usage-error", { state: "gone" });',
      'await app.press("id:context-usage-fixture-empty"); await app.waitUntil(() => app.texts().includes("$0.00"));',
      'await app.back(); await app.waitFor("id:context-usage-fixture-open");',
      'expect(app.texts().join("\\n")).not.toMatch(/ReferenceError|TypeError|Unexpected context fixture|capability.*denied/i);',
    ].join('\n') });
    expect(result.error, result.stdout + result.stderr).toBeUndefined(); expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 100_000);
