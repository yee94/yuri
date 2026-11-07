import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expect, test } from 'vitest';
import { remoteDesktopFixtureJPEG } from './remote-desktop-fixture-images';

// Explicit opt-in: NSH test can bring NshDev to the foreground. The main session
// owns the device/engine validation window and must serialize this fixture itself.
const enabled = process.env.NSH_REMOTE_DESKTOP_UI_TESTS === '1';
const directory = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tests/remote-desktop');

function run(steps: string[], rejectInput = false) {
  const temporary = mkdtempSync(path.join(tmpdir(), 'nsh-remote-desktop-fixture-'));
  const fixture = path.join(temporary, 'host.js');
  writeFileSync(fixture, `export function createHost(player) {
    let current, opens = 0, closes = 0, acks = 0, inputs = 0, views = 0;
    return { call(name, args) {
      if (name === 'remoteDesktop.open') {
        if (current) throw new Error('Previous owner was not released');
        current = args.owner; opens++;
        setTimeout(() => player.hostEvent('remoteDesktop.event', { owner: args.owner, type: 'frame', frame: 1, width: 16, height: 9, source: ${JSON.stringify(remoteDesktopFixtureJPEG.source)} }), 10);
        return true;
      }
      if (name === 'remoteDesktop.close') { if (current === args.owner) { current = null; closes++; } return true; }
      if (name === 'runtime.request') return { opens, closes, acks, inputs, views };
      if (args.owner !== current) throw new Error('Stale owner');
      if (name === 'remoteDesktop.ack') { acks++; player.hostEvent('remoteDesktop.event', { owner: args.owner, type: 'state', phase: 'live' }); return true; }
      if (name === 'remoteDesktop.input') { inputs++; if (${rejectInput}) throw new Error('Synthetic failed input'); return true; }
      if (name === 'remoteDesktop.view') { views++; return true; }
      throw new Error('Unexpected desktop bridge call ' + name);
    } };
  }`);
  try {
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'fixture.tsx', '--web-host', fixture], {
      cwd: directory, encoding: 'utf8', timeout: 60_000,
      input: ['await app.waitFor("id:remote-desktop-frame");', 'await app.waitFor("id:remote-desktop-controls-live");', ...steps].join('\n'),
    });
    expect(result.error, result.stdout + result.stderr).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

test.skipIf(!enabled)('native desktop synthetic frame enables controls; keyboard/mode/manual rotation do not reconnect', () => {
  run([
    'expect(app.enabled("id:remote-desktop-keyboard")).toBe(true);',
    'await app.press("id:remote-desktop-cursor");',
    'await app.press("id:remote-desktop-keyboard");',
    'await app.waitFor("id:remote-desktop-text");',
    'await app.type("id:remote-desktop-text", "Synthetic native input");',
    'await app.press("id:remote-desktop-send");',
    'await app.wait(100);',
    'expect(app.value("id:remote-desktop-text")).toBe("");',
    'await app.press("id:remote-desktop-key-Enter");',
    'await app.press("id:remote-desktop-rotate");',
    'expect(app.shows("id:remote-desktop-keyboard-footer")).toBe(false);',
    'await app.press("id:fixture-inspect");',
    'await app.waitFor("text:\\"opens\\":1");',
    'expect(app.texts().join("\\n")).toContain("\\"inputs\\":2");',
  ]);
}, 75_000);

test.skipIf(!enabled)('native desktop hide/resume releases the owner and Host change does not attach to the next Host', () => {
  run([
    'await app.press("id:fixture-hide");',
    'expect(app.enabled("id:remote-desktop-keyboard")).toBe(false);',
    'await app.press("id:fixture-show");',
    'await app.waitFor("id:remote-desktop-controls-live");',
    'expect(app.enabled("id:remote-desktop-keyboard")).toBe(true);',
    'await app.press("id:fixture-host");',
    'await app.waitFor("text:The connected instance changed");',
    'await app.press("id:fixture-inspect");',
    'await app.waitFor("text:\\"opens\\":2");',
    'expect(app.texts().join("\\n")).toContain("\\"closes\\":2");',
  ]);
}, 75_000);

test.skipIf(!enabled)('native desktop input failure preserves the text; close returns to the source page', () => {
  run([
    'await app.press("id:remote-desktop-keyboard");',
    'await app.type("id:remote-desktop-text", "Retained draft");',
    'await app.press("id:remote-desktop-send");',
    'await app.waitFor("id:remote-desktop-retry");',
    'expect(app.value("id:remote-desktop-text")).toBe("Retained draft");',
    'await app.press("id:remote-desktop-back");',
    'await app.waitFor("text:Source page retained");',
    'expect(app.shows("id:remote-desktop-page")).toBe(false);',
  ], true);
}, 75_000);
