import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const cwd = path.dirname(fileURLToPath(import.meta.url));
test('production Chat admits one committed future reply with hidden manual buttons and never replays history (silent fixture)', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'nsh-auto-read-chat-'));
  try {
    const fixture = path.join(directory, 'host.js');
    const built = spawnSync('bun', ['build', 'tests/auto-read-chat-host.js', '--target=browser', '--outfile', fixture], { cwd, encoding: 'utf8' });
    expect(built.status, built.stderr).toBe(0);
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'App.tsx', '--web-host', fixture], { cwd, encoding: 'utf8', timeout: 60000, input: [
      'await app.waitFor("text:Native conversation");',
      'await app.press("text:Native conversation");',
      'await app.waitFor("text:Historical answer");',
      'expect(app.shows("id:speech-history-answer")).toBe(false);',
      'expect(app.shows("id:speech-history-final-answer")).toBe(false);',
      'await app.press("id:chat-header-root >> id:chat-header-options");',
      'await app.press("id:chat-menu-auto-read");',
      'await app.wait(100);',
      'await app.press("id:chat-header-root >> id:chat-header-options");',
      'await app.press("id:chat-menu-refresh");',
      'await app.waitFor("text:Only this future reply is spoken");',
      'await app.wait(100);',
      'await app.press("id:chat-header-root >> id:chat-header-metadata");',
      'await app.waitFor("text:Played:1");',
      'await app.press("id:chat-header-root >> id:chat-header-metadata");',
      'await app.press("id:chat-header-root >> id:chat-header-options");',
      'await app.press("id:chat-menu-auto-read");',
    ].join('\n') });
    expect(result.error, result.stdout + result.stderr).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 75000);

test('production admission consumes authoritative hydration/reset/stream signals and the rendered body plan', () => {
  const source = readFileSync(path.join(cwd, 'application.tsx'), 'utf8');
  expect(source.match(/createNativeSpeech\(/g)).toHaveLength(1);
  expect(source).toContain('chat.messagesResolved()');
  expect(source).toContain('chat.historyGeneration()');
  expect(source).toContain('streaming={chat.streamingMessageIDs().has(row().tail.id)}');
  expect(source).toContain('await autoRead.beginRecognition();');
  const body = readFileSync(path.join(cwd, 'transcript-body.tsx'), 'utf8');
  expect(body).toContain('<NativeAutoReadBody');
  expect(body).toContain('plan={plan()}');
});
