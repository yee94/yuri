import { expect, test } from 'vitest';
import { createHost as createReadHost } from './chat-changes-fixture-host.js';
import { createHost as createActionHost } from './chat-changes-actions-fixture-host.js';
import { createHost as createLayoutHost } from './tests/chat-changes-host.js';
import { createChangesReader } from './chat-changes-model';
import { createHost as createToolHost } from './tool-diff-fixture-host.js';
import { prepareChangesEngineDriver } from './tests/chat-changes-engine-driver';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

test.each([['read', createReadHost], ['actions', createActionHost], ['layout', createLayoutHost]] as const)('%s fixture supplies a selected connection and captured Host lease before page owners mount', (_, createHost) => {
  const host = createHost();
  const saved = host.call('connection.list', {});
  expect(saved).toMatchObject({ selected: expect.any(String), runtimeScope: { hostID: expect.any(String), lease: expect.any(String) }, connections: expect.any(Array) });
  expect(saved.selected).toBe(saved.runtimeScope.hostID);
  expect(saved.connections.some((connection: { id: string }) => connection.id === saved.selected)).toBe(true);
});

test.each([['read', createReadHost, '/fixture'], ['actions', createActionHost, '/fixture'], ['layout', createLayoutHost, '/workspace/project']] as const)('%s fixture rejects a foreign lease instead of accidentally authorizing intercepted Git reads', (_, createHost, directory) => {
  const host = createHost();
  expect(() => host.call('runtime.request', { path: `/api/git/status?directory=${encodeURIComponent(directory)}`, method: 'GET', expectedHost: { hostID: 'foreign', lease: 'foreign' } })).toThrow();
});

test('300-file layout fixture serves full side texts and array remotes, and preserves real reader authority on failure', async () => {
  const host = createLayoutHost();
  const saved = host.call('connection.list', {});
  const request = async (path: string) => {
    const result = host.call('runtime.request', { path, method: 'GET', expectedHost: saved.runtimeScope });
    if (result.status >= 400) throw Object.assign(new Error(String(result.body.message)), { status: result.status });
    return result.body;
  };
  const reader = createChangesReader({ kind: 'workspace', directory: '/workspace/project' }, request);
  await reader.refresh(); const prior = reader.state().snapshot;
  expect(prior?.files).toHaveLength(300);
  await reader.refresh(); expect(reader.state().error).toContain('Neutral status offline'); expect(reader.state().snapshot).toBe(prior);
  await reader.refresh(); expect(reader.state().error).toBe('');
  await reader.select('neutral-0.txt');
  expect(reader.state().diff).toMatchObject({ before: expect.any(String), after: expect.any(String) });
  expect(reader.state().diffError).toBe('');
  expect(await request('/api/git/remotes?directory=%2Fworkspace%2Fproject')).toEqual([]);
});

test.each([['read', createReadHost, 'a.ts'], ['actions', createActionHost, 'folder/a.ts']] as const)('%s fixture supplies complete workspace text sides', async (_, createHost, file) => {
  const host = createHost(), saved = host.call('connection.list', {});
  const reader = createChangesReader({ kind: 'workspace', directory: '/fixture' }, async path => host.call('runtime.request', { path, method: 'GET', expectedHost: saved.runtimeScope }).body);
  await reader.select(file);
  expect(reader.state().diff).toMatchObject({ before: expect.any(String), after: expect.any(String), isBinary: false });
  expect(reader.state().diffError).toBe('');
});

test('tool diff fixture provides real root boot metadata but refuses any fallback HTTP to current Git', () => {
  const host = createToolHost(), saved = host.call('connection.list', {});
  expect(saved.runtimeScope.hostID).toBe(saved.selected);
  expect(saved.connections[0].id).toBe(saved.selected);
  for (const name of ['status', 'file-diff', 'diff', 'remotes']) {
    expect(() => host.call('runtime.request', { path: `/api/git/${name}?directory=%2Ffixture`, method: 'GET', expectedHost: saved.runtimeScope })).toThrow('Unexpected historical fixture request');
  }
});

test('legacy engine drivers use distinct repository directories with an nsh.json ancestor and preserve the complete steps on explicit macOS', () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const steps = ['await app.press("id:changes-close");', 'await app.waitUntil(() => !app.shows("id:native-changes-sheet"));', 'expect(app.shows("id:composer-change-neutral-0.txt")).toBe(false);'];
  const first = prepareChangesEngineDriver(directory, 'changes-layout-fixture.tsx', steps);
  const second = prepareChangesEngineDriver(directory, 'tool-diff-fixture.tsx', steps);
  try {
    expect(first.directory).not.toBe(second.directory);
    for (const driver of [first, second]) {
      expect(driver.directory.startsWith(path.join(directory, 'tests') + path.sep)).toBe(true);
      let ancestor = path.dirname(driver.testFile);
      while (!existsSync(path.join(ancestor, 'nsh.json')) && path.dirname(ancestor) !== ancestor) ancestor = path.dirname(ancestor);
      expect(ancestor).toBe(directory);
      const source = readFileSync(driver.testFile, 'utf8');
      expect(source).toContain('platform: "macos"');
      expect(source).toContain('storage: {}, network: {}');
      expect(source).toContain('finally { app.dispose(); }');
      for (const step of steps) expect(source).toContain(step);
    }
  } finally { first.dispose(); second.dispose(); }
  expect(existsSync(first.directory)).toBe(false); expect(existsSync(second.directory)).toBe(false);
});

test.each(['chat-changes-fixture-host.js', 'chat-changes-actions-fixture-host.js', 'tests/chat-changes-host.js', 'tool-diff-fixture-host.js'])('bundled %s is a standalone loadable host and retains strict shared lease validation', async entry => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const driver = prepareChangesEngineDriver(directory, 'chat-changes-test-app.tsx', []);
  try {
    const fixture = driver.bundleHost(entry);
    expect(path.dirname(fixture)).toBe(driver.directory);
    expect(fixture).not.toBe(path.join(directory, entry));
    const source = readFileSync(fixture, 'utf8');
    expect(source).not.toMatch(/^\s*import\s/m);
    const loaded = await import(/* @vite-ignore */ pathToFileURL(fixture).href);
    const host = loaded.createHost(), saved = host.call('connection.list', {});
    expect(saved.runtimeScope.hostID).toBe(saved.selected);
    expect(() => host.call('runtime.request', { path: '/api/git/status?directory=%2Ffixture', method: 'GET', expectedHost: { ...saved.runtimeScope, lease: 'foreign' } })).toThrow(/scope/i);
  } finally { driver.dispose(); }
});
