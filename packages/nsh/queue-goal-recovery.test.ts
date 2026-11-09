import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { prepareInteractionEngineDriver } from './tests/chat-interaction-engine-driver';
import { createHost } from './tests/queue-goal-recovery-host.js';

const directory = path.dirname(fileURLToPath(import.meta.url));
const session = '/api/session/ses_1', query = '?directory=%2Fworkspace%2Fproject';
function run(steps: string[]) {
  const driver = prepareInteractionEngineDriver(directory, 'App.tsx', 'tests/queue-goal-recovery-host.js', [
    'await app.waitFor("text:Native conversation");',
    'await app.press("id:project-session-ses_1 >> nth=0");',
    'await app.waitFor("id:queue-edit-q-recover");',
    'await app.waitFor("id:chat-goal-row");',
    ...steps,
  ]);
  try {
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', driver.testFile, '--web-host', driver.bundleHost()], { cwd: directory, encoding: 'utf8', timeout: 60_000 });
    expect(result.error, result.stdout + result.stderr).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally { driver.dispose(); }
}
const receipt = (counts: string) => [
  'await app.press("id:chat-header-root >> id:chat-header-metadata");',
  `await app.waitUntil(() => app.texts().some(text => text.includes(${JSON.stringify(`QUEUE_RECOVERY ${counts}`)})));`,
  'await app.press("id:chat-header-root >> id:chat-header-metadata");',
  'await app.waitUntil(() => !app.shows("id:chat-metadata-panel"));',
];

test('isolated Host models committed DELETE with lost ACK and denies stale or selection-bearing writes', () => {
  const host = createHost(), expectedHost = host.call('connection.list').runtimeScope;
  const request = (path: string, method = 'GET', body?: unknown) => host.call('runtime.request', { path, method, ...(body ? { body } : {}), expectedHost });
  expect(request(`${session}/inbox${query}`).body.data).toHaveLength(3);
  expect(() => host.call('runtime.request', { path: `${session}/inbox/q-recover${query}`, method: 'DELETE' })).toThrow('request scope');
  expect(request(`${session}/inbox/q-recover${query}`, 'DELETE').status).toBe(503);
  expect(request(`${session}/inbox${query}`).body.data.map(item => item.id)).toEqual(['q-remove', 'q-steer']);
  expect(request(`${session}/message/q-recover${query}`).status).toBe(404);
  expect(request(`${session}/inbox/q-recover${query}`, 'DELETE').status).toBe(404);
  expect(() => request(`${session}/prompt${query}`, 'POST', { id: 'new', text: 'Recover queued input', delivery: 'queue', model: 'must-not-apply' })).toThrow('Unsafe queue');
});

test('production App recovers cancelled queue input and files beside a live Goal without repeating DELETE', () => {
  run([
    'expect(app.count("id:chat-queue-goal-divider")).toBe(1);',
    'await app.press("id:queue-edit-q-recover");',
    'await app.waitFor("id:queue-edit-recovery");',
    'expect(app.value("id:composer")).toBe("Recover queued input");',
    'expect(app.texts()).toContain("queued.txt");',
    'await expect(app.press("id:send")).rejects.toMatchObject({ code: "ERR_NSH_TEST_DISABLED" });',
    'await app.press("id:queue-edit-retry");',
    'await app.waitUntil(() => !app.shows("id:queue-edit-recovery"));',
    'expect(app.value("id:composer")).toBe("Recover queued input");',
    'expect(app.texts()).toContain("queued.txt");',
    'expect(app.shows("id:queue-edit-q-recover")).toBe(false);',
    'expect(app.shows("id:queue-edit-q-remove")).toBe(true);',
    'expect(app.shows("id:queue-edit-q-steer")).toBe(true);',
    'expect(app.shows("text:Synthetic existing Goal")).toBe(true);',
    ...receipt('delete=1 remove=0 steer=0 prompt=0'),
    'await app.press("id:send");',
    'await app.waitUntil(() => app.value("id:composer") === "");',
    'await app.waitFor("id:chat-queue >> text:Recover queued input");',
    'expect(app.count("id:chat-queue >> text:Recover queued input")).toBe(1);',
    'expect(app.shows("id:chat-goal-row")).toBe(true);',
    ...receipt('delete=1 remove=0 steer=0 prompt=1'),
  ]);
}, 75_000);

test('production App keeps three queue items and an unrelated draft isolated from Goal pause/resume/clear', () => {
  run([
    'await app.type("id:composer", "Unrelated draft stays untouched");',
    'await app.press("id:chat-goal-toggle");',
    'await app.waitFor("text:Paused");',
    'expect(app.value("id:composer")).toBe("Unrelated draft stays untouched");',
    'expect(app.shows("id:queue-edit-q-recover")).toBe(true);',
    'await app.press("id:chat-goal-toggle");',
    'await app.waitFor("text:Active");',
    'await app.press("id:queue-steer-q-steer");',
    'await app.waitFor("id:queue-steering-q-steer");',
    'expect(app.value("id:composer")).toBe("Unrelated draft stays untouched");',
    'await app.waitUntil(() => app.enabled("id:queue-remove-q-remove"));',
    'await app.press("id:queue-remove-q-remove");',
    'await app.waitFor("text:HTTP 503: Synthetic cancellation unavailable");',
    'expect(app.shows("id:queue-remove-q-remove")).toBe(true);',
    'await app.press("id:queue-remove-q-remove");',
    'await app.waitUntil(() => !app.shows("id:queue-remove-q-remove"));',
    'await app.press("id:chat-goal-details");',
    'await app.waitFor("id:chat-goal-panel-clear");',
    'await app.press("id:chat-goal-panel-clear");',
    'await app.waitUntil(() => !app.shows("id:chat-goal-row") && !app.shows("id:chat-goal-panel"));',
    'expect(app.shows("id:queue-edit-q-recover")).toBe(true);',
    'expect(app.shows("id:queue-steering-q-steer")).toBe(true);',
    'expect(app.value("id:composer")).toBe("Unrelated draft stays untouched");',
    'expect(app.count("id:chat-queue-goal-divider")).toBe(0);',
    ...receipt('delete=0 remove=2 steer=1 prompt=0'),
  ]);
}, 75_000);
