import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { settingsPreferenceFields, settingsPreferencePatch } from './settings-preferences-core';
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
      const samples = field.options ? field.options.map(option => option.value) : field.kind === 'boolean' ? [true, false] : field.kind === 'number' ? [field.min, field.max] : field.key === 'monoFont' ? ['jetbrains-mono', 'system-mono'] : ['Example'];
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
