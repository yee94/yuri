import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { prepareQuotaCredentialsFixture } from './tests/settings-quota-credentials-fixture-config.mjs';

/** Prepared for main to run serially. Never starts an engine without this independent opt-in. */
const engine = test.skipIf(process.env.NSH_QUOTA_CREDENTIALS_ENGINE !== '1');
function run(steps: string[]) {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const parent = process.env.OPENCODE_TMP_DIR || path.join(process.env.TMPDIR || tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true });
  const temporary = mkdtempSync(path.join(parent, 'nsh-quota-credentials-'));
  try {
    const fixture = prepareQuotaCredentialsFixture(root, temporary);
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', fixture.entry, '--web-host', fixture.host], { cwd: temporary, timeout: 75_000, encoding: 'utf8', input: steps.join('\n') });
    expect(result.error, result.stdout + result.stderr).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
engine.each(['opencode-go', 'ollama-cloud', 'cursor'])('%s native form retains rejected draft and saves separate usage credential', provider => {
  const field = provider === 'opencode-go' ? 'authCookie' : provider === 'ollama-cloud' ? 'cookie' : 'accessToken';
  run([
    `await app.waitUntil(() => app.enabled("id:quota-${provider}-manage"));`, `await app.press("id:quota-${provider}-manage");`,
    `await app.waitFor("id:quota-field-${field}");`, `await app.type("id:quota-field-${field}", "fixture-only-input");`,
    'await app.press("id:quota-fixture-reject");', 'await app.press("id:quota-form-save");', 'await app.waitFor("id:quota-form-error");',
    `expect(app.value("id:quota-field-${field}")).toBe("fixture-only-input");`,
    'await app.press("id:quota-fixture-ok");', 'await app.press("id:quota-form-save");',
    `await app.waitUntil(() => app.enabled("id:quota-${provider}-manage"));`,
    'await app.press("id:quota-fixture-audit");', 'await app.waitUntil(() => app.texts().some(text => text.includes("\\"saves\\":2")));',
  ]);
}, 90_000);

engine('Cursor validates, requires explicit deletion consent, imports without draft, and clears on visibility boundary', () => run([
  'await app.waitUntil(() => app.enabled("id:quota-cursor-manage"));', 'await app.press("id:quota-cursor-manage");',
  'await app.waitFor("id:quota-field-accessToken");', 'await app.type("id:quota-field-accessToken", "fixture-only-input");',
  'await app.press("id:quota-fixture-invalid-validation");', 'await app.press("id:quota-form-validate");', 'await app.waitFor("id:quota-form-error");',
  'expect(app.value("id:quota-field-accessToken")).toBe("fixture-only-input");',
  'await app.press("id:quota-fixture-ok");', 'await app.press("id:quota-form-validate");', 'await app.waitFor("id:quota-form-validated");',
  'await app.press("id:quota-form-delete");', 'await app.waitFor("id:quota-form-delete-confirm");',
  'await app.press("id:quota-fixture-audit");', 'await app.waitUntil(() => app.texts().some(text => text.includes("\\"deletes\\":0")));',
  'await app.press("id:quota-form-delete-confirm");', 'await app.waitUntil(() => app.enabled("id:quota-cursor-manage"));',
  'await app.press("id:quota-cursor-manage");', 'await app.waitFor("id:quota-field-accessToken");',
  'await app.press("id:quota-form-import");', 'await app.waitUntil(() => app.enabled("id:quota-cursor-manage"));',
  'await app.press("id:quota-cursor-manage");', 'await app.waitFor("id:quota-field-accessToken");',
  'expect(app.value("id:quota-field-accessToken")).toBe("");',
  'await app.type("id:quota-field-accessToken", "fixture-only-input");', 'await app.press("id:quota-fixture-active");',
  'await app.waitUntil(() => !app.shows("id:quota-field-accessToken"));', 'await app.press("id:quota-fixture-active");',
  'await app.waitFor("id:quota-field-accessToken");', 'expect(app.value("id:quota-field-accessToken")).toBe("");',
  'await app.press("id:quota-fixture-audit");', 'await app.waitUntil(() => app.texts().some(text => text.includes("\\"imports\\":1")));',
]), 90_000);

engine('unknown Cursor save requires read before explicit retry; closing and Host switch clear the form', () => run([
  'await app.waitUntil(() => app.enabled("id:quota-cursor-manage"));', 'await app.press("id:quota-cursor-manage");',
  'await app.waitFor("id:quota-field-accessToken");', 'await app.type("id:quota-field-accessToken", "fixture-only-input");',
  'await app.press("id:quota-fixture-lost-ack");', 'await app.press("id:quota-form-save");', 'await app.waitFor("id:quota-form-read");',
  'expect(app.enabled("id:quota-form-save")).toBe(false);',
  'await app.press("id:quota-fixture-read-fail");', 'await app.press("id:quota-form-read");',
  'await app.waitUntil(() => app.enabled("id:quota-form-read"));', 'expect(app.enabled("id:quota-form-save")).toBe(false);',
  'await app.press("id:quota-fixture-ok");', 'await app.press("id:quota-form-read");',
  'await app.waitUntil(() => app.enabled("id:quota-form-save"));', 'expect(app.value("id:quota-field-accessToken")).toBe("fixture-only-input");',
  'await app.press("id:quota-fixture-audit");', 'await app.waitUntil(() => app.texts().some(text => text.includes("\\"saves\\":1")));',
  'await app.press("id:quota-form-cancel");', 'await app.waitUntil(() => app.enabled("id:quota-cursor-manage"));',
  'await app.press("id:quota-cursor-manage");', 'await app.waitFor("id:quota-field-accessToken");', 'expect(app.value("id:quota-field-accessToken")).toBe("");',
  'await app.type("id:quota-field-accessToken", "fixture-only-input");', 'await app.press("id:quota-fixture-host");',
  'await app.waitUntil(() => !app.shows("id:quota-field-accessToken"));',
]), 90_000);
