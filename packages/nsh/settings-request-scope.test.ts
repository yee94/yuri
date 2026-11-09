import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativeLayoutDensity } from './native-density';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import * as model from './model';
import * as protocol from './settings-protocol';
import * as collections from './settings-collections-core';
import * as collectionOperations from './settings-collection-operations';
import * as collectionScope from './settings-collection-scope';
import * as collectionJSONC from './settings-collection-jsonc';
import * as settingsSearch from './settings-search-core';
import * as defaults from './settings-defaults-core';
import * as models from './chat-models-helpers';
import * as retention from './settings-retention-controller';
import * as runtimeScope from './runtime-scope';
import * as integrationForm from './settings-integration-form';

const root = path.dirname(fileURLToPath(import.meta.url));
const flush = async () => { for (let index = 0; index < 100; index++) await Promise.resolve(); };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
type Scope = runtimeScope.RuntimeScope;
type Call = { scope: Scope | null; path: string; method: string; body?: unknown };
type Node = { type: unknown; props: Record<string, unknown>; children: unknown[] };

/** Runs original page callbacks and settingsLifetime, not an NSH renderer. The
 * state capture port delegates to the actual bindRequest/runtimeScope modules;
 * only the native call port models lease validation. No engine, timer, Host or
 * network runs, and this does not prove Swift lease validation. */
function productionPages() {
  let generation = 1, selected: Scope | null = Object.freeze({ hostID: 'A', lease: 'lease-1' });
  let connection = 'A';
  const calls: Call[] = [], rejected: Call[] = [], cleanups: Array<() => void> = [];
  let respond: (call: Call) => Promise<unknown> = async () => ({});
  let runtime!: typeof import('./runtime');
  const captureHostRequest = vi.fn(() => vi.fn(runtime.bindRequest(selected)));
  const source = <T>(initial: T) => { let value = initial; return Object.assign(() => value, { set(next: T) { value = next; } }); };
  const nodes: Node[] = [];
  const jsx = (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => {
    const node = { type, props: props ?? {}, children }; nodes.push(node); return node;
  };
  const modules: Record<string, unknown> = {
    nsh: { signal: source, context: (initial: unknown) => () => initial, cleanup: (work: () => void) => cleanups.push(work), effect: (work: () => void) => work(), untracked: (work: () => unknown) => work(), lifecycle: () => 'active', Scroll: 'Scroll', Text: 'Text', View: 'View', Storage: { getItem: async () => null, setItem: async () => undefined } },
    'nsh/base': Object.fromEntries(['Button', 'Input', 'Switch', 'Select', 'TextView', 'AlertDialog'].map(key => [key, key])),
    './native-select': { NativeSelect: 'Select' },
    './appearance': { nativeCodeTextViewStyles: () => ({}), nativeDensity: () => nativeLayoutDensity(100) },
    './native-editor-style': { nativeEditorTextStyle: () => ({}) },
    './i18n': { t: (key: string) => key }, './model': model, './settings-protocol': protocol,
    './state': { captureHostRequest, epoch: () => generation, app: { connection: () => ({ id: connection }) } },
    './runtime-scope': runtimeScope,
    './Icon': { Icon: 'Icon' }, './settings-collections-core': collections,
    './settings-collection-operations': collectionOperations, './settings-search-core': settingsSearch,
    './settings-collection-scope': collectionScope, './settings-collection-jsonc': collectionJSONC,
    './settings-collection-kv': { SettingsCollectionKV: 'SettingsCollectionKV' }, './settings-collection-picker': { SettingsCollectionPicker: 'SettingsCollectionPicker' },
    './settings-collection-plugins': { SettingsCollectionPlugins: 'SettingsCollectionPlugins' }, './settings-collection-directory': { SettingsCollectionDirectory: 'SettingsCollectionDirectory' },
    './native-sheet': { NativeSheet: 'NativeSheet' },
    './settings-defaults-core': defaults, './chat-models-helpers': models,
    './settings-integration-form': integrationForm, './settings-integration-fields': { SettingsIntegrationFields: 'SettingsIntegrationFields' },
    './settings-target': { SettingsTarget: 'SettingsTarget' },
    './settings-retention-controller': retention,
    './settings-retention-scheduler': { createRetentionScheduler: () => { throw new Error('Unexpected scheduler'); } },
    '../ui/src/lib/session-retention-policy': { RETENTION_DEFAULT_DAYS: 30, RETENTION_MIN_DAYS: 1, RETENTION_MAX_DAYS: 365 },
  };
  for (const [name, exports] of Object.entries({
    providers: ['SettingsProviders'], 'skill-files': ['SettingsSkillFiles'], permissions: ['SettingsPermissions', 'SettingsSavedPermissions'],
    'mcp-live': ['SettingsMcpLive'], 'plugin-runtime': ['SettingsPluginRuntime'], 'mcp-import': ['SettingsMcpImport'],
  })) modules[`./settings-${name}`] = Object.fromEntries(exports.map(key => [key, key]));
  function evaluate<T>(filename: string): T {
    const output = ts.transpileModule(readFileSync(path.join(root, filename), 'utf8'), { fileName: filename,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, jsx: ts.JsxEmit.React, jsxFactory: 'jsx' } }).outputText;
    const exports = {};
    vm.runInNewContext(output, { exports, jsx, If: 'If', Each: 'Each', clearTimeout: () => undefined, setTimeout: () => { throw new Error('Unexpected timer'); }, require: (id: string) => {
      if (!(id in modules)) throw new Error('Unexpected page dependency: ' + id);
      return modules[id];
    } });
    return exports as T;
  }
  Object.assign(modules.nsh as Record<string, unknown>, { host: {
    available: () => true,
    call: async (name: string, input: Record<string, unknown>) => {
      expect(name).toBe('runtime.request');
      expect(Object.keys(input).sort()).toEqual(['path', 'method', ...('body' in input ? ['body'] : []), ...('expectedHost' in input ? ['expectedHost'] : [])].sort());
      const scope = runtimeScope.runtimeScopeFrom(input.expectedHost);
      const call = { scope, path: String(input.path), method: String(input.method), ...('body' in input ? { body: input.body } : {}) };
      if (scope && !runtimeScope.sameRuntimeScope(scope, selected)) { rejected.push(call); throw new Error('Retired lease'); }
      calls.push(call);
      return { status: 200, body: await respond(call) };
    },
  } });
  runtime = evaluate<typeof import('./runtime')>('runtime.ts');
  modules['./runtime'] = runtime;
  const captureHostOperation = vi.fn(() => {
    const scope = selected, captured = generation, send = runtime.bindRequest(scope);
    const current = () => captured === generation;
    return Object.freeze({ scope, generation: captured, current, request: vi.fn(async (path: string, method?: string, body?: unknown) => {
      if (!current()) throw new Error('host_operation_stale');
      const result = await send(path, method, body);
      if (!current()) throw new Error('host_operation_stale');
      return result;
    }) });
  });
  Object.assign(modules['./state'] as object, { captureHostOperation, app: { connection: () => ({ id: connection }), runtimeScope: () => selected } });
  modules['./desktop-settings-content-core'] = evaluate('desktop-settings-content-core.ts');
  modules['./desktop-settings-publisher'] = evaluate('desktop-settings-publisher.tsx');
  const controls = evaluate<typeof import('./settings-controls')>('settings-controls.tsx');
  modules['./settings-controls'] = controls;
  const expanded = new Set<Node>();
  const expand = () => {
    for (let index = 0; index < nodes.length; index++) {
      const node = nodes[index];
      if (node.type !== 'Each' || expanded.has(node)) continue;
      expanded.add(node);
      (node.props.of as unknown[]).forEach((value, position) => (node.children[0] as (item: () => unknown, index: () => number) => unknown)(() => value, () => position));
    }
  };
  const button = (label: string) => {
    expand();
    const found = [...nodes].reverse().find(node => node.type === 'Button' && node.children.some(child => (child as Node)?.children?.includes(label)));
    if (!found) throw new Error('Missing production action: ' + label);
    return found.props.onPress as () => void;
  };
  const input = (id: string) => {
    expand();
    const found = [...nodes].reverse().find(node => node.props.testID === id || node.props.title === id);
    if (!found) throw new Error('Missing production input: ' + id);
    return found.props.onChange as (value: string) => void;
  };
  return {
    controls, evaluate, captureHostRequest, captureHostOperation, calls, rejected, button, input,
    respond: (next: typeof respond) => { respond = next; },
    select(host: string | null) { generation++; if (host) connection = host; selected = host ? Object.freeze({ hostID: host, lease: `lease-${generation}` }) : null; },
    scope: () => selected,
    dispose: () => cleanups.forEach(work => work()),
  };
}

describe('Settings constructor-captured request migration', () => {
  it('owned production pages compile and cannot import an unbound runtime sender', () => {
    for (const filename of ['settings-controls.tsx', 'settings-archive.tsx', 'settings-collections.tsx', 'settings-defaults.tsx', 'settings-git.tsx', 'settings-integration.tsx', 'settings-magic-prompts.tsx', 'settings-mcp-live.tsx', 'settings-permissions.tsx', 'settings-plugin-runtime.tsx', 'settings-preferences.tsx', 'settings-projects.tsx', 'settings-providers.tsx', 'settings-skill-files.tsx', 'settings-usage.tsx', 'settings-retention.tsx']) {
      const source = readFileSync(path.join(root, filename), 'utf8');
      const syntax = ts.createSourceFile(filename, source, ts.ScriptTarget.ES2023, true, ts.ScriptKind.TSX);
      const runtimeImports = syntax.statements.filter(ts.isImportDeclaration).filter(node => ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === './runtime');
      expect(runtimeImports, filename).toEqual([]);
      const compiled = ts.transpileModule(source, { fileName: filename, reportDiagnostics: true, compilerOptions: { jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ES2023 } });
      expect(compiled.diagnostics, filename).toEqual([]);
    }
  });

  it('one lifetime shares its captured sender with transactions and never rebinds after A-B-A', async () => {
    const page = productionPages(), lifetime = page.controls.settingsLifetime(), first = page.scope();
    await lifetime.transaction('/api/config/settings', 'PUT', { keep: true });
    expect(page.captureHostRequest).toHaveBeenCalledTimes(1);
    expect(page.calls[0].scope).toEqual(first);
    page.select('B');
    await expect(lifetime.request('/api/config/settings', 'PUT', {})).rejects.toThrow('lease');
    page.select('A');
    expect(lifetime.current()).toBe(false);
    await expect(lifetime.transaction('/api/config/settings', 'PUT', {})).rejects.toThrow('Runtime changed');
    await expect(lifetime.request('/api/config/settings', 'PUT', {})).rejects.toThrow('lease');
    expect(page.rejected.map(call => call.scope)).toEqual([first, first]);
    const fresh = page.controls.settingsLifetime();
    await fresh.transaction('/api/config/settings', 'PUT', { keep: true });
    expect(page.calls[1].scope).toEqual(page.scope());
    expect(page.captureHostRequest).toHaveBeenCalledTimes(2);
    page.dispose();
  });

  it('real collection save callbacks refuse B and revisited A; fresh A keeps its actual directory', async () => {
    const page = productionPages();
    const component = page.evaluate<typeof import('./settings-collections')>('settings-collections.tsx').SettingsCollection;
    const props = { page: 'commands' as const, create: true, directory: '/actual/worktree', onOpen() {}, onBack() {} };
    component(props); await flush();
    page.input('settings.commands.page.field.commandName')('example'); page.input('settings-template')('preserved draft');
    const oldSave = page.button('settings.plugins.page.action.save');
    page.select('B'); oldSave(); await flush();
    page.select('A'); oldSave(); await flush();
    expect(page.calls).toEqual([]);
    expect(page.captureHostOperation).toHaveBeenCalledTimes(2);
    component(props); await flush();
    page.input('settings.commands.page.field.commandName')('example'); page.input('settings-template')('preserved draft');
    page.button('settings.plugins.page.action.save')(); await flush();
    expect(page.calls).toEqual([{ scope: page.scope(), path: '/api/config/commands/example?directory=%2Factual%2Fworktree', method: 'POST', body: { template: 'preserved draft', scope: 'user' } }]);
    expect(page.captureHostOperation).toHaveBeenCalledTimes(4);
    page.dispose();
  });

  it('the real existing-Agent scope callback runs the production migration with captured directory and exact cleanup scope', async () => {
    const page = productionPages(), source = '/actual/worktree/global/agent.md', target = '/actual/worktree/.opencode/agents/example.md';
    const original = '---\ncustom:\n  retained: true\nnullable: null\n---\n\noriginal prompt\n';
    const files = new Map([[source, original]]);
    page.respond(async call => {
      if (call.path.startsWith('/api/agent?')) return [{ name: 'example' }];
      if (call.path.startsWith('/api/config/agents/metadata')) return { agents: { example: { scope: 'user' } } };
      if (call.path.includes('/config?')) return { source: 'md', scope: 'user', config: { prompt: 'original prompt', custom: { retained: true }, nullable: null } };
      if (call.path.startsWith('/api/fs/read')) { const path = new URL(call.path, 'https://fixture.invalid').searchParams.get('path')!; if (!files.has(path)) throw Object.assign(new Error('missing'), { status: 404 }); return files.get(path); }
      if (call.path.startsWith('/api/fs/write')) { const body = call.body as { path: string; content: string }; files.set(body.path, body.content); return { success: true }; }
      if (call.method === 'DELETE') { expect(call.body).toEqual({ scope: 'user' }); files.delete(source); return { success: true }; }
      return { sources: { md: { exists: files.has(source), scope: 'user', path: source }, json: { exists: false }, userMd: { exists: files.has(source), path: source }, projectMd: { exists: files.has(target), path: target } } };
    });
    page.evaluate<typeof import('./settings-collections')>('settings-collections.tsx').SettingsCollection({ page: 'agents', entity: 'example', directory: '/actual/worktree', onOpen() {}, onBack() {} });
    await flush();
    page.input('settings.agents.page.field.scope')('project'); page.button('settings.plugins.page.action.save')(); await flush();
    expect(files.get(target)).toBe(original); expect(files.has(source)).toBe(false);
    const writes = page.calls.filter(call => call.path.startsWith('/api/fs/write') || call.method === 'DELETE');
    expect(writes).toHaveLength(2);
    expect(writes.every(call => call.scope?.hostID === 'A' && call.scope.lease === 'lease-1' && call.path.includes('directory=%2Factual%2Fworktree'))).toBe(true);
    page.dispose();
  });

  it('the real copied-Command save preserves JSONC source text and unknown fields, and opening the draft writes nothing', async () => {
    const page = productionPages();
    const raw = '{\n// root note\n"command": {"original": {"template": "echo keep", /* extension note */ "custom": {"keep": true},},},\n"other": true,\n}\n';
    let stored = raw;
    page.respond(async call => {
      if (call.path.startsWith('/api/config/commands')) return { sources: { md: { exists: false }, json: { exists: false } } };
      if (call.path.startsWith('/api/fs/read')) return stored;
      if (call.path.startsWith('/api/fs/write')) { stored = (call.body as { content: string }).content; return { success: true }; }
      throw new Error('Unexpected copy request');
    });
    page.evaluate<typeof import('./settings-collections')>('settings-collections.tsx').SettingsCollection({
      page: 'commands', create: true, directory: '/actual/worktree', onOpen() {}, onBack() {},
      collectionDraft: { editor: { name: 'copied', scope: 'project', template: 'echo keep', custom: { keep: true } }, config: { template: 'echo keep', custom: { keep: true } }, jsonc: { name: 'original', section: 'command', scope: 'project', path: '/actual/worktree/opencode.jsonc', directory: '/actual/worktree', raw } },
    });
    await flush(); expect(page.calls).toEqual([]);
    page.button('settings.plugins.page.action.save')(); await flush();
    expect(stored).toContain('// root note'); expect(stored.match(/\/\* extension note \*\//g)).toHaveLength(2);
    expect(collectionJSONC.parseCollectionJSONC(stored)).toMatchObject({ command: { original: { custom: { keep: true } }, copied: { custom: { keep: true }, template: 'echo keep' } }, other: true });
    const writes = page.calls.filter(call => call.method !== 'GET');
    expect(writes).toHaveLength(1); expect(writes[0].scope).toEqual(page.scope());
    expect(writes[0].path).toBe('/api/fs/write?directory=%2Factual%2Fworktree');
    page.dispose();
  });

  it.each(['B', 'A-B-A'])('late agent metadata POST after %s retains the original rejected lease', async sequence => {
    const page = productionPages(), wait = deferred<unknown>(), first = page.scope();
    page.respond(async call => {
      if (call.path.startsWith('/api/agent?')) return wait.promise;
      throw new Error('Unexpected dispatched continuation');
    });
    page.evaluate<typeof import('./settings-collections')>('settings-collections.tsx').SettingsCollection({ page: 'agents', directory: '/actual/worktree', onOpen() {}, onBack() {} });
    expect(page.calls).toHaveLength(1);
    page.select('B'); if (sequence === 'A-B-A') page.select('A');
    wait.resolve([{ name: 'example', mode: 'primary' }]); await flush();
    expect(page.calls).toHaveLength(1);
    expect(page.rejected).toEqual([]);
    expect(page.captureHostOperation.mock.results[0].value.scope).toEqual(first);
    expect(page.captureHostOperation.mock.results[0].value.request.mock.calls).toEqual([['/api/agent?location%5Bdirectory%5D=%2Factual%2Fworktree', undefined, undefined]]);
    expect(page.captureHostOperation).toHaveBeenCalledTimes(2);
    page.dispose();
  });

  it('summary connection test uses the same constructor sender, with no scope becoming read-only', async () => {
    const page = productionPages(); page.select(null);
    page.respond(async call => call.path === '/api/config/settings' ? {} : { schemaVersion: 1, providers: [] });
    page.evaluate<typeof import('./settings-defaults')>('settings-defaults.tsx').SettingsDefaults({ page: 'summary-ai' });
    await flush();
    page.button('settings.yuri.defaults.summary.testConnection')(); await flush();
    expect(page.calls.every(call => call.method === 'GET')).toBe(true);
    expect(page.rejected).toEqual([]);
    expect(page.captureHostOperation.mock.results[0].value.request).toHaveBeenCalledWith('/api/small-model/test', 'POST', { mode: 'provider', providerID: '', modelID: '' });
    expect(page.captureHostOperation).toHaveBeenCalledTimes(2);
    page.select('A');
    page.button('settings.yuri.defaults.summary.testConnection')(); await flush();
    expect(page.rejected).toHaveLength(0);
    expect(page.captureHostOperation.mock.results[0].value.request.mock.calls.filter(call => call[1] === 'POST')).toHaveLength(1);
    expect(page.captureHostOperation).toHaveBeenCalledTimes(2);
    page.dispose();
  });

  it('archive ACK followed by failed verification retries GET only and retains the session directory', async () => {
    const page = productionPages();
    let written = false, verificationFailed = false;
    page.respond(async call => {
      if (call.method === 'PUT') { written = true; return {}; }
      if (call.path.includes('/message?')) return { data: [] };
      if (written && !verificationFailed) { verificationFailed = true; throw new Error('Synthetic read failure'); }
      return { id: 'archived', location: { directory: '/session/own-directory' }, time: { archived: written ? 0 : 123 } };
    });
    const back = vi.fn();
    page.evaluate<typeof import('./settings-archive')>('settings-archive.tsx').SettingsArchive({ page: 'archived-sessions', entity: 'archived', directory: '/route/context', onOpen() {}, onBack: back });
    await flush();
    page.button('settings.yuri.archivedSessions.actions.restore')(); await flush();
    expect(back).not.toHaveBeenCalled();
    page.button('settings.yuri.archivedSessions.actions.restore')(); await flush();
    const writes = page.calls.filter(call => call.method !== 'GET');
    expect(writes).toEqual([{ scope: page.scope(), path: '/api/yuri/sessions/archived/archive', method: 'PUT', body: { archivedAt: 0, directory: '/session/own-directory' } }]);
    expect(page.calls.slice(-2).map(call => [call.method, call.path])).toEqual([
      ['GET', '/api/session/archived?directory=%2Fsession%2Fown-directory'],
      ['GET', '/api/session/archived?directory=%2Fsession%2Fown-directory'],
    ]);
    expect(back).toHaveBeenCalledTimes(1);
    expect(page.captureHostOperation).toHaveBeenCalledTimes(2);
    page.dispose();
  });

  it('integration key ACK clears the secret before a failed readback and cannot replay the write', async () => {
    const page = productionPages();
    let written = false;
    page.respond(async call => {
      if (call.method === 'POST') { written = true; return {}; }
      if (written) throw new Error('Synthetic metadata refresh failure');
      return { data: { methods: [{ id: 'key', type: 'key' }] } };
    });
    const saved = vi.fn();
    page.evaluate<typeof import('./settings-integration')>('settings-integration.tsx').SettingsIntegration({ integrationID: 'example', directory: '/actual/worktree', onSaved: saved });
    await flush();
    page.input('integration-api-key')('synthetic-secret');
    const save = page.button('settings.providers.page.actions.saveKey');
    save(); await flush(); save(); await flush();
    expect(page.calls.filter(call => call.method !== 'GET')).toEqual([{ scope: page.scope(), path: '/api/integration/example/connect/key?location%5Bdirectory%5D=%2Factual%2Fworktree', method: 'POST', body: { key: 'synthetic-secret', answer: {} } }]);
    expect(saved).toHaveBeenCalledTimes(1);
    expect(page.captureHostOperation).toHaveBeenCalledTimes(2);
    page.dispose();
  });

  it('Retention captures per actual Host root, never permanently at module scope or on retry', async () => {
    const page = productionPages();
    const { createNativeRetentionOwner } = page.evaluate<typeof import('./settings-retention')>('settings-retention.tsx');
    expect(page.captureHostRequest).not.toHaveBeenCalled();
    page.respond(async () => ({}));
    const options = { current: () => true, active: () => true, protectedIDs: () => new Set<string>() };
    const first = createNativeRetentionOwner({ ...options, scope: 'root-A' }); await flush();
    page.select('B');
    const second = createNativeRetentionOwner({ ...options, scope: 'root-B' }); await flush();
    expect(page.captureHostOperation).toHaveBeenCalledTimes(4);
    const preferences = { autoDeleteEnabled: false, autoDeleteAfterDays: 30, sessionRetentionAction: 'archive' as const };
    await first.save(preferences); await first.save(preferences);
    expect(page.calls.filter(call => call.method === 'PUT' && call.scope?.hostID === 'A')).toEqual([]);
    expect(page.captureHostOperation).toHaveBeenCalledTimes(4);
    await second.save(preferences);
    expect(page.calls.filter(call => call.method === 'PUT')).toHaveLength(1);
    expect(page.calls.filter(call => call.method === 'PUT').every(call => runtimeScope.sameRuntimeScope(call.scope, page.scope()))).toBe(true);
    page.dispose();
  });
});
