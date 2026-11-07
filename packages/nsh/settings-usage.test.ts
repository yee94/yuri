import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { usageAccountRows, usageModelPatch, usageValueLabel, usageModelGroups, usageModelSelection, createSettingsUsage, usageResultFrom, usageHeaderProviders } from './settings-usage-core';
import { usageWindow, usageResult, usageFixtureResult } from './settings-usage-fixture-data';
import { usageQuotaBinding } from './settings-usage-quota-source.mjs';
import { createUsageQuotaHelpers } from './settings-usage-quota';
import { createSettingsHelpers } from '../web/server/lib/opencode/settings-helpers.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const sanitize = createSettingsHelpers({ normalizePathForPersistence: (value: unknown) => value, normalizeDirectoryPath: (value: unknown) => value, sanitizeTypographySizesPartial: () => undefined, normalizeStringArray: (value: unknown) => value, sanitizeModelRefs: () => undefined, sanitizeSkillCatalogs: () => undefined, sanitizeProjects: () => undefined }).sanitizeSettingsUpdate;

function fixture() {
  let settings: Record<string, unknown> = { usageSelectedModels: { google: ['gemini/z-model', 'gemini/a-model'], claude: ['claude-opus'] }, unrelated: 'preserved' };
  let valid = true, settingsFail = false, ackFail = false, readbackFail = false, afterWrite = false;
  let magpie: unknown = { sources: [], incomplete: false };
  const providerFailures = new Set<string>();
  const send = vi.fn(async (url: string, method = 'GET', body?: unknown): Promise<unknown> => {
    if (url === '/api/config/settings') {
      if (method === 'PUT') { settings = { ...settings, ...sanitize(body) }; afterWrite = true; if (ackFail) throw new Error('Synthetic missing ACK'); return { success: true, settings: { never: 'used-as-authority' } }; }
      if (settingsFail || afterWrite && readbackFail) throw new Error('Synthetic failed settings read');
      return structuredClone(settings);
    }
    if (url.startsWith('/api/quota/magpie?')) return magpie;
    const id = decodeURIComponent(url.slice('/api/quota/'.length));
    if (providerFailures.has(id)) throw new Error('Synthetic failed provider');
    return id === 'google' ? usageFixtureResult() : usageResult({ providerId: 'claude', providerName: 'Claude', ok: false, configured: false, usage: null });
  });
  const changed = vi.fn(), owner = createSettingsUsage({ send, current: () => valid, changed, providers: ['google', 'claude'], directory: '/fixture/project' });
  return { owner, send, changed, providerFailures, invalidate: () => { valid = false; }, failSettings: (value = true) => { settingsFail = value; }, failAck: (value = true) => { ackFail = value; }, failReadback: (value = true) => { readbackFail = value; }, setMagpie: (value: unknown) => { magpie = value; }, settings: () => settings, updateSettings: (next: Record<string, unknown>) => { settings = next; } };
}
async function open(value: ReturnType<typeof fixture>) { value.owner.setActive(true); await value.owner.refresh(); }

describe('Native Usage real Web contracts', () => {
  it('accounts-only snapshots render every account in Host order, with real IDs and independent windows', () => {
    const result = usageResult({ usage: { windows: {}, accounts: [
      { id: 'z-account', name: 'First', user: 'user-1', plan: 'Pro', kind: 'oauth', from: 'gateway', balance: '$12', readAt: 1700000000000, stale: true, error: 'refresh failed', windows: { credits: usageWindow({ valueLabel: '$12', disablePace: true }) } },
      { id: 'a-account', name: 'Second', user: '', plan: '', kind: '', from: '', balance: '', readAt: null, stale: false, windows: { daily: usageWindow({ usedPercent: 42, remainingPercent: 58 }) } },
    ] } });
    expect(usageAccountRows(result).map(row => row.id)).toEqual(['z-account', 'a-account']);
    expect(usageAccountRows(result)[0]).toMatchObject({ name: 'First', stale: true, error: 'refresh failed' });
    expect(usageAccountRows(result)[0].windows[0][1].valueLabel).toBe('$12');
  });
  it('preserves balance, unlimited, percent+valueLabel and unknown values instead of inventing zero', () => {
    expect(usageValueLabel(usageWindow({ valueLabel: '$19.25', disablePace: true }))).toBe('$19.25');
    expect(usageValueLabel(usageWindow({ valueLabel: 'Unlimited', disablePace: true }))).toBe('Unlimited');
    expect(usageValueLabel(usageWindow({ usedPercent: 12.6, valueLabel: '13 / 100', disablePace: true }))).toBe('13% · 13 / 100');
    expect(usageValueLabel(usageWindow())).toBe('-');
  });
  it('selects by real model ID and writes only the Host model preference, preserving all other providers', () => {
    const settings = { usageSelectedModels: { google: ['gemini/z', 'gemini/a'], claude: ['claude-opus'] } };
    expect(usageModelPatch(settings, 'google', 'gemini/z', false)).toEqual({ usageSelectedModels: { google: ['gemini/a'], claude: ['claude-opus'] } });
    expect(usageModelPatch(settings, 'google', 'antigravity/claude-sonnet', true).usageSelectedModels.google).toEqual(['gemini/z', 'gemini/a', 'antigravity/claude-sonnet']);
    expect(settings.usageSelectedModels.google).toEqual(['gemini/z', 'gemini/a']);
  });
  it('binds exact Web declarations without hand-maintained quota formulas', () => {
    expect(readFileSync(path.join(root, 'settings-usage-quota.ts'), 'utf8')).toBe(usageQuotaBinding());
  });
  it('all added UI keys live in every formal dictionary with real translations and identical placeholders', () => {
    const keys = ['settings.usage.page.window.resets', 'settings.usage.page.state.preferenceUnconfirmed'];
    const values: Record<string, string[]> = {};
    for (const locale of ['en', 'zh-CN', 'zh-TW', 'ja', 'ko', 'fr', 'es', 'pt-BR', 'pl', 'uk']) {
      const source = readFileSync(path.join(root, `../ui/src/lib/i18n/messages/${locale}.settings.ts`), 'utf8');
      const file = ts.createSourceFile(`${locale}.settings.ts`, source, ts.ScriptTarget.Latest, true), dictionary = new Map<string, string>();
      const visit = (node: ts.Node) => { if (ts.isPropertyAssignment(node) && ts.isStringLiteral(node.name) && ts.isStringLiteral(node.initializer)) dictionary.set(node.name.text, node.initializer.text); ts.forEachChild(node, visit); }; visit(file);
      values[locale] = keys.map(key => { const value = dictionary.get(key); expect(value, `${locale}:${key}`).toBeTruthy(); return value!; });
      expect(values[locale][0]).toContain('{time}'); expect(values[locale][1]).not.toMatch(/\{.*?\}/);
      if (locale !== 'en') for (let index = 0; index < keys.length; index++) expect(values[locale][index]).not.toBe(values.en[index]);
    }
  });
  it('reuses actual model family order and display names, but never sorts model identity as rank', () => {
    const groups = usageModelGroups(usageFixtureResult());
    expect(groups.map(group => group.id)).toEqual(['gemini-auth', 'antigravity-auth', 'other']);
    expect(groups[0].models.map(model => model.id)).toEqual(['gemini/z-model', 'gemini/a-model']);
    expect(groups[0].models[0].name).toBe('z-model');
    expect(usageModelSelection({}, usageFixtureResult())).toEqual(['antigravity/claude-sonnet']);
    expect(usageModelSelection({ usageSelectedModels: { google: [] } }, usageFixtureResult())).toEqual([]);
  });
  it('accounts suppress duplicate top-level projection; no-account windows and empty success remain distinct', () => {
    const result = usageFixtureResult(); result.usage!.windows = { duplicate: usageWindow() };
    expect(usageAccountRows(result).map(account => account.id)).toEqual(['z-account', 'a-account']);
    expect(usageAccountRows(usageResult({ usage: { windows: { daily: usageWindow() } } }))[0].windows[0][0]).toBe('daily');
    expect(usageAccountRows(usageResult())).toEqual([]);
    expect(usageAccountRows(usageResult({ usage: null }))).toEqual([]);
  });
  it('remaining mode, nonfinite/unknown percentages and reset fallbacks preserve shared helper semantics', () => {
    expect(usageValueLabel(usageWindow({ usedPercent: 9, remainingPercent: 91 }), 'remaining')).toBe('91%');
    for (const value of [NaN, Infinity, null]) expect(usageValueLabel(usageWindow({ usedPercent: value }))).toBe('-');
    const helpers = createUsageQuotaHelpers({ t: key => key, formatTimeForPreference: () => 'TIME', formatDateTimeForPreference: () => 'DATE' });
    expect(helpers.formatQuotaResetLabel(null, 'after 2 hours')).toBe('after 2 hours');
    expect(helpers.formatQuotaResetLabel(NaN, 'unknown')).toBe('unknown');
    expect(helpers.formatQuotaResetLabel(1700000000000)).toBe('DATE');
    expect(helpers.formatWindowLabel('credits_balance')).toBe('quota.window.creditsBalance');
    expect(helpers.clampPercent(null)).toBeNull(); expect(helpers.clampPercent(140)).toBe(100);
  });
  it('valid provider error responses are data, whereas malformed provider identity is failure', () => {
    expect(usageResultFrom(usageResult({ ok: false, configured: true, error: 'quota unavailable', usage: null }))).toMatchObject({ ok: false, configured: true });
    expect(() => usageResultFrom(usageFixtureResult(), 'claude')).toThrow();
    expect(() => usageResultFrom({ ...usageFixtureResult(), usage: { accounts: {} } })).toThrow();
  });
});

describe('page-owned requests, authoritative settings and read-only recovery', () => {
  it('closed mount does no reads; open performs one settings + N providers + one aggregate and repeated active is free', async () => {
    const f = fixture(); await f.owner.refresh(); expect(f.send).not.toHaveBeenCalled();
    await open(f); expect(f.send).toHaveBeenCalledTimes(4);
    f.owner.setActive(true); expect(f.send).toHaveBeenCalledTimes(4);
    expect(f.send.mock.calls.map(([url]) => url)).toEqual(['/api/config/settings', '/api/quota/google', '/api/quota/claude', '/api/quota/magpie?refresh=1&directory=%2Ffixture%2Fproject']);
    expect(f.owner.state().results.map(result => result.providerId)).toEqual(['google', 'claude']);
    f.owner.setActive(false); await f.owner.refresh(); expect(f.send).toHaveBeenCalledTimes(4);
    f.owner.setActive(true); await f.owner.refresh(); expect(f.send).toHaveBeenCalledTimes(8);
    f.owner.dispose(); await f.owner.refresh(); expect(f.send).toHaveBeenCalledTimes(8);
  });
  it('one failed provider/settings read retains valid prior values while unrelated providers remain usable', async () => {
    const f = fixture(); await open(f); const prior = f.owner.state();
    f.providerFailures.add('google'); f.failSettings(); await f.owner.refresh();
    expect(f.owner.state().settings).toBe(prior.settings);
    expect(f.owner.state().results[0]).toBe(prior.results[0]);
    expect(f.owner.state().results[1].configured).toBe(false);
    expect(f.owner.state().errors.google).toBe(true); expect(f.owner.state().settingsFailed).toBe(true);
  });
  it('writes partial settings with real IDs, preserving newest other-provider selections, then GETs authority', async () => {
    const f = fixture(); await open(f); f.send.mockClear();
    f.updateSettings({ usageSelectedModels: { google: ['gemini/z-model', 'gemini/a-model'], claude: ['new-concurrent-model'] }, unrelated: 'preserved' });
    await f.owner.selectModel('google', 'gemini/z-model', false);
    expect(f.send.mock.calls.map(([, method]) => method ?? 'GET')).toEqual(['GET', 'PUT', 'GET']);
    expect(f.send.mock.calls[1][2]).toEqual({ usageSelectedModels: { google: ['gemini/a-model'], claude: ['new-concurrent-model'] } });
    expect(f.owner.state().settings).toMatchObject({ unrelated: 'preserved', usageSelectedModels: { claude: ['new-concurrent-model'] } });
    expect(f.owner.state().settings).not.toHaveProperty('never'); expect(f.owner.state().draft).toBeNull(); expect(f.owner.state().preferenceFailed).toBe(false);
  });
  it('does not accept unknown or display-only model IDs for writes', async () => {
    const f = fixture(); await open(f); f.send.mockClear();
    await f.owner.selectModel('google', 'z-model', true); await f.owner.selectModel('claude', 'gemini/z-model', true);
    expect(f.send).not.toHaveBeenCalled();
  });
  it('ACK lost after committed write reconciles with GET and never replays PUT on refresh', async () => {
    const f = fixture(); await open(f); f.send.mockClear(); f.failAck();
    await f.owner.selectModel('google', 'gemini/z-model', false);
    expect(f.send.mock.calls.filter(([, method]) => method === 'PUT')).toHaveLength(1);
    expect(f.owner.state().draft).toBeNull(); expect(f.owner.state().recovery).toBe(false);
    await f.owner.refresh(); expect(f.send.mock.calls.filter(([, method]) => method === 'PUT')).toHaveLength(1);
  });
  it('ACK succeeded but GET failed retains prior + draft; retry/foreground re-entry only reads', async () => {
    const f = fixture(); await open(f); const prior = f.owner.state().settings; f.send.mockClear(); f.failReadback();
    await f.owner.selectModel('google', 'gemini/z-model', false);
    expect(f.owner.state().settings).toBe(prior); expect(f.owner.state().draft).toEqual({ usageSelectedModels: { google: ['gemini/a-model'], claude: ['claude-opus'] } });
    expect(f.owner.state()).toMatchObject({ recovery: true, preferenceFailed: true, writing: false });
    expect(f.send.mock.calls).toHaveLength(3);
    await f.owner.selectModel('google', 'gemini/a-model', false); expect(f.send.mock.calls).toHaveLength(3);
    await f.owner.refresh(); f.owner.setActive(false); f.owner.setActive(true); await f.owner.refresh();
    expect(f.send.mock.calls.filter(([, method]) => method === 'PUT')).toHaveLength(1);
    f.failReadback(false); await f.owner.refresh(); expect(f.owner.state().draft).toBeNull(); expect(f.owner.state().preferenceFailed).toBe(false);
  });
  it('failed preflight preserves prior and draft and never sends a write', async () => {
    const f = fixture(); await open(f); const prior = f.owner.state().settings; f.send.mockClear(); f.failSettings();
    await f.owner.selectModel('google', 'gemini/z-model', false);
    expect(f.owner.state().settings).toBe(prior); expect(f.owner.state().draft).not.toBeNull(); expect(f.owner.state().preferenceFailed).toBe(true);
    expect(f.send.mock.calls).toHaveLength(1);
  });
  it('actual Host sanitizer capability decides whether clear is confirmed or retained as unconfirmed draft', async () => {
    const f = fixture(); await open(f);
    f.updateSettings({ usageSelectedModels: { google: ['gemini/z-model'] } }); await f.owner.refresh(); f.send.mockClear();
    const supportsEmpty = Array.isArray(sanitize({ usageSelectedModels: { google: [] } }).usageSelectedModels?.google);
    await f.owner.selectModel('google', 'gemini/z-model', false);
    expect(f.owner.state().settings?.usageSelectedModels?.google).toEqual(supportsEmpty ? [] : ['gemini/z-model']);
    expect(f.owner.state().draft).toEqual(supportsEmpty ? null : { usageSelectedModels: { google: [] } }); expect(f.owner.state().preferenceFailed).toBe(!supportsEmpty);
    await f.owner.refresh(); expect(f.send.mock.calls.filter(([, method]) => method === 'PUT')).toHaveLength(1);
  });
  it('clearing the last model with other providers present cannot masquerade as a persistent empty selection', async () => {
    const f = fixture(); await open(f);
    f.updateSettings({ usageSelectedModels: { google: ['antigravity/claude-sonnet'], claude: ['claude-opus'] } }); await f.owner.refresh();
    await f.owner.selectModel('google', 'antigravity/claude-sonnet', false);
    const supportsEmpty = Array.isArray(sanitize({ usageSelectedModels: { google: [] } }).usageSelectedModels?.google);
    expect(f.owner.state().settings?.usageSelectedModels).toEqual(supportsEmpty ? { google: [], claude: ['claude-opus'] } : { claude: ['claude-opus'] });
    expect(f.owner.state().draft).toEqual(supportsEmpty ? null : { usageSelectedModels: { google: [], claude: ['claude-opus'] } });
    expect(f.owner.state().preferenceFailed).toBe(!supportsEmpty);
  });
  it('magpie source failures/incomplete discovery retain accounts, authorization clear and complete empty remove them', async () => {
    const f = fixture(); const magpie = usageResult({ providerId: 'magpie:source:google', source: 'magpie', sourceId: 'source', usage: usageFixtureResult().usage });
    f.setMagpie({ sources: [{ id: 'source', results: [magpie] }] }); await open(f);
    expect(usageHeaderProviders(f.owner.state().settings!, f.owner.state().results)).toContain(magpie.providerId);
    f.setMagpie({ sources: [{ id: 'source', results: [], error: 'failed' }] }); await f.owner.refresh();
    expect(f.owner.state().results.at(-1)).toBe(magpie); expect(f.owner.state().errors.source).toBe(true);
    f.setMagpie({ sources: [], incomplete: true }); await f.owner.refresh(); expect(f.owner.state().results).toContain(magpie);
    f.setMagpie({ sources: [{ id: 'source', results: [], clearPrevious: true, error: 'unauthorized' }] }); await f.owner.refresh();
    expect(f.owner.state().results).not.toContain(magpie);
    f.setMagpie({ sources: [{ id: 'source', results: [magpie] }] }); await f.owner.refresh();
    f.setMagpie({ sources: [], incomplete: false }); await f.owner.refresh(); expect(f.owner.state().results).not.toContain(magpie);
  });
  it('Magpie header changes persist both visibility and explicit opt-out using partial schema', async () => {
    const f = fixture(), magpie = usageResult({ providerId: 'magpie:source:google', source: 'magpie', sourceId: 'source' });
    f.setMagpie({ sources: [{ id: 'source', results: [magpie] }] }); await open(f); f.send.mockClear();
    await f.owner.selectHeader('magpie:source:google', false);
    const patch = f.send.mock.calls.find(([, method]) => method === 'PUT')![2] as Record<string, unknown>;
    expect(Object.keys(patch)).toEqual(['usageDropdownProviders', 'magpieHiddenProviders']); expect(patch.magpieHiddenProviders).toEqual(['magpie:source:google']);
    expect(usageHeaderProviders(f.owner.state().settings!, f.owner.state().results)).not.toContain(magpie.providerId);
  });
  it('late responses after Host invalidation/dispose publish nothing', async () => {
    const f = fixture(); let finish!: (value: unknown) => void;
    f.send.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    f.owner.setActive(true); const pending = f.owner.refresh(), changes = f.changed.mock.calls.length;
    f.invalidate(); finish({ usageSelectedModels: {} }); await pending;
    expect(f.changed).toHaveBeenCalledTimes(changes); expect(f.owner.state().settings).toBeNull();
  });
  it('covering/uncovering an in-flight page fences the old response and queues at most one read-only refresh', async () => {
    const f = fixture(); const original = f.send.getMockImplementation()!; let finish!: (value: unknown) => void;
    f.send.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    f.owner.setActive(true); const pending = f.owner.refresh();
    f.owner.setActive(false); f.owner.setActive(true); f.owner.setActive(true);
    finish({ usageSelectedModels: { google: ['stale'] } }); await pending;
    await f.owner.refresh();
    expect(f.owner.state().settings?.usageSelectedModels?.google).toEqual(['gemini/z-model', 'gemini/a-model']);
    expect(f.send.mock.calls.filter(([url]) => url === '/api/config/settings')).toHaveLength(2);
    expect(f.send.mock.calls.filter(([, method]) => method === 'PUT')).toHaveLength(0);
    expect(original).toBeDefined();
  });
  it('default full registry never has more than four quota reads in flight, irrespective of row count', async () => {
    let inflight = 0, peak = 0;
    const send = vi.fn(async (url: string) => {
      if (url === '/api/config/settings') return {};
      if (url.includes('/magpie?')) return { sources: [] };
      inflight++; peak = Math.max(peak, inflight); await Promise.resolve(); await Promise.resolve(); inflight--;
      return usageResult({ providerId: decodeURIComponent(url.slice('/api/quota/'.length)) as 'google', usage: { windows: {}, models: Object.fromEntries(Array.from({ length: 500 }, (_, index) => [`model-${index}`, { windows: { daily: usageWindow() } }])) } });
    });
    const owner = createSettingsUsage({ send, current: () => true }); owner.setActive(true); await owner.refresh();
    expect(peak).toBe(4); expect(send).toHaveBeenCalledTimes(18);
    expect(owner.state().results[0].providerId).toBe('claude'); owner.dispose();
  });
});
