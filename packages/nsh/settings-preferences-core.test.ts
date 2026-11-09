import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createNativeCodeFontPreference, settingsCodeFontSize, settingsPreferenceAvailable, settingsPreferenceFields, settingsPreferencePatch } from './settings-preferences-core';
import { createSettingsHelpers } from '../web/server/lib/opencode/settings-helpers.js';
import type { Row } from './model';
import { appearanceFromSettings } from './appearance-core';

const host = createSettingsHelpers({
  normalizePathForPersistence: (value: unknown) => value,
  normalizeDirectoryPath: (value: unknown) => value,
  sanitizeTypographySizesPartial: () => undefined,
  normalizeStringArray: (value: unknown) => value,
  sanitizeModelRefs: () => undefined,
  sanitizeSkillCatalogs: () => undefined,
  sanitizeProjects: () => undefined,
});
describe('Native Settings Host preference contract', () => {
  it('enables only actual native consumers, not every valid Host setting or browser-local field', () => {
    for (const os of ['macos', 'windows', 'linux', 'ios']) {
      for (const key of ['fontSize', 'monoFont', 'timeFormatPreference', 'sessionTitleRefreshEnabled']) expect(settingsPreferenceAvailable(key, os)).toBe(true);
      for (const key of ['padding', 'inputBarOffset', 'editorFontSize', 'terminalFontSize', 'fileEditorKeymap', 'reportUsage', 'pwaAppName']) expect(settingsPreferenceAvailable(key, os)).toBe(false);
      expect(settingsPreferenceAvailable('codeFontSize', os)).toBe(false);
      expect(settingsPreferenceAvailable('codeFontSize', os, true)).toBe(os !== 'ios');
    }
    for (const value of ['', null, true, [], {}, 49, 201, Infinity]) expect(() => settingsCodeFontSize(value)).toThrow();
    expect(settingsCodeFontSize('125')).toBe(125);
  });
  it('does not label unrelated unavailable controls as an iOS capability', () => {
    const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'settings-preferences.tsx'), 'utf8');
    expect(source).not.toContain("t('settings.yuri.visual.field.iosNativeUi')");
    expect(source).toContain('!available(field().key)');
  });
  it.each(['sessionGoalEnabled', 'showAssistantTps', 'collapsibleThinkingBlocks'] as const)('declares the real root appearance consumer for %s and round-trips both values', async key => {
    expect(settingsPreferenceFields.find(field => field.key === key)).toMatchObject({ consumer: 'appearance', initial: true });
    for (const value of [false, true]) {
      const patch = settingsPreferencePatch({ [key]: value });
      const response = host.formatSettingsResponse(host.sanitizeSettingsUpdate(patch));
      expect((await appearanceFromSettings(response, async () => ({ themes: [] })))[key]).toBe(value);
    }
  });
  it('keeps incomplete layout and follow-up consumers explicitly unconnected', () => {
    for (const key of ['padding', 'inputBarOffset', 'followUpBehavior']) expect(settingsPreferenceFields.find(field => field.key === key)?.consumer).toBe('unconnected');
  });
  it('defaults follow-up to Web queue while preserving both explicit choices', () => {
    expect(settingsPreferenceFields.find(field => field.key === 'followUpBehavior')?.initial).toBe('queue');
    for (const followUpBehavior of ['queue', 'steer']) expect(settingsPreferencePatch({ followUpBehavior })).toEqual({ followUpBehavior });
  });
  it('every editable field really survives the current Host sanitizer and response formatter', () => {
    for (const field of settingsPreferenceFields.filter(field => !field.local)) {
      const samples = field.options ? field.options.map(option => option.value) : field.kind === 'boolean' ? [true, false] : field.kind === 'number' ? [field.min, field.max] : field.key === 'monoFont' ? ['jetbrains-mono', 'system-mono'] : field.key === 'uiFont' ? ['inter', 'system'] : ['Example'];
      for (const value of samples) {
        const patch = settingsPreferencePatch({ [field.key]: value });
        expect(host.sanitizeSettingsUpdate(patch), field.key).toEqual(patch);
        expect(host.formatSettingsResponse(patch)[field.key], field.key).toEqual(value);
      }
    }
  });
  it.each(['codeFontSize', 'editorFontSize', 'fileEditorKeymap', 'persistChatDraft', 'allowPromptingSubagentSessions', 'collapsibleUserMessages', 'sidebarBrandName', 'iosNativeUiEnabled', 'transcriptCache'])('does not fake a Host write for browser-local %s', key => {
    expect(settingsPreferenceFields.find(field => field.key === key)?.local).toBe(true);
    expect(() => settingsPreferencePatch({ [key]: true })).toThrow();
    expect(host.sanitizeSettingsUpdate({ [key]: true })).not.toHaveProperty(key);
  });
  it.each(['fontSize', 'terminalFontSize', 'padding', 'inputBarOffset'])('rejects invalid/blank/out-of-range %s before a Host can silently clamp it', key => {
    const field = settingsPreferenceFields.find(item => item.key === key)!;
    for (const value of ['', null, false, 'NaN', Infinity, field.min! - 1, field.max! + 1]) expect(() => settingsPreferencePatch({ [key]: value })).toThrow();
    expect(settingsPreferencePatch({ [key]: String(field.min) })).toEqual({ [key]: field.min });
  });
  it('does not mutate drafts or forward unknown keys and rejects bogus enum values', () => {
    const draft: Row = { fontSize: '125', showReasoningTraces: false };
    expect(settingsPreferencePatch(draft)).toEqual({ fontSize: 125, showReasoningTraces: false });
    expect(draft).toEqual({ fontSize: '125', showReasoningTraces: false });
    expect(settingsPreferencePatch({ fontSize: '125.6', pwaAppName: '  Example   App ' })).toEqual({ fontSize: 126, pwaAppName: 'Example App' });
    for (const field of settingsPreferenceFields.filter(item => item.options)) expect(() => settingsPreferencePatch({ [field.key]: 'invented' })).toThrow();
    expect(() => settingsPreferencePatch({ secret: 'not-permitted' })).toThrow();
    expect(() => settingsPreferencePatch({ monoFont: 'invented' })).toThrow();
  });
  it('uses existing translations in all ten dictionaries, including every enum label', () => {
    const directory = path.dirname(fileURLToPath(import.meta.url));
    const keys = settingsPreferenceFields.flatMap(field => [field.title, ...(field.options || []).map(option => option.title)]);
    for (const locale of ['en', 'zh-CN', 'zh-TW', 'ja', 'ko', 'es', 'fr', 'pl', 'pt-BR', 'uk']) {
      const source = readFileSync(path.join(directory, `../ui/src/lib/i18n/messages/${locale}.settings.ts`), 'utf8');
      for (const key of keys) expect(source.includes(`'${key}'`) || source.includes(`"${key}"`), `${locale}: ${key}`).toBe(true);
    }
  });
});

describe('native device code typography preference', () => {
  it('waits for storage ACK, blocks concurrent writes, and preserves the prior value on failure', async () => {
    const values: Array<number | null> = [];
    let resolve!: () => void, fail = false, raw: string | null = null;
    const preference = createNativeCodeFontPreference({ getItem: async () => raw, setItem: async (_key, next) => { if (fail) throw new Error('disk'); await new Promise<void>(done => { resolve = done; }); raw = next; } }, value => values.push(value));
    await expect(preference.save(125)).rejects.toThrow();
    await preference.load(); expect(values).toEqual([100]);
    const save = preference.save('150');
    expect(values).toEqual([100]); await expect(preference.save(125)).rejects.toThrow();
    resolve(); await save; expect(values).toEqual([100, 150]);
    fail = true; await expect(preference.save(125)).rejects.toThrow('disk');
    expect(values.at(-1)).toBe(150);
  });
  it('marks unknown disk outcomes pending until a read succeeds, without replaying the write', async () => {
    let raw: string | null = null, unreadable = false, writes = 0;
    const states: Array<[number | null, boolean | undefined]> = [];
    const preference = createNativeCodeFontPreference({ getItem: async () => { if (unreadable) throw new Error('read'); return raw; }, setItem: async (_key, next) => { writes++; raw = next; unreadable = true; throw new Error('ACK'); } }, (value, pending) => states.push([value, pending]));
    await preference.load(); await expect(preference.save(125)).rejects.toThrow('read');
    expect(states.at(-1)).toEqual([100, true]); await expect(preference.save(125)).rejects.toThrow(); expect(writes).toBe(1);
    unreadable = false; await preference.load(); expect(states.at(-1)).toEqual([125, false]); expect(writes).toBe(1);
  });
  it('reconciles a lost write ACK without replaying it, and refuses malformed persisted data', async () => {
    let raw: string | null = null, writes = 0;
    const values: Array<number | null> = [];
    const preference = createNativeCodeFontPreference({ getItem: async () => raw, setItem: async (_key, value) => { raw = value; writes++; throw new Error('lost ACK'); } }, value => values.push(value));
    await preference.load(); await preference.save(175);
    expect(writes).toBe(1); expect(values).toEqual([100, 175]);
    raw = '"bad"'; await expect(preference.load()).rejects.toThrow(); expect(values.at(-1)).toBe(175);
    raw = null; await preference.load(); expect(values.at(-1)).toBe(100);
  });
});
