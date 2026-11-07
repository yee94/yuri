import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { readSettingsModels, settingsCatalogModels, settingsDefaultModelPatch, settingsDefaultVariantPatch, settingsSummaryDefaults, settingsSummaryPrompts, settingsVisibleAgents } from './settings-defaults-core';
import { createSettingsTransaction } from './settings-protocol';

const directory = path.dirname(fileURLToPath(import.meta.url));
const providers = [{ id: 'p', models: { 'model/with/slash': { name: 'Real model', variants: { high: {}, low: {} } }, hidden: { hidden: true }, other: {} } }];
const models = settingsCatalogModels(providers, { hiddenModels: [{ providerID: 'p', modelID: 'other' }] });

describe('Settings defaults authoritative choices', () => {
  it('normalizes keyed catalog IDs without losing slash-containing model IDs, hidden filters or variants', () => {
    expect(models.map(item => item.modelID)).toEqual(['model/with/slash']);
    expect(settingsDefaultModelPatch('p/model/with/slash', models)).toEqual({ defaultModel: 'p/model/with/slash', defaultVariant: '' });
    expect(settingsDefaultVariantPatch('p/model/with/slash', 'high', models)).toEqual({ defaultVariant: 'high' });
    expect(() => settingsDefaultVariantPatch('p/model/with/slash', 'unknown', models)).toThrow();
  });
  it('clears default variant atomically on model reset and rejects free-form or hidden selections', () => {
    expect(settingsDefaultModelPatch('', models)).toEqual({ defaultModel: '', defaultVariant: '' });
    for (const value of ['p/hidden', 'p/other', 'invented/model']) expect(() => settingsDefaultModelPatch(value, models)).toThrow();
    expect(settingsDefaultVariantPatch('', '', models)).toEqual({ defaultVariant: '' });
    expect(() => settingsDefaultVariantPatch('', 'high', models)).toThrow();
  });
  it('Summary selection always writes provider mode and a complete pair, without touching prompts', () => {
    expect(settingsDefaultModelPatch('p/model/with/slash', models, true)).toEqual({ summaryModelMode: 'provider', summaryProviderID: 'p', summaryModelID: 'model/with/slash' });
    expect(settingsDefaultModelPatch('', models, true)).toEqual({ summaryModelMode: 'provider', summaryProviderID: '', summaryModelID: '' });
  });
  it('keeps visible subagents like Web, but excludes top-level and options.hidden Agents', () => {
    const rows = [{ name: 'build' }, { name: 'visible-subagent', mode: 'subagent' }, { name: 'internal', hidden: true }, { name: 'nested', options: { hidden: true } }];
    expect(settingsVisibleAgents({ data: rows }).map(item => item.name)).toEqual(['build', 'visible-subagent']);
    expect(() => settingsVisibleAgents({ data: null })).toThrow();
    expect(() => settingsVisibleAgents({ ok: false, data: [] })).toThrow();
  });
  it('reads Summary location-less while preserving the directory for Sessions', async () => {
    const send = vi.fn(async () => ({ schemaVersion: 1, providers }));
    await readSettingsModels(send, {});
    expect(send).toHaveBeenLastCalledWith('/api/config/catalog/providers');
    await readSettingsModels(send, {}, '/fixture/work tree');
    expect(send).toHaveBeenLastCalledWith('/api/config/catalog/providers?directory=%2Ffixture%2Fwork%20tree');
  });
  it('never treats a rejected or malformed catalog as a valid empty collection', async () => {
    await expect(readSettingsModels(async () => { throw new Error('offline'); }, {})).rejects.toThrow('offline');
    for (const value of [{ schemaVersion: 2, providers }, { schemaVersion: 1, providers: null }, { ok: false }]) await expect(readSettingsModels(async () => value, {})).rejects.toThrow();
    for (const provider of [{ id: 'p', models: [] }, { models: {} }, { id: 'p', models: null }]) expect(() => settingsCatalogModels([provider], {})).toThrow();
    for (const preferences of [{ hiddenModels: [{}] }, { hiddenModels: false }, { providerOrder: [false] }]) expect(() => settingsCatalogModels(providers, preferences)).toThrow();
  });
});

describe('Summary prompts and write failures', () => {
  it('matches the complete current Web default prompts byte for byte', () => {
    const source = readFileSync(path.join(directory, '../ui/src/components/sections/yuri/SummarySettings.tsx'), 'utf8');
    const commit = source.match(/const DEFAULT_SUMMARY_COMMIT_PROMPT = ('[^']*');/)!;
    const title = source.match(/const DEFAULT_SESSION_TITLE_PROMPT = (\[[\s\S]*?\]\.join\('\\n'\));/)!;
    expect(settingsSummaryDefaults.summaryCommitPrompt).toBe(runInNewContext(commit[1]));
    expect(settingsSummaryDefaults.summarySessionTitlePrompt).toBe(runInNewContext(title[1]));
  });
  it('uses defaults only for missing/malformed fields, preserving explicit empty and whitespace prompts', () => {
    expect(settingsSummaryPrompts({})).toEqual(settingsSummaryDefaults);
    expect(settingsSummaryPrompts({ summaryCommitPrompt: '', summarySessionTitlePrompt: '  custom\n' })).toEqual({ summaryCommitPrompt: '', summarySessionTitlePrompt: '  custom\n' });
    expect(settingsSummaryPrompts({ summaryCommitPrompt: false })).toEqual(settingsSummaryDefaults);
  });
  it('failed writes preserve the prior revision and can retry without touching unrelated settings', async () => {
    let saved = { summaryCommitPrompt: 'old', summarySessionTitlePrompt: 'title', unrelated: 7 };
    let fail = true;
    const send = vi.fn(async (_path, _method, body) => {
      if (fail) throw new Error('409');
      saved = { ...saved, ...body as object }; return { ok: true };
    });
    const write = createSettingsTransaction(send, () => true), patch = { summaryCommitPrompt: 'draft' };
    await expect(write('/api/config/settings', 'PUT', patch)).rejects.toThrow('409');
    expect(saved).toEqual({ summaryCommitPrompt: 'old', summarySessionTitlePrompt: 'title', unrelated: 7 });
    fail = false; await write('/api/config/settings', 'PUT', patch);
    expect(saved).toEqual({ summaryCommitPrompt: 'draft', summarySessionTitlePrompt: 'title', unrelated: 7 });
    expect(send).toHaveBeenCalledTimes(2);
  });
});
