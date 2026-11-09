import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expect, test } from 'vitest';

const directory = path.dirname(fileURLToPath(import.meta.url));
function run(steps: string[], failFirst = false, deferWrite = false, closedOnly = false) {
  const temporary = mkdtempSync(path.join(tmpdir(), 'nsh-composer-selection-'));
  const fixture = path.join(temporary, 'host.js');
  writeFileSync(fixture, `export function createHost() {
    let agent = 'build', writes = 0, catalogReads = 0, release;
    return { call(name, input) {
      if (name === 'connection.list') return { connections: [{ id: 'fixture-host', label: 'Fixture', url: 'https://host.example', lastUsedAt: 0 }], selected: 'fixture-host', runtimeScope: { hostID: 'fixture-host', lease: 'fixture-lease' } };
      if (name !== 'runtime.request') throw new Error('Unexpected bridge request ' + name);
      if (input.method !== 'GET' && (input.expectedHost?.hostID !== 'fixture-host' || input.expectedHost?.lease !== 'fixture-lease')) throw new Error('Missing synthetic write authority');
      const pathname = input.path.split('?')[0];
      if (pathname === '/fixture/release') { if (release) { release(); release = null; } return { status: 200, body: {} }; }
      if (pathname === '/api/config/catalog/providers') {
        if (${closedOnly} && ++catalogReads > 1) throw new Error('Closed picker enumerated catalog again');
        return { status: 200, body: { schemaVersion: 1, providers: [{ id: 'fixture', name: 'Fixture provider', models: Object.fromEntries([['model', { id: 'model', name: 'Fixture model' }], ...Array.from({ length: 300 }, (_, index) => ['extra-' + index, { id: 'extra-' + index, name: 'Extra model ' + index }])]) }] } };
      }
      if (pathname === '/api/agent') return { status: 200, body: [{ name: 'build', mode: 'primary', description: 'Default agent with full tool access.' }, { name: 'hidden', mode: 'primary', hidden: true }, { name: 'child', mode: 'subagent' }, { name: 'plan', mode: 'primary', description: 'Read-only exploration before implementation.' }] };
      if (pathname === '/api/config/settings') return { status: 200, body: {} };
      if (pathname === '/api/session/selection-session/agent') {
        writes++;
        if (input.method !== 'POST' || input.body.agent !== (agent === 'build' ? 'plan' : 'build')) throw new Error('Wrong cycle order or reentrant write');
        if (${failFirst} && writes === 1) return { status: 503, body: { message: 'Agent update rejected' } };
        if (${deferWrite}) return new Promise(resolve => { release = () => { agent = input.body.agent; resolve({ status: 200, body: {} }); }; });
        agent = input.body.agent; return { status: 200, body: {} };
      }
      if (pathname === '/api/session/selection-session') return { status: 200, body: { id: 'selection-session', agent, model: { providerID: 'fixture', id: 'model' } } };
      throw new Error('Unexpected composer selection wire ' + pathname);
    } };
  }`);
  try {
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', 'chat-composer-selection-fixture.tsx', '--web-host', fixture], { cwd: directory, encoding: 'utf8', timeout: 60_000, input: ['await app.waitFor("label:build");', ...steps].join('\n') });
    expect(result.error, result.stdout + result.stderr).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

test('short Agent tap cycles without opening a sheet, reveals then retracts label, and preserves input focus', () => {
  run([
    'expect(app.shows("id:chat-agent-cycle-label")).toBe(false);',
    'await app.type("id:fixture-composer", "Keep this draft");',
    'await app.press("id:chat-agent-selection");',
    'await app.waitFor("label:plan");',
    'expect(app.shows("id:model-agent-plan")).toBe(false);',
    'await app.waitFor("id:chat-agent-cycle-label");',
    'expect(app.value("id:fixture-composer")).toBe("Keep this draft");',
    'expect(app.texts()).toContain("Input blur count: 0");',
    'await app.wait(1500);',
    'expect(app.shows("id:chat-agent-cycle-label")).toBe(false);',
  ]);
}, 75_000);

test('desktop Agent click opens the actual selector without cycling; inactive model selection is disabled', () => {
  run([
    'await app.press("id:fixture-desktop");',
    'await app.type("id:fixture-composer", "Desktop retained draft");',
    'await app.press("id:chat-agent-selection");',
    'await app.waitFor("id:model-agent-plan");',
    'expect(app.shows("label:build")).toBe(true);',
    'expect(app.shows("id:chat-agent-cycle-label")).toBe(false);',
    'await app.back();',
    'await app.press("id:fixture-hide");',
    'expect(app.enabled("id:chat-selection")).toBe(false);',
    'expect(app.value("id:fixture-composer")).toBe("Desktop retained draft");',
  ]);
}, 75_000);

test('pending Agent write rejects reentry and reads authority after settlement', () => {
  run([
    'await app.press("id:chat-agent-selection");',
    'expect(app.enabled("id:chat-agent-selection")).toBe(false);',
    'await expect(app.press("id:chat-agent-selection")).rejects.toMatchObject({ code: "ERR_NSH_TEST_DISABLED" });',
    'expect(app.shows("label:build")).toBe(true);',
    'await app.press("id:fixture-release");',
    'await app.waitFor("label:plan");',
  ], false, true);
}, 75_000);

test('a response from a hidden page cannot reveal a stale Agent label or update that page', () => {
  run([
    'await app.press("id:chat-agent-selection");',
    'await app.press("id:fixture-hide");',
    'await app.press("id:fixture-release");',
    'await app.wait(100);',
    'expect(app.shows("label:plan")).toBe(false);',
    'expect(app.shows("id:chat-agent-cycle-label")).toBe(false);',
    'await app.press("id:fixture-show");',
    'await app.waitFor("label:plan");',
    'expect(app.shows("id:chat-agent-cycle-label")).toBe(false);',
  ], false, true);
}, 75_000);

test('old Host completion cannot update Agent selection or start a follow-up read on the next Host', () => {
  run([
    'await app.press("id:chat-agent-selection");',
    'await app.press("id:fixture-host-change");',
    'await app.press("id:fixture-release");',
    'await app.wait(100);',
    'expect(app.shows("label:build")).toBe(true);',
    'expect(app.shows("label:plan")).toBe(false);',
    'expect(app.shows("id:chat-agent-cycle-label")).toBe(false);',
  ], false, true);
}, 75_000);

test('typing with the selector closed never starts picker catalog work', () => {
  run([
    'await app.type("id:fixture-composer", "Fifty keystrokes remain independent of all catalog data.");',
    'expect(app.shows("id:model-search")).toBe(false);',
    'expect(app.shows("id:model-agent-plan")).toBe(false);',
    'expect(app.texts().join("\\n")).not.toContain("Closed picker enumerated");',
  ], false, false, true);
}, 75_000);

test('holding Agent opens only the Agent sheet; releasing does not cycle and cancellation keeps current Agent', () => {
  run([
    'await app.longPress("id:chat-agent-selection");',
    'await app.waitFor("id:model-agent-plan");',
    'expect(app.shows("id:model-search")).toBe(false);',
    'expect(app.shows("id:model-picker-close")).toBe(false);',
    'expect(app.texts()).toContain("Default agent with full tool access.");',
    'expect(app.texts()).not.toContain("hidden");',
    'expect(app.texts()).not.toContain("child");',
    'await app.back();',
    'await app.waitFor("label:build");',
    'expect(app.shows("id:chat-agent-cycle-label")).toBe(false);',
  ]);
}, 75_000);

test('drag-cancelled Agent gesture neither cycles nor opens its sheet', () => {
  run([
    'await app.drag("id:chat-agent-selection", { x: 60, y: 0 });',
    'await app.wait(600);',
    'expect(app.shows("label:build")).toBe(true);',
    'expect(app.shows("id:model-agent-plan")).toBe(false);',
    'expect(app.shows("id:chat-agent-cycle-label")).toBe(false);',
  ]);
}, 75_000);

test('failed Agent write rereads authority without a false label reveal and can be retried', () => {
  run([
    'await app.press("id:chat-agent-selection");',
    'await app.waitFor("text:HTTP 503: Agent update rejected");',
    'expect(app.shows("label:build")).toBe(true);',
    'expect(app.shows("id:chat-agent-cycle-label")).toBe(false);',
    'await app.press("id:chat-agent-selection");',
    'await app.waitFor("label:plan");',
  ], true);
}, 75_000);
