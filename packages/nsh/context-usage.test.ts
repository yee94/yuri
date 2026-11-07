import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { createContextUsageOwner, contextUsageSnapshotFrom, type ContextUsageSnapshot, type ContextUsageEntry } from './context-usage-core';
import { contextUsageFixtureSnapshot } from './context-usage-fixture-data';
import { contextUsageMoney } from './context-usage-format';
import { deriveMessageRole } from '../ui/src/components/chat/message/messageRole';
import { projectTurnRecords } from '../ui/src/components/chat/lib/turns/projectTurnRecords';
import * as tokenUtils from '../ui/src/stores/utils/tokenUtils';
import * as tps from '../ui/src/components/chat/message/assistantTps';
import * as preview from '../ui/src/components/layout/rawMessagePreview';
import { readContextUsageMetadata, contextUsageProvidersFrom } from './context-usage-authority';
import { prepareContextUsageFixture } from './tests/context-usage-fixture-config.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
/** Execute the actual Web component's useMemo, not another hand-written expected formula. */
function webView(snapshot: ContextUsageSnapshot, showAssistantTps = true): Record<string, unknown> {
  const source = ts.transpileModule(readFileSync(path.join(root, '../ui/src/components/layout/ContextSidebarTab.tsx'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, jsx: ts.JsxEmit.React } }).outputText;
  let model: Record<string, unknown> | undefined;
  const react = { useState: (initial: unknown) => [initial, () => {}], useRef: () => ({ current: null }), useEffect: () => {}, useCallback: (fn: unknown) => fn, useMemo: (fn: () => Record<string, unknown>) => { model = fn(); return model; }, createElement: () => null, Fragment: 'fragment' };
  const ui = { showAssistantTps, timeFormatPreference: '24h' };
  const imports: Record<string, unknown> = {
    react: { default: react }, '@/components/code/WorkerHighlightedCode': {}, '@/components/icon/Icon': {},
    '@/components/chat/message/messageRole': { deriveMessageRole }, '@/components/chat/lib/turns/projectTurnRecords': { projectTurnRecords },
    '@/stores/useConfigStore': { useConfigStore: (selector: (state: { providers: ContextUsageSnapshot['providers'] }) => unknown) => selector({ providers: snapshot.providers }) },
    '@/stores/useUIStore': { useUIStore: (selector: (state: typeof ui) => unknown) => selector(ui) },
    '@/sync/session-ui-store': { useSessionUIStore: (selector: (state: { currentSessionId: string }) => unknown) => selector({ currentSessionId: snapshot.scope.sessionID }) },
    '@/stores/utils/tokenUtils': tokenUtils,
    '@/sync/sync-context': { useSessions: () => [snapshot.session], useSessionMessageRecords: () => snapshot.messages },
    '@/lib/clipboard': {}, '@/lib/i18n': { getCurrentIntlLocale: () => 'en-US', useI18n: () => ({ t: (key: string) => key }) },
    '@/lib/utils': { cn: (...args: unknown[]) => args.filter(Boolean).join(' ') },
    './rawMessagePreview': preview, '@/lib/timeFormat': { formatDateTimeForPreference: () => '' },
    '@/components/chat/message/assistantTps': tps,
  };
  const exports: Record<string, unknown> = {};
  vm.runInNewContext(source, { exports, require: (id: string) => { if (!(id in imports)) throw new Error('Web parity import escaped its test boundary: ' + id); return imports[id]; } });
  (exports.ContextPanelContent as () => void)();
  if (!model) throw new Error('Web did not publish the overview view model');
  return model;
}
function assertWebParity(snapshot: ContextUsageSnapshot, showAssistantTps = true) {
  const owner = createContextUsageOwner(snapshot.scope, { current: () => true, showAssistantTps }); owner.reset(snapshot);
  const actual = owner.view()!, expected = webView(snapshot, showAssistantTps);
  for (const key of Object.keys(actual) as Array<keyof typeof actual>) expect(actual[key], key).toEqual(expected[key]);
  const rates = expected.assistantTpsByMessageID as Map<string, string>;
  for (const entry of snapshot.messages) expect(owner.tps(entry.info.id)).toBe(rates.get(entry.info.id) ?? null);
  return owner;
}

describe('full Web context overview parity, not header metadata', () => {
  it('matches all actual Web fields: counts, cost, limits, cache, context segments and cumulative/settled TPS', () => {
    const snapshot = contextUsageFixtureSnapshot(), owner = assertWebParity(snapshot);
    expect(owner.view()).toMatchObject({ messagesCount: 3, userMessagesCount: 1, assistantMessagesCount: 2, tokenBreakdown: { total: 28900 }, contextLimit: 400000, totalAssistantCost: .005, sessionTpsLabel: '500.0 tok/s', lastAssistantTpsLabel: '500.0 tok/s', providerModel: { providerName: 'Actual provider', modelName: 'Actual model' } });
    expect(owner.order()).toEqual(['final', 'step', 'user']);
    expect(owner.operations().jsonBuilds).toBe(0);
    expect(JSON.parse(owner.json('final'))).toEqual(snapshot.messages[2]);
  });
  it('same field set with TPS disabled, and authoritative runtime preference toggles recalculate without changing raw records', () => {
    const snapshot = contextUsageFixtureSnapshot(), owner = assertWebParity(snapshot, false), raw = owner.message('final');
    expect(owner.view()?.sessionTpsLabel).toBeNull(); owner.setShowAssistantTps(true);
    expect(owner.view()?.sessionTpsLabel).toBe('500.0 tok/s'); expect(owner.message('final')).toBe(raw);
    owner.setShowAssistantTps(false); expect(owner.view()?.lastAssistantTpsLabel).toBeNull();
  });
  it('matches empty success, unknown model, numeric/part token fallback and authoritative missing time', () => {
    const snapshot = contextUsageFixtureSnapshot();
    assertWebParity({ ...snapshot, messages: [] });
    assertWebParity({ ...snapshot, providers: [] });
    const final = snapshot.messages[2];
    for (const tokens of [1000, { input: -5, output: 20, reasoning: NaN, cache: { read: 10, write: Infinity } }, undefined]) {
      const changed = { ...final, info: { ...final.info, tokens, time: {}, cost: -1 }, parts: [...final.parts, { id: 'usage', type: 'step-finish', tokens: { input: 123, output: 4 } }] } as ContextUsageEntry;
      assertWebParity({ ...snapshot, messages: [snapshot.messages[0], snapshot.messages[1], changed] });
    }
  });
  it('never substitutes completed/elapsed/client clocks for authoritative time.streamed in throughput', () => {
    const snapshot = contextUsageFixtureSnapshot(), last = snapshot.messages[2];
    const missingStreamed = { ...last, info: { ...last.info, time: { created: 1700000003000, completed: 1700000006000 } } } as ContextUsageEntry;
    const owner = assertWebParity({ ...snapshot, messages: [snapshot.messages[0], snapshot.messages[1], missingStreamed] });
    expect(owner.view()?.sessionTpsLabel).toBeNull(); expect(owner.view()?.lastAssistantTpsLabel).toBeNull();
    expect(owner.view()?.lastActivityAt).toBe(1700000003000);
  });
  it('matches failed/interrupted and still-active continuation TPS disposition', () => {
    for (const finish of ['tool-calls', 'stop', 'length']) {
      const snapshot = contextUsageFixtureSnapshot(), last = snapshot.messages[2];
      const info = { ...last.info, finish, error: finish === 'length' ? { type: 'error', message: 'Interrupted synthetic turn' } : undefined } as ContextUsageEntry['info'];
      assertWebParity({ ...snapshot, messages: [...snapshot.messages.slice(0, 2), { ...last, info }] });
    }
  });
  it('preserves the overview-specific role treatment of compaction, shell and synthetic rows', () => {
    const snapshot = contextUsageFixtureSnapshot(), last = snapshot.messages[2];
    const compaction = { ...last, info: { ...last.info, id: 'compact', clientRole: 'compaction' }, parts: [{ id: 'compact:part', type: 'compaction', status: 'completed' }] } as ContextUsageEntry;
    const shell = { ...snapshot.messages[0], info: { ...snapshot.messages[0].info, id: 'shell', nativeType: 'shell' } } as ContextUsageEntry;
    assertWebParity({ ...snapshot, messages: [...snapshot.messages, compaction, shell] });
  });
});

describe('incremental owner operation budget and failure isolation', () => {
  it('5000-record history + 200 body/token patches visit only the changed message/owning turn; views and closed JSON do no work', () => {
    const seed = contextUsageFixtureSnapshot();
    const history = Array.from({ length: 1700 }, (_, index) => seed.messages.map(entry => ({ ...entry, info: { ...entry.info, id: `${index}:${entry.info.id}` } }))) .flat();
    const snapshot = { ...seed, messages: history }, owner = createContextUsageOwner(seed.scope, { current: () => true, showAssistantTps: true });
    owner.reset(snapshot); const before = owner.operations(), first = owner.message(history[0].info.id), order = owner.order();
    let last = history.at(-1)!;
    for (let delta = 0; delta < 200; delta++) {
      last = { ...last, info: { ...last.info, tokens: { ...last.info.tokens, output: 900 + delta } } as ContextUsageEntry['info'], parts: [{ ...last.parts[0], text: `Synthetic body token ${delta}` } as ContextUsageEntry['parts'][number]] };
      owner.patch({ scope: seed.scope, entries: [last] }); owner.view();
    }
    const after = owner.operations();
    expect(after.messageVisits - before.messageVisits).toBe(200);
    expect(after.turnVisits - before.turnVisits).toBeLessThanOrEqual(600);
    expect(after.resets).toBe(1); expect(after.jsonBuilds).toBe(0); expect(owner.order()).toBe(order); expect(owner.message(history[0].info.id)).toBe(first);
    const stable = owner.operations(); for (let draft = 0; draft < 200; draft++) owner.view(); expect(owner.operations()).toEqual(stable);
  });
  it('incremental patches match a fresh Web projection, including a changed earlier step in the same turn', () => {
    const snapshot = contextUsageFixtureSnapshot(), owner = createContextUsageOwner(snapshot.scope, { current: () => true, showAssistantTps: true }); owner.reset(snapshot);
    const old = snapshot.messages[1], changed = { ...old, info: { ...old.info, tokens: { ...old.info.tokens, output: 600 } } as ContextUsageEntry['info'] };
    owner.patch({ scope: snapshot.scope, entries: [changed] });
    const expected = webView({ ...snapshot, messages: [snapshot.messages[0], changed, snapshot.messages[2]] });
    for (const [key, value] of Object.entries(owner.view()!)) expect(value, key).toEqual(expected[key]);
    expect(owner.tps('final')).toBe((expected.assistantTpsByMessageID as Map<string, string>).get('final'));
  });
  it('failed first load remains unresolved; failure after authority preserves prior measured values and JSON', () => {
    const snapshot = contextUsageFixtureSnapshot(), owner = createContextUsageOwner(snapshot.scope, { current: () => true, showAssistantTps: true });
    owner.failed(new Error('cold authority failed')); expect(owner.state()).toMatchObject({ resolved: false, error: 'cold authority failed' }); expect(owner.view()).toBeUndefined();
    owner.reset(snapshot); const before = owner.view(), json = owner.json('final'); owner.loading(); owner.failed(new Error('refresh failed'));
    expect(owner.view()).toEqual(before); expect(owner.json('final')).toBe(json); expect(owner.state()).toMatchObject({ resolved: true, error: 'refresh failed' });
    owner.reset({ ...snapshot, messages: [] }); expect(owner.state().error).toBe(''); expect(owner.view()).toMatchObject({ messagesCount: 0, totalAssistantCost: 0 });
  });
  it('scope/duplicate/structural validation is atomic and late data cannot publish to a retired route', () => {
    const snapshot = contextUsageFixtureSnapshot(); let valid = true;
    const owner = createContextUsageOwner(snapshot.scope, { current: () => valid, showAssistantTps: true }); owner.reset(snapshot); const before = owner.view();
    expect(() => owner.reset({ ...snapshot, scope: { ...snapshot.scope, directory: '/guessed/first' } })).toThrow();
    expect(() => owner.reset({ ...snapshot, messages: [...snapshot.messages, snapshot.messages[0]] })).toThrow();
    expect(() => owner.patch({ scope: snapshot.scope, entries: [{ ...snapshot.messages[0], info: { ...snapshot.messages[0].info, id: 'new' } }] })).toThrow();
    expect(owner.view()).toEqual(before); valid = false; owner.failed('late failure'); owner.reset({ ...snapshot, messages: [] }); expect(owner.view()).toEqual(before);
    owner.dispose(); expect(owner.view()).toBeUndefined();
  });
  it('raw canonical JSON parser rejects slim Message data and cross-session rows; no browser transport is required', () => {
    const snapshot = contextUsageFixtureSnapshot(); expect(contextUsageSnapshotFrom(snapshot)).toBe(snapshot);
    expect(() => contextUsageSnapshotFrom({ ...snapshot, messages: [{ id: 'slim', role: 'assistant', text: 'lost usage fields' }] })).toThrow();
    expect(() => contextUsageSnapshotFrom({ ...snapshot, messages: [{ ...snapshot.messages[0], info: { ...snapshot.messages[0].info, sessionID: 'other' } }] })).toThrow();
    expect(contextUsageMoney(.005, 'en-US')).toBe('$0.0050'); expect(contextUsageMoney(1, 'en-US')).toBe('$1.00');
  });
});

describe('narrow metadata reuse/read and isolated bundled fixture', () => {
  it('reuses existing authoritative snapshots without network and cold reads only the actual current session/directory', async () => {
    const snapshot = contextUsageFixtureSnapshot(), calls: string[] = [];
    const read = async (resource: string) => { calls.push(resource); if (resource.startsWith('/api/session/')) return { data: snapshot.session }; return { schemaVersion: 1, providers: snapshot.providers.map(provider => ({ ...provider, models: Object.fromEntries(provider.models.map(model => [model.id, model])) })) }; };
    expect(await readContextUsageMetadata({ scope: snapshot.scope, session: snapshot.session, providers: snapshot.providers, read })).toEqual({ session: snapshot.session, providers: snapshot.providers });
    expect(calls).toEqual([]);
    expect(await readContextUsageMetadata({ scope: snapshot.scope, read })).toEqual({ session: snapshot.session, providers: snapshot.providers });
    expect(calls).toEqual(['/api/session/ses_context?directory=%2Fworkspace%2Factual', '/api/config/catalog/providers?directory=%2Fworkspace%2Factual']);
    await expect(readContextUsageMetadata({ scope: snapshot.scope, read: async () => { throw new Error('cold read failed'); } })).rejects.toThrow('cold read failed');
    expect(() => contextUsageProvidersFrom({ schemaVersion: 1, providers: null })).toThrow();
  });
  it('uses one bundled Host, no URL globals, unique temporary identity and no production config changes', () => {
    const parent = process.env.OPENCODE_TMP_DIR || path.join(tmpdir(), 'opencode'); mkdirSync(parent, { recursive: true });
    const temporary = mkdtempSync(path.join(parent, 'context-usage-host-test-'));
    const before = readFileSync(path.join(root, 'nsh.json'), 'utf8');
    try {
      const fixture = prepareContextUsageFixture(root, temporary);
      const config = JSON.parse(readFileSync(path.join(temporary, 'nsh.json'), 'utf8'));
      expect(config.id).toMatch(/^example\.yuri\.context\./); expect(config.capabilities).toEqual({ clipboard: true, host: ['contextUsage.fixture.snapshot', 'contextUsage.fixture.empty'] });
      expect(path.dirname(fixture.host)).toBe(temporary);
      const js = readFileSync(fixture.host, 'utf8'), syntax = ts.createSourceFile(fixture.host, js, ts.ScriptTarget.ES2023, true, ts.ScriptKind.JS);
      expect(syntax.statements.some(node => ts.isImportDeclaration(node) || ts.isExportDeclaration(node) && !!node.moduleSpecifier)).toBe(false);
      const source = ts.transpileModule(js, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 } }).outputText;
      const context = vm.createContext({ exports: {} }); expect(vm.runInContext('typeof URL + ":" + typeof URLSearchParams', context)).toBe('undefined:undefined'); vm.runInContext(source, context);
      const host = vm.runInContext('exports.createHost()', context) as { call(name: string, input: unknown): unknown };
      expect(contextUsageSnapshotFrom(host.call('contextUsage.fixture.snapshot', {})).messages).toHaveLength(3);
      expect(contextUsageSnapshotFrom(host.call('contextUsage.fixture.empty', {})).messages).toEqual([]);
      for (const invalid of [undefined, null, [], { directory: '/wrong' }]) expect(() => host.call('contextUsage.fixture.snapshot', invalid)).toThrow();
      expect(() => host.call('runtime.request', { path: '/api/session', method: 'POST' })).toThrow();
    } finally { rmSync(temporary, { recursive: true, force: true }); }
    expect(readFileSync(path.join(root, 'nsh.json'), 'utf8')).toBe(before);
  });
});
