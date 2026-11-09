import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { createConnectionEditor, type ConnectionEditorSnapshot } from './connection-editor-core';
import { createNotificationSettingsTransport } from './notification-preferences-core';
import { createNotificationRootController } from './notification-root-core';
import { connectionEditorProductionCapabilities, withConnectionEditorProductionFixture } from './tests/connection-editor-production-runner.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const primaryID = 'connection-editor-primary';
type Fixture = { directory: string; entry: string; host: string };
type Audit = {
  sequence: number; nativeCounts: Record<string, number>; requests: Array<{ path: string; method: string }>;
  rejected: unknown[]; expectedFailures: string[]; metadataWrites: number; selected: string;
  connections: Array<{ id: string; label: string; url: string }>;
  settingsReads: number; reauthorizations: Array<{ id: string; version: string; label: string; url: string }>;
  notification: { configurations: unknown[]; lease: string | null; osAuthorization: 'unknown'; scheduled: number };
};
type Host = { call(name: string, input?: unknown): unknown };
function isolatedHost() {
  return withConnectionEditorProductionFixture(root, (fixture: Fixture) => {
    const context = vm.createContext({ URL: undefined, URLSearchParams: undefined });
    const artifact = readFileSync(fixture.host, 'utf8');
    const syntax = ts.createSourceFile(fixture.host, artifact, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
    expect(syntax.statements.some(node => ts.isImportDeclaration(node) || ts.isExportDeclaration(node) && !!node.moduleSpecifier)).toBe(false);
    const source = ts.transpileModule(artifact, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const exports: Record<string, unknown> = {};
    vm.runInContext(`(function(exports) { ${source}\n})`, context)(exports);
    expect(vm.runInContext('typeof URL + ":" + typeof URLSearchParams', context)).toBe('undefined:undefined');
    const host = (exports.createHost as () => Host)();
    return { host, audit: () => host.call('connectionEditor.fixture.audit', {}) as Audit };
  });
}

describe('connection editor production strict Host (pure Node/VM, not an NSH renderer)', () => {
  it('runs the production metadata controller against the exact standalone Host artifact without URL globals', async () => {
    const { host, audit } = isolatedHost();
    const before = audit();
    const editor = createConnectionEditor({
      read: id => Promise.resolve(host.call('connection.editor', { id })),
      write: async (name, input) => host.call(name, input) as ConnectionEditorSnapshot,
      current: () => true,
    });
    const baseline = await editor.load(primaryID);
    expect(baseline?.url).toBe('https://primary.example.invalid');
    const saved = await editor.save('Saved through rename');
    expect(saved?.selected).toBe(primaryID);
    const after = audit();
    expect(after.connections[0].label).toBe('Saved through rename');
    expect(after.connections[1]).toEqual(before.connections[1]);
    expect(after).toMatchObject({ selected: primaryID, metadataWrites: 1, rejected: [], requests: [], nativeCounts: { 'connection.editor': 1, 'connection.rename': 1 } });
    expect(after.nativeCounts['runtime.stream'] ?? 0).toBe(0);
    expect(after.nativeCounts['runtime.stop'] ?? 0).toBe(0);
    expect(after.nativeCounts['connection.connect'] ?? 0).toBe(0);
  });

  it('cross-origin failure is explicit and leaves both saved records unchanged', async () => {
    const { host, audit } = isolatedHost(), before = audit();
    const editor = createConnectionEditor({ read: id => Promise.resolve(host.call('connection.editor', { id })), write: async (name, input) => host.call(name, input) as ConnectionEditorSnapshot, current: () => true });
    await editor.load(primaryID);
    const label = 'Unsaved cross-origin', url = 'https://replacement.example.invalid';
    await expect(editor.save(label, url)).rejects.toThrow('connection_editor_pairing_required');
    expect({ label, url }).toEqual({ label: 'Unsaved cross-origin', url: 'https://replacement.example.invalid' });
    const after = audit();
    expect(after.connections).toEqual(before.connections);
    expect(after).toMatchObject({ metadataWrites: 0, selected: primaryID, rejected: [], requests: [], expectedFailures: ['connection_editor_pairing_required'] });
  });

  it('records wrong-version failure without treating it as a successful write', () => {
    const { host, audit } = isolatedHost();
    expect(() => host.call('connection.rename', { id: primaryID, version: 'obsolete', label: 'Stale' })).toThrow('connection_editor_stale');
    expect(audit()).toMatchObject({ metadataWrites: 0, expectedFailures: ['connection_editor_stale'], rejected: [] });
  });

  it('the real notification root performs its one extra GET/configure before the metadata baseline, without OS permission or notification delivery', async () => {
    const { host, audit } = isolatedHost(), scope = { hostID: primaryID, generation: 1 };
    const transport = createNotificationSettingsTransport({
      scope: () => scope, language: () => 'en', call: async (name, input) => host.call(name, input),
      read: async () => (host.call('runtime.request', { path: '/api/config/settings', method: 'GET' }) as { body: unknown }).body,
      write: async () => { throw new Error('Unexpected notification fixture Host write'); },
    });
    const root = createNotificationRootController({ transport, scope: () => scope, sessions: () => [], resolve: () => [], open: () => { throw new Error('Unexpected notification fixture navigation'); }, changed: () => {} });
    try {
      root.bind(scope, 'en', true);
      for (let attempt = 0; attempt < 100 && (!root.state().ready || root.state().refreshing); attempt++) await Promise.resolve();
      expect(root.state()).toEqual({ ready: true, refreshing: false, error: null, recovery: 'unsupported' });
      const before = audit();
      expect(before.settingsReads).toBe(1);
      expect(before.requests).toEqual([{ path: '/api/config/settings', method: 'GET' }]);
      expect(before.nativeCounts['notification.configure']).toBe(1);
      expect(before.notification).toEqual({ configurations: [{ hostID: primaryID, enabled: false, mode: 'hidden-only', events: ['completion', 'error', 'question', 'permission', 'schedule', 'assistant', 'goal'], language: 'en' }], lease: 'connection-editor-memory-notification-lease', osAuthorization: 'unknown', scheduled: 0 });
      const editor = createConnectionEditor({ read: async id => host.call('connection.editor', { id }), write: async (name, input) => host.call(name, input) as ConnectionEditorSnapshot, current: () => true });
      await editor.load(primaryID); await editor.save('Saved through rename');
      const after = audit();
      expect(after.requests).toEqual(before.requests);
      expect(after.notification).toEqual(before.notification);
      for (const name of ['notification.configure', 'runtime.request', 'runtime.stream', 'runtime.stop']) expect(after.nativeCounts[name] ?? 0).toBe(before.nativeCounts[name] ?? 0);
      expect(after.rejected).toEqual([]);
    } finally { root.dispose(); }
  });

  it('configure checks exact current keys/scope/preferences and returns only an idempotent in-memory lease, never OS authorization', () => {
    const { host, audit } = isolatedHost();
    const configuration = { hostID: primaryID, enabled: false, mode: 'hidden-only', events: ['completion', 'error', 'question', 'permission', 'schedule', 'assistant', 'goal'], language: 'en' };
    expect(() => host.call('notification.configure', configuration)).toThrow();
    host.call('runtime.request', { path: '/api/config/settings', method: 'GET' });
    const first = host.call('notification.configure', configuration), second = host.call('notification.configure', configuration);
    expect(first).toEqual({ lease: 'connection-editor-memory-notification-lease' }); expect(second).toEqual(first);
    const { language: _language, ...missingLanguage } = configuration;
    const invalid = [
      missingLanguage, { ...configuration, hostID: 'other' }, { ...configuration, enabled: 'false' }, { ...configuration, enabled: true },
      { ...configuration, mode: 'focused-only' }, { ...configuration, language: 'unknown' },
      { ...configuration, events: ['completion', 'completion'] }, { ...configuration, events: ['unknown'] },
      { ...configuration, events: 'completion' }, { ...configuration, events: [] },
      { ...configuration, url: 'https://external.example.invalid' },
    ];
    for (const value of invalid) expect(() => host.call('notification.configure', value)).toThrow();
    for (const name of ['notification.status', 'notification.request', 'notification.openSettings', 'notification.live', 'notification.test']) expect(() => host.call(name, {})).toThrow();
    expect(audit().rejected).toHaveLength(1 + invalid.length + 5);
    expect(audit().notification).toMatchObject({ osAuthorization: 'unknown', scheduled: 0 });
    expect(audit().notification.configurations).toHaveLength(2);
  });

  it('the exact public Connect id/version form may replace only the scripted non-selected record, with runtimeInvalidated absent', () => {
    const { host, audit } = isolatedHost(), before = audit();
    const descriptor = host.call('connection.editor', { id: 'connection-editor-secondary' }) as { version: string };
    const input = { id: 'connection-editor-secondary', version: descriptor.version, pairingLink: 'synthetic-reauthorize-secondary', url: 'https://replacement.example.invalid', label: 'Reauthorized secondary', password: '', token: '' };
    const result = host.call('connection.connect', input) as ConnectionEditorSnapshot;
    expect(result.selected).toBe(primaryID); expect('runtimeInvalidated' in result).toBe(false);
    expect(result.connections[0]).toEqual(before.connections[0]);
    expect(result.connections[1]).toMatchObject({ id: input.id, label: input.label, url: input.url, lastUsedAt: 50 });
    const after = audit();
    expect(after).toMatchObject({ metadataWrites: 0, selected: primaryID, requests: [], rejected: [], reauthorizations: [{ id: input.id, version: descriptor.version, label: input.label, url: input.url }] });
    expect(host.call('connection.editor', { id: input.id })).toMatchObject({ version: 'synthetic-version-1' });
    expect(() => host.call('connection.connect', input)).toThrow('connection_editor_stale');
    expect(audit().reauthorizations).toHaveLength(1);
    for (const name of ['runtime.request', 'runtime.stream', 'runtime.stop', 'connection.list']) expect(after.nativeCounts[name] ?? 0).toBe(0);
  });

  it('reauthorization rejects extra/missing fields, a different id, guessed pairing data and any injected credential before mutating records', () => {
    const { host, audit } = isolatedHost(), before = audit();
    const valid = { id: 'connection-editor-secondary', version: 'synthetic-version-0', pairingLink: 'synthetic-reauthorize-secondary', url: 'https://replacement.example.invalid', label: 'Reauthorized secondary', password: '', token: '' };
    const { version: _version, ...missingVersion } = valid;
    for (const input of [missingVersion, { ...valid, id: primaryID }, { ...valid, pairingLink: '' }, { ...valid, token: 'synthetic-injected' }, { ...valid, password: 'synthetic-injected' }, { ...valid, relay: {} }]) expect(() => host.call('connection.connect', input)).toThrow();
    const after = audit();
    expect(after.connections).toEqual(before.connections); expect(after.reauthorizations).toEqual([]); expect(after.requests).toEqual([]); expect(after.rejected).toHaveLength(6);
  });

  it('allows only the actual root observers and paused Chat authority wire', () => {
    const { host, audit } = isolatedHost();
    const read = (resource: string) => host.call('runtime.request', { path: resource, method: 'GET' }) as { status: number; body: unknown };
    for (const resource of [
      '/api/config/settings', '/api/config/themes', '/api/debug/location', '/api/yuri/session-index', '/api/yuri/assistants/snapshot', '/api/yuri/scheduled-tasks', '/api/session/active',
      '/api/session/connection-editor-authority?directory=%2Ffixture%2Fconnection-editor',
      '/api/session/connection-editor-authority/message?directory=%2Ffixture%2Fconnection-editor&limit=20&order=desc',
      '/api/session/connection-editor-authority/inbox?directory=%2Ffixture%2Fconnection-editor',
      '/api/session/connection-editor-authority/form?directory=%2Ffixture%2Fconnection-editor',
      '/api/permission/request?directory=%2Ffixture%2Fconnection-editor',
    ]) expect(read(resource).status).toBe(200);
    expect(host.call('runtime.stream', { path: '/api/yuri/events', key: 'global' })).toBe(true);
    expect(host.call('runtime.stream', { path: '/api/event?directory=%2Ffixture%2Fconnection-editor', key: 'chat' })).toBe(true);
    expect(host.call('runtime.stop', { key: 'chat' })).toBe(true);
    expect(host.call('runtime.stop', {})).toBe(true);
    expect(host.call('appearance.reset', { hostID: null })).toEqual({ revision: 1 });
    expect(host.call('appearance.reset', { hostID: primaryID })).toEqual({ revision: 2 });
    expect(host.call('appearance.apply', { hostID: primaryID, revision: 2, mode: 'system', cssVars: { light: {}, dark: {} }, fonts: { ui: 'system-ui', mono: 'monospace', assistantLight: 'system-ui', assistantDark: 'system-ui' } })).toMatchObject({ unsupportedFonts: [] });
    expect(audit().rejected).toEqual([]);
  });

  it('rejects unknown native calls, mutable Host APIs, malformed queries and unexpected scope instead of blanket success', () => {
    const { host, audit } = isolatedHost();
    const invalid: Array<[string, Record<string, unknown>]> = [
      ['connection.connect', { url: 'https://replacement.example.invalid' }], ['connection.select', { id: primaryID }], ['connection.remove', { id: primaryID }], ['camera.scan', {}],
      ['connection.editor', { id: 'unknown' }], ['connection.rename', { id: primaryID, version: 'synthetic-version-0', label: 'Name', token: 'synthetic-not-a-credential' }],
      ['runtime.stream', { path: '/api/yuri/events', key: 'chat' }], ['runtime.stream', { path: 'https://external.example.invalid/api/yuri/events', key: 'global' }],
      ['runtime.stop', { key: 'unexpected' }], ['appearance.reset', { hostID: 'other' }], ['appearance.apply', { hostID: primaryID }],
      ['runtime.request', { path: '/api/config/settings', method: 'PUT', body: {} }],
      ...[
        '/api/unknown', '/api/config/settings/extra', '/api/config/settings?', '/api/config/settings?x=1', '/api/config/settings#fragment',
        'https://external.example.invalid/api/config/settings', '//external.example.invalid/api/config/settings',
        '/api/session/connection-editor-authority?directory=%2Fwrong',
        '/api/session/connection-editor-authority?directory=%ZZ',
        '/api/session/connection-editor-authority?directory=%2Ffixture%2Fconnection-editor&%64irectory=%2Fwrong',
        '/api/session/connection-editor-authority/message?directory=%2Ffixture%2Fconnection-editor&limit=30&order=desc',
        '/api/session/connection-editor-authority/message?directory=%2Ffixture%2Fconnection-editor&limit=20&order=desc&cursor=unknown',
      ].map(resource => ['runtime.request', { path: resource, method: 'GET' }] as [string, Record<string, unknown>]),
    ];
    for (const [name, input] of invalid) expect(() => host.call(name, input)).toThrow();
    expect(audit().rejected).toHaveLength(invalid.length);
    expect(audit()).toMatchObject({ metadataWrites: 0, selected: primaryID });
  });

  it('audit is read-only and cannot reset failures or inject controls', () => {
    const { host, audit } = isolatedHost();
    for (const payload of [undefined, null, [], { reset: true }, { connect: true }]) expect(() => host.call('connectionEditor.fixture.audit', payload)).toThrow();
    expect(audit().rejected).toHaveLength(5);
    expect(audit().metadataWrites).toBe(0);
    expect(isolatedHost().audit().rejected).toEqual([]);
  });
});

it('isolates capabilities, identity, bytecode and Storage, preserves production config and always cleans its own artifacts', () => {
  const production = readFileSync(path.join(root, 'nsh.json'), 'utf8');
  let first = '', second = '';
  withConnectionEditorProductionFixture(root, (fixture: Fixture) => {
    first = fixture.directory;
    const config = JSON.parse(readFileSync(path.join(first, 'nsh.json'), 'utf8'));
    expect(config.capabilities).toEqual({ host: connectionEditorProductionCapabilities });
    expect(config.capabilities.host).toContain('connection.connect');
    expect(config.capabilities.host.filter((name: string) => name.startsWith('notification.'))).toEqual(['notification.configure']);
    expect(config.capabilities.host).not.toContain('runtime.*');
    expect(config.id).toMatch(/^example\.yuri\.connection-editor\./);
    expect(config.id).not.toBe('com.yee94.yuri.nsh');
    expect(readFileSync(path.join(first, fixture.entry), 'utf8')).toBe(`import ${JSON.stringify(path.join(root, 'tests/connection-editor-production-fixture.tsx'))};\n`);
    expect(path.dirname(fixture.host)).toBe(first);
    expect(JSON.parse(readFileSync(path.join(first, 'tsconfig.json'), 'utf8')).extends).toBe(path.join(root, 'tsconfig.json'));
  });
  expect(existsSync(first)).toBe(false);
  expect(() => withConnectionEditorProductionFixture(root, (fixture: Fixture) => { second = fixture.directory; throw new Error('Synthetic callback failed'); })).toThrow('Synthetic callback failed');
  expect(first).not.toBe(second); expect(existsSync(second)).toBe(false);
  expect(readFileSync(path.join(root, 'nsh.json'), 'utf8')).toBe(production);
  expect(JSON.parse(production).capabilities.host).not.toContain('connectionEditor.fixture.audit');
});

it('production fixture graph includes the real app, Settings, editor and Chat state without React/runtime aliases (compile only)', () => {
  withConnectionEditorProductionFixture(root, (fixture: Fixture) => {
    const metadata = path.join(fixture.directory, 'graph.json');
    const result = spawnSync('bun', ['build', fixture.entry, '--target=browser', '--external=nsh', '--external=nsh/*', '--metafile=' + metadata, '--outdir', path.join(fixture.directory, 'graph')], { cwd: fixture.directory, encoding: 'utf8', timeout: 30_000 });
    expect(result.error, result.stdout + result.stderr).toBeUndefined(); expect(result.status, result.stdout + result.stderr).toBe(0);
    const graph = JSON.parse(readFileSync(metadata, 'utf8')) as { inputs: Record<string, { imports: Array<{ original?: string }> }> };
    const files = Object.keys(graph.inputs);
    for (const name of ['application.tsx', 'settings-basics.tsx', 'connection-editor.tsx', 'state.ts']) expect(files.some(file => file.endsWith('/' + name))).toBe(true);
    expect(files.filter(file => /\/node_modules\/(?:\.bun\/)?(?:react(?:-dom)?(?:@|\/)|zustand(?:@|\/)|@tanstack\/react-query\/)/.test(file))).toEqual([]);
    expect(Object.values(graph.inputs).flatMap(file => file.imports.filter(item => item.original?.startsWith('@/')))).toEqual([]);
  });
});

it.skipIf(process.env.NSH_CONNECTION_EDITOR_PRODUCTION_BUNDLE !== '1')('isolated production fixture compiles to NSH bytecode without starting an engine', () => {
  withConnectionEditorProductionFixture(root, (fixture: Fixture) => {
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['build', fixture.entry, '--release', '--out', path.join(fixture.directory, 'bytecode')], { cwd: fixture.directory, encoding: 'utf8', timeout: 60_000 });
    expect(result.error, result.stdout + result.stderr).toBeUndefined(); expect(result.status, result.stdout + result.stderr).toBe(0);
  });
}, 75_000);

const engine = process.env.NSH_CONNECTION_EDITOR_PRODUCTION_ENGINE === '1' ? it : it.skip;
function productionEngine(steps: string[]) {
  withConnectionEditorProductionFixture(root, (fixture: Fixture) => {
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', fixture.entry, '--web-host', fixture.host], { cwd: fixture.directory, encoding: 'utf8', timeout: 75_000, input: [
      'const auditValue = () => { const row = app.texts().find(text => text.startsWith("connection-editor-production-audit:")); return row ? JSON.parse(row.slice("connection-editor-production-audit:".length)) : null; };',
      'const readAudit = async () => { const previous = auditValue()?.sequence || 0; await app.press("id:connection-editor-production-audit"); await app.waitUntil(() => (auditValue()?.sequence || 0) > previous); return auditValue(); };',
      'const assertAuthority = value => { expect(value.rejected).toEqual([]); expect(value.appError).toBe(""); expect(value.online).toBe(true); expect(value.authority).toEqual({ ready: true, error: "", resolved: true, sameSelectedObject: true, sameEpoch: true, sameMessages: true, sameHistoryGeneration: true }); expect(value.selectedID).toBe("connection-editor-primary"); };',
      'const assertRuntimeUnchanged = (before, after) => { for (const key of ["runtime.stream", "runtime.stop", "runtime.request", "connection.list", "notification.configure"]) expect(after.nativeCounts[key] || 0).toBe(before.nativeCounts[key] || 0); expect(after.requests).toEqual(before.requests); expect(after.notification).toEqual(before.notification); assertAuthority(after); };',
      'const assertNoReconnect = (before, after) => { assertRuntimeUnchanged(before, after); expect(after.nativeCounts["connection.connect"] || 0).toBe(before.nativeCounts["connection.connect"] || 0); };',
      'await app.waitFor("id:settings-search");',
      'await app.waitFor("text:Synthetic authority ready");',
      'await app.press("text:Saved connections");',
      'await app.waitFor("id:connection-rename-connection-editor-primary");',
      // Exactly one configure and three leading settings GETs: catalog refresh,
      // appearance and the new notification root. All belong BEFORE the baseline.
      'let initial; for (let attempt = 0; attempt < 20; attempt++) { initial = await readAudit(); if (initial.nativeCounts["notification.configure"] === 1 && initial.settingsReads === 3 && initial.online && initial.authority.ready) break; }',
      'assertAuthority(initial); expect(initial.metadataWrites).toBe(0); expect(initial.nativeCounts["runtime.stream"]).toBeGreaterThan(0); expect(initial.nativeCounts["notification.configure"]).toBe(1); expect(initial.settingsReads).toBe(3); expect(initial.requests.filter(row => row.path === "/api/config/settings" && row.method === "GET").length).toBe(3);',
      'expect(initial.notification).toEqual({ configurations: [{ hostID: "connection-editor-primary", enabled: false, mode: "hidden-only", events: ["completion", "error", "question", "permission", "schedule", "assistant", "goal"], language: "en" }], lease: "connection-editor-memory-notification-lease", osAuthorization: "unknown", scheduled: 0 }); expect(app.shows("id:notification-root-feedback")).toBe(false);',
      ...steps,
      'expect(app.texts().join("\\n")).not.toMatch(/Unexpected connection-editor|Synthetic authority did not resolve|ReferenceError|TypeError|capability.*denied/i);',
    ].join('\n') });
    expect(result.error, result.stdout + result.stderr).toBeUndefined(); expect(result.status, result.stdout + result.stderr).toBe(0);
  });
}

engine('public YuriNativeApp → Settings Instances: dirty native Back cancel retains, discard exits, rename/edit saves update only the list', () => {
  productionEngine([
    'await app.press("id:connection-rename-connection-editor-primary");',
    'await app.waitFor("id:connection-editor-label");',
    'await app.clear("id:connection-editor-label"); await app.type("id:connection-editor-label", "Unsaved rename");',
    'app.onDialog(() => "Cancel"); const dialogsBefore = app.dialogs().length; await app.back();',
    'expect(app.dialogs().length).toBe(dialogsBefore + 1); expect(JSON.stringify(app.dialogs().at(-1))).toContain("Unsaved changes");',
    'expect(app.value("id:connection-editor-label")).toBe("Unsaved rename");',
    'app.onDialog(() => "Discard"); await app.back();',
    'await app.waitFor("id:connection-editor-label", { state: "gone" });',
    'await app.waitFor("id:connection-rename-connection-editor-primary");',
    'const discarded = await readAudit(); expect(discarded.metadataWrites).toBe(0); assertAuthority(discarded);',
    'await app.press("id:connection-rename-connection-editor-primary"); await app.waitFor("id:connection-editor-label");',
    'expect(app.value("id:connection-editor-label")).toBe("Primary synthetic connection");',
    'await app.clear("id:connection-editor-label"); await app.type("id:connection-editor-label", "Saved through rename");',
    'const beforeRename = await readAudit(); await app.press("id:connection-editor-save");',
    'await app.waitFor("id:connection-editor-label", { state: "gone" }); await app.waitFor("text:Saved through rename");',
    'const renamed = await readAudit(); assertNoReconnect(beforeRename, renamed); expect(renamed.metadataWrites).toBe(1); expect(renamed.nativeCounts["connection.rename"]).toBe(1);',
    'expect(renamed.list[0].label).toBe("Saved through rename"); expect(renamed.selectedLabel).toBe("Primary synthetic connection"); expect(renamed.connections[1]).toEqual(initial.connections[1]);',
    'await app.press("id:connection-edit-connection-editor-primary"); await app.waitFor("id:connection-editor-url");',
    'await app.clear("id:connection-editor-label"); await app.type("id:connection-editor-label", "Saved through edit");',
    'const beforeEdit = await readAudit(); await app.press("id:connection-editor-save");',
    'await app.waitFor("id:connection-editor-label", { state: "gone" }); await app.waitFor("text:Saved through edit");',
    'const edited = await readAudit(); assertNoReconnect(beforeEdit, edited); expect(edited.metadataWrites).toBe(2); expect(edited.nativeCounts["connection.edit"]).toBe(1);',
    'expect(edited.list[0].url).toBe("https://primary.example.invalid"); expect(edited.connections[1]).toEqual(initial.connections[1]);',
  ]);
}, 100_000);

engine('public edit cross-origin rejection retains label/URL; explicit reauthorize then Back returns to the same draft without connecting', () => {
  productionEngine([
    'await app.press("id:connection-edit-connection-editor-primary"); await app.waitFor("id:connection-editor-url");',
    'await app.clear("id:connection-editor-label"); await app.type("id:connection-editor-label", "Unsaved cross-origin");',
    'await app.clear("id:connection-editor-url"); await app.type("id:connection-editor-url", "https://replacement.example.invalid");',
    'const beforeFailure = await readAudit(); await app.press("id:connection-editor-save");',
    'await app.waitFor("id:connection-editor-error");',
    'expect(app.value("id:connection-editor-label")).toBe("Unsaved cross-origin"); expect(app.value("id:connection-editor-url")).toBe("https://replacement.example.invalid");',
    'app.onDialog(() => "Cancel"); await app.back(); expect(JSON.stringify(app.dialogs().at(-1))).toContain("Unsaved changes");',
    'expect(app.value("id:connection-editor-label")).toBe("Unsaved cross-origin"); expect(app.value("id:connection-editor-url")).toBe("https://replacement.example.invalid");',
    'const failed = await readAudit(); assertNoReconnect(beforeFailure, failed); expect(failed.metadataWrites).toBe(0); expect(failed.expectedFailures).toEqual(["connection_editor_pairing_required"]);',
    'await app.press("id:connection-editor-reauthorize"); await app.waitFor("id:pairing-link"); await app.waitFor("id:server-url");',
    'expect(app.value("id:server-url")).toBe("https://replacement.example.invalid");',
    'const reauthorize = await readAudit(); assertNoReconnect(failed, reauthorize); expect(reauthorize.nativeCounts["connection.connect"] || 0).toBe(0);',
    'await app.back(); await app.waitFor("id:pairing-link", { state: "gone" }); await app.waitFor("id:connection-editor-url");',
    'expect(app.value("id:connection-editor-label")).toBe("Unsaved cross-origin"); expect(app.value("id:connection-editor-url")).toBe("https://replacement.example.invalid");',
    'app.onDialog(() => "Discard"); await app.press("id:connection-editor-cancel");',
    'await app.waitFor("id:connection-editor-label", { state: "gone" }); await app.waitFor("id:connection-edit-connection-editor-primary");',
    'const cancelled = await readAudit(); assertNoReconnect(failed, cancelled); expect(cancelled.metadataWrites).toBe(0); expect(cancelled.connections).toEqual(initial.connections);',
  ]);
}, 100_000);

engine('public Connect reauthorization with captured secondary id/version and absent runtimeInvalidated pops both pages back to Instances without retiring the selected Chat', () => {
  productionEngine([
    'await app.press("id:connection-edit-connection-editor-secondary"); await app.waitFor("id:connection-editor-url");',
    'expect(app.value("id:connection-editor-label")).toBe("Other synthetic connection"); expect(app.value("id:connection-editor-url")).toBe("https://secondary.example.invalid");',
    'await app.clear("id:connection-editor-label"); await app.type("id:connection-editor-label", "Reauthorized secondary");',
    'await app.clear("id:connection-editor-url"); await app.type("id:connection-editor-url", "https://replacement.example.invalid");',
    'await app.press("id:connection-editor-reauthorize"); await app.waitFor("id:pairing-link"); await app.waitFor("id:server-url");',
    'expect(app.value("id:server-url")).toBe("https://replacement.example.invalid");',
    'await app.type("id:pairing-link", "synthetic-reauthorize-secondary");',
    'const beforeConnect = await readAudit(); assertNoReconnect(initial, beforeConnect); expect(beforeConnect.reauthorizations).toEqual([]);',
    'await app.press("text:Connect");',
    'await app.waitFor("id:pairing-link", { state: "gone" }); await app.waitFor("id:connection-editor-label", { state: "gone" });',
    'await app.waitFor("id:connection-edit-connection-editor-secondary"); await app.waitFor("text:Reauthorized secondary");',
    'const connected = await readAudit(); assertRuntimeUnchanged(beforeConnect, connected); expect(connected.nativeCounts["connection.connect"]).toBe((beforeConnect.nativeCounts["connection.connect"] || 0) + 1);',
    'expect(connected.reauthorizations).toEqual([{ id: "connection-editor-secondary", version: "synthetic-version-0", label: "Reauthorized secondary", url: "https://replacement.example.invalid" }]); expect(connected.metadataWrites).toBe(0); expect(connected.expectedFailures).toEqual([]);',
    'expect(connected.connections[0]).toEqual(initial.connections[0]); expect(connected.list[1].id).toBe("connection-editor-secondary"); expect(connected.list[1].label).toBe("Reauthorized secondary"); expect(connected.selectedLabel).toBe("Primary synthetic connection");',
    // Reopen through the production Instances row: a fresh editor must read the
    // new version and candidate, not preserve the popped editor's stale baseline.
    'await app.press("id:connection-edit-connection-editor-secondary"); await app.waitFor("id:connection-editor-url");',
    'expect(app.value("id:connection-editor-label")).toBe("Reauthorized secondary"); expect(app.value("id:connection-editor-url")).toBe("https://replacement.example.invalid");',
    'await app.clear("id:connection-editor-label"); await app.type("id:connection-editor-label", "After reauthorization metadata");',
    'const beforeFreshSave = await readAudit(); await app.press("id:connection-editor-save");',
    'await app.waitFor("id:connection-editor-label", { state: "gone" }); await app.waitFor("text:After reauthorization metadata");',
    'const freshSaved = await readAudit(); assertNoReconnect(beforeFreshSave, freshSaved); expect(freshSaved.nativeCounts["connection.editor"]).toBe(2); expect(freshSaved.metadataWrites).toBe(1); expect(freshSaved.reauthorizations).toHaveLength(1); expect(freshSaved.expectedFailures).toEqual([]);',
  ]);
}, 100_000);
