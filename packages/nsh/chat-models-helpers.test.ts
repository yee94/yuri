import { describe, expect, test } from 'vitest';
import { contextLabel, inlineModelVariants, modelCapabilities, modelLabel, modelMatches, modelRefs, pickerLists, pickerModels, pickerPreferences, pickerSheetHeight, preferenceUpdate, resolvedVariant, variantLabel } from './chat-models-helpers';

const providers = [
  { id: 'p', name: 'Provider', models: {
    a: { id: 'a', name: 'GPT-6.1 Sol', variants: { low: {}, high: {} } },
    b: { id: 'b', name: 'DeepSeek-V4-Flash' },
    hidden: { id: 'hidden', name: 'Never show', hidden: true },
  } },
  { id: 'q', name: 'Other', models: { a: { id: 'a', name: 'Other model' } } },
];

describe('native model picker mirrors Web catalog/preferences contracts', () => {
  test('sheet is 72% of app content plus the home safe area, in portrait and after rotation', () => {
    expect(pickerSheetHeight(874, { top: 62, bottom: 34 })).toBeCloseTo(594.16);
    expect(pickerSheetHeight(402, { top: 0, bottom: 21 })).toBeCloseTo(295.32);
    expect(pickerSheetHeight(778, { top: 0, bottom: 0 })).toBeCloseTo(560.16);
    expect(pickerSheetHeight(1200, { top: 24, bottom: 20 })).toBeCloseTo(852.32);
  });
  test('provider groups follow actual visible catalog and saved order, not the selected Provider or screenshot', () => {
    const catalog = [...providers, { id: 'empty', name: 'Empty', models: {} }, { id: 'masked', name: 'Hidden provider', models: { x: { id: 'x' } } }];
    const preferences = { providerOrder: ['q', 'p'], hiddenModels: [{ providerID: 'masked', modelID: 'x' }] };
    const entries = pickerModels(catalog, preferences);
    expect([...new Set(entries.map(entry => entry.providerID))]).toEqual(['q', 'p']);
    expect([...new Set(entries.filter(entry => modelMatches(entry, 'provider')).map(entry => entry.providerID))]).toEqual(['p']);
  });
  test('malformed or failed preferences never become authoritative empty settings', () => {
    for (const value of [null, false, 1, [], { ok: false }, { success: false }, { hiddenModels: {} }, { recentModels: 'invalid' }]) expect(pickerPreferences(value)).toBeUndefined();
    expect(pickerPreferences({ projects: [] })).toEqual({ projects: [] });
  });
  test('filters saved hidden models across every list without filtering same ID in another provider', () => {
    const preferences = { hiddenModels: [{ providerID: 'p', modelID: 'a' }], recentModels: [{ providerID: 'p', modelID: 'a' }], favoriteModels: [{ providerID: 'q', modelID: 'a' }] };
    const entries = pickerModels(providers, preferences);
    expect(entries.map(entry => [entry.providerID, entry.modelID])).toEqual([['p', 'b'], ['q', 'a']]);
    expect(pickerLists(entries, preferences, { providerID: 'p', modelID: 'a' }).recents).toEqual([]);
  });
  test('uses saved provider order and Web model display/search functions', () => {
    const entries = pickerModels(providers, { providerOrder: ['q'] });
    expect(entries[0].providerID).toBe('q');
    expect(modelLabel(entries[2])).toBe('DeepSeek V4 Flash');
    expect(modelMatches(entries[2], 'deepseek v4flash')).toBe(true);
    expect(modelMatches(entries[1], 'provider')).toBe(true);
  });
  test('recents preserve saved order/variants, remove favorites, and pin authoritative current like Web', () => {
    const preferences = { favoriteModels: [{ providerID: 'q', modelID: 'a' }], recentModels: [{ providerID: 'q', modelID: 'a' }, { providerID: 'p', modelID: 'b' }, { providerID: 'p', modelID: 'a', variant: 'high' }] };
    const lists = pickerLists(pickerModels(providers, preferences), preferences, { providerID: 'p', modelID: 'a' });
    expect(lists.favorites.map(entry => entry.providerID)).toEqual(['q']);
    expect(lists.recents.map(entry => [entry.modelID, entry.variant])).toEqual([['a', 'high'], ['b', undefined]]);
    expect(preferences.recentModels[0].providerID).toBe('q');
  });
  test('does not manufacture persisted recents from catalog', () => {
    const entries = pickerModels(providers, {});
    expect(pickerLists(entries, {}, { providerID: '', modelID: '' }).recents).toEqual([]);
    expect(pickerLists(entries, {}, { providerID: 'p', modelID: 'a' }).recents.map(entry => entry.modelID)).toEqual(['a']);
  });
  test('selected default remains authoritative; saved variants only apply when valid', () => {
    const entry = pickerModels(providers, {})[0];
    const preferences = { recentModels: [{ providerID: 'p', modelID: 'a', variant: 'high' }] };
    const current = { providerID: 'p', modelID: 'a' };
    expect(resolvedVariant(entry, current, preferences)).toBeUndefined();
    expect(resolvedVariant(entry, current, preferences, true)).toBe('high');
    expect(resolvedVariant({ ...entry, variant: 'expired' }, { ...current, variant: 'low' }, {})).toBe('low');
    expect(resolvedVariant({ ...entry, variant: 'expired' }, { providerID: 'q', modelID: 'a' }, {})).toBeUndefined();
  });
  test('ordinary provider rows never borrow favorites or recents; valid session/default fallback is distinct from remembered clicks', () => {
    const entry = pickerModels(providers, {})[0], other = { providerID: 'q', modelID: 'a' };
    const preferences = { favoriteModels: [{ providerID: 'p', modelID: 'a', variant: 'high' }] };
    expect(resolvedVariant(entry, other, preferences)).toBeUndefined();
    expect(resolvedVariant(entry, other, preferences, false, 'low')).toBe('low');
    expect(resolvedVariant(entry, other, preferences, true, 'low')).toBe('high');
    expect(resolvedVariant(entry, other, preferences, false, 'expired')).toBeUndefined();
    expect(resolvedVariant(entry, entry, preferences, false, 'low')).toBeUndefined();
  });
  test('inline options, labels and both snap heights match the mobile panel', () => {
    const entry = { ...pickerModels(providers, {})[0], model: { variants: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`v${i}`, {}])) } };
    expect(inlineModelVariants(entry)).toEqual(['', 'v0', 'v1', 'v2', 'v3', 'v4', 'v5', 'v6']);
    expect(variantLabel(' high ', 'Default')).toBe('High'); expect(variantLabel('1024', 'Default')).toBe('1024');
    expect(variantLabel('', '默认')).toBe('默认');
    expect(pickerSheetHeight(874, { top: 62, bottom: 34 }, true)).toBeCloseTo(796.44);
  });
  test('favorite writes are a narrow patch preserving other entries/variants', () => {
    const preferences = { unrelated: 'keep', favoriteModels: [{ providerID: 'q', modelID: 'a', variant: 'low' }] };
    const entry = { providerID: 'p', modelID: 'a', variant: 'high' };
    const patch = preferenceUpdate(preferences, 'favorite', entry);
    expect(patch).toEqual({ favoriteModels: [entry, ...preferences.favoriteModels] });
    expect(preferenceUpdate(patch, 'favorite', entry)).toEqual({ favoriteModels: preferences.favoriteModels });
    expect(preferences.unrelated).toBe('keep');
  });
  test('recent writes are newest first, idempotent, and bounded to Web’s five entries', () => {
    const entries = Array.from({ length: 20 }, (_, index) => ({ providerID: 'p', modelID: String(index) }));
    const ref = { providerID: 'p', modelID: '8', variant: 'high' };
    const patch = preferenceUpdate({ recentModels: entries }, 'recent', ref);
    expect(modelRefs(patch.recentModels)).toHaveLength(5);
    expect(modelRefs(patch.recentModels)[0]).toEqual(ref);
    expect(preferenceUpdate(patch, 'recent', ref)).toEqual(patch);
  });
  test('selecting a favorite updates its variant in place without reordering favorites', () => {
    const first = { providerID: 'q', modelID: 'a', variant: 'low' };
    const selected = { providerID: 'p', modelID: 'a' };
    const preferences = { favoriteModels: [first, { ...selected, variant: 'high' }] };
    expect(preferenceUpdate(preferences, 'recent', selected)).toEqual({ recentModels: [selected], favoriteModels: [first, selected] });
  });
  test('only catalog capabilities are displayed, with duplicate modalities collapsed', () => {
    expect(modelCapabilities({ capabilities: { toolcall: true, reasoning: true, input: { image: true, pdf: true }, output: { image: true } } }).map(entry => entry.icon)).toEqual(['tools', 'brain-ai-3', 'file-image', 'file-pdf']);
    expect(modelCapabilities({})).toEqual([]);
    expect(contextLabel({ limit: { context: 400000 } })).toBe('400k ctx');
    expect(contextLabel({ limit: { context: 400000 } }, 'zh-CN')).toBe('40万 ctx');
    expect(contextLabel({ limit: { context: 400000 } }, 'zh-CN')).not.toMatch(/40\s+万/);
    expect(contextLabel({ limit: { context: 628000 } }, 'zh-CN')).toBe('62.8万 ctx');
    expect(contextLabel({ limit: { context: NaN } })).toBe('');
  });
});
