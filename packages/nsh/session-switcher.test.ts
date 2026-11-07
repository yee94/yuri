import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSessionSwitcherSelection, chatNavigationSearchCommands } from './session-switcher-actions';
import { createChatHeaderMetadata, type ChatHeaderMetadata } from './chat-header-metadata';
import type { ChatTarget } from './model';
import { prepareSessionSwitcherFixture } from './tests/session-switcher-fixture-config.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const target: ChatTarget = { kind: 'session', id: 'ses_a', title: 'First conversation', directory: '/workspace/second' };
type Host = { call(name: string, input: unknown): unknown };
type Audit = { requests: Array<{ path: string; method: string }>; rejected: number };
let temporary = '', hostSource = '';
beforeAll(() => {
  const parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true });
  temporary = mkdtempSync(path.join(parent, 'session-switcher-test-'));
  const fixture = prepareSessionSwitcherFixture(root, temporary);
  const source = readFileSync(fixture.host, 'utf8');
  const syntax = ts.createSourceFile(fixture.host, source, ts.ScriptTarget.ES2023, true, ts.ScriptKind.JS);
  expect(syntax.statements.some(node => ts.isImportDeclaration(node) || ts.isExportDeclaration(node) && !!node.moduleSpecifier)).toBe(false);
  hostSource = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 } }).outputText;
});
afterAll(() => { if (temporary) rmSync(temporary, { recursive: true, force: true }); });

function fixtureHost() {
  const context = vm.createContext({ exports: {} });
  expect(vm.runInContext('typeof URL + ":" + typeof URLSearchParams', context)).toBe('undefined:undefined');
  vm.runInContext(hostSource, context);
  const host = vm.runInContext('exports.createHost()', context) as Host;
  const send = (resource: string, method = 'GET', body?: unknown) => host.call('runtime.request', { path: resource, method, ...(body === undefined ? {} : { body }) }) as { status: number; body: unknown };
  const read = async (resource: string) => { const reply = send(resource); if (reply.status !== 200) throw new Error(`Synthetic HTTP ${reply.status}`); return reply.body; };
  return { host, send, read, audit: () => host.call('sessionSwitcher.fixture.audit', {}) as Audit, mode: (mode: string) => host.call('sessionSwitcher.fixture.scenario', { mode }) };
}

describe('thin session switcher navigation', () => {
  it('closes only the picker before opening another Chat, without replacing/mutating the current draft owner', () => {
    const routes = [{ target, draft: 'unsent text', references: ['src/native.ts'] }, { picker: true }];
    const retained = routes[0], events: string[] = [];
    const destination = { ...target, id: 'ses_b' };
    createSessionSwitcherSelection({ currentTarget: target, current: () => true, close() { events.push('close'); routes.pop(); }, openChat(next) { events.push('open'); routes.push({ target: next, draft: '', references: [] }); } })(destination);
    expect(events).toEqual(['close', 'open']); expect(routes[0]).toBe(retained);
    expect(retained).toMatchObject({ draft: 'unsent text', references: ['src/native.ts'] });
    routes.pop(); expect(routes[0]).toBe(retained);
  });
  it('same session closes without another Chat; exact-message navigation is never swallowed', () => {
    const opened: unknown[] = [], events: string[] = [], location = { messageID: 'opaque/message?exact#anchor' };
    const select = createSessionSwitcherSelection({ currentTarget: target, current: () => true, close: () => events.push('close'), openChat: (next, options) => opened.push([next, options]) });
    select(target); expect(opened).toEqual([]);
    select(target, location); expect(opened).toEqual([[target, location]]);
    expect((opened[0] as unknown[])[1]).toBe(location); expect(events).toHaveLength(2);
  });
  it('uses exact runtime directory identity, not ID/project guesses, and ignores stale scope', () => {
    const opened: unknown[] = [];
    const select = createSessionSwitcherSelection({ currentTarget: target, current: () => true, close: () => {}, openChat: next => opened.push(next) });
    select({ ...target, directory: '/workspace/first' }); expect(opened).toHaveLength(1);
    createSessionSwitcherSelection({ currentTarget: target, current: () => false, close: () => { throw new Error('stale close'); }, openChat: () => { throw new Error('stale open'); } })(target);
  });
  it('adds only actual injected actions; context is explicit open, never a synthetic ring toggle', () => {
    const events: string[] = [];
    const options = { t: (key: string) => key, current: () => true, closeSearch: () => events.push('close'), openSessions: () => events.push('sessions') };
    expect(chatNavigationSearchCommands(options).map(row => row.id)).toEqual(['toggle-sidebar']);
    const commands = chatNavigationSearchCommands({ ...options, openContextUsage: () => events.push('context') });
    commands[0].onSelect(); commands[1].onSelect();
    expect(events).toEqual(['close', 'sessions', 'close', 'context']);
    chatNavigationSearchCommands({ ...options, current: () => false })[0].onSelect(); expect(events).toHaveLength(4);
  });
});

describe('reuse production metadata, not a second usage implementation (Node/VM, no engine)', () => {
  it('reads the active second directory and reuses existing baseline/catalog calculation', async () => {
    const fixture = fixtureHost(); let snapshot: ChatHeaderMetadata | undefined;
    const controller = createChatHeaderMetadata({ target, current: () => true, read: fixture.read, changed: value => { snapshot = value; } });
    await controller.refresh();
    expect(snapshot).toMatchObject({ tokens: 28900, limit: 400000, pending: false, contextStale: false, branch: 'feature/second' });
    expect(fixture.audit().requests.filter(row => row.path.startsWith('/api/config/catalog'))).toEqual([{ path: '/api/config/catalog/providers?directory=%2Fworkspace%2Fsecond', method: 'GET' }]);
    controller.dispose();
  });
  it('failed cold refresh retains prior measured usage; successful compaction is pending, never measured zero', async () => {
    const fixture = fixtureHost(); let snapshot: ChatHeaderMetadata | undefined;
    const controller = createChatHeaderMetadata({ target, current: () => true, read: fixture.read, changed: value => { snapshot = value; } });
    await controller.refresh(); fixture.mode('fail-page'); await controller.refresh();
    expect(snapshot).toMatchObject({ tokens: 28900, limit: 400000, contextStale: true }); expect(snapshot?.errors).toContain('Synthetic HTTP 503');
    fixture.mode('compacted'); await controller.refresh();
    expect(snapshot).toMatchObject({ pending: true, contextStale: false }); expect(snapshot?.tokens).toBeUndefined();
    fixture.mode('empty'); await controller.refresh(); expect(snapshot?.tokens).toBeUndefined(); expect(snapshot?.pending).toBe(false);
    controller.dispose();
  });
  it('concurrent requests coalesce and command construction/dispatch has zero history/catalog/network reads', async () => {
    const fixture = fixtureHost();
    const controller = createChatHeaderMetadata({ target, current: () => true, read: fixture.read, changed: () => {} });
    await Promise.all(Array.from({ length: 50 }, () => controller.refresh()));
    expect(fixture.audit().requests).toHaveLength(4);
    const before = fixture.audit(); let callbacks = 0;
    for (let event = 0; event < 200; event++) {
      const commands = chatNavigationSearchCommands({ t: key => key, current: () => true, closeSearch: () => {}, openSessions: () => { callbacks++; }, openContextUsage: () => { callbacks++; } });
      commands[event % 2].onSelect();
    }
    expect(callbacks).toBe(200); expect(fixture.audit()).toEqual(before);
    await controller.refresh();
    expect(fixture.audit().requests.filter(row => row.path.startsWith('/api/config/catalog'))).toHaveLength(1);
    controller.dispose();
  });
  it('does not publish stale in-flight data after scope retirement', async () => {
    const fixture = fixtureHost(), snapshots: ChatHeaderMetadata[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const controller = createChatHeaderMetadata({ target, current: () => true, read: async resource => { await gate; return fixture.read(resource); }, changed: value => snapshots.push(value) });
    const pending = controller.refresh(); controller.dispose(); release(); await pending;
    expect(snapshots).toHaveLength(1); expect(snapshots[0].tokens).toBeUndefined();
  });
});

describe('bundled synthetic Host strict parser', () => {
  it.each([
    'https://host.example/api/session/active', '//host.example/api/session/active', '/api/session/active?', '/api/session/active#x',
    '/api/session/ses_a?directory=%ZZ', '/api/session/ses_a?directory=%2Fworkspace%2Ffirst',
    '/api/session/ses_a?directory=%2Fworkspace%2Fsecond&%64irectory=%2Fworkspace%2Fsecond',
    '/api/session/ses_a/message?directory=%2Fworkspace%2Fsecond&limit=200&order=desc',
    '/api/config/catalog/providers?directory=%2Fworkspace%2Ffirst', '/api/quota/providers?extra=1', '/api/unknown',
  ])('rejects malformed/duplicate/scope-widened requests: %s', resource => {
    const fixture = fixtureHost(); expect(() => fixture.send(resource)).toThrow(); expect(fixture.audit().rejected).toBe(1);
  });
  it('forbids create/prompt/config writes and every unknown native call', () => {
    const fixture = fixtureHost();
    for (const [resource, method] of [['/api/session', 'POST'], ['/api/session/ses_a/prompt?directory=%2Fworkspace%2Fsecond', 'POST'], ['/api/config/settings', 'PUT']]) expect(() => fixture.send(resource, method)).toThrow();
    expect(() => fixture.send('/api/session/active', 'GET', {})).toThrow();
    expect(() => fixture.host.call('connection.list', {})).toThrow();
    expect(() => fixture.host.call('sessionSwitcher.fixture.audit', [])).toThrow();
    expect(fixture.audit()).toEqual({ requests: [], rejected: 6 });
  });
  it('bundle-only production fixture stays outside React/browser SDK/application entrypoints', () => {
    const metadata = path.join(temporary, 'graph.json');
    const result = spawnSync('bun', ['build', path.join(root, 'session-switcher-fixture.tsx'), '--target=browser', '--external=nsh', '--external=nsh/*', `--metafile=${metadata}`, '--outdir', path.join(temporary, 'graph')], { cwd: temporary, encoding: 'utf8', timeout: 30_000 });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const inputs = Object.keys(JSON.parse(readFileSync(metadata, 'utf8')).inputs);
    expect(inputs.some(file => /(?:^|\/)application\.tsx$|node_modules\/(?:react|@tanstack|@opencode-ai\/sdk|@capacitor)\//.test(file))).toBe(false);
    for (const owner of ['session-switcher.tsx', 'projects.tsx', 'state.ts', 'chat-header.tsx', 'chat-header-metadata.ts']) expect(inputs.some(file => file.endsWith(owner)), owner).toBe(true);
  });
});
