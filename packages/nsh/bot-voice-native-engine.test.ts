import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expect, test } from 'vitest';

const directory = path.dirname(fileURLToPath(import.meta.url));
const engine = test.skipIf(process.env.NSH_BOT_VOICE_ENGINE !== '1');
function run(steps: string[]) {
  const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'bot-voice-native.fixture.tsx', '--web-host', 'bot-voice-native.fixture-host.js'], { cwd: directory, encoding: 'utf8', timeout: 60000, input: steps.join('\n') });
  expect(result.error, result.stdout + result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
}
engine('Bot production editor uses first Yuri name and settings model/inline variant', () => run([
  'await app.press("id:fixture-open-bot");',
  'await app.waitUntil(() => app.value("id:features-bot-name") === "Yuri");',
  'await app.waitUntil(() => app.enabled("id:features-bot-save"));',
  'await app.press("id:features-bot-save");',
  'await app.waitFor("id:fixture-bot-saved");',
]), 75000);
engine('Voice production model UI keeps selection separate and retries reads without replaying download', () => run([
  'await app.press("id:fixture-open-voice");',
  'await app.waitFor("id:voice-local-download-parakeet-tdt-0.6b-v2-int8");',
  'await app.press("id:voice-local-select-whisper-tiny-int8");',
  'expect(app.texts()).toContain("whisper-tiny-int8");',
  'await app.press("id:voice-local-download-parakeet-tdt-0.6b-v2-int8");',
  'await app.waitFor("id:voice-local-status-error");',
  'expect(app.shows("id:voice-local-delete-parakeet-tdt-0.6b-v2-int8")).toBe(false);',
  'await app.press("id:voice-local-refresh");',
  'await app.waitFor("id:voice-local-delete-parakeet-tdt-0.6b-v2-int8");',
  'await app.press("id:fixture-toggle-active");',
  'expect(app.enabled("id:voice-local-refresh")).toBe(false);',
]), 75000);
