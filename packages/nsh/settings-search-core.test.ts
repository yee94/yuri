import { describe, expect, it, vi } from 'vitest';
import { createSettingsTargetNavigation, searchSettingsFields, settingsSearchItems } from './settings-search-core';
import { settingsPreferenceFields } from './settings-preferences-core';
import { settingsBasicSections, settingsBasicTarget } from './settings-basics-core';

describe('Native Settings field search', () => {
  it('excludes iOS/browser-only appearance entries from desktop search and global config from iOS', () => {
    for (const os of ['macos', 'windows']) {
      for (const query of ['iosNativeUiEnabled', 'pwaAppName', 'mobileKeyboardMode']) expect(searchSettingsFields(query, key => key, os)).toEqual([]);
      expect(searchSettingsFields('opencode.jsonc', key => key, os).map(item => item.id)).toEqual(['global-config.editor']);
    }
    expect(searchSettingsFields('opencode.jsonc', key => key, 'ios')).toEqual([]);
  });
  it('matches translated field labels and technical synonyms, not only page titles', () => {
    const t = (key: string) => key.endsWith('section.messageStreamTransport') ? '消息流传输' : key;
    expect(searchSettingsFields('消息流', t).map(item => item.id)).toEqual(['chat.message-transport']);
    expect(searchSettingsFields('ws', t).some(item => item.id === 'chat.message-transport')).toBe(true);
    expect(searchSettingsFields('git commit', t).map(item => item.id)).toEqual(['summary-ai.commit-prompt']);
    expect(searchSettingsFields('  ', t)).toEqual([]);
    expect(searchSettingsFields('not-in-any-setting', t)).toEqual([]);
  });
  it('indexes every new visible field once, without dynamic entities or hidden desktop controls', () => {
    expect(new Set(settingsSearchItems.map(item => item.id)).size).toBe(settingsSearchItems.length);
    for (const field of settingsPreferenceFields) expect(settingsSearchItems.some(item => item.id === field.id)).toBe(true);
    for (const section of settingsBasicSections) for (const field of section.fields) expect(settingsSearchItems.some(item => item.id === settingsBasicTarget(section.page, field))).toBe(true);
    expect(settingsSearchItems.some(item => /inline-assistant|spellcheck|terminal-quick/.test(item.id))).toBe(false);
  });
  it('exposes the implemented About surfaces including the disabled update explanation and conditional export target', () => {
    const about = settingsSearchItems.filter(item => item.page === 'about');
    expect(about.map(item => item.id)).toEqual(['about.feedback', 'about.host-update', 'about.check-updates', 'about.beta-updates', 'about.diagnostics', 'about.export-diagnostics']);
    expect(searchSettingsFields('export diagnostics', key => key).some(item => item.id === 'about.export-diagnostics')).toBe(true);
  });
  it('reveals the actual measured field without reordering or assuming uniform row height', async () => {
    const scrollTo = vi.fn(), viewport = { measure: async () => ({ pagePosition: { y: 90 } }), scrollTo };
    const navigation = createSettingsTargetNavigation(() => viewport, () => true);
    navigation.onScroll({ offset: { y: 120 } });
    await navigation.reveal({ measure: async () => ({ pagePosition: { y: 420 } }) });
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ y: 450, animated: false });
    await navigation.reveal({ measure: async () => ({ pagePosition: { y: 900 } }) });
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });
  it('waits for real layout and fences a late measurement when the owner changes', async () => {
    let current = true;
    const scrollTo = vi.fn(), viewport = { measure: async () => ({ pagePosition: { y: 0 } }), scrollTo };
    const navigation = createSettingsTargetNavigation(() => viewport, () => current);
    await navigation.reveal({ measure: async () => null });
    expect(scrollTo).not.toHaveBeenCalled();
    let resolve!: (value: { pagePosition: { y: number } }) => void;
    const pending = navigation.reveal({ measure: () => new Promise(done => { resolve = done; }) });
    current = false; resolve({ pagePosition: { y: 100 } }); await pending;
    expect(scrollTo).not.toHaveBeenCalled();
  });
});
