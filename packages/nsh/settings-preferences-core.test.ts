import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { settingsPreferenceFields, settingsPreferencePatch, settingsPreferenceReadbackMatches } from './settings-preferences-core';
import { createSettingsHelpers } from '../web/server/lib/opencode/settings-helpers.js';
import type { Row } from './model';
import { appearanceFromSettings } from './appearance-core';
import { nativeDiffLayout } from './chat-changes-layout';
import { editorCalendarPreferences } from './features-calendar';

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
  it('ACK readback checks actual normalized Host values for every nonlocal field without coercing missing/wrong typed values', () => {
    for (const field of settingsPreferenceFields.filter(item => !item.local)) {
      const samples = field.options ? field.options.map(option => option.value) : field.kind === 'boolean' ? [true, false] : field.kind === 'number' ? [field.min, field.max, field.min! + .6] : field.key === 'monoFont' ? ['jetbrains-mono', 'system-mono'] : ['Example'];
      for (const value of samples) {
        const patch = settingsPreferencePatch({ [field.key]: value });
        const snapshot = host.formatSettingsResponse(host.sanitizeSettingsUpdate(patch));
        expect(settingsPreferenceReadbackMatches(patch, snapshot), field.key).toBe(true);
        expect(settingsPreferenceReadbackMatches(patch, { [field.key]: null }), field.key).toBe(false);
        expect(settingsPreferenceReadbackMatches(patch, { [field.key]: typeof patch[field.key] === 'boolean' ? String(patch[field.key]) : false }), field.key).toBe(false);
        if (!['pwaOrientation', 'mobileKeyboardMode'].includes(field.key)) expect(settingsPreferenceReadbackMatches(patch, {}), field.key).toBe(false);
      }
    }
    expect(settingsPreferenceReadbackMatches({ fontSize: 125 }, { fontSize: 126 })).toBe(false);
    expect(settingsPreferenceReadbackMatches({ fontSize: 125 }, { fontSize: '125' })).toBe(false);
    expect(settingsPreferenceReadbackMatches({ editorFontSize: 24 }, { editorFontSize: 24 })).toBe(false);
    expect(settingsPreferenceReadbackMatches({ unknown: true }, { unknown: true })).toBe(false);
  });
  it('PWA clear means missing/empty override, never the display name; only named Host defaults admit absent fields', () => {
    const patch = settingsPreferencePatch({ pwaAppName: '  ' });
    expect(patch).toEqual({ pwaAppName: '' });
    expect(settingsPreferenceReadbackMatches(patch, host.formatSettingsResponse({}))).toBe(true);
    expect(settingsPreferenceReadbackMatches(patch, {})).toBe(true);
    expect(settingsPreferenceReadbackMatches(patch, { pwaAppName: '' })).toBe(true);
    expect(settingsPreferenceReadbackMatches(patch, { pwaAppName: 'Yuri' })).toBe(false);
    expect(settingsPreferenceReadbackMatches({ pwaOrientation: 'system', mobileKeyboardMode: 'native' }, {})).toBe(true);
    expect(settingsPreferenceReadbackMatches({ pwaOrientation: 'portrait' }, {})).toBe(false);
    expect(settingsPreferenceReadbackMatches({ mobileKeyboardMode: 'resize-content' }, {})).toBe(false);
    expect(settingsPreferenceReadbackMatches({ followUpBehavior: 'queue' }, {})).toBe(false);
  });
  it('theme ACK readback requires every submitted identity field and a consistent active palette', () => {
    const patch = { themeId: 'jetbrains-light', themeVariant: 'light', useSystemTheme: true, lightThemeId: 'jetbrains-light', darkThemeId: 'jetbrains-dark' };
    expect(settingsPreferenceReadbackMatches(patch, host.formatSettingsResponse(patch))).toBe(true);
    for (const key of Object.keys(patch)) {
      const snapshot: Row = { ...patch }; delete snapshot[key];
      expect(settingsPreferenceReadbackMatches(patch, snapshot), key).toBe(false);
    }
    expect(settingsPreferenceReadbackMatches(patch, { ...patch, themeId: 'jetbrains-dark' })).toBe(false);
    const inconsistent = { ...patch, themeId: 'jetbrains-dark' };
    expect(settingsPreferenceReadbackMatches(inconsistent, inconsistent)).toBe(false);
  });
  it.each(['sessionGoalEnabled', 'showAssistantTps', 'collapsibleThinkingBlocks'] as const)('declares the real root appearance consumer for %s and round-trips both values', async key => {
    expect(settingsPreferenceFields.find(field => field.key === key)).toMatchObject({ consumer: 'appearance', initial: true });
    for (const value of [false, true]) {
      const patch = settingsPreferencePatch({ [key]: value });
      const response = host.formatSettingsResponse(host.sanitizeSettingsUpdate(patch));
      expect((await appearanceFromSettings(response, async () => ({ themes: [] })))[key]).toBe(value);
    }
  });
  it('connects padding to canonical appearance and keeps input offset on its Host-only Web surface', () => {
    expect(settingsPreferenceFields.find(field => field.key === 'padding')?.consumer).toBe('appearance');
    expect(settingsPreferenceFields.find(field => field.key === 'inputBarOffset')?.consumer).toBe('host-only');
  });
  it('defaults follow-up to Web queue while preserving both explicit choices', () => {
    expect(settingsPreferenceFields.find(field => field.key === 'followUpBehavior')?.initial).toBe('queue');
    for (const followUpBehavior of ['queue', 'steer']) expect(settingsPreferencePatch({ followUpBehavior })).toEqual({ followUpBehavior });
  });
  it.each(['queue', 'steer'] as const)('round-trips follow-up %s into the actual root appearance consumer', async followUpBehavior => {
    expect(settingsPreferenceFields.find(field => field.key === 'followUpBehavior')?.consumer).toBe('appearance');
    const patch = settingsPreferencePatch({ followUpBehavior });
    const response = host.formatSettingsResponse(host.sanitizeSettingsUpdate(patch));
    expect((await appearanceFromSettings(response, async () => ({ themes: [] }))).followUpBehavior).toBe(followUpBehavior);
  });
  it('declares the real device-cache consumer without inventing a Host preference write', () => {
    expect(settingsPreferenceFields.find(field => field.key === 'transcriptCache')).toMatchObject({ consumer: 'device-cache', local: true });
    expect(() => settingsPreferencePatch({ transcriptCache: 'clear' })).toThrow();
  });
  it('declares device-local code size as appearance without giving it a Host write contract', () => {
    expect(settingsPreferenceFields.find(field => field.key === 'codeFontSize')).toMatchObject({ consumer: 'appearance', local: true, min: 50, max: 200, initial: 100 });
    expect(() => settingsPreferencePatch({ codeFontSize: 150 })).toThrow('No Host preference contract');
  });
  it('declares only the connected Skills editors for local editor point size, never a Host preference', () => {
    expect(settingsPreferenceFields.find(field => field.key === 'editorFontSize')).toMatchObject({ consumer: 'skills-editor', local: true, min: 9, max: 32, initial: 13 });
    expect(() => settingsPreferencePatch({ editorFontSize: 18 })).toThrow('No Host preference contract');
    expect(host.sanitizeSettingsUpdate({ editorFontSize: 18 })).not.toHaveProperty('editorFontSize');
  });
  it('declares mobile keymap as a saved device preference without pretending to implement native Vim or Host writes', () => {
    expect(settingsPreferenceFields.find(field => field.key === 'fileEditorKeymap')).toMatchObject({ consumer: 'device-preference', local: true, initial: 'default', options: [{ value: 'default' }, { value: 'vim' }] });
    expect(() => settingsPreferencePatch({ fileEditorKeymap: 'vim' })).toThrow('No Host preference contract');
    expect(host.sanitizeSettingsUpdate({ fileEditorKeymap: 'vim' })).not.toHaveProperty('fileEditorKeymap');
  });
  it.each(['dynamic', 'inline', 'side-by-side'] as const)('round-trips diff %s through the canonical appearance into the native layout consumer', async diffLayoutPreference => {
    expect(settingsPreferenceFields.find(field => field.key === 'diffLayoutPreference')?.consumer).toBe('appearance');
    const response = host.formatSettingsResponse(host.sanitizeSettingsUpdate(settingsPreferencePatch({ diffLayoutPreference })));
    const appearance = await appearanceFromSettings(response, async () => ({ themes: [] }));
    expect(appearance.diffLayoutPreference).toBe(diffLayoutPreference);
    expect(nativeDiffLayout(appearance.diffLayoutPreference, 402, false)).toBe(diffLayoutPreference === 'side-by-side' ? 'split' : 'unified');
  });
  it.each(['auto', 'sunday', 'monday'] as const)('round-trips week start %s into the actual calendar consumer', async weekStartPreference => {
    expect(settingsPreferenceFields.find(field => field.key === 'weekStartPreference')?.consumer).toBe('appearance');
    const response = host.formatSettingsResponse(host.sanitizeSettingsUpdate(settingsPreferencePatch({ weekStartPreference })));
    const appearance = await appearanceFromSettings(response, async () => ({ themes: [] }));
    expect(appearance.weekStartPreference).toBe(weekStartPreference);
    expect(editorCalendarPreferences(appearance, 'en-US').weekStartsOn).toBe(weekStartPreference === 'monday' ? 1 : 0);
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
    const keys = [...settingsPreferenceFields.flatMap(field => [field.title, ...(field.description ? [field.description] : []), ...(field.options || []).map(option => option.title)]),
      ...['description', 'action', 'dialog.title', 'dialog.description', 'dialog.clearing', 'toast.cleared', 'toast.failed'].map(key => `settings.yuri.visual.transcriptCache.${key}`),
      'settings.github.native.unknown', 'settings.preferences.native.notApplied'];
    for (const locale of ['en', 'zh-CN', 'zh-TW', 'ja', 'ko', 'es', 'fr', 'pl', 'pt-BR', 'uk']) {
      const source = readFileSync(path.join(directory, `../ui/src/lib/i18n/messages/${locale}.settings.ts`), 'utf8');
      for (const key of keys) expect(source.includes(`'${key}'`) || source.includes(`"${key}"`), `${locale}: ${key}`).toBe(true);
    }
  });
  it('classifies actual device Chat consumers and compatibility flag without pretending client usage reporting is implemented', () => {
    for (const key of ['allowPromptingSubagentSessions', 'collapsibleUserMessages', 'persistChatDraft']) expect(settingsPreferenceFields.find(field => field.key === key)).toMatchObject({ consumer: 'device-chat', local: true });
    expect(settingsPreferenceFields.find(field => field.key === 'iosNativeUiEnabled')).toMatchObject({ consumer: 'device-preference', local: true, initial: false });
    expect(settingsPreferenceFields.find(field => field.key === 'reportUsage')).toMatchObject({ consumer: 'unconnected', initial: false });
    for (const [key, initial] of Object.entries({ terminalFontSize: 13, inputBarOffset: 0, pwaAppName: '', pwaOrientation: 'system', mobileKeyboardMode: 'native' })) expect(settingsPreferenceFields.find(field => field.key === key)).toMatchObject({ initial, consumer: 'host-only' });
  });
});
